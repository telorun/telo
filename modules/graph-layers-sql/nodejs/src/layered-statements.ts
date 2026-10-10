import {
  selectList,
  type Assignment,
  type CompiledColumn,
  type CompiledRelationship,
  type CompiledTable,
} from "./compiled-types.js";
import { REMOVED, STATED } from "./declared-table.js";
import { matchIdentity, selectWinner, type StackView } from "./layer-overlay.js";
import { SqlFragments } from "@telorun/sql";

/**
 * The writes of one layer, each a single statement over the layer's own rows.
 * A write never touches a row of another layer: what lies beneath is changed
 * only by stating over it — a copy carrying the change, or a `removed` row.
 * A node write states nothing about relationships: it only withdraws the ones
 * its own layer states.
 *
 * Every write that depends on the layer's own row for an identity is ONE
 * conditional statement against that row, through the layer's unique index:
 * that index is where concurrent writers of one identity meet, so whichever
 * arrives second is answered by the conflict arm against the row the first
 * left — `own` in a conflict arm, beside `excluded`, the row proposed. A
 * statement that returns no row is an outcome its caller names; none is
 * retried. A merge is the one write of two such statements: a statement's
 * column list is fixed and only the engine knows a column's default, so the
 * values an identity the view does not show starts from come from an insert
 * that does not name them.
 */

function conflictTarget(table: CompiledTable): string {
  return [table.layer, ...table.identity].map((c) => c.sql).join(", ");
}

function insertedColumns(table: CompiledTable): string {
  return [table.layer, table.effect, ...table.columns].map((c) => c.sql).join(", ");
}

/** `INSERT … VALUES` of a `stated` row naming only the given columns, so the
 *  engine applies the declared default of every other one. */
function statedValues(
  table: CompiledTable,
  layer: string,
  identity: readonly unknown[],
  assignments: readonly Assignment[],
): SqlFragments {
  const columns = [table.layer, table.effect, ...table.identity, ...assignments.map((a) => a.column)]
    .map((c) => c.sql)
    .join(", ");
  return new SqlFragments()
    .text(`INSERT INTO ${table.table} AS own (${columns}) VALUES (`)
    .value(layer)
    .text(`, '${STATED}', `)
    .valueList([...identity, ...assignments.map((a) => a.value)], ", ")
    .text(`) ON CONFLICT (${conflictTarget(table)}) DO UPDATE SET ${table.effect.sql} = '${STATED}'`);
}

/**
 * A new statement of exactly the given values. Where the layer already holds a
 * row for the identity, a `removed` one is replaced whole and a `stated` one
 * is left alone — the statement then returns no row.
 */
export function insertStated(
  table: CompiledTable,
  layer: string,
  identity: readonly unknown[],
  assignments: readonly Assignment[],
): SqlFragments {
  const replaced = [...table.properties.values()].map((c) => `, ${c.sql} = excluded.${c.sql}`);
  return statedValues(table, layer, identity, assignments).text(
    `${replaced.join("")} WHERE own.${table.effect.sql} = '${REMOVED}' ` +
      `RETURNING ${selectList(table, "")}`,
  );
}

/**
 * States the given values for an identity the view does not show, whatever the
 * layer holds for it. Where the layer already holds a row, a `stated` one takes
 * the given columns and keeps the rest; a `removed` one takes the whole
 * proposed row — the given values, and the declared default of every other
 * column, since the engine filled those in. It always returns a row.
 */
export function stateNew(
  table: CompiledTable,
  layer: string,
  identity: readonly unknown[],
  assignments: readonly Assignment[],
): SqlFragments {
  const set = [...table.properties.values()].map((c) =>
    assignments.some((a) => a.column.name === c.name)
      ? `, ${c.sql} = excluded.${c.sql}`
      : `, ${c.sql} = CASE WHEN own.${table.effect.sql} = '${REMOVED}' ` +
        `THEN excluded.${c.sql} ELSE own.${c.sql} END`,
  );
  return statedValues(table, layer, identity, assignments).text(
    `${set.join("")} RETURNING ${selectList(table, "")}`,
  );
}

/** `, <column>` per author column: the given value where one is assigned, the
 *  winner's otherwise. */
function overWinner(
  sql: SqlFragments,
  columns: readonly CompiledColumn[],
  assignments: readonly Assignment[],
): SqlFragments {
  for (const column of columns) {
    const assigned = assignments.find((a) => a.column.name === column.name);
    if (assigned) sql.text(", ").value(assigned.value);
    else sql.text(`, w.${column.sql}`);
  }
  return sql;
}

/** `INSERT … SELECT` of the stated winner of `beneath`, read inside the
 *  statement, under `effect`: no row is proposed when its winner is not a
 *  stated one. */
function overBeneath(
  table: CompiledTable,
  layer: string,
  effect: typeof STATED | typeof REMOVED,
  identity: readonly unknown[],
  assignments: readonly Assignment[],
  beneath: StackView,
): SqlFragments {
  const sql = new SqlFragments()
    .text(`INSERT INTO ${table.table} AS own (${insertedColumns(table)}) SELECT `)
    .value(layer)
    .text(`, '${effect}'`);
  return overWinner(sql, table.columns, assignments)
    .text(" FROM (")
    .append(selectWinner(table, identity, beneath))
    .text(`) w WHERE w.${table.effect.sql} = '${STATED}'`);
}

/**
 * States the given values over what `view` — the store's whole view — shows
 * for an identity: the stated winner with the given columns. Where the layer
 * already holds a row, a `stated` one takes the given columns; a `removed` one
 * stands. No row is returned when the view does not show the identity.
 */
export function mergeShown(
  table: CompiledTable,
  layer: string,
  identity: readonly unknown[],
  assignments: readonly Assignment[],
  view: StackView,
): SqlFragments {
  const set = assignments.map((a) => `, ${a.column.sql} = excluded.${a.column.sql}`).join("");
  return overBeneath(table, layer, STATED, identity, assignments, view).text(
    ` ON CONFLICT (${conflictTarget(table)}) DO UPDATE SET ${table.effect.sql} = '${STATED}'${set} ` +
      `WHERE own.${table.effect.sql} = '${STATED}' RETURNING ${selectList(table, "")}`,
  );
}

/**
 * Changes a value the layers beneath state, by stating it in `layer` with the
 * change. Where the layer already holds a row, a `stated` one takes the given
 * columns; a `removed` one stands, and the statement returns no row — as it
 * does when nothing beneath states the identity any more.
 */
export function changeBeneath(
  table: CompiledTable,
  layer: string,
  identity: readonly unknown[],
  assignments: readonly Assignment[],
  beneath: StackView,
): SqlFragments {
  const set = assignments.map((a) => `${a.column.sql} = excluded.${a.column.sql}`).join(", ");
  return overBeneath(table, layer, STATED, identity, assignments, beneath).text(
    ` ON CONFLICT (${conflictTarget(table)}) DO UPDATE SET ${set} ` +
      `WHERE own.${table.effect.sql} = '${STATED}' RETURNING ${selectList(table, "")}`,
  );
}

/**
 * Hides what the layers beneath state for an identity: a `removed` row keeping
 * the hidden values, so its own columns stay valid. A row the layer already
 * holds becomes the removal. No row is returned when nothing beneath states
 * the identity.
 */
export function removeBeneath(
  table: CompiledTable,
  layer: string,
  identity: readonly unknown[],
  beneath: StackView,
): SqlFragments {
  return overBeneath(table, layer, REMOVED, identity, [], beneath).text(
    ` ON CONFLICT (${conflictTarget(table)}) DO UPDATE SET ` +
      `${table.effect.sql} = '${REMOVED}' RETURNING ${selectList(table, "")}`,
  );
}

/** Changes the layer's own stated row. */
export function updateStated(
  table: CompiledTable,
  layer: string,
  identity: readonly unknown[],
  assignments: readonly Assignment[],
): SqlFragments {
  const sql = new SqlFragments().text(`UPDATE ${table.table} SET `);
  assignments.forEach((assignment, index) => {
    sql.text(`${index === 0 ? "" : ", "}${assignment.column.sql} = `).value(assignment.value);
  });
  return sql
    .text(` WHERE ${table.layer.sql} = `)
    .value(layer)
    .text(` AND ${table.effect.sql} = '${STATED}' AND `)
    .append(matchIdentity(table, "", identity))
    .text(` RETURNING ${selectList(table, "")}`);
}

/** Withdraws the layer's own row for the identity — whatever it says, or only
 *  a `stated` one. */
export function deleteOwn(
  table: CompiledTable,
  layer: string,
  identity: readonly unknown[],
  only?: typeof STATED,
): SqlFragments {
  const sql = new SqlFragments()
    .text(`DELETE FROM ${table.table} WHERE ${table.layer.sql} = `)
    .value(layer)
    .text(" AND ");
  if (only) sql.text(`${table.effect.sql} = '${only}' AND `);
  return sql.append(matchIdentity(table, "", identity)).text(` RETURNING ${selectList(table, "")}`);
}

/** Withdraws every relationship the layer itself states at one endpoint. */
export function deleteStatedTouching(
  relationship: CompiledRelationship,
  layer: string,
  endpoint: CompiledColumn,
  key: unknown,
): SqlFragments {
  return new SqlFragments()
    .text(`DELETE FROM ${relationship.table} WHERE ${relationship.layer.sql} = `)
    .value(layer)
    .text(` AND ${relationship.effect.sql} = '${STATED}' AND ${endpoint.sql} = `)
    .value(key);
}
