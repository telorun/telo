import type { ConflictClass } from "@telorun/graph-layers";
import { readInt64Column } from "@telorun/sql";
import { DRAFT, REMOVED, RETRACTED, STATED } from "./declared-table.js";
import type { DraftedTable } from "./drafted-tables.js";
import { CONFLICT_ALIASES, theirsAlias, type RowEffect, type RowState } from "./drafted-statements.js";
import { sameValue } from "./same-value.js";

type Row = Record<string, unknown>;

/**
 * Conflicts on this strategy are two-way: a draft row is compared with the
 * layer's published row for the same identity, through the revision the draft
 * row was written over. No ancestor is kept, so a conflict has no `base`, and
 * two sides changing different properties of one identity is one conflict.
 */
export interface Candidate {
  /** The row the layer states in the draft's view: the draft's, or a published
   *  one the draft leaves standing. */
  readonly state: RowState;
  readonly effect: RowEffect;
  readonly over: bigint | null;
  /** The row's own revision: set on a published row, null on a draft's. */
  readonly revision: bigint | null;
  readonly row: Row;
  /** The published row beside a draft row, as it now stands. */
  readonly theirs?: { readonly effect: RowEffect; readonly revision: bigint; readonly row: Row };
  /** A relationship with an endpoint that does not resolve in the draft's view. */
  readonly missing: boolean;
}

export interface Classified {
  readonly class: ConflictClass;
  readonly properties?: string[];
  readonly token: string;
}

function int64OrNull(value: unknown): bigint | null {
  return value === null || value === undefined ? null : readInt64Column(value);
}

/** One row of a conflict listing, read apart into the two sides. */
export function readCandidate(table: DraftedTable, row: Row): Candidate {
  const theirsEffect = row[CONFLICT_ALIASES.theirsEffect];
  const theirsRow: Row = {};
  table.columns.forEach((c, index) => {
    theirsRow[c.name] = row[theirsAlias(index)];
  });
  return {
    state: row[CONFLICT_ALIASES.state] as RowState,
    effect: row[CONFLICT_ALIASES.effect] as RowEffect,
    over: int64OrNull(row[CONFLICT_ALIASES.over]),
    revision: int64OrNull(row[CONFLICT_ALIASES.revision]),
    row,
    theirs:
      typeof theirsEffect === "string"
        ? {
            effect: theirsEffect as RowEffect,
            revision: readInt64Column(row[CONFLICT_ALIASES.theirsRevision]),
            row: theirsRow,
          }
        : undefined,
    missing: Number(row[CONFLICT_ALIASES.missing]) === 1,
  };
}

function token(parts: readonly unknown[]): string {
  return Buffer.from(parts.map((part) => String(part ?? "")).join(":"), "utf8").toString("base64url");
}

/**
 * What a candidate is. Undefined when it is no conflict: the two sides say the
 * same thing, which a rebase merges without asking.
 */
export function classify(table: DraftedTable, candidate: Candidate): Classified | undefined {
  const { effect, over, theirs } = candidate;
  // The token names the row as it stands: a draft row by what it stands over,
  // a published one by its own revision — so it stops matching when the row
  // is written again.
  const endpointMissing = (): Classified | undefined =>
    candidate.missing && effect === STATED
      ? { class: "endpoint-missing", token: token(["e", candidate.state, over, candidate.revision]) }
      : undefined;
  if (candidate.state !== DRAFT) return endpointMissing();
  if ((over ?? -1n) === (theirs?.revision ?? -1n)) return endpointMissing();

  const moved = (kind: ConflictClass, properties?: string[]): Classified => ({
    class: kind,
    ...(properties ? { properties } : {}),
    token: token(["m", over, theirs?.revision]),
  });
  if (effect === STATED) {
    if (theirs?.effect !== STATED) return moved("changed-removed");
    const differing = [...table.properties.keys()].filter(
      (name) => !sameValue(candidate.row[name], theirs.row[name]),
    );
    if (differing.length === 0) return undefined;
    return over === null ? moved("added-both") : moved("changed-both", differing);
  }
  if (effect === REMOVED && theirs?.effect === REMOVED) return undefined;
  if (effect === RETRACTED && !theirs) return undefined;
  return moved("removed-changed");
}
