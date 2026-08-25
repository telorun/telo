import type { SqlConnection } from "../sql-connection.js";
import type { LedgerTables } from "./schema-ledger.js";
import type { PlanPhase } from "./schema-reconciler.js";
import type {
  SchemaObjectId,
  DeclaredCheck,
  DeclaredColumn,
  DeclaredEnum,
  DeclaredForeignKey,
  DeclaredIndex,
  DeclaredTable,
} from "./declared-schema.js";

/** The live shape of one table, as the driver reads it back from the database. */
export interface LiveColumn {
  readonly name: string;
  /**
   * The driver's canonical rendering of the column's type, compared verbatim
   * against what {@link SchemaDriver.typeSignature} produces for a declaration.
   * Comparing signatures rather than parsed parts is what keeps every type rule
   * inside the driver.
   */
  readonly typeSignature: string;
  readonly nullable: boolean;
  readonly hasDefault: boolean;
  /** Whether the column is part of the table's primary key. */
  readonly primaryKey: boolean;
  /** Whether a single-column uniqueness constraint covers it. */
  readonly unique: boolean;
}

/**
 * An index as the database has it, not merely its name.
 *
 * Compared by name alone, changing which columns an index covers — or making it
 * unique — emitted nothing and reported nothing, while the ledger recorded the
 * new definition as owned. The declaration then asserted an index the database
 * was not providing.
 */
export interface LiveIndex {
  readonly name: string;
  readonly columns: readonly string[];
  readonly unique: boolean;
}

/** A foreign key as the database has it. Same reasoning as {@link LiveIndex}:
 *  changing `onDelete` is a change to what the constraint DOES. */
export interface LiveForeignKey {
  readonly name: string;
  readonly columns: readonly string[];
  readonly references: { readonly table: string; readonly columns: readonly string[] };
  readonly onDelete?: string;
  readonly onUpdate?: string;
}

/** A named check as the engine has it. `expression` is the engine's own
 *  NORMALIZED rendering, which is why a change is classified by the driver
 *  rather than compared as text here. */
export interface LiveCheck {
  readonly name: string;
  readonly expression: string;
  /** False while the constraint is `NOT VALID` — declared and enforced for new
   *  rows, not yet proven against the existing ones. */
  readonly validated: boolean;
}

export interface LiveTable {
  readonly name: string;
  readonly columns: readonly LiveColumn[];
  readonly indexes: readonly LiveIndex[];
  readonly foreignKeys: readonly LiveForeignKey[];
  readonly checks: readonly LiveCheck[];
}

/** An enum type as the engine has it. Only an engine with named types reports
 *  one; see {@link SchemaDriver.namedEnumTypes}. */
export interface LiveEnum {
  readonly name: string;
  /** In the engine's own sort order, which for an enum type is declaration
   *  order — the property a CHECK over text does not have. */
  readonly values: readonly string[];
}

/** How a declared change relates to the data already in the column. */
export type ChangeSafety =
  | { readonly safe: true }
  | { readonly safe: false; readonly reason: string };

/**
 * Everything reconciliation needs that only the engine knows: how a type is
 * spelled, how it is read back, what a lock is, and which alterations the
 * engine can perform at all. The diff, the ledger, the tombstones and the
 * ordering live in the shared library and are identical for every backend.
 *
 * Statement renderers return SQL text; the runner executes and logs it. They
 * never touch the connection themselves, so a plan can be built, reported and
 * refused without anything having run.
 */
export interface SchemaDriver {
  readonly connection: SqlConnection;

  /** Quote an identifier. */
  quote(name: string): string;
  /** Qualify a table with the namespace this schema resource owns. */
  qualify(schema: string, table: string): string;

  /**
   * Hold the engine's cross-process schema lock for the duration of `body`.
   * Every replica of an app boots the same pass, so this is what makes
   * "reconcile once" true rather than hoped for.
   */
  withLock<T>(schema: string, body: () => Promise<T>): Promise<T>;

  /** Create the namespace when absent. Purely additive. */
  ensureNamespaceStatements(schema: string): string[];

  /** The three ledger tables, `CREATE TABLE IF NOT EXISTS`. Named by the caller:
   *  which ledger a schema resource writes to is its own declaration. */
  ledgerStatements(schema: string, tables: LedgerTables): string[];

  /**
   * Run `statements` atomically where the engine allows DDL inside a
   * transaction, and sequentially where it does not. Which of the two an engine
   * offers is the driver's to know; the runner only needs the strongest
   * grouping available, and relies on the pass being idempotent for the rest.
   *
   * A migration's ledger row is the LAST statement of its group, so on an engine
   * with transactional DDL "applied" and "recorded as applied" are one commit.
   * An implementation whose engine cannot do that MUST say so here, because the
   * consequence is specific: a crash mid-group can re-run a migration that is
   * not idempotent.
   */
  runAtomically(statements: readonly string[]): Promise<void>;

  /**
   * The current time, as ISO-8601 UTC text, **from the database**.
   *
   * Not the application's clock: the grace window gates an irreversible drop,
   * and one replica with a skewed clock would satisfy `afterDuration`
   * instantly. The ledger's history already treats the database as the
   * authority; the clock measured against it has to come from there too, so
   * every replica measures the same elapsed time.
   */
  now(): Promise<string>;

  /** Read back the live shape of the named tables. Absent tables are omitted. */
  introspect(schema: string, tables: readonly string[]): Promise<LiveTable[]>;

  /**
   * Whether this engine has a first-class enum type at all.
   *
   * The declaration is the same on either side of this answer, and only the
   * RENDERING differs: an engine that has one creates a schema object and reads
   * it back, while an engine that does not renders the values as a per-column
   * constraint and has nothing to introspect. Stated rather than inferred from
   * an empty `introspectEnums`, which is also what a fresh database looks like.
   */
  readonly namedEnumTypes: boolean;

  /**
   * Whether this engine has installable extensions.
   *
   * PROVISIONING IS A DECLARATION, NOT A BUCKET. A storage class like `citext`
   * needs an extension before any column can use it, and smuggling that in as a
   * `CREATE EXTENSION IF NOT EXISTS` migration is desired state wearing a
   * migration's clothes — with no release it belongs to and a migration key that
   * is a lie.
   */
  readonly namedExtensions: boolean;

  /** Which of the named extensions are present. Empty for an engine with none. */
  introspectExtensions(schema: string, names: readonly string[]): Promise<string[]>;
  createExtension(schema: string, name: string): string[];
  /** Reclaiming an extension is deliberately refused on every engine — see
   *  `canReclaim`. This exists so the seam is total. */
  dropExtension(schema: string, name: string): string[];

  /** The enum types this schema holds, by physical name. Empty for an engine
   *  with no named types — the shared half asks only when it has them. */
  introspectEnums(schema: string, names: readonly string[]): Promise<LiveEnum[]>;

  createEnum(schema: string, declared: DeclaredEnum): string[];

  /**
   * Add values to an existing type.
   *
   * Rendered separately from `createEnum` because PostgreSQL cannot use a value
   * in the transaction that adds it — so these run in their own phase, ahead of
   * the atomic pass, which is why the runner asks for them apart from everything
   * else.
   */
  addEnumValues(schema: string, declared: DeclaredEnum, values: readonly string[]): string[];

  /** `ALTER TYPE … RENAME TO`, or nothing at all on an engine whose constraints
   *  never named the type — there the ledger key rewrite IS the rename. */
  renameEnum(schema: string, from: string, to: string): string[];

  /** `ALTER TABLE … RENAME TO`. Immediate and unbounded-work-free, which is why
   *  a table rename is native where a column's is expand-contract. */
  renameTable(schema: string, from: string, to: string): string[];

  /**
   * Whether the declared enum can be brought to its declaration.
   *
   * `live` is undefined on an engine with no named types, where `owned` — the
   * declaration the ledger recorded — is the only thing a change can be compared
   * against. Removing a VALUE is never planned by the shared half on any engine:
   * no engine can drop an enum label without rewriting every table that stores
   * it, so a removal is recorded and reported rather than executed.
   */
  classifyEnumChange(
    live: LiveEnum | undefined,
    declared: DeclaredEnum,
    owned: DeclaredEnum | undefined,
  ): ChangeSafety;

  /** The canonical signature of a declared column's type, for comparison with {@link LiveColumn.typeSignature}. */
  typeSignature(column: DeclaredColumn): string;

  /**
   * Whether altering a live column to the declared one can be applied without
   * risking the data already in it. Type widening is safe, narrowing is not,
   * and only the engine knows which is which.
   */
  classifyAlter(live: LiveColumn, declared: DeclaredColumn): ChangeSafety;

  /**
   * Whether the values in a live column can be COPIED into a newly added one —
   * the expand-contract half of a rename.
   *
   * A different question from {@link classifyAlter}, which asks whether a column
   * can be changed in place. Here the target is brand new, so its nullability
   * and default are already what the declaration says and only the VALUES have
   * to survive the move. An engine that can alter nothing in place can still
   * copy freely between compatible types, and one that copies between anything
   * may still lose data doing it.
   */
  classifyCopy(live: LiveColumn, target: DeclaredColumn): ChangeSafety;

  /**
   * Whether an index can be brought to its declaration in place. Most engines
   * cannot alter one, so the honest answer is usually to drop and recreate —
   * which this returns as statements, or refuses when the index is not this
   * schema's to rebuild.
   */
  classifyIndexChange(live: LiveIndex, declared: DeclaredIndex): ChangeSafety;

  /** Whether a foreign key can be brought to its declaration in place. */
  classifyForeignKeyChange(live: LiveForeignKey, declared: DeclaredForeignKey): ChangeSafety;

  /**
   * Whether a named check differs from its declaration, and whether the
   * difference can be applied.
   *
   * Nothing in the shared half reads an expression: the engine stores a
   * NORMALIZED rendering (`balance_cents >= 0` comes back as
   * `((balance_cents >= 0))`), so comparing text here would replan the same
   * constraint on every boot. The driver owns the comparison for the same reason
   * it owns `typeSignature`.
   */
  checkDiffers(live: LiveCheck, declared: DeclaredCheck): boolean;
  classifyCheckChange(live: LiveCheck, declared: DeclaredCheck): ChangeSafety;

  /** Whether a check can be added to a table that already exists. False for an
   *  engine with no `ADD CONSTRAINT`, where a check exists only as part of the
   *  table it was created with — the same answer its foreign keys give. */
  readonly checksInCreateTable: boolean;

  addCheck(schema: string, table: string, check: DeclaredCheck): string[];
  dropCheck(schema: string, table: string, name: string): string[];
  /** Prove a `NOT VALID` constraint against the rows already there. Rendered on
   *  a later pass than the one that added it, which is the whole point of
   *  `validate: deferred`. */
  validateCheck(schema: string, table: string, name: string): string[];

  /**
   * Whether `createTable` already carries the table's foreign keys, so the
   * reconciler must not also plan an `addForeignKey` for a table it just made.
   *
   * REQUIRED, like every other member here, because the wrong answer is silent:
   * a driver that omitted it would get name matching by default, and if its
   * engine also emits keys inside `CREATE TABLE` it would get exactly the
   * unrestartable application this member exists to prevent — with no compile
   * error and no failing test. Stating an answer is the point.
   */
  readonly foreignKeysInCreateTable: boolean;

  /**
   * Whether the engine reports a foreign key back under the name the
   * declaration gave it.
   *
   * Separate from `foreignKeysInCreateTable` because they are separate facts and
   * an engine can hold one without the other: MySQL emits keys inside `CREATE
   * TABLE` and names them. Where this is false a declaration is matched to a
   * live key by its columns, target and referential actions, since there is no
   * name to match on and matching by one reads a table's own key as missing on
   * every boot after the one that created it.
   */
  readonly namesForeignKeys: boolean;

  createTable(schema: string, table: DeclaredTable): string[];
  addColumn(schema: string, table: string, column: DeclaredColumn): string[];
  alterColumn(schema: string, table: string, live: LiveColumn, column: DeclaredColumn): string[];
  copyColumn(schema: string, table: string, from: string, to: string): string[];
  createIndex(schema: string, table: string, index: DeclaredIndex): string[];
  dropIndex(schema: string, table: string, index: string): string[];
  addForeignKey(schema: string, table: string, fk: DeclaredForeignKey): string[];
  dropForeignKey(schema: string, table: string, name: string): string[];

  /**
   * Whether this engine can reclaim an object of this kind at all.
   *
   * Asked BEFORE the drop is attempted, because a tombstone the engine cannot
   * act on is otherwise permanent breakage rather than a one-off failure: it
   * stays eligible, so every boot from then on fails in the same place, and the
   * application never starts again. Reported instead, with the reason, and the
   * tombstone is left standing.
   */
  canReclaim(id: SchemaObjectId): ChangeSafety;

  /** Reclamation. Separated from the rest because these are the only destructive statements. */
  dropColumn(schema: string, table: string, column: string): string[];
  dropTable(schema: string, table: string): string[];
  dropEnum(schema: string, name: string): string[];

  /**
   * Insert the row, or update the columns it STATES when a row with the same key
   * is already there.
   *
   * Columns the row does not state are left alone — the insert takes the column
   * default and the update keeps whatever an operator set. That is what makes a
   * partial seed row a real declaration rather than a whole-row overwrite.
   */
  upsertRow(
    schema: string,
    table: string,
    key: readonly string[],
    row: Record<string, unknown>,
  ): string[];

  /** Delete one seed row by its key columns — reclamation for a tombstoned row.
   *  Held and reported when a foreign key still references it, exactly as a type
   *  still in use is. */
  deleteRow(
    schema: string,
    table: string,
    key: readonly string[],
    row: Record<string, unknown>,
  ): string[];

  /**
   * Run `statements` one at a time, OUTSIDE any transaction.
   *
   * For DDL an engine refuses to combine with anything else: PostgreSQL cannot
   * use an enum value in the transaction that added it. Every other statement
   * this design emits goes through `runAtomically`; this exists for the ones
   * that provably cannot.
   */
  runSequentially(statements: readonly string[]): Promise<void>;

  /**
   * Whether this engine can run one reconciliation phase inside a transaction.
   *
   * The ENGINE's answer, because that is what it is: PostgreSQL cannot use an
   * enum value in the transaction that adds it, so its `enumValue` phase runs
   * unwrapped, while SQLite has no such rule and wraps everything. The shared
   * phase list used to hardcode that one exclusion, which put a PostgreSQL
   * limitation in the half that exists not to know about engines — and left a
   * backend whose `ALTER TYPE` is transactional no way to say so.
   *
   * Default-true is the right polarity: an engine that says nothing gets the
   * atomic behaviour every other phase already has.
   */
  transactionalPhase(phase: PlanPhase): boolean;
}
