/**
 * The closure backend: a tree compiled into nested closures, with **no `eval`, no
 * `new Function` and no disk**.
 *
 * Everything an expression's shape decides is decided once, at compile time — which name
 * is a bound slot, which select is a dotted activation read, which call is a macro — so
 * evaluating is calling closures over a frame. Semantics are not here: every operator and
 * function is the runtime library's (`runtime-library.ts`), every comprehension is
 * `comprehension-runtime.ts`, every member read, name read and call-site dispatch is
 * `backend-runtime.ts`. The emitter (`js-emitter.ts`) emits calls into exactly those, which
 * is the only way two backends can be held to one answer.
 */

import { celMapFromEntries } from "./cel-map-value.js";
import { splitDeclaredChain } from "./declared-chain.js";
import type { CelValue } from "./cel-value.js";
import {
  celError,
  asyncValueRefused,
  celNone,
  celSome,
  celUint,
  isCelError,
  isCelOptional,
  literalValue,
} from "./cel-value.js";
import {
  celAll,
  celExists,
  celExistsOne,
  celFilter,
  celMapComprehension,
} from "./comprehension-runtime.js";
import { namespaceMacroBinding, receiverMacroBinding } from "./comprehension-bindings.js";
import { isMacroCall } from "./macro-check.js";
import { celIterable } from "./member-read.js";
import type { CelStep, CompileTarget } from "./backend-runtime.js";
import {
  boolOperand,
  callSiteOf,
  CelCompileError,
  plainMemberChain,
  hasMember,
  optionalEntry,
  prefixCandidates,
  readHostValue,
  readName,
  readNameChain,
  readThrough,
  searchNameChain,
} from "./backend-runtime.js";
import { optionalOfNonZero } from "./runtime-library.js";
import type { CallForm } from "./signature.js";
import type { CelNode, CelSelectNode, SourceRange } from "./syntax-tree.js";

export interface CompiledTree {
  readonly step: CelStep;
  /** How many binding slots a frame needs. */
  readonly slots: number;
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
    return (frame) => readName(frame.activation, constants, name, range);
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
      return (frame) => readNameChain(frame.activation, constants, name, rest, range);
    }
    // Nothing declares a prefix of this chain, so there is nothing to split it on and the
    // checker has no opinion either: the activation is searched, longest prefix first. Every
    // conformance row that binds a dotted key reads this way.
    const candidates = prefixCandidates(segments);
    const written = segments.join(".");
    return (frame) => searchNameChain(frame.activation, constants, candidates, written, range);
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
    const chain = plainMemberChain(node, (name) => boundSlot(scope, name) !== undefined);
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
      const a = boolOperand(left(frame), range);
      if (a === decided) return decided;
      const b = boolOperand(right(frame), range);
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
      const held = boolOperand(condition(frame), range);
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
   * One dispatch: evaluate the arguments, carry the first error out, then hand the values
   * to the site, which resolves the overload on their own types.
   */
  private callStep(name: string, form: CallForm, args: readonly CelStep[], range: SourceRange): CelStep {
    const site = callSiteOf(this.target, name, form, range);
    const count = args.length;
    return (frame) => {
      const values: CelValue[] = new Array<CelValue>(count);
      for (let at = 0; at < count; at += 1) {
        const value = args[at]!(frame);
        if (isCelError(value)) return value;
        values[at] = value;
      }
      return site.call(values);
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
      return readHostValue(implementation(values, { range }), range);
    };
  }

  // --- macros -------------------------------------------------------------

  /**
   * Lowering a macro. There is no comprehension node to lower *to*: the macro's meaning
   * is a call into the comprehension runtime with the body as a closure, which is the
   * same shape the emitter produces.
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
      return hasMember(held, field, range);
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
