/**
 * The activation: the values an expression reads names from.
 *
 * Two rules, both of which the checker already applies to types, so the evaluator must
 * apply them to values or `telo check` and the runtime disagree:
 *
 * - **A dotted declaration is one name, and the longest one wins.** A host may hold
 *   `a.b.c`, or `a.b` holding a map, or both; `a.b.c` reads the entry of that name where
 *   it is held and the map's entry where only `a.b` is. So resolution tries the longest
 *   prefix first, exactly as `qualifiedVariableType` does at check.
 * - **A read is an OWN entry**, never an inherited one, so an activation whose prototype
 *   is `Object.prototype` cannot answer `constructor` or `toString`.
 *
 * A name nothing holds is `no_such_variable` — the error value, so it short-circuits like
 * any other. A value read from here is a HOST's, so it is admitted through the backend's
 * one entry point for a host value, which is where a thenable is refused.
 */



/** What a host binds names to. A value is read through the guard below, never trusted. */
export interface CelActivation {
  readonly [name: string]: unknown;
}

/**
 * Whether the activation holds a name itself. The backend asks this for each prefix of a
 * dotted chain, longest first, having built the prefixes once at compile time.
 */
export function activationHolds(activation: CelActivation, name: string): boolean {
  return Object.prototype.hasOwnProperty.call(activation, name);
}
