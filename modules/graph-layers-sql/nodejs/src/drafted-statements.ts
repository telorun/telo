import type { Actor } from "@telorun/graph-layers";
import { selectList, type Assignment, type CompiledColumn } from "./compiled-types.js";
import { DRAFT, PUBLISHED, REMOVED, RETRACTED, STATED } from "./declared-table.js";
import type { DraftedNode, DraftedRelationship, DraftedTable } from "./drafted-tables.js";
import { matchIdentity, unresolvedAmong, type StackView } from "./layer-overlay.js";
import { SqlFragments } from "@telorun/sql";

/**
 * The statements of a drafted table, where a layer holds at most one draft row
 * and one published row per identity. Every one names a single layer; a value,
 * a layer id and a revision are only ever bound.
 *
 * The table is indexed `(layer, state, identity…)`: a layer's draft rows are
 * one contiguous range and its published rows another. So every statement
 * names the state it reads, and whatever concerns the draft as a whole —
 * publishing, discarding, rebasing, counting and listing its conflicts — is
 * driven from the draft's range and reaches a published row only by probing
 * for an identity it already holds.
 */

export type RowState = typeof DRAFT | typeof PUBLISHED;
export type RowEffect = typeof STATED | typeof REMOVED | typeof RETRACTED;

/** One row of one layer: which of the two it is. */
export interface RowAt {
  readonly layer: string;
  readonly state: RowState;
}

/** The bookkeeping a write leaves on a row. */
export interface Stamp {
  readonly effect: RowEffect;
  /** The revision that publishes the row; null on a draft row. */
  readonly revision: bigint | null;
  /** On a draft row, the revision of the published row it stands over. */
  readonly over: bigint | null;
  readonly resolution: "mine" | "theirs" | "merged" | null;
  readonly resolvedBy: Actor | null;
}

function bound(sql: SqlFragments, value: unknown): SqlFragments {
  return value === null ? sql.text("NULL") : sql.value(value);
}

function conflictTarget(table: DraftedTable): string {
  return [table.layer, table.state, ...table.identity].map((c) => c.sql).join(", ");
}

function stampColumns(table: DraftedTable): CompiledColumn[] {
  return [
    table.layer,
    table.state,
    table.effect,
    table.revision,
    table.over,
    table.writtenAt,
    table.resolution,
    table.resolvedByType,
    table.resolvedById,
  ];
}

/** The values of {@link stampColumns}, in order. `now` is the engine's own
 *  expression for the instant the statement runs. */
function stampValues(sql: SqlFragments, at: RowAt, stamp: Stamp, now: string): SqlFragments {
  sql.value(at.layer).text(`, '${at.state}', '${stamp.effect}', `);
  bound(sql, stamp.revision).text(", ");
  bound(sql, stamp.over).text(`, ${now}, `);
  bound(sql, stamp.resolution).text(", ");
  bound(sql, stamp.resolvedBy?.type ?? null).text(", ");
  return bound(sql, stamp.resolvedBy?.id ?? null);
}

function returning(table: DraftedTable): string {
  return ` RETURNING ${selectList(table, "")}`;
}

function at(table: DraftedTable, qualifier: string, where: RowAt): SqlFragments {
  return new SqlFragments()
    .text(`${qualifier}${table.layer.sql} = `)
    .value(where.layer)
    .text(` AND ${qualifier}${table.state.sql} = '${where.state}'`);
}

/** The rows a layer holds for an identity in `states`, with their bookkeeping:
 *  one index probe per state named. */
export function selectOwn(
  table: DraftedTable,
  layer: string,
  states: readonly RowState[],
  identity: readonly unknown[],
): SqlFragments {
  const bookkeeping = [table.state, table.effect, table.revision, table.over, table.resolution]
    .map((c) => c.sql)
    .join(", ");
  return new SqlFragments()
    .text(`SELECT ${selectList(table, "")}, ${bookkeeping}, ${table.resolvedByType.sql}, `)
    .text(`${table.resolvedById.sql} FROM ${table.table} WHERE ${table.layer.sql} = `)
    .value(layer)
    .text(` AND ${table.state.sql} IN (${states.map((state) => `'${state}'`).join(", ")}) AND `)
    .append(matchIdentity(table, "", identity));
}

/** A new row. Returns none when the layer already holds that row. */
export function insertRow(
  table: DraftedTable,
  where: RowAt,
  stamp: Stamp,
  now: string,
  identity: readonly unknown[],
  assignments: readonly Assignment[],
): SqlFragments {
  const columns = [...stampColumns(table), ...table.identity, ...assignments.map((a) => a.column)]
    .map((c) => c.sql)
    .join(", ");
  const sql = new SqlFragments().text(`INSERT INTO ${table.table} (${columns}) VALUES (`);
  stampValues(sql, where, stamp, now)
    .text(", ")
    .valueList([...identity, ...assignments.map((a) => a.value)], ", ");
  return sql.text(`) ON CONFLICT (${conflictTarget(table)}) DO NOTHING${returning(table)}`);
}

/** A row holding what the row at `from` holds, with `assignments` in place of
 *  the columns they name. */
export function copyRow(
  table: DraftedTable,
  where: RowAt,
  stamp: Stamp,
  now: string,
  from: RowAt,
  identity: readonly unknown[],
  assignments: readonly Assignment[],
): SqlFragments {
  const columns = [...stampColumns(table), ...table.columns].map((c) => c.sql).join(", ");
  const sql = new SqlFragments().text(`INSERT INTO ${table.table} (${columns}) SELECT `);
  stampValues(sql, where, stamp, now);
  for (const column of table.columns) {
    const assigned = assignments.find((a) => a.column.name === column.name);
    if (assigned) sql.text(", ").value(assigned.value);
    else sql.text(`, b.${column.sql}`);
  }
  return sql
    .text(` FROM ${table.table} b WHERE `)
    .append(at(table, "b.", from))
    .text(" AND ")
    .append(matchIdentity(table, "b.", identity))
    .text(` ON CONFLICT (${conflictTarget(table)}) DO NOTHING${returning(table)}`);
}

/**
 * Makes the row at `where` hold what the row at `from` holds, with
 * `assignments` in place of the columns they name — one statement over the row
 * already there, so with nothing at `from` that row stands as it was and none
 * is returned.
 */
export function copyOnto(
  table: DraftedTable,
  where: RowAt,
  stamp: Stamp,
  now: string,
  from: RowAt,
  identity: readonly unknown[],
  assignments: readonly Assignment[],
): SqlFragments {
  const source = (select: string): SqlFragments =>
    new SqlFragments()
      .text(`(SELECT ${select} FROM ${table.table} b WHERE `)
      .append(at(table, "b.", from))
      .text(" AND ")
      .append(matchIdentity(table, "b.", identity))
      .text(" LIMIT 1)");
  const sql = new SqlFragments().text(`UPDATE ${table.table} SET `);
  for (const column of table.properties.values()) {
    const assigned = assignments.find((a) => a.column.name === column.name);
    sql.text(`${column.sql} = `);
    if (assigned) sql.value(assigned.value);
    else sql.append(source(`b.${column.sql}`));
    sql.text(", ");
  }
  return stampSet(sql, table, stamp, now)
    .text(" WHERE ")
    .append(at(table, "", where))
    .text(" AND ")
    .append(matchIdentity(table, "", identity))
    .text(" AND ")
    .append(source("1"))
    .text(` IS NOT NULL${returning(table)}`);
}

/** `SET` entries of a row's bookkeeping. */
function stampSet(sql: SqlFragments, table: DraftedTable, stamp: Stamp, now: string): SqlFragments {
  sql.text(`${table.effect.sql} = '${stamp.effect}', ${table.revision.sql} = `);
  bound(sql, stamp.revision).text(`, ${table.over.sql} = `);
  bound(sql, stamp.over).text(`, ${table.writtenAt.sql} = ${now}, ${table.resolution.sql} = `);
  bound(sql, stamp.resolution).text(`, ${table.resolvedByType.sql} = `);
  bound(sql, stamp.resolvedBy?.type ?? null).text(`, ${table.resolvedById.sql} = `);
  return bound(sql, stamp.resolvedBy?.id ?? null);
}

/** `over` as a condition: a null-safe equality written per value, since the
 *  engines spell null-safe comparison differently. */
function overIs(table: DraftedTable, over: bigint | null): SqlFragments {
  return over === null
    ? new SqlFragments().text(`${table.over.sql} IS NULL`)
    : new SqlFragments().text(`${table.over.sql} = `).value(over);
}

/** Changes one row in place. With `whileOver`, only while the row still stands
 *  over that revision — the condition that makes a decision apply once. */
export function updateRow(
  table: DraftedTable,
  where: RowAt,
  stamp: Stamp,
  now: string,
  identity: readonly unknown[],
  assignments: readonly Assignment[],
  whileOver?: { readonly over: bigint | null },
): SqlFragments {
  const sql = new SqlFragments().text(`UPDATE ${table.table} SET `);
  for (const assignment of assignments) sql.text(`${assignment.column.sql} = `).value(assignment.value).text(", ");
  stampSet(sql, table, stamp, now)
    .text(" WHERE ")
    .append(at(table, "", where))
    .text(" AND ")
    .append(matchIdentity(table, "", identity));
  if (whileOver) sql.text(" AND ").append(overIs(table, whileOver.over));
  return sql.text(returning(table));
}

export function deleteRow(
  table: DraftedTable,
  where: RowAt,
  identity: readonly unknown[],
  whileOver?: { readonly over: bigint | null },
): SqlFragments {
  const sql = new SqlFragments()
    .text(`DELETE FROM ${table.table} WHERE `)
    .append(at(table, "", where))
    .text(" AND ")
    .append(matchIdentity(table, "", identity));
  if (whileOver) sql.text(" AND ").append(overIs(table, whileOver.over));
  return sql.text(returning(table));
}

/** `p` is the published row of the same layer and identity as `d`. */
function publishedTwin(table: DraftedTable, d: string, p: string): string {
  const same = table.identity.map((c) => `${p}.${c.sql} = ${d}.${c.sql}`).join(" AND ");
  return `${p}.${table.layer.sql} = ${d}.${table.layer.sql} AND ${p}.${table.state.sql} = '${PUBLISHED}' AND ${same}`;
}

/** Withdraws the relationships a layer has PUBLISHED at one endpoint, outside
 *  a draft: its own stated rows there are deleted. */
export function deletePublishedTouching(
  relationship: DraftedRelationship,
  layer: string,
  endpoint: CompiledColumn,
  key: unknown,
): SqlFragments {
  return new SqlFragments()
    .text(`DELETE FROM ${relationship.table} WHERE `)
    .append(at(relationship, "", { layer, state: PUBLISHED }))
    .text(` AND ${relationship.effect.sql} = '${STATED}' AND ${endpoint.sql} = `)
    .value(key);
}

/**
 * Withdraws, in a draft, every relationship the layer states at one endpoint —
 * three statements, none touching a row of another layer: a draft statement
 * over a published one becomes its retraction, a draft statement with no
 * published one is dropped, and a published statement the draft has not
 * touched gets a retraction of its own.
 */
export function withdrawTouchingInDraft(
  relationship: DraftedRelationship,
  layer: string,
  endpoint: CompiledColumn,
  key: unknown,
  now: string,
): SqlFragments[] {
  const t = relationship;
  const draftStated = (qualifier: string) =>
    at(t, qualifier, { layer, state: DRAFT })
      .text(` AND ${qualifier}${t.effect.sql} = '${STATED}' AND ${qualifier}${endpoint.sql} = `)
      .value(key);
  // Scalar probes throughout: one index probe per draft row, whatever the planner.
  const twinStated = `(SELECT 1 FROM ${t.table} p WHERE ${publishedTwin(t, "d", "p")} AND p.${t.effect.sql} = '${STATED}') IS NOT NULL`;
  const retract = new SqlFragments()
    .text(`UPDATE ${t.table} AS d SET ${t.effect.sql} = '${RETRACTED}', ${t.writtenAt.sql} = ${now} WHERE `)
    .append(draftStated("d."))
    .text(` AND ${twinStated}`);
  const drop = new SqlFragments().text(`DELETE FROM ${t.table} WHERE `).append(draftStated(""));
  const columns = [...stampColumns(t), ...t.columns].map((c) => c.sql).join(", ");
  const cover = new SqlFragments()
    .text(`INSERT INTO ${t.table} (${columns}) SELECT `)
    .value(layer)
    .text(`, '${DRAFT}', '${RETRACTED}', NULL, p.${t.revision.sql}, ${now}, NULL, NULL, NULL`)
    .text(t.columns.map((c) => `, p.${c.sql}`).join(""))
    .text(` FROM ${t.table} p WHERE `)
    .append(at(t, "p.", { layer, state: PUBLISHED }))
    .text(` AND p.${t.effect.sql} = '${STATED}' AND p.${endpoint.sql} = `)
    .value(key)
    .text(` ON CONFLICT (${conflictTarget(t)}) DO NOTHING`);
  return [retract, drop, cover];
}

/**
 * A draft row no longer stands on the published row it was written over: the
 * layer's published statement for the identity has another revision, has
 * appeared, or is gone. `d` is the draft row's alias.
 */
export function movedBeneath(table: DraftedTable, d: string): string {
  return (
    `COALESCE(${d}.${table.over.sql}, -1) <> COALESCE((SELECT q.${table.revision.sql} ` +
    `FROM ${table.table} q WHERE ${publishedTwin(table, d, "q")}), -1)`
  );
}

export function anyDraftRow(table: DraftedTable, layer: string): SqlFragments {
  return new SqlFragments()
    .text(`SELECT 1 AS found FROM ${table.table} WHERE `)
    .append(at(table, "", { layer, state: DRAFT }))
    .text(" LIMIT 1");
}

/** The draft rows of a layer the published side has moved under. */
export function countMoved(table: DraftedTable, layer: string): SqlFragments {
  return new SqlFragments()
    .text(`SELECT COUNT(*) AS moved FROM ${table.table} d WHERE `)
    .append(at(table, "d.", { layer, state: DRAFT }))
    .text(` AND ${movedBeneath(table, "d")}`);
}

/**
 * Rebasing: the draft rows the published side moved under and that now say what
 * it says are dropped, since nothing is left to publish for them — both sides
 * stated equal values, both removed the identity, or the draft retracted a
 * statement that is already gone. Each statement reads the draft's range,
 * probes the published row of each identity it holds, and returns the rows it
 * merged.
 */
export function mergeConvergent(table: DraftedTable, layer: string): SqlFragments[] {
  const one = table.identity[0].sql;
  const equal = [...table.properties.values()]
    .map((c) => ` AND (d.${c.sql} = p.${c.sql} OR (d.${c.sql} IS NULL AND p.${c.sql} IS NULL))`)
    .join("");
  const moved = (effect: RowEffect) =>
    new SqlFragments()
      .text(`DELETE FROM ${table.table} AS d WHERE `)
      .append(at(table, "d.", { layer, state: DRAFT }))
      .text(` AND d.${table.effect.sql} = '${effect}' AND `);
  /** The revision of the published twin when it says `effect` (and `extra`). */
  const twinRevision = (effect: RowEffect, extra: string) =>
    `(SELECT p.${table.revision.sql} FROM ${table.table} p WHERE ${publishedTwin(table, "d", "p")} ` +
    `AND p.${table.effect.sql} = '${effect}'${extra})`;
  const over = `COALESCE(d.${table.over.sql}, -1)`;
  return [
    moved(STATED).text(`${twinRevision(STATED, equal)} <> ${over} RETURNING ${one}`),
    moved(REMOVED).text(`${twinRevision(REMOVED, "")} <> ${over} RETURNING ${one}`),
    moved(RETRACTED).text(
      `(SELECT 1 FROM ${table.table} p WHERE ${publishedTwin(table, "d", "p")}) IS NULL ` +
        `RETURNING ${one}`,
    ),
  ];
}

/**
 * Publishing: the draft's rows replace the layer's published ones, at once.
 * The published rows replaced are reached through the draft's identities, never
 * by reading the published range for rows that have a draft twin.
 */
export function publishRows(table: DraftedTable, layer: string, revision: bigint): SqlFragments[] {
  const draft = { layer, state: DRAFT } as const;
  const identity = (qualifier: string) => table.identity.map((c) => `${qualifier}${c.sql}`).join(", ");
  const tuple = (columns: string) => (table.identity.length === 1 ? columns : `(${columns})`);
  const replaced = new SqlFragments()
    .text(`DELETE FROM ${table.table} WHERE `)
    .append(at(table, "", { layer, state: PUBLISHED }))
    .text(` AND ${tuple(identity(""))} IN (SELECT ${identity("d.")} FROM ${table.table} d WHERE `)
    .append(at(table, "d.", draft))
    .text(")");
  const retracted = new SqlFragments()
    .text(`DELETE FROM ${table.table} WHERE `)
    .append(at(table, "", draft))
    .text(` AND ${table.effect.sql} = '${RETRACTED}'`);
  const promoted = new SqlFragments()
    .text(`UPDATE ${table.table} SET ${table.state.sql} = '${PUBLISHED}', ${table.revision.sql} = `)
    .value(revision)
    .text(`, ${table.over.sql} = NULL WHERE `)
    .append(at(table, "", draft));
  return [replaced, retracted, promoted];
}

export function discardRows(table: DraftedTable, layer: string): SqlFragments {
  return new SqlFragments()
    .text(`DELETE FROM ${table.table} WHERE `)
    .append(at(table, "", { layer, state: DRAFT }));
}

export function endpointMissing(
  relationship: DraftedRelationship,
  r: string,
  view: StackView,
): SqlFragments {
  const t = relationship;
  return new SqlFragments()
    .text("(")
    .append(unresolvedAmong(t.source, `${r}.${t.sourceColumn.sql}`, view, "m"))
    .text(" OR ")
    .append(unresolvedAmong(t.target, `${r}.${t.targetColumn.sql}`, view, "m"))
    .text(")");
}

/** The draft removes or retracts the node `key` names: its draft row, when it
 *  has one, states nothing. A scalar probe of the node table's draft range. */
function unstatedInDraft(
  node: DraftedNode,
  layer: string,
  key: string,
  alias: string,
): SqlFragments {
  return new SqlFragments()
    .text(`(SELECT 1 FROM ${node.table} ${alias} WHERE ${alias}.${node.layer.sql} = `)
    .value(layer)
    .text(` AND ${alias}.${node.state.sql} = '${DRAFT}' AND ${alias}.${node.key.sql} = ${key} `)
    .text(`AND ${alias}.${node.effect.sql} <> '${STATED}')`);
}

/** `r`, a published relationship of the layer, has no draft row over it. */
function untouchedByDraft(relationship: DraftedRelationship, r: string): string {
  const t = relationship;
  return (
    `(SELECT 1 FROM ${t.table} x WHERE x.${t.layer.sql} = ${r}.${t.layer.sql} ` +
    `AND x.${t.state.sql} = '${DRAFT}' AND x.${t.sourceColumn.sql} = ${r}.${t.sourceColumn.sql} ` +
    `AND x.${t.targetColumn.sql} = ${r}.${t.targetColumn.sql}) IS NULL`
  );
}

/**
 * The relationships the layer has PUBLISHED, and the draft leaves standing, at
 * a node the draft removes or retracts — reached from the node table's draft
 * range through the relationship index that leads on that endpoint, never by
 * reading the layer's relationships. `FROM … WHERE …` only; `r` is the
 * relationship. A relationship with both endpoints withdrawn is the source
 * side's, so the two sides never hold one twice.
 */
function publishedAtWithdrawn(
  relationship: DraftedRelationship,
  side: "source" | "target",
  view: StackView,
): SqlFragments {
  const t = relationship;
  const layer = view.layers[0];
  const node = side === "source" ? t.source : t.target;
  const endpoint = side === "source" ? t.sourceColumn : t.targetColumn;
  const sql = new SqlFragments()
    .text(
      `FROM ${node.table} y JOIN ${t.table} r ON r.${t.layer.sql} = y.${node.layer.sql} ` +
        `AND r.${t.state.sql} = '${PUBLISHED}' AND r.${endpoint.sql} = y.${node.key.sql} ` +
        `WHERE y.${node.layer.sql} = `,
    )
    .value(layer)
    .text(` AND y.${node.state.sql} = '${DRAFT}' AND y.${node.effect.sql} <> '${STATED}' `)
    .text(`AND r.${t.effect.sql} = '${STATED}' AND ${untouchedByDraft(t, "r")}`);
  if (side === "target") {
    sql
      .text(" AND ")
      .append(unstatedInDraft(t.source, layer, `r.${t.sourceColumn.sql}`, "ys"))
      .text(" IS NULL");
  }
  return sql.text(" AND ").append(endpointMissing(t, "r", view));
}

/**
 * The relationships the draft's view states with an endpoint that does not
 * resolve in it, as two driven sets: the draft's own stated relationships the
 * published side has not moved under, and the layer's published relationships
 * at a node the draft removes or retracts.
 */
export function countEndpointMissing(
  relationship: DraftedRelationship,
  view: StackView,
): SqlFragments {
  const t = relationship;
  const layer = view.layers[0];
  return new SqlFragments()
    .text(`SELECT COUNT(*) AS missing FROM (SELECT 1 AS found FROM ${t.table} r WHERE `)
    .append(at(t, "r.", { layer, state: DRAFT }))
    .text(` AND r.${t.effect.sql} = '${STATED}' AND NOT (${movedBeneath(t, "r")}) AND `)
    .append(endpointMissing(t, "r", view))
    .text(" UNION ALL SELECT 1 ")
    .append(publishedAtWithdrawn(t, "source", view))
    .text(" UNION ALL SELECT 1 ")
    .append(publishedAtWithdrawn(t, "target", view))
    .text(") c");
}

/** Result aliases of a conflict listing: the row's own columns under their
 *  own names, the published side's under `theirsAlias`. */
export function theirsAlias(index: number): string {
  return `graph_theirs_${index}`;
}

export const CONFLICT_ALIASES = {
  state: "graph_c_state",
  effect: "graph_c_effect",
  over: "graph_c_over",
  revision: "graph_c_revision",
  theirsEffect: "graph_c_theirs_effect",
  theirsRevision: "graph_c_theirs_revision",
  missing: "graph_c_missing",
} as const;

/** What narrows a conflict listing to part of the candidates: one identity, or
 *  the position past a cursor. Each is written against the alias `r`. */
export interface ConflictNarrowing {
  readonly identity?: readonly unknown[];
  readonly seek?: () => SqlFragments;
  readonly limit?: number;
}

/**
 * A draft's conflict candidates on a table, in identity order. Two driven sets,
 * neither a filter over the layer's rows:
 *
 * - the draft's own rows the published side has moved under, each beside the
 *   published row as it now stands — and, for a relationship, its own stated
 *   rows with an endpoint that does not resolve;
 * - for a relationship, the layer's published rows the draft leaves standing
 *   at a node the draft removes or retracts, when an endpoint does not resolve.
 *
 * Which candidates are conflicts, and of which class, is decided from the two
 * rows. Conflicts are not stored, so the statement reads the draft and those
 * relationships whole before it orders and cuts the page.
 */
export function selectConflictCandidates(
  table: DraftedTable,
  view: StackView,
  quote: (name: string) => string,
  narrowing: ConflictNarrowing,
): SqlFragments {
  const layer = view.layers[0];
  const relationship = "sourceColumn" in table ? (table as DraftedRelationship) : undefined;
  const narrowed = (sql: SqlFragments): SqlFragments => {
    if (narrowing.identity) sql.text(" AND ").append(matchIdentity(table, "r.", narrowing.identity));
    if (narrowing.seek) sql.text(" AND ").append(narrowing.seek());
    return sql;
  };
  const projection =
    `${selectList(table, "r")}, r.${table.state.sql} AS ${quote(CONFLICT_ALIASES.state)}, ` +
    `r.${table.effect.sql} AS ${quote(CONFLICT_ALIASES.effect)}, ` +
    `r.${table.over.sql} AS ${quote(CONFLICT_ALIASES.over)}, ` +
    `r.${table.revision.sql} AS ${quote(CONFLICT_ALIASES.revision)}, `;

  // The draft's own rows.
  const drafted = new SqlFragments().text(`SELECT ${projection}`);
  if (relationship) {
    drafted
      .text("CASE WHEN ")
      .append(endpointMissing(relationship, "r", view))
      .text(` THEN 1 ELSE 0 END AS ${quote(CONFLICT_ALIASES.missing)}`);
  } else {
    drafted.text(`0 AS ${quote(CONFLICT_ALIASES.missing)}`);
  }
  drafted.text(` FROM ${table.table} r WHERE `).append(at(table, "r.", { layer, state: DRAFT }));
  if (relationship) {
    drafted
      .text(` AND (${movedBeneath(table, "r")} OR (r.${table.effect.sql} = '${STATED}' AND `)
      .append(endpointMissing(relationship, "r", view))
      .text("))");
  } else {
    drafted.text(` AND ${movedBeneath(table, "r")}`);
  }
  const arms = [narrowed(drafted)];

  if (relationship) {
    // The published rows the draft leaves standing; the endpoint is known to
    // be missing.
    const standing = `SELECT ${projection}1 AS ${quote(CONFLICT_ALIASES.missing)} `;
    if (narrowing.identity) {
      // One relationship: probed directly, then asked whether either endpoint
      // is a node the draft withdraws.
      const t = relationship;
      const one = new SqlFragments()
        .text(`${standing}FROM ${t.table} r WHERE `)
        .append(at(t, "r.", { layer, state: PUBLISHED }))
        .text(` AND r.${t.effect.sql} = '${STATED}' AND ${untouchedByDraft(t, "r")} AND (`)
        .append(unstatedInDraft(t.source, layer, `r.${t.sourceColumn.sql}`, "ys"))
        .text(" IS NOT NULL OR ")
        .append(unstatedInDraft(t.target, layer, `r.${t.targetColumn.sql}`, "yt"))
        .text(" IS NOT NULL) AND ")
        .append(endpointMissing(t, "r", view));
      arms.push(narrowed(one));
    } else {
      for (const side of ["source", "target"] as const) {
        arms.push(
          narrowed(
            new SqlFragments()
              .text(standing)
              .append(publishedAtWithdrawn(relationship, side, view)),
          ),
        );
      }
    }
  }

  // The published row beside each draft row, as it now stands: one scalar
  // probe per column for the rows the page keeps, never a join a planner
  // could answer by reading the layer's published range.
  const twin = (select: string) =>
    `(SELECT p.${select} FROM ${table.table} p WHERE p.${table.layer.sql} = c.${table.layer.sql} ` +
    `AND p.${table.state.sql} = '${PUBLISHED}' AND c.${quote(CONFLICT_ALIASES.state)} = '${DRAFT}'` +
    `${table.identity.map((column) => ` AND p.${column.sql} = c.${column.sql}`).join("")})`;
  const theirs = [
    `${twin(table.effect.sql)} AS ${quote(CONFLICT_ALIASES.theirsEffect)}`,
    `${twin(table.revision.sql)} AS ${quote(CONFLICT_ALIASES.theirsRevision)}`,
    ...table.columns.map((column, index) => `${twin(column.sql)} AS ${quote(theirsAlias(index))}`),
  ];
  const sql = new SqlFragments().text(`SELECT c.*, ${theirs.join(", ")} FROM (`);
  arms.forEach((arm, index) => sql.text(index === 0 ? "" : " UNION ALL ").append(arm));
  sql.text(`) c ORDER BY ${table.identity.map((column) => `c.${column.sql}`).join(", ")}`);
  if (narrowing.limit !== undefined) sql.text(" LIMIT ").value(narrowing.limit);
  return sql;
}
