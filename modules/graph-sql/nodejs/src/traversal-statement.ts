import type { GraphFilter, PreparedTraversal, TraversalDirection, TraversalSpec } from "@telorun/graph";
import type { CompiledNode, CompiledRelationship } from "./compiled-types.js";
import { filterConditions } from "./compiled-types.js";
import { pageLimit } from "./graph-statements.js";
import { SqlFragments } from "@telorun/sql";

export interface CompiledHop {
  readonly relationship: CompiledRelationship;
  readonly direction: TraversalDirection;
  readonly minHops: number;
  readonly maxHops: number;
}

/**
 * One traversal, compiled when its operation is created: every identifier is
 * fixed, and a call adds only the start key, the end-node filter and paging.
 */
export interface SqlPreparedTraversal extends PreparedTraversal {
  /** The CTE chain, up to the start key's gap and after it. */
  readonly headBefore: string;
  readonly headAfter: string;
  readonly start: string;
  readonly last: string;
  readonly end: CompiledNode;
  readonly presentAlias: string;
  readonly quote: (name: string) => string;
}

/** A name no table the query touches uses, so a CTE never shadows one. */
function unusedName(base: string, taken: ReadonlySet<string>): string {
  let name = base;
  while (taken.has(name)) name += "_";
  return name;
}

/** `(SELECT <from> AS a, <to> AS b FROM <edges>)` — the pairs a hop may take in
 *  its direction, so one join shape serves every direction. */
function adjacency(
  hop: CompiledHop,
  quote: (name: string) => string,
): string {
  const { table, sourceColumn: s, targetColumn: t } = hop.relationship;
  const a = quote("a");
  const b = quote("b");
  const out = `SELECT ${s.sql} AS ${a}, ${t.sql} AS ${b} FROM ${table}`;
  const back = `SELECT ${t.sql} AS ${a}, ${s.sql} AS ${b} FROM ${table}`;
  switch (hop.direction) {
    case "out":
      return `(${out})`;
    case "in":
      return `(${back})`;
    case "both":
      return `(${out} UNION ALL ${back})`;
  }
}

/**
 * The chain as CTEs over key sets: the start node, then one set per hop. A hop
 * taken once is a join against the previous set; a repeated hop is a recursive
 * CTE over (key, depth) bounded by its `maxHops`, and `UNION` de-duplicates on
 * that pair, so a cycle ends when the depth bound is reached rather than never.
 */
export function prepareTraversal(
  spec: TraversalSpec,
  start: CompiledNode,
  end: CompiledNode,
  hops: readonly CompiledHop[],
  tableNames: ReadonlySet<string>,
  quote: (name: string) => string,
): SqlPreparedTraversal {
  const k = quote("k");
  const d = quote("d");
  const a = quote("a");
  const b = quote("b");
  const stepName = (suffix: string) => quote(unusedName(`telo_graph_${suffix}`, tableNames));

  const startName = stepName("start");
  const headBefore =
    `WITH RECURSIVE ${startName} (${k}) AS ` +
    `(SELECT ${start.key.sql} FROM ${start.table} WHERE ${start.key.sql} = `;
  let headAfter = ")";
  let previous = startName;

  hops.forEach((hop, index) => {
    const edges = adjacency(hop, quote);
    const reached = stepName(`hop_${index}`);
    if (hop.maxHops === 1) {
      headAfter +=
        `, ${reached} (${k}) AS (SELECT DISTINCT e.${b} FROM ${edges} e ` +
        `JOIN ${previous} p ON e.${a} = p.${k})`;
    } else {
      const walk = stepName(`walk_${index}`);
      headAfter +=
        `, ${walk} (${k}, ${d}) AS (SELECT p.${k}, 0 FROM ${previous} p ` +
        `UNION SELECT e.${b}, w.${d} + 1 FROM ${walk} w JOIN ${edges} e ON e.${a} = w.${k} ` +
        `WHERE w.${d} < ${hop.maxHops})` +
        `, ${reached} (${k}) AS (SELECT DISTINCT w.${k} FROM ${walk} w ` +
        `WHERE w.${d} >= ${hop.minHops})`;
    }
    previous = reached;
  });

  const columns = new Set([end.key.name, ...end.properties.keys()]);
  return {
    spec,
    headBefore,
    headAfter,
    start: startName,
    last: previous,
    end,
    presentAlias: unusedName("telo_graph_start_present", columns),
    quote,
  };
}

/**
 * The call: the start key, then one page of the end nodes reached, in key order.
 * The whole reach is walked on every page — the walk is what finds the end keys —
 * and the page is cut from those keys: the ones after the cursor, and, when no
 * property filter has to read the nodes first, only the page's own. The start
 * set's size rides on a one-row outer select, so an absent start node is told
 * apart from one that reaches nothing.
 */
export function traversalStatement(
  describe: string,
  typeName: string,
  prepared: SqlPreparedTraversal,
  key: unknown,
  where: GraphFilter,
  limit: number,
  after: unknown,
): SqlFragments {
  const { end, quote, last } = prepared;
  const k = quote("k");
  const n = "n";
  const conditions = filterConditions(describe, typeName, where, end.properties, "");
  const sql = new SqlFragments()
    .text(prepared.headBefore)
    .value(key)
    .text(prepared.headAfter)
    .text(
      ` SELECT c.${quote("present")} AS ${quote(prepared.presentAlias)}, ` +
        [end.key, ...end.properties.values()].map((c) => `${n}.${c.sql}`).join(", ") +
        ` FROM (SELECT COUNT(*) AS ${quote("present")} FROM ${prepared.start}) c` +
        ` LEFT JOIN (SELECT ${end.returning} FROM ${end.table}` +
        ` WHERE ${end.key.sql} IN (SELECT ${k} FROM ${last}`,
    );
  if (after !== undefined) sql.text(` WHERE ${k} > `).value(after);
  if (conditions.length === 0) sql.text(` ORDER BY ${k}`).append(pageLimit(limit));
  sql.text(")");
  for (const condition of conditions) sql.text(" AND ").append(condition);
  return sql
    .text(` ORDER BY ${end.key.sql}`)
    .append(pageLimit(limit))
    .text(`) ${n} ON 1 = 1 ORDER BY ${n}.${end.key.sql}`);
}
