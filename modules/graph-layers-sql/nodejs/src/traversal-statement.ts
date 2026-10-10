import type { GraphFilter, PreparedTraversal, TraversalDirection, TraversalSpec } from "@telorun/graph";
import {
  selectList,
  type CompiledNode,
  type CompiledRelationship,
} from "./compiled-types.js";
import {
  resolvesAmong,
  rowRef,
  rowsOf,
  seenInView,
  viewArms,
  type RowRef,
  type StackView,
} from "./layer-overlay.js";
import { filterConditions } from "./compiled-types.js";
import { SqlFragments } from "@telorun/sql";

export interface CompiledHop {
  readonly relationship: CompiledRelationship;
  readonly direction: TraversalDirection;
  readonly minHops: number;
  readonly maxHops: number;
}

/**
 * One traversal, compiled when its operation is created: every identifier is
 * fixed, and a call adds only the stack, the start key, the end-node filter
 * and paging.
 */
export interface LayeredPreparedTraversal extends PreparedTraversal {
  readonly start: CompiledNode;
  readonly end: CompiledNode;
  readonly hops: readonly CompiledHop[];
  /** A name for each CTE that no table the query touches uses. */
  readonly stepName: (suffix: string) => string;
  readonly presentAlias: string;
  readonly quote: (name: string) => string;
}

/** A name no table the query touches uses, so a CTE never shadows one. */
function unusedName(base: string, taken: ReadonlySet<string>): string {
  let name = base;
  while (taken.has(name)) name += "_";
  return name;
}

export function prepareTraversal(
  spec: TraversalSpec,
  start: CompiledNode,
  end: CompiledNode,
  hops: readonly CompiledHop[],
  tableNames: ReadonlySet<string>,
  quote: (name: string) => string,
): LayeredPreparedTraversal {
  return {
    spec,
    start,
    end,
    hops,
    stepName: (suffix) => quote(unusedName(`telo_graph_${suffix}`, tableNames)),
    presentAlias: unusedName(
      "telo_graph_start_present",
      new Set([...end.columns.map((c) => c.name), end.layer.name]),
    ),
    quote,
  };
}

/**
 * The rows a hop may take, in its direction: `a` is where it is entered and `b`
 * where it leaves, beside the row's own identity and layer bookkeeping so the
 * overlay is decided per row. Only base scans sit under the `UNION ALL`, so the
 * join that enters it reaches each through its index.
 */
function edges(
  hop: CompiledHop,
  view: StackView,
  quote: (name: string) => string,
): { sql: string; row: RowRef } {
  const { table, sourceColumn: s, targetColumn: t, layer, effect, versions } = hop.relationship;
  const [a, b, x, y, l, f, z, g, u, v, c] = ["a", "b", "x", "y", "l", "f", "z", "g", "u", "v", "c"].map(quote);
  // One bare scan per direction — and, where the table keeps every version,
  // per layer of the view and for the draft, each tagging its rows with the
  // state and the place in the stack it stands for.
  const arms = viewArms(hop.relationship, view);
  const scans: string[] = [];
  const scan = (enter: string, leave: string) => {
    for (const arm of arms) {
      scans.push(
        `SELECT ${enter} AS ${a}, ${leave} AS ${b}, ${s.sql} AS ${x}, ${t.sql} AS ${y}, ` +
          `${layer.sql} AS ${l}, ${effect.sql} AS ${f}` +
          (arm.state ? `, ${arm.state} AS ${z}` : "") +
          (arm.place ? `, ${arm.place} AS ${c}` : "") +
          (versions
            ? `, ${versions.changeset.sql} AS ${g}, ${versions.from.sql} AS ${u}, ${versions.to.sql} AS ${v}`
            : "") +
          ` FROM ${table}`,
      );
    }
  };
  if (hop.direction !== "in") scan(s.sql, t.sql);
  if (hop.direction !== "out") scan(t.sql, s.sql);
  return {
    sql: `(${scans.join(" UNION ALL ")})`,
    row: {
      layer: `e.${l}`,
      effect: `e.${f}`,
      identity: [`e.${x}`, `e.${y}`],
      ...(arms[0].state ? { state: `e.${z}` } : {}),
      ...(arms[0].place ? { place: `e.${c}` } : {}),
      ...(versions ? { versions: { changeset: `e.${g}`, from: `e.${u}`, to: `e.${v}` } } : {}),
    },
  };
}

/** `row` is one the view reads, and the visible winner for its identity —
 *  and, with `also`, a row those further probes hold for. */
function seen(
  table: CompiledNode | CompiledRelationship,
  row: RowRef,
  view: StackView,
  also: readonly SqlFragments[] = [],
): SqlFragments {
  return seenInView(table, row, view, "h", also);
}

/**
 * The call, as one statement over the resolved node and relationship sets: the
 * start node as the stack resolves it, one key set per hop — each relationship
 * row followed only when it is the visible winner for its pair and the node it
 * leads to resolves — then one page of the end nodes the stack resolves among
 * the keys reached, in key order. Every set therefore holds resolved nodes
 * only, so a walk neither ends on nor passes through a node the view lacks,
 * and each reached node is resolved once.
 *
 * A hop taken once is a join against the previous set; a repeated hop is a
 * recursive CTE over (key, depth) bounded by its `maxHops`, where `UNION`
 * de-duplicates on that pair, so a cycle ends at the depth bound. The start
 * set's size rides on a one-row outer select, so an absent start node is told
 * apart from one that reaches nothing.
 */
export function traversalStatement(
  describe: string,
  typeName: string,
  prepared: LayeredPreparedTraversal,
  view: StackView,
  key: unknown,
  where: GraphFilter,
  limit: number,
  after: unknown,
): SqlFragments {
  const { start, end, quote, stepName } = prepared;
  const k = quote("k");
  const d = quote("d");
  const a = quote("a");
  const b = quote("b");

  const startName = stepName("start");
  const sql = new SqlFragments()
    .text(`WITH RECURSIVE ${startName} (${k}) AS (SELECT n.${start.key.sql} FROM `)
    .append(rowsOf(start, view))
    .text(` n WHERE n.${start.key.sql} = `)
    .value(key)
    .text(" AND ")
    .append(seen(start, rowRef(start, "n"), view))
    .text(")");

  let previous = startName;
  prepared.hops.forEach((hop, index) => {
    const e = edges(hop, view, quote);
    const reached = stepName(`hop_${index}`);
    // `both` joins one node type, so the node a hop leaves at is its target's
    // type unless the hop is followed backwards.
    const left = hop.direction === "in" ? hop.relationship.source : hop.relationship.target;
    const resolves = () => resolvesAmong(left, `e.${b}`, view, "m");
    const last = index === prepared.hops.length - 1;
    if (hop.maxHops === 1) {
      // The page select resolves the keys the last hop reaches.
      sql
        .text(
          `, ${reached} (${k}) AS (SELECT DISTINCT e.${b} FROM ${e.sql} e ` +
            `JOIN ${previous} p ON e.${a} = p.${k} WHERE `,
        )
        .append(seen(hop.relationship, e.row, view, last ? [] : [resolves()]))
        .text(")");
    } else {
      const walk = stepName(`walk_${index}`);
      sql
        .text(
          `, ${walk} (${k}, ${d}) AS (SELECT p.${k}, 0 FROM ${previous} p ` +
            `UNION SELECT e.${b}, w.${d} + 1 FROM ${walk} w JOIN ${e.sql} e ON e.${a} = w.${k} ` +
            `WHERE w.${d} < ${hop.maxHops} AND `,
        )
        .append(seen(hop.relationship, e.row, view, [resolves()]))
        .text(
          `), ${reached} (${k}) AS (SELECT DISTINCT w.${k} FROM ${walk} w ` +
            `WHERE w.${d} >= ${hop.minHops})`,
        );
    }
    previous = reached;
  });

  const present = quote("present");
  sql
    .text(
      ` SELECT c.${present} AS ${quote(prepared.presentAlias)}, ${selectList(end, "n")}` +
        ` FROM (SELECT COUNT(*) AS ${present} FROM ${startName}) c` +
        ` LEFT JOIN (SELECT ${selectList(end, "n")} FROM `,
    )
    .append(rowsOf(end, view))
    .text(` n WHERE n.${end.key.sql} IN (SELECT ${k} FROM ${previous}`);
  if (after !== undefined) sql.text(` WHERE ${k} > `).value(after);
  sql.text(") AND ").append(seen(end, rowRef(end, "n"), view));
  for (const condition of filterConditions(describe, typeName, where, end.properties, "n.")) {
    sql.text(" AND ").append(condition);
  }
  return sql
    .text(` ORDER BY n.${end.key.sql} LIMIT `)
    .value(limit + 1)
    .text(`) n ON 1 = 1 ORDER BY n.${end.key.sql}`);
}
