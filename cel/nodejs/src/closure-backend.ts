/**
 * The closure backend: a tree compiled into nested closures, with **no `eval`, no
 * `new Function` and no disk**.
 *
 * Everything an expression's shape decides is decided once, at compile time — which name
 * is a bound slot, which select is a dotted activation read, which call is a macro — so
 * evaluating is calling closures over a frame. Semantics are not here: every operator and
 * function is the runtime library's (`runtime-library.ts`), every comprehension is
 * `comprehension-runtime.ts`, and every member read is the seam
 * (`member-read.ts`). The emitter that comes later emits calls into exactly those, which
 * is the only way two backends can be held to one answer.
 *
 * **Overloads are resolved on the values' own types**, per call site: `dyn(1.0) == 1` checks
 * and must then answer across the numeric types, so the statically resolved signature is not
 * enough. A site holds its last resolution beside a bounded cache, and a container's element
 * type is read as `dyn` rather than walked — walking a list on every call would make dispatch
 * cost grow with the data.
 */

import type { CelActivation } from "./activation.js";
import { activationHolds } from "./activation.js";
import { BoundedCache } from "./bounded-cache.js";
import { celMapFromEntries } from "./cel-map-value.js";
import { splitDeclaredChain } from "./declared-chain.js";
import type { CelType } from "./cel-type.js";
import {
  BOOL,
  BYTES,
  DOUBLE,
  DURATION,
  DYN,
  INT,
  listOf,
  mapOf,
  NULL,
  optionalOf,
  STRING,
  TIMESTAMP,
  TYPE,
  UINT,
} from "./cel-type.js";
import type { CelValue } from "./cel-value.js";
import {
  celError,
  asyncValueRefused,
  celNone,
  celSome,
  celTypeNameOf,
  celUint,
  isCelError,
  isCelOptional,
  type CelError,
  type CelOptional,
} from "./cel-value.js";
import {
  celAll,
  celExists,
  celExistsOne,
  celFilter,
  celMapComprehension,
} from "./comprehension-runtime.js";
import { namespaceMacroBinding, receiverMacroBinding } from "./comprehension-bindings.js";
import type { FunctionRegistry, Resolution, ResolutionFailure } from "./function-registry.js";
import { isMacroCall } from "./macro-check.js";
import {
  celHas,
  celIterable,
  celLookup,
  celRead,
  lookupError,
  MISSING,
  OUT_OF_RANGE,
} from "./member-read.js";
import type { CelCallContext, CelImplementation } from "./runtime-library.js";
import { implementationOf, optionalOfNonZero } from "./runtime-library.js";
import type { CallForm } from "./signature.js";
import type { CelNode, CelSelectNode, SourceRange } from "./syntax-tree.js";

/** How many distinct argument-type combinations one call site remembers. */
export const CALL_SITE_CACHE_CAPACITY = 16;

/** What a namespaced call is dispatched through, when something bound it. */
export type NamespaceDispatch = (namespace: string, name: string) => CelImplementation | undefined;

export interface EvaluationFrame {
  readonly activation: CelActivation;
  readonly slots: CelValue[];
  /** Absent rather than optional: one frame shape, however the evaluation was started. */
  readonly namespaceFunction: NamespaceDispatch | undefined;
}

export type CelStep = (frame: EvaluationFrame) => CelValue;

/** What the backend needs of the environment it compiles against. */
export interface CompileTarget {
  readonly registry: FunctionRegistry;
  /** The library's own names — the type values and `google`. */
  readonly constants: ReadonlyMap<string, CelValue>;
  /** How many type arguments a host's named type takes, for dispatch on one of its values. */
  readonly nominalArity: (name: string) => number | undefined;
  /**
   * Whether a host DECLARED this name — including a dotted one. It decides where a chain
   * splits, at compile time, through the same function the checker uses.
   */
  readonly declares: (name: string) => boolean;
}

export interface CompiledTree {
  readonly step: CelStep;
  /** How many binding slots a frame needs. */
  readonly slots: number;
}

/** A compile-time refusal: a tree that cannot be compiled at all. */
export class CelCompileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CelCompileError";
  }
}

/** A name bound by a macro, and the slot its value lives in. */
interface Binding {
  readonly name: string;
  readonly slot: number;
  readonly outer: Binding | undefined;
}

function boundSlot(scope: Binding | undefined, name: string): number | undefined {
  for (let at = scope; at; at = at.outer) if (at.name === name) return at.slot;
  return undefined;
}

export function compileTree(root: CelNode, target: CompileTarget): CompiledTree {
  const compiler = new Compiler(target);
  const step = compiler.compile(root, undefined);
  return { step, slots: compiler.slots };
}

class Compiler {
  slots = 0;

  constructor(private readonly target: CompileTarget) {}

  compile(node: CelNode, scope: Binding | undefined): CelStep {
    switch (node.kind) {
      case "literal":
        return constantStep(literalValue(node.literal));
      case "ident":
        return this.identStep(node, scope);
      case "list":
        return this.listStep(node, scope);
      case "map":
        return this.mapStep(node, scope);
      case "select":
        return this.selectStep(node, scope);
      case "index":
        return this.indexStep(node, scope);
      case "unary":
        return this.callStep(node.operator, "global", [this.compile(node.operand, scope)], node.range);
      case "binary":
        return this.binaryStep(node, scope);
      case "conditional":
        return this.conditionalStep(node, scope);
      case "call":
      case "receiverCall":
        return this.anyCallStep(node, scope);
      case "qcall":
        return this.qualifiedCallStep(node, scope);
      case "unparsed":
        throw new CelCompileError("the expression could not be read whole, so it cannot be compiled");
    }
  }

  // --- names --------------------------------------------------------------

  private identStep(node: Extract<CelNode, { kind: "ident" }>, scope: Binding | undefined): CelStep {
    if (!node.absolute) {
      const slot = boundSlot(scope, node.name);
      if (slot !== undefined) return (frame) => frame.slots[slot]!;
    }
    const { name, range } = node;
    const { constants } = this.target;
    return (frame) => {
      if (activationHolds(frame.activation, name)) return read(frame.activation[name], range);
      const held = constants.get(name);
      if (held !== undefined) return held;
      return celError("no_such_variable", `no such variable: ${name}`, range);
    };
  }

  /**
   * A chain of plain member names rooted at a free name: one activation lookup over the
   * longest declared prefix, the rest read through the seam. The checker resolves the
   * same chain the same way, so a host holding `a.b.c` reads that name and one holding
   * only `a.b` reads the map's entry.
   */
  private qualifiedChainStep(segments: readonly string[], range: SourceRange): CelStep {
    const { constants, declares } = this.target;
    // **A DECLARED chain splits at compile time**, through the same function the checker
    // splits it with (`declared-chain.ts`), so evaluation performs exactly one activation
    // read and then member reads — no search over prefixes, and no chance of reading a
    // different name than the one the checker typed. A declared name the activation does not
    // hold is `no_such_variable` for THAT name: falling back to a shorter prefix would read a
    // value of a name the host did not mean.
    const declaredSplit = splitDeclaredChain(segments, declares);
    if (declaredSplit) {
      const { name, rest } = declaredSplit;
      return (frame) => this.chainFrom(frame, name, rest, range);
    }
    // Nothing declares a prefix of this chain, so there is nothing to split it on and the
    // checker has no opinion either: the activation is searched, longest prefix first. Every
    // conformance row that binds a dotted key reads this way.
    const candidates = prefixCandidates(segments);
    const written = segments.join(".");
    return (frame) => {
      for (let at = 0; at < candidates.length; at += 1) {
        const candidate = candidates[at]!;
        if (!activationHolds(frame.activation, candidate.name) && !constants.has(candidate.name)) {
          continue;
        }
        return this.chainFrom(frame, candidate.name, candidate.rest, range);
      }
      return celError("no_such_variable", `no such variable: ${written}`, range);
    };
  }

  /** One name read from the activation (or the library's constants), then its members. */
  private chainFrom(
    frame: EvaluationFrame,
    name: string,
    rest: readonly string[],
    range: SourceRange,
  ): CelValue {
    const { constants } = this.target;
    let held: CelValue;
    if (activationHolds(frame.activation, name)) held = read(frame.activation[name], range);
    else {
      const constant = constants.get(name);
      if (constant === undefined) return celError("no_such_variable", `no such variable: ${name}`, range);
      held = constant;
    }
    for (const field of rest) {
      if (isCelError(held)) return held;
      held = readThrough(held, field, false, range);
    }
    return held;
  }

  // --- aggregates ---------------------------------------------------------

  private listStep(node: Extract<CelNode, { kind: "list" }>, scope: Binding | undefined): CelStep {
    const elements = node.elements.map((element) => ({
      step: this.compile(element.value, scope),
      optional: element.optional,
    }));
    const { range } = node;
    return (frame) => {
      const out: CelValue[] = [];
      for (const element of elements) {
        const value = element.step(frame);
        if (isCelError(value)) return value;
        if (!element.optional) {
          out.push(value);
          continue;
        }
        const held = optionalEntry(value, range);
        if (isCelError(held)) return held;
        // An absent optional entry leaves no element: the aggregate shrinks, which is
        // the whole reason to write one.
        if (held.present) out.push(held.held as CelValue);
      }
      return out;
    };
  }

  private mapStep(node: Extract<CelNode, { kind: "map" }>, scope: Binding | undefined): CelStep {
    const entries = node.entries.map((entry) => ({
      key: this.compile(entry.key, scope),
      value: this.compile(entry.value, scope),
      optional: entry.optional,
    }));
    const { range } = node;
    return (frame) => {
      const pairs: [CelValue, CelValue][] = [];
      for (const entry of entries) {
        const key = entry.key(frame);
        if (isCelError(key)) return key;
        const value = entry.value(frame);
        if (isCelError(value)) return value;
        if (!entry.optional) {
          pairs.push([key, value]);
          continue;
        }
        const held = optionalEntry(value, range);
        if (isCelError(held)) return held;
        if (held.present) pairs.push([key, held.held as CelValue]);
      }
      return celMapFromEntries(pairs, range);
    };
  }

  // --- member reads -------------------------------------------------------

  private selectStep(node: CelSelectNode, scope: Binding | undefined): CelStep {
    const chain = plainChain(node, scope);
    if (chain) return this.qualifiedChainStep(chain, node.range);
    const operand = this.compile(node.operand, scope);
    const { field, optional, range } = node;
    return (frame) => {
      const held = operand(frame);
      if (isCelError(held)) return held;
      return readThrough(held, field, optional, range);
    };
  }

  private indexStep(node: Extract<CelNode, { kind: "index" }>, scope: Binding | undefined): CelStep {
    const operand = this.compile(node.operand, scope);
    const index = this.compile(node.index, scope);
    const { optional, range } = node;
    return (frame) => {
      const held = operand(frame);
      if (isCelError(held)) return held;
      const key = index(frame);
      if (isCelError(key)) return key;
      return readThrough(held, key, optional, range);
    };
  }

  // --- operators ----------------------------------------------------------

  /**
   * `&&` and `||` carry an error-valued operand through: `false && <error>` is `false`
   * and `true || <error>` is `true`, whichever side the error is on. That is why a CEL
   * error is a value — an exception thrown where it was found could not be discarded
   * here.
   */
  private binaryStep(node: Extract<CelNode, { kind: "binary" }>, scope: Binding | undefined): CelStep {
    if (node.operator !== "&&" && node.operator !== "||") {
      return this.callStep(
        node.operator,
        "global",
        [this.compile(node.left, scope), this.compile(node.right, scope)],
        node.range,
      );
    }
    const left = this.compile(node.left, scope);
    const right = this.compile(node.right, scope);
    const { range } = node;
    const decided = node.operator === "&&" ? false : true;
    return (frame) => {
      const a = boolOf(left(frame), range);
      if (a === decided) return decided;
      const b = boolOf(right(frame), range);
      if (b === decided) return decided;
      if (isCelError(a)) return a;
      if (isCelError(b)) return b;
      return !decided;
    };
  }

  private conditionalStep(
    node: Extract<CelNode, { kind: "conditional" }>,
    scope: Binding | undefined,
  ): CelStep {
    const condition = this.compile(node.condition, scope);
    const whenTrue = this.compile(node.whenTrue, scope);
    const whenFalse = this.compile(node.whenFalse, scope);
    const { range } = node;
    return (frame) => {
      const held = boolOf(condition(frame), range);
      if (isCelError(held)) return held;
      return held ? whenTrue(frame) : whenFalse(frame);
    };
  }

  // --- calls --------------------------------------------------------------

  private anyCallStep(
    node: Extract<CelNode, { kind: "call" | "receiverCall" }>,
    scope: Binding | undefined,
  ): CelStep {
    // The same question the checker asks, in the same place: a macro is not a function,
    // and it is recognised before any overload is looked for.
    if (isMacroCall(node)) return this.macroStep(node, scope);
    const form: CallForm = node.kind === "call" ? "global" : "receiver";
    const args = [
      ...(node.kind === "receiverCall" ? [this.compile(node.receiver, scope)] : []),
      ...node.args.map((argument) => this.compile(argument, scope)),
    ];
    return this.callStep(node.name, form, args, node.range);
  }

  /**
   * One dispatch: evaluate the arguments, carry the first error out, then resolve the
   * overload on the values' own types and call its implementation.
   */
  private callStep(name: string, form: CallForm, args: readonly CelStep[], range: SourceRange): CelStep {
    const { registry, nominalArity } = this.target;
    const resolved = new BoundedCache<string, Dispatch | null>(CALL_SITE_CACHE_CAPACITY);
    const context: CelCallContext = { range };
    const count = args.length;
    // A call site is almost always monomorphic — the same argument types on every
    // evaluation — so the last resolution is held beside the cache and reached by comparing
    // the type names themselves. Building the cache key is what that avoids: a string
    // concatenation per call, on the hottest path there is.
    let lastNames: string[] | undefined;
    let lastDispatch: Dispatch | null = null;
    return (frame) => {
      const values: CelValue[] = new Array<CelValue>(count);
      let same = lastNames !== undefined;
      for (let at = 0; at < count; at += 1) {
        const value = args[at]!(frame);
        if (isCelError(value)) return value;
        values[at] = value;
        if (same && celTypeNameOf(value) !== lastNames![at]) same = false;
      }
      if (same) return answer(lastDispatch, values, context, name, lastNames!, range);
      const names: string[] = new Array<string>(count);
      for (let at = 0; at < count; at += 1) {
        const held = celTypeNameOf(values[at]!);
        if (held === undefined) {
          // A value of no CEL type. A **thenable** is one, and a thenable NESTED inside a
          // host value arrives here rather than through the activation read, because a member
          // read hands back what the host put there — and `resources.x.status.y` is exactly
          // that shape, so this is the door a host actually uses. `read` names it for what it
          // is; anything else is the overload failure it was going to be. The cost is on the
          // slow path only: dispatch was about to fail either way.
          const named = read(values[at], range);
          if (isCelError(named)) return named;
          return celError("no_matching_overload", `${name} was handed a value of no CEL type`, range);
        }
        names[at] = held;
      }
      const key = names.join(",");
      let dispatch = resolved.get(key);
      if (dispatch === undefined) {
        const types = values.map((value) => runtimeType(value, nominalArity));
        const resolution = registry.resolve(
          name,
          form,
          form === "receiver" ? types.slice(1) : types,
          form === "receiver" ? types[0] : undefined,
        );
        dispatch = dispatchOf(name, resolution);
        resolved.set(key, dispatch);
      }
      lastNames = names;
      lastDispatch = dispatch;
      return answer(dispatch, values, context, name, names, range);
    };
  }

  private qualifiedCallStep(
    node: Extract<CelNode, { kind: "qcall" }>,
    scope: Binding | undefined,
  ): CelStep {
    const args = node.args.map((argument) => this.compile(argument, scope));
    const { namespace, name, range } = node;
    return (frame) => {
      const implementation = frame.namespaceFunction?.(namespace, name);
      if (!implementation) {
        return celError(
          "unbound_function",
          `unbound function '${namespace}.${name}' — nothing is bound under that name here`,
          range,
        );
      }
      const values: CelValue[] = [];
      for (const step of args) {
        const value = step(frame);
        if (isCelError(value)) return value;
        values.push(value);
      }
      return read(implementation(values, { range }), range);
    };
  }

  // --- macros -------------------------------------------------------------

  /**
   * Lowering a macro. There is no comprehension node to lower *to*: the macro's meaning
   * is a call into the comprehension runtime with the body as a closure, which is the
   * same shape the emitter will produce.
   */
  private macroStep(
    node: Extract<CelNode, { kind: "call" | "receiverCall" }>,
    scope: Binding | undefined,
  ): CelStep {
    if (node.kind === "call") return this.hasStep(node, scope);
    const receiver = node.receiver;
    if (receiver.kind === "ident" && receiver.name === "cel" && node.name === "bind") {
      return this.bindStep(node, scope);
    }
    if (receiver.kind === "ident" && receiver.name === "optional") {
      return this.optionalNamespaceStep(node, scope);
    }
    if ((node.name === "optMap" || node.name === "optFlatMap") && node.args.length === 2) {
      return this.optionalBindingStep(node, scope);
    }
    return this.comprehensionStep(node, scope);
  }

  /** `has(a.b)` — presence, which a missing key answers `false` rather than erroring. */
  private hasStep(node: Extract<CelNode, { kind: "call" }>, scope: Binding | undefined): CelStep {
    const argument = node.args[0]!;
    if (argument.kind !== "select") {
      throw new CelCompileError("has() asks about a member, so its argument ends in a select");
    }
    const operand = this.compile(argument.operand, scope);
    const { field } = argument;
    const { range } = node;
    return (frame) => {
      const held = operand(frame);
      if (isCelError(held)) return held;
      if (isCelOptional(held)) return held.present ? celHas(held.held as CelValue, field, range) : false;
      return celHas(held, field, range);
    };
  }

  private bindStep(
    node: Extract<CelNode, { kind: "receiverCall" }>,
    scope: Binding | undefined,
  ): CelStep {
    const binding = namespaceMacroBinding("cel", node.name, node.args.length);
    if (!binding) {
      throw new CelCompileError("cel.bind(name, value, body) takes a name, its value and a body");
    }
    const name = node.args[binding.variableArgument]!;
    if (name.kind !== "ident") throw new CelCompileError("cel.bind binds a name");
    const value = this.compile(node.args[1]!, scope);
    const slot = this.slots++;
    const body = this.compile(node.args[2]!, { name: name.name, slot, outer: scope });
    const { range } = node;
    return (frame) => {
      const held = value(frame);
      if (isCelError(held)) return held;
      // A name is bound to a VALUE, so a value that must be awaited is refused here rather
      // than inside the body, where every read of the name would meet it again.
      const refused = asyncValueRefused(held, range);
      if (refused) return refused;
      frame.slots[slot] = held;
      return body(frame);
    };
  }

  /** `optional.of(v)`, `optional.ofNonZeroValue(v)` and `optional.none()`. */
  private optionalNamespaceStep(
    node: Extract<CelNode, { kind: "receiverCall" }>,
    scope: Binding | undefined,
  ): CelStep {
    if (node.name === "none") return constantStep(celNone());
    if (node.args.length !== 1) {
      throw new CelCompileError(`optional.${node.name}(value) takes one argument`);
    }
    const value = this.compile(node.args[0]!, scope);
    const nonZero = node.name === "ofNonZeroValue";
    return (frame) => {
      const held = value(frame);
      if (isCelError(held)) return held;
      return nonZero ? optionalOfNonZero(held) : celSome(held);
    };
  }

  /** `opt.optMap(v, body)` wraps what the body answers; `optFlatMap` does not. */
  private optionalBindingStep(
    node: Extract<CelNode, { kind: "receiverCall" }>,
    scope: Binding | undefined,
  ): CelStep {
    const name = node.args[0]!;
    if (name.kind !== "ident") throw new CelCompileError(`${node.name} binds a name`);
    const receiver = this.compile(node.receiver, scope);
    const slot = this.slots++;
    const body = this.compile(node.args[1]!, { name: name.name, slot, outer: scope });
    const wrap = node.name === "optMap";
    const { range } = node;
    return (frame) => {
      const held = receiver(frame);
      if (isCelError(held)) return held;
      if (!isCelOptional(held)) {
        return celError("no_matching_overload", `${JSON.stringify(node.name)} reads an optional`, range);
      }
      if (!held.present) return celNone();
      // A host may hand over the optional itself, so what it HOLDS is a door of its own.
      const refused = asyncValueRefused(held.held, range);
      if (refused) return refused;
      frame.slots[slot] = held.held as CelValue;
      const answered = body(frame);
      if (isCelError(answered)) return answered;
      if (wrap) return celSome(answered);
      if (isCelOptional(answered)) return answered;
      return celError("no_matching_overload", "optFlatMap's body answers an optional", range);
    };
  }

  private comprehensionStep(
    node: Extract<CelNode, { kind: "receiverCall" }>,
    scope: Binding | undefined,
  ): CelStep {
    const binding = receiverMacroBinding(node.name, node.args.length);
    if (!binding) throw new CelCompileError(`${node.name} is not a comprehension`);
    const name = node.args[binding.variableArgument]!;
    if (name.kind !== "ident") throw new CelCompileError(`${node.name} binds a name`);
    const receiver = this.compile(node.receiver, scope);
    const slot = this.slots++;
    const inner: Binding = { name: name.name, slot, outer: scope };
    const scoped = binding.scopedArguments.map((at) => this.compile(node.args[at]!, inner));
    const { range } = node;
    const macro = node.name;
    return (frame) => {
      const held = receiver(frame);
      if (isCelError(held)) return held;
      const elements = celIterable(held, range);
      if (isCelError(elements)) return elements;
      const run = (step: CelStep) => (element: CelValue) => {
        frame.slots[slot] = element;
        return step(frame);
      };
      switch (macro) {
        case "all":
          return celAll(elements, run(scoped[0]!), range);
        case "exists":
          return celExists(elements, run(scoped[0]!), range);
        case "exists_one":
          return celExistsOne(elements, run(scoped[0]!), range);
        case "filter":
          return celFilter(elements, run(scoped[0]!), range);
        default:
          return scoped.length === 2
            ? celMapComprehension(elements, run(scoped[1]!), run(scoped[0]!), range)
            : celMapComprehension(elements, run(scoped[0]!), undefined, range);
      }
    };
  }
}

// --- the pieces the steps are built from ------------------------------------

function constantStep(value: CelValue): CelStep {
  return () => value;
}

function literalValue(literal: Extract<CelNode, { kind: "literal" }>["literal"]): CelValue {
  switch (literal.type) {
    case "int":
      return literal.value;
    case "uint":
      return celUint(literal.value);
    case "double":
      return literal.value;
    case "string":
      return literal.value;
    case "bytes":
      return literal.value;
    case "bool":
      return literal.value;
    case "null":
      return null;
  }
}

/**
 * A host value entering the engine — from an activation, from an implementation the host
 * registered, or out of a host value a read reached into. A thenable is refused here rather
 * than carried: an awaiting expression is an invocation in disguise, invisible to a journal
 * and absent from a trace. The refusal itself lives in `cel-value.ts`, so every door answers
 * with the same code and the same wording.
 */
function read(value: unknown, range: SourceRange): CelValue {
  return asyncValueRefused(value, range) ?? (value as CelValue);
}

/** Every prefix of a dotted chain, longest first, with the segments left to read. */
function prefixCandidates(
  segments: readonly string[],
): readonly { readonly name: string; readonly rest: readonly string[] }[] {
  const candidates: { name: string; rest: readonly string[] }[] = [];
  for (let length = segments.length; length >= 1; length -= 1) {
    candidates.push({ name: segments.slice(0, length).join("."), rest: segments.slice(length) });
  }
  return candidates;
}

/**
 * What a call site resolved to: the behaviour, and whether it came from the HOST. The
 * engine's own implementations are typed and cannot answer a thenable, so only a host's
 * answer is checked for one — which keeps the check off the path every operator takes.
 */
interface Dispatch {
  readonly implementation: CelImplementation;
  readonly foreign: boolean;
}

function dispatchOf(name: string, resolution: Resolution | ResolutionFailure): Dispatch | null {
  if ("resolved" in resolution) {
    const host = resolution.resolved.metadata.implementation;
    if (host) return { implementation: host, foreign: true };
    const own = implementationOf(resolution.resolved.signature);
    return own ? { implementation: own, foreign: false } : null;
  }
  // **Equality is universal at runtime**, over every pair of types: the checker refuses
  // `1 == 1u` deliberately, but `dyn(1) == 1u` reaches evaluation and cel-spec answers
  // `true` there. A host's own registration still wins, because it resolved first.
  const equality = equalityFallback(name);
  return equality ? { implementation: equality, foreign: false } : null;
}

function answer(
  dispatch: Dispatch | null,
  values: readonly CelValue[],
  context: CelCallContext,
  name: string,
  names: readonly string[],
  range: SourceRange,
): CelValue {
  if (!dispatch) {
    return celError(
      "no_matching_overload",
      `no overload of ${JSON.stringify(name)} takes (${names.join(", ")})`,
      range,
    );
  }
  const value = dispatch.implementation(values, context);
  return dispatch.foreign ? read(value, range) : value;
}

/** The universal equality, for a pair of types no registration names. */
function equalityFallback(name: string): CelImplementation | null {
  if (name !== "==" && name !== "!=") return null;
  return implementationOf({ name, form: "global", parameters: [], returns: DYN }) ?? null;
}

/** A bool operand, or the error it is — a non-bool is a mistake of its own. */
function boolOf(value: CelValue, range: SourceRange): boolean | CelError {
  if (typeof value === "boolean") return value;
  if (isCelError(value)) return value;
  return celError("no_matching_overload", "this value is not a bool", range);
}

/** What an optional entry of an aggregate contributes, or the error it is not one. */
function optionalEntry(value: CelValue, range: SourceRange): CelOptional | CelError {
  if (isCelOptional(value)) return value;
  return celError("no_matching_overload", "an entry written with '?' holds an optional", range);
}

/**
 * A member read in every form. Reading **through an optional** answers an optional
 * whichever form the read is written in, which is what lets a chain over a value that
 * may be absent stay one expression: an absent one propagates as absent, a key the held
 * value does not have is absent too, and a held value that holds no members at all is
 * still the mistake it would be outside an optional.
 */
function readThrough(
  container: CelValue,
  key: CelValue,
  optionalForm: boolean,
  range: SourceRange,
): CelValue {
  if (isCelOptional(container)) {
    if (!container.present) return celNone();
    return optionalRead(container.held as CelValue, key, range);
  }
  if (optionalForm) return optionalRead(container, key, range);
  // **A member read is a door a host value comes through**, and the value it answers is
  // whatever the host put inside its own object: `read` is what refuses a thenable there,
  // rather than the aggregate, the operator or the exit that happens to see it next.
  return read(celRead(container, key, range), range);
}

function optionalRead(container: CelValue, key: CelValue, range: SourceRange): CelValue {
  const found = celLookup(container, key);
  if (typeof found !== "symbol") {
    const held = read(found, range);
    // A value that must be awaited is refused rather than carried as a present optional.
    return isCelError(held) ? held : celSome(held);
  }
  if (found === MISSING || found === OUT_OF_RANGE) return celNone();
  return lookupError(found, key, range);
}

/**
 * The dotted chain a select spells, when every step is a plain named member of a **free**
 * name. A name a macro bound is a value, so a chain rooted at one is an ordinary member
 * read — the same rule the checker applies.
 */
function plainChain(node: CelSelectNode, scope: Binding | undefined): readonly string[] | undefined {
  const segments: string[] = [];
  let at: CelNode = node;
  while (at.kind === "select") {
    if (at.optional || at.field === "") return undefined;
    segments.unshift(at.field);
    at = at.operand;
  }
  if (at.kind !== "ident") return undefined;
  if (!at.absolute && boundSlot(scope, at.name) !== undefined) return undefined;
  segments.unshift(at.name);
  return segments;
}

/**
 * The type of a value, for dispatch. A container's element type is `dyn`: reading it
 * exactly would mean walking the data on every call, and the registry's loose pass
 * resolves a parameterized overload against `dyn` anyway.
 */
function runtimeType(value: CelValue, nominalArity: (name: string) => number | undefined): CelType {
  const name = celTypeNameOf(value);
  switch (name) {
    case "int":
      return INT;
    case "uint":
      return UINT;
    case "double":
      return DOUBLE;
    case "bool":
      return BOOL;
    case "string":
      return STRING;
    case "bytes":
      return BYTES;
    case "null_type":
      return NULL;
    case "type":
      return TYPE;
    case "google.protobuf.Timestamp":
      return TIMESTAMP;
    case "google.protobuf.Duration":
      return DURATION;
    case "list":
      return listOf(DYN);
    case "map":
      return mapOf(DYN, DYN);
    case "optional":
      return optionalOf(DYN);
    default: {
      const arity = nominalArity(name!) ?? 0;
      return { kind: "nominal", name: name!, base: DYN, args: Array.from({ length: arity }, () => DYN) };
    }
  }
}
