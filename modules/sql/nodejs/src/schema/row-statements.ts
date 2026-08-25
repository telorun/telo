/**
 * Rendering a seed row to an upsert and to a delete.
 *
 * Shared because both engines write the SAME statement — SQLite has had
 * `ON CONFLICT … DO UPDATE` since 3.24 — and they were two near-identical
 * copies differing only in the case of `EXCLUDED`. Two copies of a statement
 * shape is how the two backends come to seed differently over a declaration that
 * says one thing.
 *
 * What genuinely differs is the DIALECT, so that is what a backend supplies:
 * how it quotes an identifier, how it spells a literal, and the case of the
 * excluded-row alias. The same split the rest of this module already draws
 * between the shared reconciler and each engine's `SchemaDriver`.
 */

/** The engine-specific half of rendering a row. */
export interface RowDialect {
  /** Quote an identifier — the driver's own `quote`. */
  quote(name: string): string;
  /** Render a value as a SQL literal. */
  literal(value: unknown): string;
  /** Fully-qualified table reference — the driver's own `qualify`. */
  qualify(schema: string, table: string): string;
  /** The alias for the row being inserted, in this engine's spelling
   *  (`EXCLUDED` on PostgreSQL, `excluded` on SQLite). */
  readonly excludedAlias: string;
}

/**
 * `ON CONFLICT … DO UPDATE`, setting only the columns the row STATES.
 *
 * A row that declares no `rank` leaves the insert to the column default and the
 * update to whatever is there, which is what makes a partial seed row a real
 * declaration rather than a whole-row overwrite. A row that states only its key
 * columns has nothing to update, so it degrades to `DO NOTHING` rather than to
 * an empty `SET`, which is a syntax error.
 */
export function upsertRowStatements(
  dialect: RowDialect,
  schema: string,
  table: string,
  key: readonly string[],
  row: Record<string, unknown>,
): string[] {
  const columns = Object.keys(row);
  const target = key.map((column) => dialect.quote(column)).join(", ");
  const updates = columns
    .filter((column) => !key.includes(column))
    .map(
      (column) =>
        `${dialect.quote(column)} = ${dialect.excludedAlias}.${dialect.quote(column)}`,
    );
  const action = updates.length === 0 ? "DO NOTHING" : `DO UPDATE SET ${updates.join(", ")}`;
  return [
    `INSERT INTO ${dialect.qualify(schema, table)} ` +
      `(${columns.map((column) => dialect.quote(column)).join(", ")}) VALUES ` +
      `(${columns.map((column) => dialect.literal(row[column])).join(", ")}) ` +
      `ON CONFLICT (${target}) ${action}`,
  ];
}

/** Delete one seed row by its key columns — reclamation for a tombstoned row. */
export function deleteRowStatements(
  dialect: RowDialect,
  schema: string,
  table: string,
  key: readonly string[],
  row: Record<string, unknown>,
): string[] {
  const where = key
    .map((column) => `${dialect.quote(column)} = ${dialect.literal(row[column])}`)
    .join(" AND ");
  return [`DELETE FROM ${dialect.qualify(schema, table)} WHERE ${where}`];
}
