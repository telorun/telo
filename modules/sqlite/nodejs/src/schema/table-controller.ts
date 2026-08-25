import type { ResourceContext, ResourceInstance } from "@telorun/sdk";
import {
  enumReferenceResolver,
  normalizeTable,
  tableReferenceResolver,
  type ColumnTypeResolver,
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
    this.declaration = normalizeTable(
      raw,
      tableReferenceResolver(ctx, "SQLite.Table", raw.table),
      sqliteColumnType(ctx, raw.table),
    );
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

/** SQLite has no named types, so an enum column's engine-native type is the
 *  enum's declared base storage class; the values ride along as a CHECK. */
function sqliteColumnType(ctx: ResourceContext, table: string): ColumnTypeResolver {
  const resolveEnum = enumReferenceResolver(ctx, "SQLite.Enum", table);
  return (value, column) => {
    const declared = resolveEnum(value, column);
    if (!declared) return { type: String(value) };
    if (!declared.baseType) {
      throw new Error(
        `SQLite.Table '${table}': column '${column}' references enum '${declared.typeName}', ` +
          `which declares no 'baseType'. SQLite has no named types, so something has to say ` +
          `which storage class the values sit in.`,
      );
    }
    return {
      type: declared.baseType,
      enum: { typeName: declared.typeName, values: declared.values },
    };
  };
}

export function register(): void {}

export async function create(
  resource: RawTable,
  ctx: ResourceContext,
): Promise<SqliteTableResource> {
  return new SqliteTableResource(resource, ctx);
}
