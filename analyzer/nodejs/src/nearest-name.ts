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
  const threshold = thresholdFor(target);
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

/** How far a candidate may be from `target` and still be offered. */
function thresholdFor(target: string): number {
  return target ? Math.min(3, Math.floor(target.length / 3)) : 0;
}

/**
 * Every candidate at the smallest distance from `target` within {@link nearestName}'s
 * threshold, in candidate order — for prose that names its suggestions rather
 * than a repair applied in one click, where a tie is information, not an
 * arbitrary pick.
 */
export function nearestNames(target: string, candidates: Iterable<string>): string[] {
  const threshold = thresholdFor(target);
  if (threshold < 1) return [];
  let best: string[] = [];
  let bestDist = threshold + 1;
  for (const candidate of candidates) {
    const d = distance(target, candidate);
    if (d < bestDist) {
      best = [candidate];
      bestDist = d;
    } else if (d === bestDist) {
      best.push(candidate);
    }
  }
  return best;
}

/** The connectives {@link nearestNameWhere} computes where each answer holds in. */
export interface NameLogic<T> {
  readonly TRUE: T;
  readonly FALSE: T;
  and(a: T, b: T): T;
  or(a: T, b: T): T;
  not(a: T): T;
  isFalse(a: T): boolean;
}

/**
 * {@link nearestName} over candidates each present where `held` says: every
 * answer it gives with where it holds — a candidate where it is the one present
 * at the smallest distance within the threshold, undefined everywhere else.
 */
export function nearestNameWhere<T>(
  target: string,
  candidates: readonly { readonly name: string; readonly held: T }[],
  logic: NameLogic<T>,
): { suggestion: string | undefined; held: T }[] {
  const threshold = thresholdFor(target);
  if (threshold < 1) return [{ suggestion: undefined, held: logic.TRUE }];
  const byName = new Map<string, T>();
  for (const { name, held } of candidates) byName.set(name, logic.or(byName.get(name) ?? logic.FALSE, held));
  const levels = new Map<number, string[]>();
  for (const name of byName.keys()) {
    const d = distance(target, name);
    if (d > threshold) continue;
    levels.set(d, [...(levels.get(d) ?? []), name]);
  }
  const out: { suggestion: string | undefined; held: T }[] = [];
  let suggested = logic.FALSE;
  // No candidate nearer than the level read so far is present.
  let nearerAbsent = logic.TRUE;
  for (const d of [...levels.keys()].sort((a, b) => a - b)) {
    const names = levels.get(d)!;
    for (const name of names) {
      let alone = logic.and(nearerAbsent, byName.get(name)!);
      for (const other of names) if (other !== name) alone = logic.and(alone, logic.not(byName.get(other)!));
      if (logic.isFalse(alone)) continue;
      out.push({ suggestion: name, held: alone });
      suggested = logic.or(suggested, alone);
    }
    for (const name of names) nearerAbsent = logic.and(nearerAbsent, logic.not(byName.get(name)!));
  }
  const none = logic.not(suggested);
  if (!logic.isFalse(none)) out.push({ suggestion: undefined, held: none });
  return out;
}
