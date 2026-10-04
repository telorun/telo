/**
 * What a backend does at each kind of site — once, for both of them.
 *
 * `runtime-library.ts` holds what every operator and standard function **does**. This
 * holds everything *around* a call: admitting a host value, reading a member in every
 * form, taking a bool operand, reading a name or a dotted chain, and the per-call-site
 * overload dispatch with its bounded cache. None of it is a tree walk and none of it is an
 * operator, which is exactly why it cannot live in a backend: the closure backend compiles
 * a tree to closures and the emitter compiles the same tree to JavaScript source, and both
 * call *these* functions. A second copy of the dispatch rule or the member-read rule is a
 * second set of answers, and the whole point of two backends over one runtime is that
 * there is one answer per operation.
 *
 * So the emitter emits a call to `readThrough` and never a bare `obj.name`; it emits a
 * `CallSite` per call and never its own overload search; and a thenable is refused at the
 * same doors on both backends because the doors are here.
 */

import type { CelActivation } from "./activation.js";
import { activationHolds } from "./activation.js";
import { BoundedCache } from "./bounded-cache.js";
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
import type { CelError, CelOptional, CelValue } from "./cel-value.js";
import {
  asyncValueRefused,
  CEL_VALUE_TYPE,
  celError,
  celNone,
  celSome,
  celTypeNameOf,
  isCelError,
  isCelOptional,
} from "./cel-value.js";
import type { FunctionRegistry, Resolution, ResolutionFailure } from "./function-registry.js";
import { celHas, celLookup, celRead, lookupAbsence, lookupError } from "./member-read.js";
import type { CelCallContext, CelImplementation } from "./runtime-library.js";
import { implementationOf } from "./runtime-library.js";
import type { CallForm } from "./signature.js";
import type { CelNode, CelSelectNode, SourceRange } from "./syntax-tree.js";

/** A compile-time refusal: a tree neither backend can compile at all. */
export class CelCompileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CelCompileError";
  }
}

/** How many distinct argument-type combinations one call site remembers. */
export const CALL_SITE_CACHE_CAPACITY = 16;

/** What a namespaced call is dispatched through, when something bound it. */
/**
 * A function bound under a namespace. Its arguments arrive as **one array**, where a
 * registered overload's arrive positionally: a namespace declaration may withhold its
 * parameter list entirely, so the count is the host's and not the dispatch key's. That is
 * the whole rule — positional where the key fixes the arity, one array where the author
 * decides it.
 */
export type NamespaceImplementation = (args: readonly CelValue[], ctx: CelCallContext) => CelValue;

export type NamespaceDispatch = (
  namespace: string,
  name: string,
) => NamespaceImplementation | undefined;

export interface EvaluationFrame {
  readonly activation: CelActivation;
  readonly slots: CelValue[];
  /** Absent rather than optional: one frame shape, however the evaluation was started. */
  readonly namespaceFunction: NamespaceDispatch | undefined;
}

/**
 * One evaluation of one expression. The closure backend builds these by composition and
 * the emitter's module returns them already built, so a program is indifferent to which
 * backend produced it.
 */
export type CelStep = (frame: EvaluationFrame) => CelValue;

/** What a backend needs of the environment it compiles against. */
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

// --- host values -----------------------------------------------------------

/**
 * A host value entering the engine — from an activation, from an implementation the host
 * registered, or out of a host value a read reached into. A thenable is refused here rather
 * than carried: an awaiting expression is an invocation in disguise, invisible to a journal
 * and absent from a trace. The refusal itself lives in `cel-value.ts`, so every door answers
 * with the same code and the same wording.
 */
export function readHostValue(value: unknown, range: SourceRange): CelValue {
  return asyncValueRefused(value, range) ?? (value as CelValue);
}

// --- names -----------------------------------------------------------------

/** A bare name: the activation's own entry, then the library's constants. */
export function readName(
  activation: CelActivation,
  constants: ReadonlyMap<string, CelValue>,
  name: string,
  range: SourceRange,
): CelValue {
  if (activationHolds(activation, name)) return readHostValue(activation[name], range);
  const held = constants.get(name);
  if (held !== undefined) return held;
  return celError("no_such_variable", `no such variable: ${name}`, range);
}

/**
 * One name read from the activation (or the library's constants), then its members. This
 * is a chain whose split is already decided — at compile time, over the names the host
 * declared (`declared-chain.ts`) — so evaluating it is one lookup plus member reads.
 */
export function readNameChain(
  activation: CelActivation,
  constants: ReadonlyMap<string, CelValue>,
  name: string,
  rest: readonly string[],
  range: SourceRange,
): CelValue {
  let held: CelValue;
  if (activationHolds(activation, name)) held = readHostValue(activation[name], range);
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

/** One prefix of a dotted chain, and the segments left to read off its value. */
export interface ChainCandidate {
  readonly name: string;
  readonly rest: readonly string[];
}

/** Every prefix of a dotted chain, longest first, with the segments left to read. */
export function prefixCandidates(segments: readonly string[]): readonly ChainCandidate[] {
  const candidates: ChainCandidate[] = [];
  for (let length = segments.length; length >= 1; length -= 1) {
    candidates.push({ name: segments.slice(0, length).join("."), rest: segments.slice(length) });
  }
  return candidates;
}

/**
 * A chain **no** prefix of which the host declared: the activation is searched, longest
 * prefix first. Every conformance row that binds a dotted key reads this way, and the
 * checker has no opinion about such a chain either.
 */
export function searchNameChain(
  activation: CelActivation,
  constants: ReadonlyMap<string, CelValue>,
  candidates: readonly ChainCandidate[],
  written: string,
  range: SourceRange,
): CelValue {
  for (let at = 0; at < candidates.length; at += 1) {
    const candidate = candidates[at]!;
    if (!activationHolds(activation, candidate.name) && !constants.has(candidate.name)) continue;
    return readNameChain(activation, constants, candidate.name, candidate.rest, range);
  }
  return celError("no_such_variable", `no such variable: ${written}`, range);
}

/**
 * The dotted chain a select spells, when every step is a plain named member of a **free**
 * name. A name a macro bound is a value, so a chain rooted at one is an ordinary member
 * read — the same rule the checker applies, and the same answer both backends compile.
 */
export function plainMemberChain(
  node: CelSelectNode,
  bound: (name: string) => boolean,
): readonly string[] | undefined {
  const segments: string[] = [];
  let at: CelNode = node;
  while (at.kind === "select") {
    if (at.optional || at.field === "") return undefined;
    segments.unshift(at.field);
    at = at.operand;
  }
  if (at.kind !== "ident") return undefined;
  if (!at.absolute && bound(at.name)) return undefined;
  segments.unshift(at.name);
  return segments;
}

// --- member reads ----------------------------------------------------------

/**
 * A member read in every form. Reading **through an optional** answers an optional
 * whichever form the read is written in, which is what lets a chain over a value that
 * may be absent stay one expression: an absent one propagates as absent, and a key the
 * held value does not have is absent too.
 *
 * Which refusals are absence and which are a mistake is `lookupAbsence`'s, and it turns
 * on the FORM the read is written in rather than on what the operand turned out to be: a
 * presence-shaped read over a value that holds no members is absent, while the ordinary
 * read of a member of such a value is the mistake it is outside an optional too.
 */
export function readThrough(
  container: CelValue,
  key: CelValue,
  optionalForm: boolean,
  range: SourceRange,
): CelValue {
  // The shape nearly every read has — a record's own string-keyed entry — decided by asking
  // what the container is ONCE. The general path below is three total steps, so it reads the
  // type key twice and the prototype again; this asks each question once and falls through
  // to the one seam for every other container, every other key and every refusal.
  if (!optionalForm && typeof key === "string" && typeof container === "object" && container !== null) {
    if ((container as { [CEL_VALUE_TYPE]?: unknown })[CEL_VALUE_TYPE] === undefined) {
      const prototype = Object.getPrototypeOf(container) as object | null;
      if (
        (prototype === Object.prototype || prototype === null) &&
        Object.prototype.hasOwnProperty.call(container, key)
      ) {
        const held = (container as Record<string, CelValue>)[key] as CelValue;
        // The thenable door, inline: `readHostValue` is this test and nothing else.
        if (typeof held !== "object" || held === null || typeof (held as { then?: unknown }).then !== "function") {
          return held;
        }
      }
    }
  }
  if (isCelOptional(container)) {
    if (!container.present) return celNone();
    return optionalRead(container.held as CelValue, key, optionalForm, range);
  }
  if (optionalForm) return optionalRead(container, key, true, range);
  // **A member read is a door a host value comes through**, and the value it answers is
  // whatever the host put inside its own object: `readHostValue` is what refuses a thenable
  // there, rather than the aggregate, the operator or the exit that happens to see it next.
  return readHostValue(celRead(container, key, range), range);
}

/**
 * A read that answers an optional. `presence` is whether the read was WRITTEN in a
 * presence-shaped form (`.?`, `[?]`), which is what decides whether a value holding no
 * members is absence or a mistake.
 */
function optionalRead(
  container: CelValue,
  key: CelValue,
  presence: boolean,
  range: SourceRange,
): CelValue {
  const found = celLookup(container, key);
  if (typeof found !== "symbol") {
    const held = readHostValue(found, range);
    // A value that must be awaited is refused rather than carried as a present optional.
    return isCelError(held) ? held : celSome(held);
  }
  if (lookupAbsence(found, presence)) return celNone();
  return lookupError(found, key, range);
}

/**
 * `has(a.b)` — presence, which a missing key and a value that holds no members both
 * answer `false` for rather than erroring. An absent optional has no members, and a
 * present one is asked about what it holds.
 */
export function hasMember(container: CelValue, field: CelValue, range: SourceRange): CelValue {
  if (isCelOptional(container)) {
    return container.present ? celHas(container.held as CelValue, field, range) : false;
  }
  return celHas(container, field, range);
}

// --- operands --------------------------------------------------------------

/** A bool operand, or the error it is — a non-bool is a mistake of its own. */
export function boolOperand(value: CelValue, range: SourceRange): boolean | CelError {
  if (typeof value === "boolean") return value;
  if (isCelError(value)) return value;
  return celError("no_matching_overload", "this value is not a bool", range);
}

/** What an optional entry of an aggregate contributes, or the error it is not one. */
export function optionalEntry(value: CelValue, range: SourceRange): CelOptional | CelError {
  if (isCelOptional(value)) return value;
  return celError("no_matching_overload", "an entry written with '?' holds an optional", range);
}

// --- one call site ---------------------------------------------------------

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

/** The universal equality, for a pair of types no registration names. */
function equalityFallback(name: string): CelImplementation | null {
  if (name !== "==" && name !== "!=") return null;
  return implementationOf({ name, form: "global", parameters: [], returns: DYN }) ?? null;
}

/**
 * One call site, and the overloads it has resolved.
 *
 * **Overloads are resolved on the values' own types**, per site: `dyn(1.0) == 1` checks and
 * must then answer across the numeric types, so the statically resolved signature is not
 * enough. A site is almost always monomorphic, so the last resolution is held beside a
 * bounded cache and reached by comparing the type names themselves — building a cache key
 * per call is the allocation that costs most on the hottest path there is. A container's
 * element type is read as `dyn` rather than walked, so dispatch does not get more expensive
 * as the data gets larger.
 *
 * The arguments arrive **already evaluated and already free of errors**: carrying an
 * error-valued operand out is the caller's, because only the caller knows how far it got.
 */
export class CallSite {
  private readonly resolved = new BoundedCache<string, Dispatch | null>(CALL_SITE_CACHE_CAPACITY);
  private readonly context: CelCallContext;
  /** The arity the last resolution was made under; `-1` until there is one. */
  private count = -1;
  private t0: string | undefined;
  private t1: string | undefined;
  private t2: string | undefined;
  private t3: string | undefined;
  private lastDispatch: Dispatch | null = null;

  constructor(
    private readonly name: string,
    private readonly form: CallForm,
    private readonly range: SourceRange,
    private readonly registry: FunctionRegistry,
    private readonly nominalArity: (name: string) => number | undefined,
  ) {
    this.context = { range };
  }

  call0(): CelValue {
    if (this.count === 0) return this.answer(this.lastDispatch);
    return this.resolve(0, undefined, undefined, undefined, undefined);
  }

  call1(a: CelValue): CelValue {
    if (this.count === 1 && celTypeNameOf(a) === this.t0) return this.answer(this.lastDispatch, a);
    return this.resolve(1, a, undefined, undefined, undefined);
  }

  call2(a: CelValue, b: CelValue): CelValue {
    if (this.count === 2 && celTypeNameOf(a) === this.t0 && celTypeNameOf(b) === this.t1) {
      return this.answer(this.lastDispatch, a, b);
    }
    return this.resolve(2, a, b, undefined, undefined);
  }

  call3(a: CelValue, b: CelValue, c: CelValue): CelValue {
    if (
      this.count === 3 &&
      celTypeNameOf(a) === this.t0 &&
      celTypeNameOf(b) === this.t1 &&
      celTypeNameOf(c) === this.t2
    ) {
      return this.answer(this.lastDispatch, a, b, c);
    }
    return this.resolve(3, a, b, c, undefined);
  }

  call4(a: CelValue, b: CelValue, c: CelValue, d: CelValue): CelValue {
    if (
      this.count === 4 &&
      celTypeNameOf(a) === this.t0 &&
      celTypeNameOf(b) === this.t1 &&
      celTypeNameOf(c) === this.t2 &&
      celTypeNameOf(d) === this.t3
    ) {
      return this.answer(this.lastDispatch, a, b, c, d);
    }
    return this.resolve(4, a, b, c, d);
  }

  /**
   * The array form, for a caller that holds its arguments as one — a call written WIDER than
   * any overload can be (`'42'.replace('2', '1', 1, false)` is five values, which is a row),
   * the conformance and identity gates, and a host comparing a site cold against warm. It
   * routes to the same entry points, so there is one dispatch path and not two.
   */
  call(values: readonly CelValue[]): CelValue {
    switch (values.length) {
      case 0:
        return this.call0();
      case 1:
        return this.call1(values[0]!);
      case 2:
        return this.call2(values[0]!, values[1]!);
      case 3:
        return this.call3(values[0]!, values[1]!, values[2]!);
      case 4:
        return this.call4(values[0]!, values[1]!, values[2]!, values[3]!);
      default:
        return this.wide(values);
    }
  }

  /**
   * A call written with more values than the widest signature may declare. **The arity is
   * the SOURCE's, not the dispatch key's** — anyone may write a call of any width — so this
   * is reachable and answers the ordinary refusal, naming the types it was handed. Nothing
   * resolves here, because a signature that wide is refused where it is registered; the
   * resolution still runs, so one place decides what a call that resolves to nothing says.
   */
  private wide(values: readonly CelValue[]): CelValue {
    const names: string[] = new Array<string>(values.length);
    for (let at = 0; at < values.length; at += 1) {
      const held = celTypeNameOf(values[at]);
      if (held === undefined) {
        const named = readHostValue(values[at], this.range);
        if (isCelError(named)) return named;
        return celError(
          "no_matching_overload",
          `${this.name} was handed a value of no CEL type`,
          this.range,
        );
      }
      names[at] = held;
    }
    return celError(
      "no_matching_overload",
      `no overload of ${JSON.stringify(this.name)} takes (${names.join(", ")})`,
      this.range,
    );
  }

  private resolve(
    count: number,
    a: CelValue | undefined,
    b: CelValue | undefined,
    c: CelValue | undefined,
    d: CelValue | undefined,
  ): CelValue {
    const names: string[] = new Array<string>(count);
    for (let at = 0; at < count; at += 1) {
      const value = at === 0 ? a : at === 1 ? b : at === 2 ? c : d;
      const held = celTypeNameOf(value);
      if (held === undefined) {
        // A value of no CEL type. A **thenable** is one, and a thenable NESTED inside a host
        // value arrives here rather than through the activation read, because a member read
        // hands back what the host put there — and `resources.x.status.y` is exactly that
        // shape, so this is the door a host actually uses. `readHostValue` names it for what
        // it is; anything else is the overload failure it was going to be. The cost is on the
        // slow path only: dispatch was about to fail either way.
        const named = readHostValue(value, this.range);
        if (isCelError(named)) return named;
        return celError(
          "no_matching_overload",
          `${this.name} was handed a value of no CEL type`,
          this.range,
        );
      }
      names[at] = held;
    }
    const key = names.join(",");
    let dispatch = this.resolved.get(key);
    if (dispatch === undefined) {
      const types = names.map((unused, at) =>
        runtimeType((at === 0 ? a : at === 1 ? b : at === 2 ? c : d) as CelValue, this.nominalArity),
      );
      const resolution = this.registry.resolve(
        this.name,
        this.form,
        this.form === "receiver" ? types.slice(1) : types,
        this.form === "receiver" ? types[0] : undefined,
      );
      dispatch = dispatchOf(this.name, resolution);
      this.resolved.set(key, dispatch);
    }
    this.count = count;
    this.t0 = names[0];
    this.t1 = names[1];
    this.t2 = names[2];
    this.t3 = names[3];
    this.lastDispatch = dispatch;
    return this.answer(dispatch, a, b, c, d);
  }

  private answer(
    dispatch: Dispatch | null,
    a?: CelValue,
    b?: CelValue,
    c?: CelValue,
    d?: CelValue,
  ): CelValue {
    if (!dispatch) {
      const names = [this.t0, this.t1, this.t2, this.t3].slice(0, Math.max(this.count, 0));
      return celError(
        "no_matching_overload",
        `no overload of ${JSON.stringify(this.name)} takes (${names.join(", ")})`,
        this.range,
      );
    }
    const value = dispatch.implementation(this.context, a, b, c, d);
    return dispatch.foreign ? readHostValue(value, this.range) : value;
  }
}

/** A call site over an environment, which both backends build one of per call. */
export function callSiteOf(
  target: CompileTarget,
  name: string,
  form: CallForm,
  range: SourceRange,
): CallSite {
  return new CallSite(name, form, range, target.registry, target.nominalArity);
}

/**
 * The type of a value, for dispatch. A container's element type is `dyn`: reading it
 * exactly would mean walking the data on every call, and the registry's loose pass
 * resolves a parameterized overload against `dyn` anyway.
 */
export function runtimeType(
  value: CelValue,
  nominalArity: (name: string) => number | undefined,
): CelType {
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
