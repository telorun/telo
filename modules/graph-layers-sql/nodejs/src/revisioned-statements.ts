import type { Actor } from "@telorun/graph-layers";
import { selectList, type Assignment, type CompiledColumn } from "./compiled-types.js";
import { DRAFT, PUBLISHED, RETRACTED, STATED } from "./declared-table.js";
import type { RowEffect } from "./drafted-statements.js";
import { inOrder, matchIdentity, unresolvedAmong, type StackView } from "./layer-overlay.js";
import type {
  RevisionedNode,
  RevisionedRelationship,
  RevisionedTable,
} from "./revisioned-tables.js";
import { SqlFragments } from "@telorun/sql";

/**
 * The statements of a revisioned table, where every row is one VERSION of one
 * layer's statement about one identity, written by exactly one changeset. A
 * changeset's rows are drafts until it is published — `from` is null — and
 * from then on a row is current from its `from` revision until its `to`.
 *
 * A row also records what lay BENEATH it when it was written: the id of the
 * winning row among the layer's bases, null when none stated the identity. A
 * pin is immutable, so what lies beneath a statement changes only when the
 * layer's base list does — and then that pointer no longer matches, which is
 * how a moved pin is detected for a published row and a draft's row alike.
 *
 * Three ranges are read, each through an index of its own, and every statement
 * names the one it reads:
 *
 * - a changeset's rows, through the unique `(changeset, identity…)` index — so
 *   whatever concerns a draft as a whole is driven from there;
 * - a layer's statement for an identity at a revision, through the index over
 *   PUBLISHED rows `(layer, identity…, from)`, which holds no draft row;
 * - one row by its own id.
 *
 * A value, a layer id, a changeset id, a row id and a revision are only ever
 * bound.
 */

/** A layer read at one of its revisions. */
export interface AsOf {
  readonly layer: string;
  readonly revision: bigint;
}

/** The bookkeeping a write leaves on a row. */
export interface VersionStamp {
  readonly effect: RowEffect;
  /** On a draft row, the id of the layer's own row it stands over. */
  readonly over: string | null;
  /** The id of the winning row among the layer's bases it stands over. */
  readonly beneath: string | null;
  readonly resolution: "mine" | "theirs" | "merged" | null;
  readonly resolvedBy: Actor | null;
}

/** A row being made: its own id, and where it belongs. `from` is the revision
 *  it is published at, null for a draft's row. */
export interface NewVersion extends VersionStamp {
  readonly id: string;
  readonly layer: string;
  readonly changeset: string;
  readonly from: bigint | null;
}

/** Stands in for "no row" where two row ids are compared null-safely; the
 *  engines spell null-safe comparison differently. No row ever has this id. */
const NO_ROW = "00000000-0000-0000-0000-000000000000";

function bound(sql: SqlFragments, value: unknown): SqlFragments {
  return value === null ? sql.text("NULL") : sql.value(value);
}

function returning(table: RevisionedTable): string {
  return ` RETURNING ${selectList(table, "")}`;
}

function bookkeeping(table: RevisionedTable, qualifier: string): string {
  return [
    table.row,
    table.effect,
    table.over,
    table.beneath,
    table.resolution,
    table.resolvedByType,
    table.resolvedById,
  ]
    .map((c) => `${qualifier}${c.sql}`)
    .join(", ");
}

/** `qualifier`'s row is the layer's statement current at the revision. */
export function currentAt(table: RevisionedTable, qualifier: string, at: AsOf): SqlFragments {
  const { from, to } = table.versions;
  return new SqlFragments()
    .text(`${qualifier}${table.layer.sql} = `)
    .value(at.layer)
    .text(` AND ${qualifier}${from.sql} IS NOT NULL AND ${qualifier}${from.sql} <= `)
    .value(at.revision)
    .text(` AND (${qualifier}${to.sql} IS NULL OR ${qualifier}${to.sql} > `)
    .value(at.revision)
    .text(")");
}

function inChangeset(table: RevisionedTable, qualifier: string, changeset: string): SqlFragments {
  return new SqlFragments().text(`${qualifier}${table.versions.changeset.sql} = `).value(changeset);
}

function sameIdentity(table: RevisionedTable, a: string, b: string): string {
  return table.identity.map((c) => `${a}.${c.sql} = ${b}.${c.sql}`).join(" AND ");
}

/** The id of the layer's row, current at the revision, for the identity of the
 *  row `of` — a scalar probe of the published index. */
function currentRowOf(table: RevisionedTable, at: AsOf, of: string, alias: string): SqlFragments {
  return new SqlFragments()
    .text(`(SELECT ${alias}.${table.row.sql} FROM ${table.table} ${alias} WHERE `)
    .append(currentAt(table, `${alias}.`, at))
    .text(` AND ${sameIdentity(table, alias, of)})`);
}

/**
 * What a layer says about one identity: its statement current at the revision
 * and, when a changeset is named, that changeset's row — each one index probe,
 * each row told apart by the state it is given.
 */
export function selectVersions(
  table: RevisionedTable,
  at: AsOf,
  changeset: string | undefined,
  identity: readonly unknown[],
): SqlFragments {
  const select = (state: string) =>
    `SELECT ${selectList(table, "")}, ${bookkeeping(table, "")}, '${state}' AS ${table.state.sql} ` +
    `FROM ${table.table} WHERE `;
  const sql = new SqlFragments()
    .text(select(PUBLISHED))
    .append(currentAt(table, "", at))
    .text(" AND ")
    .append(matchIdentity(table, "", identity));
  if (changeset === undefined) return sql;
  return sql
    .text(` UNION ALL ${select(DRAFT)}`)
    .append(inChangeset(table, "", changeset))
    .text(" AND ")
    .append(matchIdentity(table, "", identity));
}

function stampColumns(table: RevisionedTable): CompiledColumn[] {
  return [
    table.row,
    table.layer,
    table.versions.changeset,
    table.versions.from,
    table.effect,
    table.over,
    table.beneath,
    table.resolution,
    table.resolvedByType,
    table.resolvedById,
  ];
}

/** The values of {@link stampColumns}, in order. */
function stampValues(sql: SqlFragments, version: NewVersion): SqlFragments {
  sql.value(version.id).text(", ").value(version.layer).text(", ").value(version.changeset).text(", ");
  bound(sql, version.from).text(`, '${version.effect}', `);
  bound(sql, version.over).text(", ");
  bound(sql, version.beneath).text(", ");
  bound(sql, version.resolution).text(", ");
  bound(sql, version.resolvedBy?.type ?? null).text(", ");
  return bound(sql, version.resolvedBy?.id ?? null);
}

/** A changeset holds one row per identity; a second is not made. Written only
 *  on a draft's row: a published row is made under the layer's own row, which
 *  admits one writer at a time. */
function onceInChangeset(table: RevisionedTable, version: NewVersion): string {
  if (version.from !== null) return "";
  const target = [table.versions.changeset, ...table.identity].map((c) => c.sql).join(", ");
  return ` ON CONFLICT (${target}) DO NOTHING`;
}

/** A new row. For a draft's row, none is returned when the changeset already
 *  holds one for the identity. */
export function insertVersion(
  table: RevisionedTable,
  version: NewVersion,
  identity: readonly unknown[],
  assignments: readonly Assignment[],
): SqlFragments {
  const columns = [...stampColumns(table), ...table.identity, ...assignments.map((a) => a.column)]
    .map((c) => c.sql)
    .join(", ");
  const sql = new SqlFragments().text(`INSERT INTO ${table.table} (${columns}) VALUES (`);
  stampValues(sql, version)
    .text(", ")
    .valueList([...identity, ...assignments.map((a) => a.value)], ", ");
  return sql.text(`)${onceInChangeset(table, version)}${returning(table)}`);
}

/** A row holding what the row `from` holds, with `assignments` in place of the
 *  columns they name. */
export function copyVersion(
  table: RevisionedTable,
  version: NewVersion,
  from: string,
  assignments: readonly Assignment[],
): SqlFragments {
  const columns = [...stampColumns(table), ...table.columns].map((c) => c.sql).join(", ");
  const sql = new SqlFragments().text(`INSERT INTO ${table.table} (${columns}) SELECT `);
  stampValues(sql, version);
  for (const column of table.columns) {
    const assigned = assignments.find((a) => a.column.name === column.name);
    if (assigned) sql.text(", ").value(assigned.value);
    else sql.text(`, b.${column.sql}`);
  }
  return sql
    .text(` FROM ${table.table} b WHERE b.${table.row.sql} = `)
    .value(from)
    .text(`${onceInChangeset(table, version)}${returning(table)}`);
}

/** What a draft row stood on when a conflict on it was read: the layer's own
 *  row, and the row beneath. A decision applies only while both still hold. */
export interface StoodOn {
  readonly over: string | null;
  readonly beneath: string | null;
}

/** A row id as a condition: a null-safe equality written per value. */
function idIs(column: CompiledColumn, id: string | null): SqlFragments {
  return id === null
    ? new SqlFragments().text(`${column.sql} IS NULL`)
    : new SqlFragments().text(`${column.sql} = `).value(id);
}

function stillStandsOn(table: RevisionedTable, stoodOn: StoodOn): SqlFragments {
  return idIs(table.over, stoodOn.over).text(" AND ").append(idIs(table.beneath, stoodOn.beneath));
}

/** Changes a changeset's row for an identity in place. With `whileOn`, only
 *  while the row still stands on those rows — what makes a decision apply once. */
export function updateDraftVersion(
  table: RevisionedTable,
  changeset: string,
  identity: readonly unknown[],
  stamp: VersionStamp,
  assignments: readonly Assignment[],
  whileOn?: StoodOn,
): SqlFragments {
  const sql = new SqlFragments().text(`UPDATE ${table.table} SET `);
  for (const assignment of assignments) {
    bound(sql.text(`${assignment.column.sql} = `), assignment.value ?? null).text(", ");
  }
  sql.text(`${table.effect.sql} = '${stamp.effect}', ${table.over.sql} = `);
  bound(sql, stamp.over).text(`, ${table.beneath.sql} = `);
  bound(sql, stamp.beneath).text(`, ${table.resolution.sql} = `);
  bound(sql, stamp.resolution).text(`, ${table.resolvedByType.sql} = `);
  bound(sql, stamp.resolvedBy?.type ?? null).text(`, ${table.resolvedById.sql} = `);
  bound(sql, stamp.resolvedBy?.id ?? null)
    .text(" WHERE ")
    .append(inChangeset(table, "", changeset))
    .text(" AND ")
    .append(matchIdentity(table, "", identity));
  if (whileOn) sql.text(" AND ").append(stillStandsOn(table, whileOn));
  return sql.text(returning(table));
}

/** Stands a changeset's row on other rows — the layer's own row, or the row
 *  beneath, that it has been merged with — leaving what was decided about it
 *  as it was. Only the pointers given are moved. */
export function restandDraftVersion(
  table: RevisionedTable,
  changeset: string,
  identity: readonly unknown[],
  onto: { readonly over?: string | null; readonly beneath?: string | null },
  assignments: readonly Assignment[],
): SqlFragments {
  const sql = new SqlFragments().text(`UPDATE ${table.table} SET `);
  for (const assignment of assignments) {
    bound(sql.text(`${assignment.column.sql} = `), assignment.value ?? null).text(", ");
  }
  const pointers: [CompiledColumn, string | null][] = [];
  if (onto.over !== undefined) pointers.push([table.over, onto.over]);
  if (onto.beneath !== undefined) pointers.push([table.beneath, onto.beneath]);
  if (pointers.length === 0) throw new Error("A row is restood on at least one row.");
  pointers.forEach(([column, id], index) => {
    bound(sql.text(`${index === 0 ? "" : ", "}${column.sql} = `), id);
  });
  return sql
    .text(" WHERE ")
    .append(inChangeset(table, "", changeset))
    .text(" AND ")
    .append(matchIdentity(table, "", identity));
}

export function deleteDraftVersion(
  table: RevisionedTable,
  changeset: string,
  identity: readonly unknown[],
  whileOn?: StoodOn,
): SqlFragments {
  const sql = new SqlFragments()
    .text(`DELETE FROM ${table.table} WHERE `)
    .append(inChangeset(table, "", changeset))
    .text(" AND ")
    .append(matchIdentity(table, "", identity));
  if (whileOn) sql.text(" AND ").append(stillStandsOn(table, whileOn));
  return sql.text(returning(table));
}

/** Ends a published row at a revision: it is kept, and current no longer. */
export function closeVersion(table: RevisionedTable, row: string, revision: bigint): SqlFragments {
  return new SqlFragments()
    .text(`UPDATE ${table.table} SET ${table.versions.to.sql} = `)
    .value(revision)
    .text(` WHERE ${table.row.sql} = `)
    .value(row)
    .text(` AND ${table.versions.to.sql} IS NULL${returning(table)}`);
}

/** Outside a draft: ends every relationship the layer currently states at one
 *  endpoint. A relationship it hides there stays hidden. */
export function closeCurrentTouching(
  relationship: RevisionedRelationship,
  layer: string,
  endpoint: CompiledColumn,
  key: unknown,
  revision: bigint,
): SqlFragments {
  const { from, to } = relationship.versions;
  return new SqlFragments()
    .text(`UPDATE ${relationship.table} SET ${to.sql} = `)
    .value(revision)
    .text(` WHERE ${relationship.layer.sql} = `)
    .value(layer)
    .text(` AND ${endpoint.sql} = `)
    .value(key)
    .text(
      ` AND ${from.sql} IS NOT NULL AND ${to.sql} IS NULL AND ${relationship.effect.sql} = '${STATED}'`,
    );
}

/**
 * In a draft: the two statements that withdraw what the CHANGESET states at one
 * endpoint. A stated row over a statement the layer holds at the draft's
 * revision becomes its retraction; a stated row over none is dropped. Scalar
 * probes throughout: one index probe per draft row, whatever the planner.
 */
export function withdrawDraftTouching(
  relationship: RevisionedRelationship,
  at: AsOf,
  changeset: string,
  endpoint: CompiledColumn,
  key: unknown,
): SqlFragments[] {
  const t = relationship;
  const statedAt = (qualifier: string) =>
    inChangeset(t, qualifier, changeset)
      .text(` AND ${qualifier}${t.effect.sql} = '${STATED}' AND ${qualifier}${endpoint.sql} = `)
      .value(key);
  const retract = new SqlFragments()
    .text(`UPDATE ${t.table} AS d SET ${t.effect.sql} = '${RETRACTED}', ${t.over.sql} = `)
    .append(currentRowOf(t, at, "d", "p"))
    .text(" WHERE ")
    .append(statedAt("d."))
    .text(" AND ")
    .append(currentRowOf(t, at, "d", "p"))
    .text(" IS NOT NULL");
  const drop = new SqlFragments().text(`DELETE FROM ${t.table} WHERE `).append(statedAt(""));
  return [retract, drop];
}

/** In a draft: the relationships the layer states at one endpoint at the
 *  draft's revision and the changeset has no row for — each to be covered by a
 *  retraction. Returns each row's id. */
export function selectUncoveredTouching(
  relationship: RevisionedRelationship,
  at: AsOf,
  changeset: string,
  endpoint: CompiledColumn,
  key: unknown,
): SqlFragments {
  const t = relationship;
  return new SqlFragments()
    .text(`SELECT p.${t.row.sql} FROM ${t.table} p WHERE `)
    .append(currentAt(t, "p.", at))
    .text(` AND p.${t.effect.sql} = '${STATED}' AND p.${endpoint.sql} = `)
    .value(key)
    .text(" AND ")
    .append(untouchedBy(t, changeset, "p"));
}

/** The changeset has no row for the identity of `r`. */
function untouchedBy(table: RevisionedTable, changeset: string, r: string): SqlFragments {
  return new SqlFragments()
    .text(`(SELECT 1 FROM ${table.table} x WHERE `)
    .append(inChangeset(table, "x.", changeset))
    .text(` AND ${sameIdentity(table, "x", r)} LIMIT 1) IS NULL`);
}

/**
 * A draft row no longer stands on the layer's row it was written over: at the
 * revision, the layer's statement for the identity is another row, has
 * appeared, or is gone. `d` is the draft row's alias.
 */
function movedBeneath(table: RevisionedTable, at: AsOf, d: string): SqlFragments {
  return new SqlFragments()
    .text(`COALESCE(${d}.${table.over.sql}, '${NO_ROW}') <> COALESCE(`)
    .append(currentRowOf(table, at, d, "q"))
    .text(`, '${NO_ROW}')`);
}

/**
 * The id of the winning row for the identity of the row `of` among the layers
 * beneath, each read at the revision it is pinned to: the first of them, in
 * stack order, that holds a statement — one probe of each layer's published
 * range, made only when every layer above it holds none. Null with no base.
 */
export function beneathRowOf(
  table: RevisionedTable,
  beneath: readonly AsOf[],
  of: string,
  alias: string,
): SqlFragments {
  if (beneath.length === 0) return new SqlFragments().text("NULL");
  if (beneath.length === 1) return currentRowOf(table, beneath[0], of, alias);
  const sql = new SqlFragments().text("COALESCE(");
  beneath.forEach((at, index) => {
    sql.text(index === 0 ? "" : ", ").append(currentRowOf(table, at, of, `${alias}${index}`));
  });
  return sql.text(")");
}

/**
 * What lies beneath the row `d` is no longer the row it records: the winning
 * row among the layers beneath is another one, has appeared, or is gone. A
 * retraction states nothing, so nothing beneath can clash with it.
 */
function beneathMoved(table: RevisionedTable, beneath: readonly AsOf[], d: string): SqlFragments {
  const sql = new SqlFragments().text(`(${d}.${table.effect.sql} <> '${RETRACTED}' AND `);
  if (beneath.length === 0) return sql.text(`${d}.${table.beneath.sql} IS NOT NULL)`);
  return sql
    .text(`COALESCE(${d}.${table.beneath.sql}, '${NO_ROW}') <> COALESCE(`)
    .append(beneathRowOf(table, beneath, d, "u"))
    .text(`, '${NO_ROW}'))`);
}

export function anyDraftVersion(table: RevisionedTable, changeset: string): SqlFragments {
  return new SqlFragments()
    .text(`SELECT 1 AS found FROM ${table.table} WHERE `)
    .append(inChangeset(table, "", changeset))
    .text(" LIMIT 1");
}

/** The rows of a changeset the layer has moved under at the revision, or that
 *  no longer stand on what lies beneath them. */
export function countMoved(table: RevisionedTable, scope: DraftScope): SqlFragments {
  return new SqlFragments()
    .text(`SELECT COUNT(*) AS moved FROM ${table.table} d WHERE `)
    .append(inChangeset(table, "d.", scope.changeset))
    .text(" AND (")
    .append(movedBeneath(table, scope.at, "d"))
    .text(" OR ")
    .append(beneathMoved(table, scope.beneath, "d"))
    .text(")");
}

/**
 * Publishing: the changeset's rows become the layer's statements from
 * `revision`. The layer's current rows they replace are ended at it — reached
 * through the changeset's identities and the index of current rows, never by
 * reading the layer — a retraction leaves no row of its own, and every other
 * row of the changeset is current from now.
 *
 * The replaced rows are joined on identity, not on the row id a draft row
 * stands over: a planner sizing a join reads the ends of the joined index, and
 * with random row ids how many of those reads it makes varies from one run to
 * the next.
 */
export function publishVersions(
  table: RevisionedTable,
  layer: string,
  changeset: string,
  revision: bigint,
): SqlFragments[] {
  const { from, to } = table.versions;
  const identity = (qualifier: string) => table.identity.map((c) => `${qualifier}${c.sql}`).join(", ");
  const tuple = (columns: string) => (table.identity.length === 1 ? columns : `(${columns})`);
  const superseded = new SqlFragments()
    .text(`UPDATE ${table.table} SET ${to.sql} = `)
    .value(revision)
    .text(` WHERE ${table.layer.sql} = `)
    .value(layer)
    .text(` AND ${from.sql} IS NOT NULL AND ${to.sql} IS NULL`)
    .text(` AND ${tuple(identity(""))} IN (SELECT ${identity("d.")} FROM ${table.table} d WHERE `)
    .append(inChangeset(table, "d.", changeset))
    .text(")");
  const retracted = new SqlFragments()
    .text(`DELETE FROM ${table.table} WHERE `)
    .append(inChangeset(table, "", changeset))
    .text(` AND ${table.effect.sql} = '${RETRACTED}'`);
  const promoted = new SqlFragments()
    .text(`UPDATE ${table.table} SET ${from.sql} = `)
    .value(revision)
    .text(`, ${table.over.sql} = NULL WHERE `)
    .append(inChangeset(table, "", changeset));
  return [superseded, retracted, promoted];
}

export function discardVersions(table: RevisionedTable, changeset: string): SqlFragments {
  return new SqlFragments()
    .text(`DELETE FROM ${table.table} WHERE `)
    .append(inChangeset(table, "", changeset));
}

function endpointMissing(
  relationship: RevisionedRelationship,
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

/** The changeset withdraws the node `key` names: its row for it states nothing. */
function unstatedInDraft(
  node: RevisionedNode,
  changeset: string,
  key: string,
  alias: string,
): SqlFragments {
  return new SqlFragments()
    .text(`(SELECT 1 FROM ${node.table} ${alias} WHERE `)
    .append(inChangeset(node, `${alias}.`, changeset))
    .text(` AND ${alias}.${node.key.sql} = ${key} AND ${alias}.${node.effect.sql} <> '${STATED}')`);
}

/** What a draft-wide statement is read in: the draft's view, the layer at the
 *  revision the draft is compared with, the layers beneath it at the revisions
 *  they are pinned to, and the draft's changeset. */
export interface DraftScope {
  readonly view: StackView;
  readonly at: AsOf;
  readonly beneath: readonly AsOf[];
  readonly changeset: string;
}

/**
 * The relationships the layer states at the revision, and the changeset leaves
 * standing, at a node the changeset withdraws — reached from the node table's
 * changeset range through the published relationship index that leads on that
 * endpoint, never by reading the layer's relationships. `FROM … WHERE …` only;
 * `r` is the relationship. A relationship with both endpoints withdrawn is the
 * source side's, so the two sides never hold one twice.
 */
function publishedAtWithdrawn(
  relationship: RevisionedRelationship,
  side: "source" | "target",
  scope: DraftScope,
): SqlFragments {
  const t = relationship;
  const node = side === "source" ? t.source : t.target;
  const endpoint = side === "source" ? t.sourceColumn : t.targetColumn;
  const sql = new SqlFragments()
    .text(`FROM ${node.table} y JOIN ${t.table} r ON r.${endpoint.sql} = y.${node.key.sql} AND `)
    .append(currentAt(t, "r.", scope.at))
    .text(" WHERE ")
    .append(inChangeset(node, "y.", scope.changeset))
    .text(` AND y.${node.effect.sql} <> '${STATED}' AND r.${t.effect.sql} = '${STATED}' AND `);
  // One expression, so the probes run in this order whatever the table holds.
  const probes = [untouchedBy(t, scope.changeset, "r")];
  if (side === "target") {
    probes.push(
      unstatedInDraft(t.source, scope.changeset, `r.${t.sourceColumn.sql}`, "ys").text(" IS NULL"),
    );
  }
  probes.push(endpointMissing(t, "r", scope.view));
  return sql.append(inOrder(probes));
}

/** Which endpoints of a relationship type have a node the changeset withdraws.
 *  A side with none contributes no relationship the changeset leaves standing. */
export interface WithdrawnSides {
  readonly source: boolean;
  readonly target: boolean;
}

/** Whether the changeset withdraws any node of a type: one of its rows states
 *  nothing. Read from the changeset's own range. */
export function anyWithdrawnNode(node: RevisionedNode, changeset: string): SqlFragments {
  return new SqlFragments()
    .text(`SELECT 1 AS found FROM ${node.table} WHERE `)
    .append(inChangeset(node, "", changeset))
    .text(` AND ${node.effect.sql} <> '${STATED}' LIMIT 1`);
}

/**
 * The relationships the draft's view states with an endpoint that does not
 * resolve in it, as two driven sets: the changeset's own stated relationships
 * the layer has not moved under, and the layer's relationships at a node the
 * changeset withdraws — asked only for a side the changeset withdraws a node
 * of.
 */
export function countEndpointMissing(
  relationship: RevisionedRelationship,
  scope: DraftScope,
  withdrawn: WithdrawnSides,
): SqlFragments {
  const t = relationship;
  const sql = new SqlFragments()
    .text(`SELECT COUNT(*) AS missing FROM (SELECT 1 AS found FROM ${t.table} r WHERE `)
    .append(inChangeset(t, "r.", scope.changeset))
    .text(` AND r.${t.effect.sql} = '${STATED}' AND `)
    .append(
      inOrder([
        new SqlFragments()
          .text("NOT (")
          .append(movedBeneath(t, scope.at, "r"))
          .text(" OR ")
          .append(beneathMoved(t, scope.beneath, "r"))
          .text(")"),
        endpointMissing(t, "r", scope.view),
      ]),
    );
  for (const side of ["source", "target"] as const) {
    if (withdrawn[side]) sql.text(" UNION ALL SELECT 1 ").append(publishedAtWithdrawn(t, side, scope));
  }
  return sql.text(") c");
}

/** Result aliases of a candidate listing, beside the row's own columns. */
export const CANDIDATE_ALIASES = {
  row: "graph_c_row",
  state: "graph_c_state",
  effect: "graph_c_effect",
  over: "graph_c_over",
  theirs: "graph_c_theirs",
  beneath: "graph_c_beneath",
  beneathNow: "graph_c_beneath_now",
  missing: "graph_c_missing",
  sourceRow: "graph_c_source_row",
  targetRow: "graph_c_target_row",
} as const;

/** What narrows a candidate listing: one identity, or the position past a
 *  cursor. Each is written against the alias `r`. */
export interface CandidateNarrowing {
  readonly identity?: readonly unknown[];
  readonly seek?: () => SqlFragments;
  readonly limit?: number;
  /** Only the changeset's rows the layer has moved under or that no longer
   *  stand on what lies beneath them: what a rebase or a pin move merges.
   *  Missing endpoints are then neither sought nor read. */
  readonly movedOnly?: boolean;
  /** For a relationship listing: the sides the changeset withdraws a node of.
   *  Absent, both are read. */
  readonly withdrawn?: WithdrawnSides;
}

/** The id of the row the draft's view reads for a node key: the changeset's,
 *  else the layer's at the revision, else the first beneath. */
function viewedRow(node: RevisionedNode, scope: DraftScope, key: string): SqlFragments {
  const sql = new SqlFragments()
    .text(`COALESCE((SELECT a.${node.row.sql} FROM ${node.table} a WHERE `)
    .append(inChangeset(node, "a.", scope.changeset))
    .text(` AND a.${node.key.sql} = ${key})`);
  for (const at of [scope.at, ...scope.beneath]) {
    sql
      .text(`, (SELECT a.${node.row.sql} FROM ${node.table} a WHERE `)
      .append(currentAt(node, "a.", at))
      .text(` AND a.${node.key.sql} = ${key})`);
  }
  return sql.text(")");
}

/**
 * A draft's conflict candidates on a table, in identity order. Two driven
 * sets, neither a filter over the layer's rows:
 *
 * - the changeset's own rows the layer has moved under, or that no longer stand
 *   on what lies beneath them, each with the id of the layer's row and of the
 *   row beneath as they now stand — and, for a relationship, its own stated
 *   rows with an endpoint that does not resolve;
 * - for a relationship, the layer's rows the changeset leaves standing at a
 *   node the changeset withdraws, when an endpoint does not resolve.
 *
 * Which candidates are conflicts, and of which class, is decided from the
 * rows themselves — the draft's, the layer's and their ancestor — which the
 * caller reads by id. Conflicts are not stored, so the statement reads the
 * changeset and those relationships whole before it orders and cuts the page.
 */
export function selectCandidates(
  table: RevisionedTable,
  scope: DraftScope,
  quote: (name: string) => string,
  narrowing: CandidateNarrowing,
): SqlFragments {
  const relationship =
    "sourceColumn" in table && !narrowing.movedOnly ? (table as RevisionedRelationship) : undefined;
  const alias = Object.fromEntries(
    Object.entries(CANDIDATE_ALIASES).map(([key, name]) => [key, quote(name)]),
  ) as Record<keyof typeof CANDIDATE_ALIASES, string>;
  const narrowed = (sql: SqlFragments): SqlFragments => {
    if (narrowing.identity) sql.text(" AND ").append(matchIdentity(table, "r.", narrowing.identity));
    if (narrowing.seek) sql.text(" AND ").append(narrowing.seek());
    return sql;
  };
  const own = `SELECT ${selectList(table, "r")}, r.${table.row.sql} AS ${alias.row}, `;

  // The changeset's own rows.
  const drafted = new SqlFragments()
    .text(`${own}'${DRAFT}' AS ${alias.state}, r.${table.effect.sql} AS ${alias.effect}, `)
    .text(`r.${table.over.sql} AS ${alias.over}, `)
    .append(currentRowOf(table, scope.at, "r", "q"))
    .text(` AS ${alias.theirs}, r.${table.beneath.sql} AS ${alias.beneath}, `)
    .append(beneathRowOf(table, scope.beneath, "r", "v"))
    .text(` AS ${alias.beneathNow}, `);
  if (relationship) {
    drafted
      .text("CASE WHEN ")
      .append(endpointMissing(relationship, "r", scope.view))
      .text(` THEN 1 ELSE 0 END AS ${alias.missing}`);
  } else {
    drafted.text(`0 AS ${alias.missing}`);
  }
  drafted
    .text(` FROM ${table.table} r WHERE `)
    .append(inChangeset(table, "r.", scope.changeset))
    .text(" AND (")
    .append(movedBeneath(table, scope.at, "r"))
    .text(" OR ")
    .append(beneathMoved(table, scope.beneath, "r"));
  if (relationship) {
    drafted
      .text(` OR (r.${table.effect.sql} = '${STATED}' AND `)
      .append(endpointMissing(relationship, "r", scope.view))
      .text(")");
  }
  const arms = [narrowed(drafted.text(")"))];

  if (relationship) {
    // The layer's rows the changeset leaves standing; the endpoint is known to
    // be missing.
    const t = relationship;
    const standing =
      `${own}'${PUBLISHED}' AS ${alias.state}, r.${t.effect.sql} AS ${alias.effect}, ` +
      `NULL AS ${alias.over}, NULL AS ${alias.theirs}, NULL AS ${alias.beneath}, ` +
      `NULL AS ${alias.beneathNow}, 1 AS ${alias.missing} `;
    if (narrowing.identity) {
      // One relationship: probed directly, then asked whether either endpoint
      // is a node the changeset withdraws.
      const one = new SqlFragments()
        .text(`${standing}FROM ${t.table} r WHERE `)
        .append(currentAt(t, "r.", scope.at))
        .text(` AND r.${t.effect.sql} = '${STATED}' AND `)
        .append(
          inOrder([
            untouchedBy(t, scope.changeset, "r"),
            new SqlFragments()
              .text("(")
              .append(unstatedInDraft(t.source, scope.changeset, `r.${t.sourceColumn.sql}`, "ys"))
              .text(" IS NOT NULL OR ")
              .append(unstatedInDraft(t.target, scope.changeset, `r.${t.targetColumn.sql}`, "yt"))
              .text(" IS NOT NULL)"),
            endpointMissing(t, "r", scope.view),
          ]),
        );
      arms.push(narrowed(one));
    } else {
      for (const side of ["source", "target"] as const) {
        if (narrowing.withdrawn && !narrowing.withdrawn[side]) continue;
        arms.push(
          narrowed(new SqlFragments().text(standing).append(publishedAtWithdrawn(t, side, scope))),
        );
      }
    }
  }

  const sql = new SqlFragments().text("SELECT c.*");
  if (relationship) {
    // What each endpoint resolves to, read only for the rows the page keeps.
    sql
      .text(", ")
      .append(viewedRow(relationship.source, scope, `c.${relationship.sourceColumn.sql}`))
      .text(` AS ${alias.sourceRow}, `)
      .append(viewedRow(relationship.target, scope, `c.${relationship.targetColumn.sql}`))
      .text(` AS ${alias.targetRow}`);
  }
  sql.text(" FROM (");
  arms.forEach((arm, index) => sql.text(index === 0 ? "" : " UNION ALL ").append(arm));
  sql.text(`) c ORDER BY ${table.identity.map((column) => `c.${column.sql}`).join(", ")}`);
  if (narrowing.limit !== undefined) sql.text(" LIMIT ").value(narrowing.limit);
  return sql;
}

/**
 * A pin move's walk of the statements the layer makes at the revision and the
 * changeset leaves standing, in identity order: those that no longer stand on
 * what lies beneath them, each with the id of the row now beneath — and, for a
 * relationship, those with an endpoint that does not resolve in the scope's
 * view. Driven from the layer's own published range, one probe of each layer
 * beneath per row: it reads what the layer states, never what a base holds.
 */
export function selectStanding(
  table: RevisionedTable,
  scope: DraftScope,
  quote: (name: string) => string,
  narrowing: Pick<CandidateNarrowing, "identity" | "seek" | "limit">,
): SqlFragments {
  const relationship = "sourceColumn" in table ? (table as RevisionedRelationship) : undefined;
  const alias = Object.fromEntries(
    Object.entries(CANDIDATE_ALIASES).map(([key, name]) => [key, quote(name)]),
  ) as Record<keyof typeof CANDIDATE_ALIASES, string>;
  const sql = new SqlFragments()
    .text(`SELECT ${selectList(table, "r")}, r.${table.row.sql} AS ${alias.row}, `)
    .text(`'${PUBLISHED}' AS ${alias.state}, r.${table.effect.sql} AS ${alias.effect}, `)
    .text(`NULL AS ${alias.over}, NULL AS ${alias.theirs}, `)
    .text(`r.${table.beneath.sql} AS ${alias.beneath}, `)
    .append(beneathRowOf(table, scope.beneath, "r", "v"))
    .text(` AS ${alias.beneathNow}, `);
  const missing = () =>
    new SqlFragments()
      .text(`(r.${table.effect.sql} = '${STATED}' AND `)
      .append(endpointMissing(relationship!, "r", scope.view))
      .text(")");
  if (relationship) sql.text("CASE WHEN ").append(missing()).text(` THEN 1 ELSE 0 END AS ${alias.missing}`);
  else sql.text(`0 AS ${alias.missing}`);
  sql
    .text(` FROM ${table.table} r WHERE `)
    .append(currentAt(table, "r.", scope.at))
    .text(" AND ");
  const judged = new SqlFragments().text("(").append(beneathMoved(table, scope.beneath, "r"));
  if (relationship) judged.text(" OR ").append(missing());
  // One expression, so the probes run in this order whatever the table holds.
  sql.append(inOrder([untouchedBy(table, scope.changeset, "r"), judged.text(")")]));
  if (narrowing.identity) sql.text(" AND ").append(matchIdentity(table, "r.", narrowing.identity));
  if (narrowing.seek) sql.text(" AND ").append(narrowing.seek());
  sql.text(` ORDER BY ${table.identity.map((column) => `r.${column.sql}`).join(", ")}`);
  if (narrowing.limit !== undefined) sql.text(" LIMIT ").value(narrowing.limit);
  return sql;
}

/** Rows by their own ids, with their effect: the layer's row and the ancestor
 *  a candidate is judged against. */
export function selectVersionsById(table: RevisionedTable, ids: readonly string[]): SqlFragments {
  return new SqlFragments()
    .text(
      `SELECT ${selectList(table, "")}, ${table.row.sql}, ${table.effect.sql} ` +
        `FROM ${table.table} WHERE ${table.row.sql} IN (`,
    )
    .valueList(ids, ", ")
    .text(")");
}
