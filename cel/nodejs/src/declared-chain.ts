/**
 * Splitting a dotted chain over the names a host DECLARED — once, for both halves.
 *
 * A host may declare `a.b.c`, or `a.b` holding a map, or both. `a.b.c` then reads the
 * variable of that name where it is declared and the map's entry where only `a.b` is, so the
 * host's own naming decides rather than the shape of the expression: the **longest declared
 * prefix wins**.
 *
 * The checker and the backend ask the same question of the same declarations, so they ask it
 * here. Two readers would be two answers to "which name is this chain", and the pair that
 * disagrees is the worst kind: `telo check` types one name while evaluation reads another, and
 * nothing says so. Splitting at compile time also means a declared chain costs **one**
 * activation read at evaluation rather than a search over its prefixes.
 *
 * A chain **no prefix of which** is declared — the root included — is left alone: there is
 * nothing to split it on, and the checker has no opinion about it either. The backend then
 * searches the activation at evaluation, which is what every conformance row binding a dotted
 * key relies on. Where any prefix IS declared the search never runs, so a key the host did not
 * declare can never win over a name it did.
 */

/** Where a chain splits: the declared name, and the members read off its value. */
export interface DeclaredChain {
  readonly name: string;
  readonly rest: readonly string[];
}

/**
 * The longest declared prefix of a chain, or nothing when no declaration covers one.
 *
 * **The root counts as a prefix**, and leaving it out was the disagreement this function
 * exists to prevent: with a chain whose root alone is declared treated as undeclared, the
 * backend fell into the activation prefix search, and an activation holding both `a` and the
 * key `"a.b"` answered the undeclared key where the checker had typed the declared name.
 */
export function splitDeclaredChain(
  segments: readonly string[],
  declared: (name: string) => boolean,
): DeclaredChain | undefined {
  for (let length = segments.length; length >= 1; length -= 1) {
    const name = segments.slice(0, length).join(".");
    if (declared(name)) return { name, rest: segments.slice(length) };
  }
  return undefined;
}
