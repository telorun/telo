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

import type { CelType } from "./cel-type.js";
import { assignable, DYN, formatType, isDyn } from "./cel-type.js";
import type { CallForm, CelSignature, FunctionMetadata } from "./signature.js";
import { formatSignature, signatureKey } from "./signature.js";

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
    const loose = this.match(viable, args, receiver, true);
    if (loose) return loose;
    return { reason: "no-overload", candidates: inForm };
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

/** How a resolution failure names what it looked at, for a message a human reads. */
export function describeCandidates(candidates: readonly RegisteredFunction[]): string {
  return candidates.map((candidate) => formatSignature(candidate.signature)).join(", ");
}

export function describeArguments(args: readonly CelType[]): string {
  return args.map((type) => formatType(type)).join(", ");
}
