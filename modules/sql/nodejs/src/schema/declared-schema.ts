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

/**
 * A declared enum, as a COLUMN carries it.
 *
 * The column's `type` still says what the engine writes in DDL — the type's own
 * name where the engine has named types, the base storage class where it does
 * not — so every existing comparison keeps working unchanged. This carries what
 * only a constraint-rendering engine needs, and what the row projection reads.
 */
export interface DeclaredEnumUse {
  readonly typeName: string;
  readonly values: readonly string[];
}

/**
 * One declared enum type, as the schema that OWNS it lists it.
 *
 * `typeName` is the durable identity — the ledger keys on it, never on the
 * resource name, so renaming the declaration is free and invisible to the
 * database while renaming the type is a schema change stated with `renamedFrom`.
 * That is the decision the schema design already made when it rejected an
 * identity column.
 */
export interface DeclaredEnum {
  readonly typeName: string;
  readonly values: readonly string[];
  /** The storage class the values sit in, for an engine with no named types.
   *  Absent where the type IS its own base type. */
  readonly baseType?: string;
  /** The physical type name this declaration supersedes. */
  readonly renamedFrom?: string;
}

export interface DeclaredColumn {
  /** Durable identity. Tombstones key on it; renaming is expand-contract. */
  readonly name: string;
  /** Backend-native type name, never parsed here. */
  readonly type: string;
  /** Present when `type:` referenced a declared enum. */
  readonly enum?: DeclaredEnumUse;
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

/**
 * One named table-level predicate.
 *
 * The expression is RAW backend SQL, not a structured predicate vocabulary. A
 * neutral predicate language would be a lowest-common-denominator one — the
 * position this design already rejected for column types — and it would fail on
 * the predicates people actually write, which correlate columns. The precedent
 * is `defaultExpression`, already raw engine SQL beside a typed `default`.
 *
 * The consequence is stated rather than papered over: nothing here can read the
 * expression, so a check naming a column the table does not declare is not
 * catchable the way an index's column list is. The engine reports it when the
 * constraint is added.
 */
export interface DeclaredCheck {
  /** Durable identity — the constraint name reconciliation diffs on. */
  readonly name: string;
  readonly expression: string;
  /** `deferred` renders the constraint NOT VALID and validates it on a later
   *  pass, so adding one to a large table does not hold a lock while every
   *  existing row is scanned. */
  readonly validate?: "immediate" | "deferred";
}

export interface DeclaredForeignKey {
  readonly name: string;
  readonly columns: readonly string[];
  readonly references: { readonly table: string; readonly columns: readonly string[] };
  readonly onDelete?: string;
  readonly onUpdate?: string;
}

/**
 * Reference data the table is DECLARED to hold.
 *
 * Desired state, not history, which is why it is declared beside the shape it
 * must satisfy rather than written as an insert migration: the rows are checked
 * against the row projection at `telo check`, and a row deleted by hand comes
 * back on the next boot.
 *
 * `key` is durable identity — the same principle as `table:` and an index name.
 * It names the columns that decide whether a row is the same row, and it is what
 * the upsert conflicts on.
 */
export interface DeclaredSeeds {
  readonly key: readonly string[];
  readonly rows: readonly Record<string, unknown>[];
  /** False withdraws the declaration, which tombstones the rows on a database
   *  that had them. That is the correct reading of the rule and the surprising
   *  one, so it is stated wherever the field is. */
  readonly when: boolean;
}

export interface DeclaredTable {
  /** Physical table name. */
  readonly name: string;
  readonly columns: readonly DeclaredColumn[];
  readonly indexes: readonly DeclaredIndex[];
  readonly foreignKeys: readonly DeclaredForeignKey[];
  readonly checks: readonly DeclaredCheck[];
  readonly seeds?: DeclaredSeeds;
  /** The physical table this one supersedes, renamed in place. Unlike a column's
   *  expand-contract rename, this is NATIVE: copying every row is unbounded work
   *  and writes during an overlap would diverge between the two names. */
  readonly renamedFrom?: string;
}

/** Every schema object reconciliation tracks, by the identity a tombstone keys on. */
export type SchemaObjectKind =
  | "table"
  | "column"
  | "index"
  | "foreignKey"
  | "check"
  | "enum"
  | "extension"
  | "seedRow";

export interface SchemaObjectId {
  readonly kind: SchemaObjectKind;
  /** The table this object belongs to. A TOP-LEVEL object — a table, an enum
   *  type — carries its own physical name here and no `name`, which is what
   *  keeps one key grammar for every kind. */
  readonly table: string;
  /** The column / index / constraint name; absent for a top-level object. */
  readonly name?: string;
}

/**
 * Object kinds that BELONG to a table — the ones a table takes with it when it
 * is retired, and the ones a rename carries to the new name.
 *
 * One list, because there are exactly two consumers and they must agree: the
 * tombstone sweep (which suppresses a child of a retired table) and
 * `applyRenames` (which moves a child's ledger key). They were two hand-written
 * lists, and only the sweep's gained `check` and `seedRow` — so renaming a table
 * left its checks and seed rows keyed under the old name, the sweep tombstoned
 * them on that same boot, and the seed-row reclamation later failed against a
 * table that no longer exists. An enum is deliberately NOT one: it is a
 * top-level object that happens to carry its physical name in the same field.
 */
export const TABLE_CHILD_KINDS: ReadonlySet<SchemaObjectKind> = new Set([
  "column",
  "index",
  "foreignKey",
  "check",
  "seedRow",
]);

export function isTableChild(kind: SchemaObjectKind): boolean {
  return TABLE_CHILD_KINDS.has(kind);
}

export function objectKey(id: SchemaObjectId): string {
  return id.name == null ? `${id.kind}:${id.table}` : `${id.kind}:${id.table}.${id.name}`;
}

export function describeObject(id: SchemaObjectId): string {
  return id.name == null ? `${id.kind} ${id.table}` : `${id.kind} ${id.table}.${id.name}`;
}
