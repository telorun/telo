import { createHash } from "node:crypto";
import type { ConflictClass } from "@telorun/graph-layers";
import type { CompiledColumn } from "./compiled-types.js";
import { STATED } from "./declared-table.js";
import type { RowEffect } from "./drafted-statements.js";
import { sameValue } from "./same-value.js";

type Row = Record<string, unknown>;

/**
 * The three-way merge of a revisioned layer. A draft row is compared with the
 * layer's row for the same identity as the layer now stands, against their
 * common ancestor — the layer's row the draft was written over, which a
 * revisioned table still holds. So the comparison is per property: a property
 * only one side changed is merged, and only a property both changed to
 * different values is a conflict.
 */
export interface MergeSides {
  /** The draft's row. */
  readonly mine: { readonly effect: RowEffect; readonly row: Row };
  /** The layer's row as it now stands; absent when the layer states none. */
  readonly theirs?: Row;
  /** The layer's row the draft was written over; absent when it was written
   *  over none. */
  readonly base?: Row;
}

/**
 * How the two sides come together.
 *
 * - `drop`: nothing is left for the draft to say — both sides did the same, or
 *   the draft changed nothing the other side did not.
 * - `keep`: the draft's statement stands on the layer's row as it now is, with
 *   `values` in place of its properties when the other side's changes merged
 *   into it.
 * - `conflict`: a decision is needed. `takingMine` and `takingTheirs` are the
 *   properties the draft's row would hold if that side were taken — every
 *   property only one side changed already merged — each absent when taking
 *   the side leaves no value.
 */
export type Merge =
  | { readonly outcome: "drop" }
  | { readonly outcome: "keep"; readonly values?: Row }
  | {
      readonly outcome: "conflict";
      readonly class: ConflictClass;
      readonly properties?: string[];
      readonly takingMine?: Row;
      readonly takingTheirs?: Row;
    };

export function sameProperties(
  properties: ReadonlyMap<string, CompiledColumn>,
  a: Row,
  b: Row,
): boolean {
  return [...properties.keys()].every((name) => sameValue(a[name], b[name]));
}

function pick(properties: ReadonlyMap<string, CompiledColumn>, row: Row): Row {
  return Object.fromEntries([...properties.keys()].map((name) => [name, row[name] ?? null]));
}

export function merge(properties: ReadonlyMap<string, CompiledColumn>, sides: MergeSides): Merge {
  const { mine, theirs, base } = sides;
  const stated = mine.effect === STATED;
  const same = (a: Row, b: Row) => sameProperties(properties, a, b);

  if (!stated) {
    // The draft withdraws the statement.
    if (!theirs) return { outcome: "drop" };
    if (base && same(theirs, base)) return { outcome: "keep" };
    return { outcome: "conflict", class: "removed-changed", takingTheirs: pick(properties, theirs) };
  }
  if (!theirs) {
    // The layer no longer states it. A draft that changed nothing accepts that.
    if (base && same(mine.row, base)) return { outcome: "drop" };
    return { outcome: "conflict", class: "changed-removed", takingMine: pick(properties, mine.row) };
  }
  if (!base) {
    // Both added it.
    if (same(mine.row, theirs)) return { outcome: "drop" };
    return {
      outcome: "conflict",
      class: "added-both",
      takingMine: pick(properties, mine.row),
      takingTheirs: pick(properties, theirs),
    };
  }

  const clashing: string[] = [];
  const merged: Row = {};
  const yielded: Row = {};
  for (const name of properties.keys()) {
    const [m, t, b] = [mine.row[name] ?? null, theirs[name] ?? null, base[name] ?? null];
    const mineChanged = !sameValue(m, b);
    const clash = mineChanged && !sameValue(t, b) && !sameValue(m, t);
    if (clash) clashing.push(name);
    merged[name] = mineChanged ? m : t;
    yielded[name] = clash ? t : merged[name];
  }
  if (clashing.length > 0) {
    return {
      outcome: "conflict",
      class: "changed-both",
      properties: clashing,
      takingMine: merged,
      takingTheirs: yielded,
    };
  }
  if (same(merged, theirs)) return { outcome: "drop" };
  return same(merged, mine.row) ? { outcome: "keep" } : { outcome: "keep", values: merged };
}

/**
 * A conflict's token: a digest of the identity of every row its class was
 * decided from, so it stops matching when any of them is written again. Only
 * the digest leaves the store — a row's id never does.
 */
export function conflictToken(rows: readonly (string | null | undefined)[]): string {
  return createHash("sha256")
    .update(rows.map((row) => row ?? "").join("\n"))
    .digest("base64url")
    .slice(0, 22);
}
