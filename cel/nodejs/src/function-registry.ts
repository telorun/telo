/**
 * Which functions an environment has, and which one a call resolves to.
 *
 * **Nothing here is privileged.** The standard library registers through exactly this
 * surface, so a host can replace one of its signatures or remove it — the capability
 * the whole package exists for. Registration is last-wins by dispatch key
 * (`signature.ts`), removal is by the same key, and both are per environment: a
 * clone inherits and may then diverge without touching its parent.
 *
 * **Resolution answers WHY it failed**, never just "no". A call on a name nothing
 * registers, a call written in the wrong form, and a call whose arguments no overload
 * takes are three different mistakes with three different repairs, and the engine
 * being replaced reported one sentence for all three — which is why a separate
 * classifier had to re-derive the cause after the fact. The checker decides it here,
 * once, with the candidates it considered.
 */

import { CelEngineError } from "./check-diagnostic.js";
import type { CelType } from "./cel-type.js";
import { assignable, DYN, formatType, isDyn, typesEqual } from "./cel-type.js";
import type { CallForm, CelSignature, FunctionMetadata } from "./signature.js";
import { formatSignature, signatureKey } from "./signature.js";
import { CALL_SITE_DIRECT_ARITY } from "./runtime-library.js";
import { isIdentifierSpelling, isReservedWord } from "./reserved-words.js";

export interface RegisteredFunction {
  readonly signature: CelSignature;
  readonly metadata: FunctionMetadata;
}

export type ResolutionFailure =
  /** No function of that name is registered, in any form. */
  | { readonly reason: "unknown"; readonly candidates: readonly RegisteredFunction[] }
  /** The name is registered, but only in the other call form. */
  | { readonly reason: "wrong-form"; readonly candidates: readonly RegisteredFunction[] }
  /** The name and form are registered; no overload takes these arguments. */
  | { readonly reason: "no-overload"; readonly candidates: readonly RegisteredFunction[] };

/**
 * How many names a refused call may name as candidates.
 *
 * It is **declared** rather than left to a message's taste, because the conformance
 * vectors pin that message byte for byte: a bound and an order a second engine cannot
 * reproduce would be a row no port can pass. The order is edit distance then name, both
 * over the name exactly as it was written.
 */
export const UNKNOWN_FUNCTION_CANDIDATES = 5;

export interface Resolution {
  readonly resolved: RegisteredFunction;
  /** The return type with every type parameter substituted by what this call bound. */
  readonly returns: CelType;
}

export class FunctionRegistry {
  private readonly byName: Map<string, RegisteredFunction[]>;

  constructor(inherited?: FunctionRegistry) {
    this.byName = new Map();
    if (inherited) {
      for (const [name, entries] of inherited.byName) this.byName.set(name, [...entries]);
    }
  }

  /** Registers a function, replacing any registration answering the same call. */
  register(signature: CelSignature, metadata: FunctionMetadata = {}): void {
    // An implementation receives its arguments positionally, up to the bound, so a wider
    // signature is refused HERE rather than resolved and then called with its tail dropped.
    // A declared bound nothing enforces is the silent wrong answer it exists to prevent.
    const arity = signature.parameters.length + (signature.form === "receiver" ? 1 : 0);
    if (arity > CALL_SITE_DIRECT_ARITY) {
      throw new CelEngineError(
        "signature_too_wide",
        `${formatSignature(signature)} takes ${arity} values and an implementation receives at most ${CALL_SITE_DIRECT_ARITY}`,
      );
    }
    const entries = this.byName.get(signature.name) ?? [];
    const key = signatureKey(signature);
    const at = entries.findIndex((entry) => signatureKey(entry.signature) === key);
    const entry: RegisteredFunction = { signature, metadata };
    if (at === -1) entries.push(entry);
    else entries[at] = entry;
    this.byName.set(signature.name, entries);
  }

  /** Removes the one registration answering that call. Answers whether it was there. */
  remove(signature: CelSignature): boolean {
    const entries = this.byName.get(signature.name);
    if (!entries) return false;
    const key = signatureKey(signature);
    const at = entries.findIndex((entry) => signatureKey(entry.signature) === key);
    if (at === -1) return false;
    entries.splice(at, 1);
    if (entries.length === 0) this.byName.delete(signature.name);
    return true;
  }

  /** Removes every registration of a name. Answers how many went. */
  removeName(name: string): number {
    const entries = this.byName.get(name);
    if (!entries) return 0;
    this.byName.delete(name);
    return entries.length;
  }

  has(name: string): boolean {
    return this.byName.has(name);
  }

  /** Every registration, in name order then registration order. */
  list(): readonly RegisteredFunction[] {
    return [...this.byName.keys()].sort().flatMap((name) => this.byName.get(name)!);
  }

  named(name: string): readonly RegisteredFunction[] {
    return this.byName.get(name) ?? [];
  }

  /**
   * The names this environment registers that would accept a call of that form and
   * arity, nearest first — what a call on a name nothing registers is offered instead.
   *
   * **Form and arity are a filter rather than a ranking**, because a nearer name a call
   * cannot be written on is not a repair: `'a'.size()` is not helped by `size`. A name
   * that is not a name is filtered for the same reason — the operators register under
   * their own symbols (`!`, `-`, `+`), and `no(1)` offered `!` and `-` as its two
   * nearest spellings, neither of which can be written as a call at all. Among what
   * passes the filter the order is edit distance then name, and the list is cut at
   * {@link UNKNOWN_FUNCTION_CANDIDATES} — a declared bound and a declared order, so the
   * message is the same text on every engine. Distance is counted over the name as
   * written, with no case folding: a port reproduces one rule and not a host language's
   * notion of lower case.
   */
  candidateNames(wanted: string, form: CallForm, arity: number): readonly string[] {
    const matching: string[] = [];
    for (const [name, entries] of this.byName) {
      if (name === wanted) continue;
      if (!isIdentifierSpelling(name) || isReservedWord(name)) continue;
      const accepts = entries.some(
        (entry) => entry.signature.form === form && entry.signature.parameters.length === arity,
      );
      if (accepts) matching.push(name);
    }
    return matching
      .map((name) => ({ name, distance: editDistance(wanted, name) }))
      .sort((left, right) => left.distance - right.distance || compareNames(left.name, right.name))
      .slice(0, UNKNOWN_FUNCTION_CANDIDATES)
      .map((candidate) => candidate.name);
  }

  /**
   * The function a call resolves to. `receiver` is the type the call is written on,
   * absent for a global call.
   */
  resolve(
    name: string,
    form: CallForm,
    args: readonly CelType[],
    receiver?: CelType,
  ): Resolution | ResolutionFailure {
    const all = this.byName.get(name);
    if (!all || all.length === 0) return { reason: "unknown", candidates: [] };
    const inForm = all.filter((entry) => entry.signature.form === form);
    if (inForm.length === 0) return { reason: "wrong-form", candidates: all };

    const arity = inForm.filter((entry) => entry.signature.parameters.length === args.length);
    const viable = arity.length === 0 ? inForm : arity;
    // Exact first, then a candidate `dyn` makes viable, which is what keeps an
    // unlisted variable from turning one mistake into two.
    const exact = this.match(viable, args, receiver, false);
    if (exact) return exact;
    const loose = this.matchLoosely(viable, args, receiver);
    if (loose) return loose;
    return { reason: "no-overload", candidates: inForm };
  }

  /**
   * The loose pass: a `dyn` argument makes a candidate viable, and **where several become
   * viable and they do not agree on a return type, the call answers `dyn`.**
   *
   * Taking the first one instead is a concrete type nothing established. `dyn('a') +
   * dyn('b')` answered `int` — the first `+` overload — so a host that declares nothing
   * about a name had `a + b` typed `int`, and a consumer comparing that against a declared
   * `string` slot refused a manifest that runs correctly. The honest answer is the one the
   * engine's own design already states: overloads are resolved per call site on the VALUES'
   * own types, so a `dyn` operand is exactly the case where the static answer is unknown.
   *
   * The candidate is still carried for the caller that wants one (a listing, a flag), and a
   * single viable overload still answers its own return type — `dyn` only where they differ.
   */
  private matchLoosely(
    candidates: readonly RegisteredFunction[],
    args: readonly CelType[],
    receiver: CelType | undefined,
  ): Resolution | undefined {
    const viable: Resolution[] = [];
    for (const candidate of candidates) {
      const held = this.match([candidate], args, receiver, true);
      if (held) viable.push(held);
    }
    const first = viable[0];
    if (!first) return undefined;
    const agree = viable.every((held) => typesEqual(held.returns, first.returns));
    return agree ? first : { resolved: first.resolved, returns: DYN };
  }

  private match(
    candidates: readonly RegisteredFunction[],
    args: readonly CelType[],
    receiver: CelType | undefined,
    allowDyn: boolean,
  ): Resolution | undefined {
    for (const candidate of candidates) {
      const { signature } = candidate;
      if (signature.parameters.length !== args.length) continue;
      const bindings = new Map<string, CelType>();
      if (signature.receiver && !this.fits(receiver ?? DYN, signature.receiver, bindings, allowDyn)) continue;
      if (!signature.parameters.every((want, at) => this.fits(args[at]!, want, bindings, allowDyn))) continue;
      return { resolved: candidate, returns: substitute(signature.returns, bindings) };
    }
    return undefined;
  }

  /**
   * Whether an argument fits a parameter, binding type parameters as it goes.
   *
   * **A type parameter is bound by the first argument that mentions it**, and a later
   * argument does not refine it: `[] + [3, 4]` is `list<T>`, because the empty list
   * fixed the element type as "unknown" and the second argument cannot retroactively
   * decide what the first one held.
   */
  private fits(
    argument: CelType,
    parameter: CelType,
    bindings: Map<string, CelType>,
    allowDyn: boolean,
  ): boolean {
    if (parameter.kind === "parameter") {
      const bound = bindings.get(parameter.name);
      if (!bound) {
        bindings.set(parameter.name, argument);
        return true;
      }
      // A binding that holds an unresolved parameter holds no information, so a later
      // concrete argument refines it: `optional.none().orValue(42)` is an int.
      if (bound.kind === "parameter" && argument.kind !== "parameter") {
        bindings.set(parameter.name, argument);
        return true;
      }
      if (bound.kind === "parameter" || argument.kind === "parameter") return true;
      return assignable(argument, bound) || (allowDyn && (isDyn(argument) || isDyn(bound)));
    }
    if (parameter.kind === "list" && argument.kind === "list") {
      return this.fits(argument.element, parameter.element, bindings, allowDyn);
    }
    if (parameter.kind === "map" && argument.kind === "map") {
      return (
        this.fits(argument.key, parameter.key, bindings, allowDyn) &&
        this.fits(argument.value, parameter.value, bindings, allowDyn)
      );
    }
    if (parameter.kind === "optional" && argument.kind === "optional") {
      return this.fits(argument.value, parameter.value, bindings, allowDyn);
    }
    if (
      parameter.kind === "nominal" &&
      argument.kind === "nominal" &&
      parameter.name === argument.name &&
      parameter.args.length === argument.args.length
    ) {
      // A named type's arguments are invariant, so they fit one for one — which is also
      // where a signature written over `Self` binds its own type parameters.
      return parameter.args.every((want, at) => this.fits(argument.args[at]!, want, bindings, allowDyn));
    }
    if (isDyn(argument)) return allowDyn || isDyn(parameter);
    return assignable(argument, parameter);
  }
}

/** The type with every bound parameter replaced; an unbound one stays as it is. */
export function substitute(type: CelType, bindings: ReadonlyMap<string, CelType>): CelType {
  switch (type.kind) {
    case "parameter":
      return bindings.get(type.name) ?? type;
    case "list": {
      const element = substitute(type.element, bindings);
      return element === type.element ? type : { kind: "list", element };
    }
    case "map": {
      const key = substitute(type.key, bindings);
      const value = substitute(type.value, bindings);
      return key === type.key && value === type.value ? type : { kind: "map", key, value };
    }
    case "optional": {
      const value = substitute(type.value, bindings);
      return value === type.value ? type : { kind: "optional", value };
    }
    case "nominal": {
      const args = type.args.map((argument) => substitute(argument, bindings));
      return args.every((argument, at) => argument === type.args[at]) ? type : { ...type, args };
    }
    default:
      return type;
  }
}

/** Code-unit order, so a port orders two names without a locale. */
function compareNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Levenshtein distance in UTF-16 code units — one insertion, deletion or substitution
 * each costing one, which is the whole rule a port needs to reproduce.
 *
 * Code units rather than code points for the same reason every range in this package is
 * in them: it is the one unit both ends of the engine already count in, and a name is
 * compared against a name rather than cut.
 */
function editDistance(from: string, to: string): number {
  let previous = Array.from({ length: to.length + 1 }, (ignored, at) => at);
  for (let left = 1; left <= from.length; left += 1) {
    const row = new Array<number>(to.length + 1);
    row[0] = left;
    for (let right = 1; right <= to.length; right += 1) {
      const substitution = previous[right - 1]! + (from[left - 1] === to[right - 1] ? 0 : 1);
      row[right] = Math.min(substitution, previous[right]! + 1, row[right - 1]! + 1);
    }
    previous = row;
  }
  return previous[to.length]!;
}

/** How a resolution failure names what it looked at, for a message a human reads. */
export function describeCandidates(candidates: readonly RegisteredFunction[]): string {
  return candidates.map((candidate) => formatSignature(candidate.signature)).join(", ");
}

export function describeArguments(args: readonly CelType[]): string {
  return args.map((type) => formatType(type)).join(", ");
}
