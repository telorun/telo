/**
 * The normalized declaration a backend's `Table` kind reduces to.
 *
 * Backends declare columns in their own vocabulary — `citext`, `jsonb`, SQLite
 * storage classes — and this model carries the type through as an opaque
 * `type` plus its structured `params`. Nothing here parses a type; only the
 * driver understands one. What IS shared is the shape of a table: named
 * columns, named indexes, named foreign keys, each with the durable identity
 * reconciliation diffs and tombstones key on.
 */

export interface DeclaredColumn {
  /** Durable identity. Tombstones key on it; renaming is expand-contract. */
  readonly name: string;
  /** Backend-native type name, never parsed here. */
  readonly type: string;
  /** Structured type parameters (`length`, `precision`, …), never spelled into `type`. */
  readonly params: Readonly<Record<string, unknown>>;
  readonly nullable: boolean;
  readonly array: boolean;
  readonly primaryKey: boolean;
  readonly unique: boolean;
  /** A typed literal. Mutually exclusive with {@link defaultExpression}. */
  readonly default?: unknown;
  /** Raw backend SQL evaluated by the database. */
  readonly defaultExpression?: string;
  /** Backend-specific identity/auto-increment mode, passed through to the driver. */
  readonly identity?: string;
  /** The column this one supersedes. The pass adds, copies, then tombstones the source. */
  readonly renamedFrom?: string;
}

export interface DeclaredIndex {
  readonly name: string;
  readonly columns: readonly string[];
  readonly unique: boolean;
  /** Backend-specific extras (partial predicate, method), passed through. */
  readonly options: Readonly<Record<string, unknown>>;
}

export interface DeclaredForeignKey {
  readonly name: string;
  readonly columns: readonly string[];
  readonly references: { readonly table: string; readonly columns: readonly string[] };
  readonly onDelete?: string;
  readonly onUpdate?: string;
}

export interface DeclaredTable {
  /** Physical table name. */
  readonly name: string;
  readonly columns: readonly DeclaredColumn[];
  readonly indexes: readonly DeclaredIndex[];
  readonly foreignKeys: readonly DeclaredForeignKey[];
}

/** Every schema object reconciliation tracks, by the identity a tombstone keys on. */
export type SchemaObjectKind = "table" | "column" | "index" | "foreignKey";

export interface SchemaObjectId {
  readonly kind: SchemaObjectKind;
  readonly table: string;
  /** The column / index / constraint name; absent for a table. */
  readonly name?: string;
}

export function objectKey(id: SchemaObjectId): string {
  return id.name == null ? `${id.kind}:${id.table}` : `${id.kind}:${id.table}.${id.name}`;
}

export function describeObject(id: SchemaObjectId): string {
  return id.name == null ? `table ${id.table}` : `${id.kind} ${id.table}.${id.name}`;
}
