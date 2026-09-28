import type { CompiledColumn, CompiledNode, CompiledRelationship } from "./compiled-types.js";
import { SqlFragments } from "./sql-fragments.js";

/**
 * Every node and relationship statement, in the one grammar both engines speak:
 * `INSERT … ON CONFLICT … RETURNING`, `UPDATE` / `DELETE … RETURNING`. Each is a
 * single statement whose returned rows ARE the outcome — no row where a conflict
 * was skipped or nothing matched — so no driver error is ever read for meaning.
 */

export interface Assignment {
  readonly column: CompiledColumn;
  readonly value: unknown;
}

/** `SET a = excluded.a, …`, or the key set to itself when nothing is given, so
 *  a conflicting row is still RETURNED. */
function upsertAssignments(assignments: readonly Assignment[], fallback: CompiledColumn): string {
  const columns = assignments.length > 0 ? assignments.map((a) => a.column) : [fallback];
  return columns.map((c) => `${c.sql} = excluded.${c.sql}`).join(", ");
}

/** The required columns a merge was not given. */
function carried(
  required: readonly CompiledColumn[],
  assignments: readonly Assignment[],
): CompiledColumn[] {
  return required.filter((column) => !assignments.some((a) => a.column.name === column.name));
}

export function insertNode(
  node: CompiledNode,
  key: unknown,
  assignments: readonly Assignment[],
  onConflict: "nothing" | "update",
): SqlFragments {
  // A merge proposes the stored value for each required column it was not
  // given — the row is checked before the conflict is, so leaving one out
  // refuses the update of an existing node. On a new node the value reads NULL
  // and the engine refuses the insert, which is the right answer.
  const kept = onConflict === "update" ? carried(node.required, assignments) : [];
  const columns = [node.key, ...assignments.map((a) => a.column), ...kept]
    .map((c) => c.sql)
    .join(", ");
  const sql = new SqlFragments()
    .text(`INSERT INTO ${node.table} (${columns}) VALUES (`)
    .valueList([key, ...assignments.map((a) => a.value)], ", ");
  for (const column of kept) {
    sql
      .text(`, (SELECT ${column.sql} FROM ${node.table} WHERE ${node.key.sql} = `)
      .value(key)
      .text(")");
  }
  sql.text(`) ON CONFLICT (${node.key.sql}) `);
  sql.text(
    onConflict === "nothing"
      ? "DO NOTHING"
      : `DO UPDATE SET ${upsertAssignments(assignments, node.key)}`,
  );
  return sql.text(` RETURNING ${node.returning}`);
}

export function updateNode(
  node: CompiledNode,
  key: unknown,
  assignments: readonly Assignment[],
): SqlFragments {
  const sql = new SqlFragments().text(`UPDATE ${node.table} SET `);
  assignments.forEach((assignment, index) => {
    sql.text(`${index === 0 ? "" : ", "}${assignment.column.sql} = `).value(assignment.value);
  });
  return sql
    .text(` WHERE ${node.key.sql} = `)
    .value(key)
    .text(` RETURNING ${node.returning}`);
}

export function deleteNode(node: CompiledNode, key: unknown): SqlFragments {
  return new SqlFragments()
    .text(`DELETE FROM ${node.table} WHERE ${node.key.sql} = `)
    .value(key)
    .text(` RETURNING ${node.returning}`);
}

export function selectNode(node: CompiledNode, key: unknown): SqlFragments {
  return new SqlFragments()
    .text(`SELECT ${node.returning} FROM ${node.table} WHERE ${node.key.sql} = `)
    .value(key);
}

/**
 * The paging tail. A statement always carries both clauses — SQLite admits no
 * `OFFSET` without a `LIMIT`, PostgreSQL no negative one — so an unset limit is
 * the largest integer both bind exactly.
 */
export function paging(limit: number | undefined, offset: number | undefined): SqlFragments {
  return new SqlFragments()
    .text(" LIMIT ")
    .value(limit ?? Number.MAX_SAFE_INTEGER)
    .text(" OFFSET ")
    .value(offset ?? 0);
}

/**
 * Inserts a relationship only where BOTH endpoints exist: the endpoint keys are
 * read from the node tables, so an absent endpoint yields no row to insert and
 * the statement returns nothing, exactly as a skipped conflict does. The caller
 * tells the two apart with one follow-up read.
 */
export function insertRelationship(
  relationship: CompiledRelationship,
  source: unknown,
  target: unknown,
  assignments: readonly Assignment[],
  onConflict: "nothing" | "update",
): SqlFragments {
  const { source: from, target: to } = relationship;
  const kept = onConflict === "update" ? carried(relationship.required, assignments) : [];
  const columns = [
    relationship.sourceColumn,
    relationship.targetColumn,
    ...assignments.map((a) => a.column),
    ...kept,
  ]
    .map((c) => c.sql)
    .join(", ");
  const sql = new SqlFragments()
    .text(`INSERT INTO ${relationship.table} (${columns}) SELECT s.${from.key.sql}, t.${to.key.sql}`);
  for (const assignment of assignments) sql.text(", ").value(assignment.value);
  for (const column of kept) {
    sql.text(
      `, (SELECT x.${column.sql} FROM ${relationship.table} x WHERE ` +
        `x.${relationship.sourceColumn.sql} = s.${from.key.sql} AND ` +
        `x.${relationship.targetColumn.sql} = t.${to.key.sql})`,
    );
  }
  sql
    .text(` FROM ${from.table} s, ${to.table} t WHERE s.${from.key.sql} = `)
    .value(source)
    .text(` AND t.${to.key.sql} = `)
    .value(target)
    .text(
      ` ON CONFLICT (${relationship.sourceColumn.sql}, ${relationship.targetColumn.sql}) `,
    )
    .text(
      onConflict === "nothing"
        ? "DO NOTHING"
        : `DO UPDATE SET ${upsertAssignments(assignments, relationship.sourceColumn)}`,
    );
  return sql.text(` RETURNING ${relationship.returning}`);
}

/** Which endpoints exist — read only after an insert returned nothing. */
export function endpointsPresent(
  relationship: CompiledRelationship,
  quote: (name: string) => string,
  source: unknown,
  target: unknown,
): SqlFragments {
  const { source: from, target: to } = relationship;
  return new SqlFragments()
    .text(`SELECT CASE WHEN EXISTS (SELECT 1 FROM ${from.table} WHERE ${from.key.sql} = `)
    .value(source)
    .text(`) THEN 1 ELSE 0 END AS ${quote("source")}, `)
    .text(`CASE WHEN EXISTS (SELECT 1 FROM ${to.table} WHERE ${to.key.sql} = `)
    .value(target)
    .text(`) THEN 1 ELSE 0 END AS ${quote("target")}`);
}

function matchPair(relationship: CompiledRelationship, source: unknown, target: unknown): SqlFragments {
  return new SqlFragments()
    .text(` WHERE ${relationship.sourceColumn.sql} = `)
    .value(source)
    .text(` AND ${relationship.targetColumn.sql} = `)
    .value(target);
}

export function updateRelationship(
  relationship: CompiledRelationship,
  source: unknown,
  target: unknown,
  assignments: readonly Assignment[],
): SqlFragments {
  const sql = new SqlFragments().text(`UPDATE ${relationship.table} SET `);
  assignments.forEach((assignment, index) => {
    sql.text(`${index === 0 ? "" : ", "}${assignment.column.sql} = `).value(assignment.value);
  });
  return sql
    .append(matchPair(relationship, source, target))
    .text(` RETURNING ${relationship.returning}`);
}

export function deleteRelationship(
  relationship: CompiledRelationship,
  source: unknown,
  target: unknown,
): SqlFragments {
  return new SqlFragments()
    .text(`DELETE FROM ${relationship.table}`)
    .append(matchPair(relationship, source, target))
    .text(` RETURNING ${relationship.returning}`);
}
