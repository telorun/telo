/**
 * What a failed `anyOf` / `oneOf` reports, decided from the STATE of each of
 * its branches — never from the findings' depth or count.
 *
 * A branch is validated on its own (`schema-findings-judge.ts`) and judged to
 * one of five states:
 *
 * - `valid` — nothing stands against the value;
 * - `type-refused` — the branch is no CANDIDATE: its own schema refuses the
 *   value's JSON type at the union's node (`union-tags.ts`);
 * - `failing` — a candidate that accepts the value's shape at the union's node
 *   and refuses something further in;
 * - `shape-refused` — a candidate a shape keyword (`required`,
 *   `additionalProperties`) refuses at the union's node itself, or a `const` /
 *   `enum` refuses at one of the union's SELECTORS: a required member one
 *   step below the node that a candidate constrains without every candidate
 *   doing so (`union-tags.ts`);
 * - `tag-refused` — a candidate a `const` / `enum` refuses at one of the
 *   union's TAGS, at the places listed.
 *
 * The outcome is a function of the states alone, so a caller holding a state
 * per branch — however it got them — decides the same verdict.
 */

export type BranchState =
  | { readonly state: "valid" }
  | { readonly state: "failing" }
  | { readonly state: "shape-refused" }
  | { readonly state: "type-refused" }
  /** `at` — every tag a `const` / `enum` refused the value at, as JSON
   *  Pointers, in the order the branch raised them. */
  | { readonly state: "tag-refused"; readonly at: readonly string[] };

export type UnionOutcome =
  /** The union holds. */
  | { readonly kind: "pass" }
  /** A `oneOf` several branches match: the union's own finding. */
  | { readonly kind: "ambiguous" }
  /** The findings of these branches, in declaration order: the one branch
   *  accepting the tag every other refuses, or every `failing` branch. */
  | { readonly kind: "branches"; readonly branches: readonly number[] }
  /** Every branch refuses the tag at `at`: one finding there listing what
   *  these branches allow. */
  | { readonly kind: "tag"; readonly at: string; readonly branches: readonly number[] }
  /** No branch is a reading of the value: one finding at the union's node
   *  listing the alternatives. */
  | { readonly kind: "alternatives" };

/**
 * The verdict of a union over its branches' states, in declaration order.
 *
 * 1. `anyOf`: a `valid` branch → pass. `oneOf`: exactly one → pass; several →
 *    ambiguous.
 * 2. When some candidate is `tag-refused`: exactly one candidate accepting the
 *    tag → that branch; none accepting, and a tag every candidate refuses → the
 *    tag finding there; several accepting → the decision continues among those
 *    alone.
 * 3. Every `failing` candidate, when there is one.
 * 4. Otherwise the alternatives.
 */
export function unionOutcome(applicator: "anyOf" | "oneOf", states: readonly BranchState[]): UnionOutcome {
  const valid = states.filter((s) => s.state === "valid").length;
  if (applicator === "anyOf" ? valid > 0 : valid === 1) return { kind: "pass" };
  if (valid > 1) return { kind: "ambiguous" };

  const candidates = states.flatMap((s, i) => (s.state === "type-refused" ? [] : [i]));
  const refused = candidates.filter((i) => states[i]!.state === "tag-refused");
  let considered = candidates;
  if (refused.length > 0) {
    const accepting = candidates.filter((i) => states[i]!.state !== "tag-refused");
    if (accepting.length === 1) return { kind: "branches", branches: accepting };
    if (accepting.length === 0) {
      const placesOf = (i: number) => (states[i] as { at: readonly string[] }).at;
      const at = placesOf(refused[0]!).find((candidate) => refused.every((i) => placesOf(i).includes(candidate)));
      if (at !== undefined) return { kind: "tag", at, branches: refused };
    } else {
      considered = accepting;
    }
  }

  const failing = considered.filter((i) => states[i]!.state === "failing");
  if (failing.length > 0) return { kind: "branches", branches: failing };
  return { kind: "alternatives" };
}
