import type { ResourceManifest } from "@telorun/sdk";
import type { DeclaredColumn, DeclaredTable } from "@telorun/sql";

/** A table resource as every engine's `Table` kind exposes it: the normalized
 *  declaration, which carries the physical name, the columns and the keys. */
export interface DeclaredTableHolder {
  readonly declaration: DeclaredTable;
}

export function isDeclaredTable(value: unknown): value is DeclaredTableHolder {
  const declaration = (value as DeclaredTableHolder | undefined)?.declaration;
  return !!declaration && typeof declaration.name === "string" && Array.isArray(declaration.columns);
}

/** The columns of the table's row contract; an internal column is the table's own. */
export function rowColumns(table: DeclaredTable): DeclaredColumn[] {
  return table.columns.filter((column) => !table.internalColumns.includes(column.name));
}

/** The manifest a name declares, resolved in the scope of `holder` — the
 *  declaration the name was read from — or of the reading resource without one. */
export type TableNameRead = (name: string, alias?: string, holder?: ResourceManifest) => ResourceManifest | undefined;

interface Reference {
  name: string;
  alias?: string;
}

function asReference(value: unknown): Reference | undefined {
  const ref = value as { name?: unknown; alias?: unknown } | null;
  if (!ref || typeof ref !== "object" || typeof ref.name !== "string") return undefined;
  return { name: ref.name, ...(typeof ref.alias === "string" ? { alias: ref.alias } : {}) };
}

/**
 * The physical table of the collection a relation names, read from the target's
 * declaration. Its `table` is a live table once that slot was injected, and
 * otherwise a reference written in the target's module, resolved in that
 * module's scope; the answer is `undefined` for a target that declares no table.
 */
export function targetTableName(collection: unknown, read: TableNameRead): string | undefined {
  const relation = asReference(collection);
  if (!relation) return undefined;
  const target = read(relation.name, relation.alias) as (ResourceManifest & { table?: unknown }) | undefined;
  const table = target?.table;
  if (table === undefined) return undefined;
  if (isDeclaredTable(table)) return table.declaration.name;
  const reference = asReference(table);
  if (!reference) return undefined;
  const declared = read(reference.name, reference.alias, target) as (ResourceManifest & { table?: unknown }) | undefined;
  return typeof declared?.table === "string" ? declared.table : undefined;
}
