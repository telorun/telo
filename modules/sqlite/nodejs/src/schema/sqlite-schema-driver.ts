import {
  quoteAnsiIdentifier,
  type ChangeSafety,
  type DeclaredCheck,
  type DeclaredColumn,
  type DeclaredEnum,
  type DeclaredForeignKey,
  type DeclaredIndex,
  type DeclaredTable,
  type LiveCheck,
  type LiveColumn,
  type LiveEnum,
  type SchemaObjectId,
  type LiveTable,
  type LedgerTables,
  type LiveForeignKey,
  type LiveIndex,
  type SchemaDriver,
  type SqlConnection,
  deleteRowStatements,
  upsertRowStatements,
  type RowDialect,
} from "@telorun/sql";
import { CompiledQuery, type Kysely } from "kysely";

/**
 * SQLite's half of declarative schema.
 *
 * The vocabulary is honestly smaller than PostgreSQL's because the engine is:
 * five storage classes, no namespaces, no `ALTER COLUMN`, and foreign keys that
 * exist only as part of the table they were created with. Nothing here pretends
 * otherwise — a change SQLite cannot make in place is refused with the reason,
 * which is what sends the author to a `migrations:` entry that rebuilds the
 * table rather than leaving them with a silently unapplied declaration.
 */

/** SQLite storage classes. There is no date, boolean or UUID type — those are
 *  conventions over these five, and inventing names for them here would be the
 *  lowest-common-denominator type vocabulary this design rejects. */
export const SQLITE_TYPES = ["integer", "real", "text", "blob", "numeric"] as const;
export type SqliteType = (typeof SQLITE_TYPES)[number];

/**
 * A declared value as SQLite literal text.
 *
 * Structured values are SERIALIZED, never stringified. `String({})` is
 * `[object Object]` and `String([1,2])` is `1,2`, so a structured seed value —
 * which the row projection admits wherever a column's mapped node is open —
 * reached the database as that text. SQLite has no JSON type, only the
 * convention of JSON in a `text` column, and the serialized form is exactly what
 * that convention (and `json_extract`) reads.
 *
 * Bytes get SQLite's own blob literal: `!include-bytes` resolves to a
 * `Uint8Array` before a controller sees it, and `String(...)` on one yields its
 * elements comma-joined.
 */
function literal(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  if (typeof value === "boolean") return value ? "1" : "0";
  if (value instanceof Uint8Array) return `X'${Buffer.from(value).toString("hex")}'`;
  if (typeof value === "object") return quoted(JSON.stringify(value));
  return quoted(String(value));
}

/** Single quotes doubled — SQLite's only string escape. */
function quoted(text: string): string {
  return `'${text.replace(/'/g, "''")}'`;
}

function columnDefault(column: DeclaredColumn): string {
  if (column.defaultExpression !== undefined) return ` DEFAULT (${column.defaultExpression})`;
  if (column.default !== undefined) return ` DEFAULT ${literal(column.default)}`;
  return "";
}

export class SqliteSchemaDriver implements SchemaDriver {
  constructor(readonly connection: SqlConnection) {}

  get #db(): Kysely<any> {
    const db = this.connection.kysely;
    if (!db) {
      throw new Error(
        "SQLite.Schema: the referenced connection is not built on kysely, which the schema " +
          "runner requires.",
      );
    }
    return db;
  }

  quote(name: string): string {
    return quoteAnsiIdentifier(name);
  }

  /** SQLite has exactly one namespace, so a table is named on its own. */
  qualify(_schema: string, table: string): string {
    return this.quote(table);
  }

  /**
   * SQLite has no advisory lock, so the contract is met by a weaker mechanism
   * and this says which.
   *
   * The engine serializes WRITERS, so no two passes interleave a write; each
   * group `runAtomically` submits is a transaction. What is NOT excluded is two
   * passes running concurrently against one database file and interleaving
   * between groups. That is survivable rather than merely unlikely: every step
   * is derived from live state and re-derivable, the DDL is `IF NOT EXISTS`, and
   * the ledger writes are last in their groups — so two racing passes converge
   * on the same schema instead of diverging.
   *
   * What it does not buy is exclusion for the destructive phase: two passes
   * could both find a tombstone eligible, and the second's `DROP … IF EXISTS`
   * is then a no-op. Acceptable because the outcome is identical; a genuine
   * lock would need `BEGIN IMMEDIATE` held across the whole pass, which cannot
   * nest with the per-group transactions.
   */
  async withLock<T>(_schema: string, body: () => Promise<T>): Promise<T> {
    return body();
  }

  ensureNamespaceStatements(): string[] {
    return [];
  }

  ledgerStatements(_schema: string, tables: LedgerTables): string[] {
    return [
      `CREATE TABLE IF NOT EXISTS ${this.quote(tables.migrations)} (` +
        `key TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS ${this.quote(tables.versions)} (` +
        `sequence INTEGER PRIMARY KEY, version TEXT NOT NULL, digest TEXT NOT NULL, ` +
        `first_seen_at TEXT NOT NULL, declaration TEXT NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS ${this.quote(tables.tombstones)} (` +
        `object_key TEXT PRIMARY KEY, kind TEXT NOT NULL, table_name TEXT NOT NULL, ` +
        `name TEXT, definition TEXT NOT NULL, missing_since_version TEXT NOT NULL, ` +
        `missing_since_sequence INTEGER NOT NULL, missing_since_at TEXT NOT NULL)`,
    ];
  }

  async now(): Promise<string> {
    const result = await this.connection.execute<{ now: string }>(
      `SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS now`,
    );
    return String(result.rows[0]?.now);
  }

  async runAtomically(statements: readonly string[]): Promise<void> {
    if (statements.length === 0) return;
    await this.#db.transaction().execute(async (trx) => {
      for (const statement of statements) {
        await trx.executeQuery(CompiledQuery.raw(statement));
      }
    });
  }

  /** SQLite has no DDL this design must keep out of a transaction, so this is
   *  `runAtomically` under the name the contract asks for. */
  async runSequentially(statements: readonly string[]): Promise<void> {
    await this.runAtomically(statements);
  }

  /** All of them: SQLite has no DDL this design must keep out of a transaction. */
  transactionalPhase(): boolean {
    return true;
  }

  async introspect(_schema: string, tables: readonly string[]): Promise<LiveTable[]> {
    const live: LiveTable[] = [];
    for (const table of tables) {
      const info = await this.connection.execute<Record<string, unknown>>(
        `PRAGMA table_info(${this.quote(table)})`,
      );
      if (info.rows.length === 0) continue;

      // `index_list` reports every index, including the ones SQLite creates for
      // UNIQUE and (for a non-rowid table) the primary key. Those are how a
      // single-column uniqueness constraint is visible at all, so they are read
      // for the column flags and then left out of the diff: they were never
      // declared, so nothing owns them.
      const indexList = await this.connection.execute<Record<string, unknown>>(
        `PRAGMA index_list(${this.quote(table)})`,
      );
      const uniqueColumns = new Set<string>();
      const indexes: LiveIndex[] = [];
      for (const row of indexList.rows) {
        const name = String(row.name);
        const unique = Number(row.unique ?? 0) === 1;
        const columnsResult = await this.connection.execute<Record<string, unknown>>(
          `PRAGMA index_info(${this.quote(name)})`,
        );
        const columns = columnsResult.rows.map((entry) => String(entry.name));
        if (unique && columns.length === 1) uniqueColumns.add(columns[0]!);
        // `origin` is `c` for an index the author created, `u`/`pk` for one
        // SQLite made to back a constraint.
        if (String(row.origin ?? "c") === "c") indexes.push({ name, columns, unique });
      }

      const columns: LiveColumn[] = info.rows.map((row) => {
        const name = String(row.name);
        return {
          name,
          typeSignature: String(row.type ?? "").toLowerCase(),
          nullable: Number(row.notnull ?? 0) === 0,
          hasDefault: row.dflt_value != null,
          primaryKey: Number(row.pk ?? 0) > 0,
          unique: uniqueColumns.has(name),
        };
      });

      const fkList = await this.connection.execute<Record<string, unknown>>(
        `PRAGMA foreign_key_list(${this.quote(table)})`,
      );
      // SQLite does not name a foreign key, so one cannot be matched to a
      // declaration by name — which is also why it has no ADD/DROP CONSTRAINT.
      // Reported as unnamed rather than invented, so the diff sees no match and
      // `addForeignKey` refuses with the reason.
      const foreignKeys: LiveForeignKey[] = [];
      const byId = new Map<number, Record<string, unknown>[]>();
      for (const row of fkList.rows) {
        const id = Number(row.id ?? 0);
        byId.set(id, [...(byId.get(id) ?? []), row]);
      }
      for (const [, rows] of byId) {
        const first = rows[0]!;
        foreignKeys.push({
          name: `sqlite_fk_${Number(first.id ?? 0)}`,
          columns: rows.map((row) => String(row.from)),
          references: {
            table: String(first.table),
            columns: rows.map((row) => String(row.to)),
          },
          onDelete: first.on_delete == null ? undefined : String(first.on_delete),
          onUpdate: first.on_update == null ? undefined : String(first.on_update),
        });
      }

      // Checks are deliberately NOT read back: SQLite keeps them only inside the
      // table's stored DDL text, and parsing that would be a SQL parser in a
      // schema driver. The shared half compares this engine's checks against the
      // RECORDED declaration instead — see `checksInCreateTable`.
      live.push({ name: table, columns, indexes, foreignKeys, checks: [] });
    }
    return live;
  }

  typeSignature(column: DeclaredColumn): string {
    return column.type.toLowerCase();
  }

  /** An index is dropped and recreated, which SQLite does support. */
  classifyIndexChange(): ChangeSafety {
    return { safe: true };
  }

  /** A foreign key exists only as part of the table it was created with, so
   *  changing one means rebuilding the table. */
  classifyForeignKeyChange(live: LiveForeignKey): ChangeSafety {
    return {
      safe: false,
      reason:
        `the foreign key on (${live.columns.join(", ")}) differs from its declaration, and ` +
        `SQLite has no ALTER for a constraint — a foreign key exists only as part of the table ` +
        `it was created with. Rebuild the table in a 'migrations:' entry.`,
    };
  }

  classifyAlter(live: LiveColumn, declared: DeclaredColumn): ChangeSafety {
    if (live.typeSignature !== this.typeSignature(declared)) {
      return {
        safe: false,
        reason:
          `SQLite cannot change a column's type in place (${live.typeSignature} → ` +
          `${this.typeSignature(declared)}). Rebuild the table in a 'migrations:' entry.`,
      };
    }
    if (live.nullable !== declared.nullable) {
      return {
        safe: false,
        reason:
          "SQLite cannot add or drop NOT NULL in place. Rebuild the table in a " +
          "'migrations:' entry.",
      };
    }
    if (live.primaryKey !== declared.primaryKey || live.unique !== declared.unique) {
      return {
        safe: false,
        reason:
          `SQLite cannot add or drop a column constraint in place (primaryKey ` +
          `${live.primaryKey} → ${declared.primaryKey}, unique ${live.unique} → ` +
          `${declared.unique}). Rebuild the table in a 'migrations:' entry, or declare a named ` +
          `unique index instead of a column flag.`,
      };
    }
    return {
      safe: false,
      reason:
        "SQLite cannot change a column default in place. Rebuild the table in a " +
        "'migrations:' entry.",
    };
  }

  classifyCopy(live: LiveColumn, target: DeclaredColumn): ChangeSafety {
    if (live.typeSignature === this.typeSignature(target)) return { safe: true };
    // SQLite would accept this and store the source's representation as it is —
    // a column declared `integer` holding text. Nothing later would report it.
    return {
      safe: false,
      reason:
        `copying ${live.typeSignature} values into a ${this.typeSignature(target)} column ` +
        `would store them unconverted, because SQLite applies affinity rather than rejecting ` +
        `them. Convert the data in a 'migrations:' entry, or declare the same type.`,
    };
  }

  #columnDefinition(column: DeclaredColumn): string {
    if (column.array) {
      throw new Error(
        `SQLite.Table: column '${column.name}' declares 'array', which SQLite has no type for.`,
      );
    }
    // AUTOINCREMENT is only legal on INTEGER PRIMARY KEY — SQLite rejects it
    // anywhere else, and the complaint names a statement the author never wrote.
    if (column.identity && !(column.primaryKey && column.type === "integer")) {
      throw new Error(
        `SQLite.Table: column '${column.name}' declares identity, which SQLite allows only on ` +
          `an integer primary key. Declare 'type: integer' and 'primaryKey: true', or drop it.`,
      );
    }
    const parts = [this.quote(column.name), column.type.toUpperCase()];
    if (column.primaryKey) parts.push("PRIMARY KEY");
    if (column.identity) parts.push("AUTOINCREMENT");
    if (!column.nullable) parts.push("NOT NULL");
    if (column.unique) parts.push("UNIQUE");
    // SQLite has no named types, so a domain reaches the database only as a
    // constraint on the column that uses it. The values sort as text rather than
    // in declaration order — the one thing the rendering cannot reproduce, and
    // why the enum's `values:` order is documented as PostgreSQL's alone.
    if (column.enum) {
      const values = column.enum.values.map((value) => literal(value)).join(", ");
      parts.push(`CHECK (${this.quote(column.name)} IN (${values}))`);
    }
    const def = columnDefault(column);
    return parts.join(" ") + def;
  }

  /** SQLite has no ADD CONSTRAINT, so a foreign key exists only as part of the
   *  table it was created with — see `createTable`. */
  readonly foreignKeysInCreateTable = true;

  /** `PRAGMA foreign_key_list` reports no name, and there is nowhere to have put
   *  one: SQLite does not record a constraint name for a foreign key. */
  readonly namesForeignKeys = false;

  createTable(schema: string, table: DeclaredTable): string[] {
    const parts = table.columns.map((column) => this.#columnDefinition(column));
    // Foreign keys are part of the table in SQLite — there is no ADD CONSTRAINT
    // — so they are emitted here and nowhere else. Named checks land in exactly
    // the same place, for exactly the same reason.
    for (const fk of table.foreignKeys) {
      parts.push(this.#foreignKeyClause(fk));
    }
    for (const check of table.checks) {
      parts.push(`CONSTRAINT ${this.quote(check.name)} CHECK (${check.expression})`);
    }
    return [
      `CREATE TABLE IF NOT EXISTS ${this.qualify(schema, table.name)} (\n  ${parts.join(",\n  ")}\n)`,
    ];
  }

  #foreignKeyClause(fk: DeclaredForeignKey): string {
    const cols = fk.columns.map((c) => this.quote(c)).join(", ");
    const refCols = fk.references.columns.map((c) => this.quote(c)).join(", ");
    let clause = `FOREIGN KEY (${cols}) REFERENCES ${this.quote(fk.references.table)} (${refCols})`;
    if (fk.onDelete) clause += ` ON DELETE ${fk.onDelete.toUpperCase()}`;
    if (fk.onUpdate) clause += ` ON UPDATE ${fk.onUpdate.toUpperCase()}`;
    return clause;
  }

  addColumn(schema: string, table: string, column: DeclaredColumn): string[] {
    if (!column.nullable && column.default === undefined && column.defaultExpression === undefined) {
      throw new Error(
        `SQLite.Table: column '${table}.${column.name}' is NOT NULL with no default, which ` +
          `cannot be added to a table that already has rows. Give it a default, or add it ` +
          `nullable and backfill in a 'migrations:' entry.`,
      );
    }
    return [
      `ALTER TABLE ${this.qualify(schema, table)} ADD COLUMN ${this.#columnDefinition(column)}`,
    ];
  }

  /** Unreachable: `classifyAlter` refuses every in-place column change SQLite
   *  cannot make, which is all of them. */
  alterColumn(_schema: string, table: string, _live: LiveColumn, column: DeclaredColumn): string[] {
    throw new Error(`SQLite.Table: column '${table}.${column.name}' cannot be altered in place.`);
  }

  copyColumn(schema: string, table: string, from: string, to: string): string[] {
    return [
      `UPDATE ${this.qualify(schema, table)} SET ${this.quote(to)} = ${this.quote(from)} ` +
        `WHERE ${this.quote(to)} IS NULL`,
    ];
  }

  createIndex(schema: string, table: string, index: DeclaredIndex): string[] {
    const unique = index.unique ? "UNIQUE " : "";
    const columns = index.columns.map((c) => this.quote(c)).join(", ");
    const where = typeof index.options.where === "string" ? ` WHERE ${index.options.where}` : "";
    return [
      `CREATE ${unique}INDEX IF NOT EXISTS ${this.quote(index.name)} ` +
        `ON ${this.qualify(schema, table)} (${columns})${where}`,
    ];
  }

  dropIndex(_schema: string, _table: string, index: string): string[] {
    return [`DROP INDEX IF EXISTS ${this.quote(index)}`];
  }

  addForeignKey(_schema: string, table: string, fk: DeclaredForeignKey): string[] {
    throw new Error(
      `SQLite.Table: foreign key '${fk.name}' cannot be added to the existing table '${table}' — ` +
        `SQLite has no ADD CONSTRAINT and a foreign key exists only as part of the table it was ` +
        `created with. Rebuild the table in a 'migrations:' entry.`,
    );
  }

  /** Unreachable: `canReclaim` refuses a foreign key before the drop is planned. */
  dropForeignKey(_schema: string, table: string, name: string): string[] {
    throw new Error(
      `SQLite.Table: foreign key '${name}' cannot be dropped from '${table}' — SQLite has no ` +
        `DROP CONSTRAINT. Rebuild the table in a 'migrations:' entry.`,
    );
  }

  /** SQLite has no `ADD CONSTRAINT`, so a check exists only as part of the table
   *  it was created with — the same place its foreign keys are. */
  readonly checksInCreateTable = true;

  /** Compared against the RECORDED declaration rather than live state, so this
   *  is declaration against declaration and the text is the whole comparison. */
  checkDiffers(live: LiveCheck, declared: DeclaredCheck): boolean {
    return live.expression !== declared.expression;
  }

  classifyCheckChange(_live: LiveCheck, declared: DeclaredCheck): ChangeSafety {
    return {
      safe: false,
      reason:
        `SQLite has no ALTER for a constraint — a check exists only as part of the table it was ` +
        `created with — so '${declared.name}' cannot be changed in place. Rebuild the table in a ` +
        `'migrations:' entry.`,
    };
  }

  addCheck(_schema: string, table: string, check: DeclaredCheck): string[] {
    throw new Error(
      `SQLite.Table: check '${check.name}' cannot be added to the existing table '${table}' — ` +
        `SQLite has no ADD CONSTRAINT and a check exists only as part of the table it was ` +
        `created with. Rebuild the table in a 'migrations:' entry.`,
    );
  }

  dropCheck(_schema: string, table: string, name: string): string[] {
    throw new Error(
      `SQLite.Table: check '${name}' cannot be dropped from '${table}' — SQLite has no DROP ` +
        `CONSTRAINT. Rebuild the table in a 'migrations:' entry.`,
    );
  }

  /** Unreachable: nothing on SQLite is ever added `NOT VALID`, so nothing is
   *  waiting to be proven. */
  validateCheck(_schema: string, table: string, name: string): string[] {
    throw new Error(`SQLite.Table: check '${table}.${name}' has no deferred validation to run.`);
  }

  /**
   * SQLite has no named types, so a domain has no database object behind it: the
   * values are rendered as a `CHECK` on every column that references the enum.
   *
   * The DECLARATION is still a ledger object like any other, which is what lets a
   * change to it be detected at all — see `classifyEnumChange`.
   */
  readonly namedEnumTypes = false;

  /** Nothing to read back: there is no type to introspect. */
  async introspectEnums(): Promise<LiveEnum[]> {
    return [];
  }

  /** Unreachable: the shared half asks only when `namedEnumTypes` holds. */
  createEnum(_schema: string, declared: DeclaredEnum): string[] {
    throw new Error(
      `SQLite.Enum '${declared.typeName}': SQLite has no named types, so nothing creates one.`,
    );
  }

  addEnumValues(_schema: string, declared: DeclaredEnum): string[] {
    throw new Error(
      `SQLite.Enum '${declared.typeName}': SQLite has no named types, so nothing alters one.`,
    );
  }

  /** No statement at all — the `CHECK`s on referencing tables never named the
   *  type, so the ledger key rewrite IS the rename. */
  renameEnum(): string[] {
    return [];
  }

  /** The one part of renaming where the two engines need no separate story:
   *  SQLite renames a table with the same statement PostgreSQL does. */
  renameTable(schema: string, from: string, to: string): string[] {
    return [`ALTER TABLE ${this.qualify(schema, from)} RENAME TO ${this.quote(to)}`];
  }

  /**
   * A domain reaches the database inside the tables that use it, so changing one
   * would mean rebuilding every referencing table — which is where SQLite's
   * foreign keys and column alterations already are.
   *
   * The comparison is against the RECORDED declaration rather than live state,
   * because there is no live state: nothing in the database corresponds to the
   * type. That is exactly what makes snapshotting the whole enum declaration
   * load-bearing rather than decorative.
   */
  classifyEnumChange(
    _live: LiveEnum | undefined,
    declared: DeclaredEnum,
    owned: DeclaredEnum | undefined,
  ): ChangeSafety {
    if (!owned) return { safe: true };
    const same =
      owned.baseType === declared.baseType &&
      owned.values.length === declared.values.length &&
      owned.values.every((value, i) => value === declared.values[i]);
    if (same) return { safe: true };
    return {
      safe: false,
      reason:
        `SQLite has no named types, so '${declared.typeName}' is rendered as a CHECK on every ` +
        `column that references it — and SQLite has no ALTER for a constraint. Changing the ` +
        `declaration would leave every existing table enforcing the old values. Rebuild the ` +
        `referencing tables in a 'migrations:' entry, which is where a changed constraint on ` +
        `this engine belongs.`,
    };
  }

  dropEnum(): string[] {
    return [];
  }

  /** SQLite has no installable extensions in the sense this declares — a
   *  loadable extension is a build-time or connection-time concern, not a schema
   *  object a pass can create. */
  readonly namedExtensions = false;

  async introspectExtensions(): Promise<string[]> {
    return [];
  }

  createExtension(_schema: string, name: string): string[] {
    throw new Error(
      `SQLite.Schema: extension '${name}' cannot be created — SQLite has no installable ` +
        `extensions a schema pass can provision.`,
    );
  }

  dropExtension(_schema: string, name: string): string[] {
    throw new Error(`SQLite.Schema: extension '${name}' cannot be dropped.`);
  }

  canReclaim(id: SchemaObjectId): ChangeSafety {
    if (id.kind === "foreignKey" || id.kind === "check") {
      return {
        safe: false,
        reason:
          `SQLite has no DROP CONSTRAINT, so this ${id.kind === "check" ? "check" : "foreign key"} ` +
          "cannot be dropped in place. Rebuild the table in a 'migrations:' entry; the tombstone " +
          "is cleared when the constraint is gone.",
      };
    }
    return { safe: true };
  }

  dropColumn(schema: string, table: string, column: string): string[] {
    return [`ALTER TABLE ${this.qualify(schema, table)} DROP COLUMN ${this.quote(column)}`];
  }

  dropTable(schema: string, table: string): string[] {
    return [`DROP TABLE IF EXISTS ${this.qualify(schema, table)}`];
  }

  /** SQLite has had upsert since 3.24, so both engines render the same statement
   *  SHAPE — which is why it lives in `row-statements.ts` and only the dialect
   *  is answered here. */
  get #rowDialect(): RowDialect {
    return {
      quote: (name) => this.quote(name),
      literal,
      qualify: (schema, table) => this.qualify(schema, table),
      excludedAlias: "excluded",
    };
  }

  upsertRow(
    schema: string,
    table: string,
    key: readonly string[],
    row: Record<string, unknown>,
  ): string[] {
    return upsertRowStatements(this.#rowDialect, schema, table, key, row);
  }

  deleteRow(
    schema: string,
    table: string,
    key: readonly string[],
    row: Record<string, unknown>,
  ): string[] {
    return deleteRowStatements(this.#rowDialect, schema, table, key, row);
  }
}
