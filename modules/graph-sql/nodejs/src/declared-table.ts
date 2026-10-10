import { InvokeError, type ResourceContext } from "@telorun/sdk";
import type { DeclaredColumn, DeclaredTable } from "@telorun/sql";

/** A table resource as every engine's `Table` kind exposes it: the normalized
 *  declaration, which carries the physical name and every column. */
export interface DeclaredTableHolder {
  readonly declaration: DeclaredTable;
}

export function isDeclaredTable(value: unknown): value is DeclaredTableHolder {
  const declaration = (value as DeclaredTableHolder | undefined)?.declaration;
  return (
    !!declaration && typeof declaration.name === "string" && Array.isArray(declaration.columns)
  );
}

export function resolveTable(
  value: unknown,
  ctx: ResourceContext,
  describe: string,
): DeclaredTableHolder {
  return ctx.resolveRef(value, isDeclaredTable, () => `${describe}: 'table'`, "Sql.Table");
}

/** The columns of the table's row contract — what a node or relationship type
 *  is made of. An internal column is the table's own and never part of a type. */
export function rowColumns(table: DeclaredTable): DeclaredColumn[] {
  return table.columns.filter((column) => !table.internalColumns.includes(column.name));
}

export function columnOf(table: DeclaredTable, name: string): DeclaredColumn | undefined {
  return rowColumns(table).find((column) => column.name === name);
}

/** A creation-time twin of a `telo check` rule: same code, stated first. */
export function refuse(code: string, message: string): never {
  throw new InvokeError(code, `${code}: ${message}`);
}
