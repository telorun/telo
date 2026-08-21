import type { ResourceContext, ResourceInstance } from "@telorun/sdk";
import {
  normalizeTable,
  tableReferenceResolver,
  type DeclaredTable,
  type RawTable,
} from "@telorun/sql";

/**
 * `SQLite.Table` — one physical table, declared rather than migrated to.
 *
 * The resource holds a declaration and performs no I/O; the `Schema` resource
 * that lists it reconciles it. Nothing is dispatched to a table, which is why
 * a schema's `tables:` slot declares `use: dependency`.
 */
export class SqliteTableResource implements ResourceInstance {
  readonly declaration: DeclaredTable;

  constructor(raw: RawTable, ctx: ResourceContext) {
    this.declaration = normalizeTable(raw, tableReferenceResolver(ctx, "SQLite.Table", raw.table));
  }

  /** The physical table name, read by consumers that build statements against
   *  it (`self.table.table` in a repository's template). */
  get table(): string {
    return this.declaration.name;
  }

  snapshot(): Record<string, unknown> {
    return { table: this.declaration.name };
  }
}

export function register(): void {}

export async function create(
  resource: RawTable,
  ctx: ResourceContext,
): Promise<SqliteTableResource> {
  return new SqliteTableResource(resource, ctx);
}
