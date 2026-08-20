import type {
  DeclaredColumn,
  DeclaredForeignKey,
  DeclaredIndex,
  DeclaredTable,
} from "./declared-schema.js";

/**
 * The manifest shape a backend's `Table` kind declares, reduced to the
 * normalized model.
 *
 * The STRUCTURE is shared — named columns, named indexes, named foreign keys —
 * while the type vocabulary is not: `type` is carried through opaquely and
 * every field the shared model does not name becomes a type parameter, so a
 * backend adds `length`, `precision` or `collation` to its schema and nothing
 * here changes. Types are structured rather than spelled into a scalar
 * (`type: varchar` with `length: 64`, never `varchar(64)`), so nothing has to
 * parse a type back apart.
 */
export interface RawColumn {
  readonly type: string;
  readonly nullable?: boolean;
  readonly array?: boolean;
  readonly primaryKey?: boolean;
  readonly unique?: boolean;
  readonly default?: unknown;
  readonly defaultExpression?: string;
  readonly identity?: string;
  readonly renamedFrom?: string;
  readonly [param: string]: unknown;
}

export interface RawIndex {
  readonly columns: readonly string[];
  readonly unique?: boolean;
  readonly [option: string]: unknown;
}

export interface RawForeignKey {
  readonly columns: readonly string[];
  readonly references: { readonly table: unknown; readonly columns: readonly string[] };
  readonly onDelete?: string;
  readonly onUpdate?: string;
}

export interface RawTable {
  readonly table: string;
  readonly columns?: Record<string, RawColumn>;
  readonly indexes?: Record<string, RawIndex>;
  readonly foreignKeys?: Record<string, RawForeignKey>;
}

const COLUMN_KEYS = new Set([
  "type",
  "nullable",
  "array",
  "primaryKey",
  "unique",
  "default",
  "defaultExpression",
  "identity",
  "renamedFrom",
]);

const INDEX_KEYS = new Set(["columns", "unique"]);

function params(raw: Record<string, unknown>, known: ReadonlySet<string>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(raw).filter(([key, value]) => !known.has(key) && value !== undefined),
  );
}

function normalizeColumn(name: string, raw: RawColumn): DeclaredColumn {
  if (raw.default !== undefined && raw.defaultExpression !== undefined) {
    throw new Error(
      `column '${name}' declares both 'default' and 'defaultExpression' — a typed literal and ` +
        `a backend SQL expression are separate fields and exactly one may be set`,
    );
  }

  // A primary key and an identity column cannot hold NULL, and the engine
  // enforces that whether or not the declaration says so. Left at the `nullable`
  // default of true, the column would read back NOT NULL on the next boot, the
  // pass would see a difference it could "fix", and every boot from then on
  // would try to DROP NOT NULL on a primary key and fail. So the implication is
  // applied here, once, where both the DDL and the comparison read it — and a
  // declaration that states the opposite is refused rather than quietly
  // overruled.
  const impliesNotNull = raw.primaryKey === true || raw.identity !== undefined;
  if (impliesNotNull && raw.nullable === true) {
    throw new Error(
      `column '${name}' is declared nullable and ${raw.primaryKey ? "a primary key" : "an identity column"}, ` +
        `which cannot hold NULL. Remove 'nullable: true'.`,
    );
  }

  return {
    name,
    type: raw.type,
    params: params(raw as Record<string, unknown>, COLUMN_KEYS),
    nullable: impliesNotNull ? false : (raw.nullable ?? true),
    array: raw.array ?? false,
    primaryKey: raw.primaryKey ?? false,
    unique: raw.unique ?? false,
    default: raw.default,
    defaultExpression: raw.defaultExpression,
    identity: raw.identity,
    renamedFrom: raw.renamedFrom,
  };
}

/** A `references.table` is a `!ref` to another table resource, injected as the
 *  live instance by the time a controller reads it. */
function referencedTableName(value: unknown, fk: string): string {
  if (typeof value === "string") return value;
  const table = (value as { table?: unknown } | null)?.table;
  if (typeof table === "string") return table;
  throw new Error(`foreign key '${fk}': 'references.table' does not name a table`);
}

/**
 * Structural checks over one declaration, at resource creation — before any
 * connection is opened, let alone any DDL planned.
 *
 * Each of these would otherwise reach the engine as raw SQL and come back as a
 * driver error naming a statement the author never wrote. They are decidable
 * from the declaration alone, so they are decided here and reported against the
 * field that is wrong.
 */
function validateTable(table: DeclaredTable): void {
  const where = `${table.name}`;
  if (table.columns.length === 0) {
    throw new Error(`table '${where}' declares no columns — a table needs at least one.`);
  }

  const names = new Set(table.columns.map((c) => c.name));

  const primaryKeys = table.columns.filter((c) => c.primaryKey).map((c) => c.name);
  if (primaryKeys.length > 1) {
    throw new Error(
      `table '${where}' marks ${primaryKeys.map((n) => `'${n}'`).join(" and ")} as primaryKey. ` +
        `A composite primary key is not expressible as a per-column flag — declare one column ` +
        `as the key, or create the constraint in a 'migrations:' entry.`,
    );
  }

  for (const column of table.columns) {
    if (!column.renamedFrom) continue;
    if (column.renamedFrom === column.name) {
      throw new Error(
        `column '${where}.${column.name}' declares renamedFrom itself, which describes no rename.`,
      );
    }
    if (names.has(column.renamedFrom)) {
      throw new Error(
        `column '${where}.${column.name}' renames from '${column.renamedFrom}', which this table ` +
          `also declares. A rename's source is the column being retired, so declaring both would ` +
          `copy one live column into another and retire neither.`,
      );
    }
  }

  // An index or foreign key over a column the table does not declare cannot be
  // created, and the engine's complaint would name a generated statement.
  for (const index of table.indexes) {
    for (const column of index.columns) {
      if (!names.has(column)) {
        throw new Error(
          `index '${where}.${index.name}' names column '${column}', which this table does not ` +
            `declare.`,
        );
      }
    }
  }
  for (const fk of table.foreignKeys) {
    for (const column of fk.columns) {
      if (!names.has(column)) {
        throw new Error(
          `foreign key '${where}.${fk.name}' names column '${column}', which this table does not ` +
            `declare.`,
        );
      }
    }
    if (fk.references.columns.length !== fk.columns.length) {
      throw new Error(
        `foreign key '${where}.${fk.name}' has ${fk.columns.length} column(s) but references ` +
          `${fk.references.columns.length} — a foreign key maps its columns one for one.`,
      );
    }
  }
}

export function normalizeTable(raw: RawTable): DeclaredTable {
  const columns = Object.entries(raw.columns ?? {}).map(([name, column]) =>
    normalizeColumn(name, column),
  );
  const indexes: DeclaredIndex[] = Object.entries(raw.indexes ?? {}).map(([name, index]) => ({
    name,
    columns: [...index.columns],
    unique: index.unique ?? false,
    options: params(index as Record<string, unknown>, INDEX_KEYS),
  }));
  const foreignKeys: DeclaredForeignKey[] = Object.entries(raw.foreignKeys ?? {}).map(
    ([name, fk]) => ({
      name,
      columns: [...fk.columns],
      references: {
        table: referencedTableName(fk.references.table, name),
        columns: [...fk.references.columns],
      },
      onDelete: fk.onDelete,
      onUpdate: fk.onUpdate,
    }),
  );
  const table: DeclaredTable = { name: raw.table, columns, indexes, foreignKeys };
  validateTable(table);
  return table;
}
