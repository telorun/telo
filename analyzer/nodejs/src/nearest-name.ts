import { distance } from "./levenshtein.js";

/**
 * THE closest candidate to a misspelled name, or undefined.
 *
 * One rule, because a suggestion here is emitted as a `DiagnosticFix` — a
 * whole-value replacement an editor applies in one click — so "closest" has to
 * mean the same thing wherever it is offered. Two properties carry that:
 *
 *  - **A TIE returns undefined.** Two candidates at equal distance make the pick
 *    arbitrary, and an arbitrary pick that is one click from being applied is
 *    worse than no suggestion: it resolves by whatever order the candidate set
 *    happened to be built in, which is a `Set`'s insertion order.
 *  - **The threshold scales but is CAPPED** (`min(3, len/3)`, and nothing under
 *    1). Without the cap a long name accepts a distant match; without the floor
 *    a two-character name gets a "correction" sharing nothing with it.
 *
 * Both are `computeSuggestKind`'s rule, lifted here so the kind-suggestion, the
 * template-body and the export checks cannot drift into three answers — which
 * they had, two of them byte-identical copies differing from this one in both
 * properties.
 */
export function nearestName(
  target: string,
  candidates: Iterable<string>,
): string | undefined {
  if (!target) return undefined;
  const threshold = Math.min(3, Math.floor(target.length / 3));
  if (threshold < 1) return undefined;

  let best: string | undefined;
  let bestDist = threshold + 1;
  let tied = false;

  for (const candidate of candidates) {
    const d = distance(target, candidate);
    if (d < bestDist) {
      best = candidate;
      bestDist = d;
      tied = false;
    } else if (d === bestDist) {
      tied = true;
    }
  }

  return !best || bestDist > threshold || tied ? undefined : best;
}
