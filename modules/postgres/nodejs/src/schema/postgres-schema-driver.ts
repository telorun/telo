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
  type PlanPhase,
  type SchemaDriver,
  type SqlConnection,
  deleteRowStatements,
  upsertRowStatements,
  type RowDialect,
} from "@telorun/sql";
import { CompiledQuery, type Kysely } from "kysely";
import { typeEntry, widens } from "./postgres-types.js";

/**
 * PostgreSQL's half of declarative schema — the full engine vocabulary, not a
 * neutral subset: `varchar` with a length, `citext`, `jsonb`, arrays, identity
 * columns, partial and method-qualified indexes.
 *
 * Every statement is schema-qualified. Relying on `search_path` would let a
 * role or session default decide where DDL lands, with no error when it lands
 * wrong.
 */
/**
 * PostgreSQL records a referential action as one character. `a` is the default
 * (NO ACTION), which a declaration that says nothing also means.
 */
const REFERENTIAL_ACTIONS: Record<string, string | undefined> = {
  a: "NO ACTION",
  r: "RESTRICT",
  c: "CASCADE",
  n: "SET NULL",
  d: "SET DEFAULT",
};

/** Long enough that a busy pool is not mistaken for an exhausted one, short
 *  enough that a boot fails rather than hangs. */
const SECOND_CONNECTION_TIMEOUT_MS = 30_000;

export class PostgresSchemaDriver implements SchemaDriver {
  constructor(readonly connection: SqlConnection) {}

  get #db(): Kysely<any> {
    const db = this.connection.kysely;
    if (!db) {
      throw new Error(
        "Postgres.Schema: the referenced connection is not built on kysely, which the schema " +
          "runner requires.",
      );
    }
    return db;
  }

  /** Every key is added in the constraint phase, after every table — which is
   *  what makes declaration order irrelevant and lets a key name a table
   *  declared below it, or the table it sits on. */
  readonly foreignKeysInCreateTable = false;

  /** `pg_constraint.conname` is the name the declaration gave it. */
  readonly namesForeignKeys = true;

  quote(name: string): string {
    return quoteAnsiIdentifier(name);
  }

  qualify(schema: string, table: string): string {
    return `${this.quote(schema)}.${this.quote(table)}`;
  }

  /**
   * A session-level advisory lock held on ONE pinned connection for the
   * duration of the pass. Every replica of an app boots the same pass, so this
   * is what makes "reconcile once" true rather than hoped for; the body runs on
   * the pool, which is fine — an advisory lock excludes other sessions, not
   * other statements in this one.
   */
  async withLock<T>(schema: string, body: () => Promise<T>): Promise<T> {
    return this.#db.connection().execute(async (pinned) => {
      await pinned.executeQuery(
        CompiledQuery.raw(`SELECT pg_advisory_lock(hashtext($1))`, [`telo.schema.${schema}`]),
      );
      try {
        // The lock is held on a PINNED connection while the pass runs on the
        // pool, so the pass needs a second connection to exist. On a pool of one
        // it would wait for the connection this hold is keeping — a deadlock at
        // boot, with no output and nothing to time it out. Proven with a trivial
        // statement before any real work, so the failure is a message naming the
        // cause rather than an application that never starts.
        await this.#requireSecondConnection(schema);
        return await body();
      } finally {
        await pinned.executeQuery(
          CompiledQuery.raw(`SELECT pg_advisory_unlock(hashtext($1))`, [`telo.schema.${schema}`]),
        );
      }
    });
  }

  async #requireSecondConnection(schema: string): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const starved = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new Error(
              `Postgres.Schema: could not obtain a second connection within ` +
                `${SECOND_CONNECTION_TIMEOUT_MS}ms while holding the schema lock for ` +
                `'${schema}'. The reconciliation pass runs on the pool while the lock is held ` +
                `on a connection of its own, so the pool must allow at least two — raise ` +
                `'pool.max' on the connection this schema references.`,
            ),
          ),
        SECOND_CONNECTION_TIMEOUT_MS,
      );
    });
    try {
      await Promise.race([this.connection.execute(`SELECT 1`), starved]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  ensureNamespaceStatements(schema: string): string[] {
    return [`CREATE SCHEMA IF NOT EXISTS ${this.quote(schema)}`];
  }

  ledgerStatements(schema: string, tables: LedgerTables): string[] {
    const table = (name: string): string => this.qualify(schema, name);
    return [
      `CREATE TABLE IF NOT EXISTS ${table(tables.migrations)} (` +
        `key text PRIMARY KEY, applied_at text NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS ${table(tables.versions)} (` +
        `sequence integer PRIMARY KEY, version text NOT NULL, digest text NOT NULL, ` +
        `first_seen_at text NOT NULL, declaration text NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS ${table(tables.tombstones)} (` +
        `object_key text PRIMARY KEY, kind text NOT NULL, table_name text NOT NULL, ` +
        `name text, definition text NOT NULL, missing_since_version text NOT NULL, ` +
        `missing_since_sequence integer NOT NULL, missing_since_at text NOT NULL)`,
    ];
  }

  async now(): Promise<string> {
    const result = await this.connection.execute<{ now: string }>(
      `SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS now`,
    );
    return String(result.rows[0]?.now);
  }

  /** PostgreSQL has transactional DDL, so a failed reconcile phase leaves
   *  nothing half applied. */
  async runAtomically(statements: readonly string[]): Promise<void> {
    if (statements.length === 0) return;
    await this.#db.transaction().execute(async (trx) => {
      for (const statement of statements) {
        await trx.executeQuery(CompiledQuery.raw(statement));
      }
    });
  }

  /** `ALTER TYPE … ADD VALUE` cannot be used in the transaction that adds it, so
   *  these run one at a time and unwrapped. Idempotent by `IF NOT EXISTS`, which
   *  is what makes a partial run safe to repeat. */
  async runSequentially(statements: readonly string[]): Promise<void> {
    for (const statement of statements) await this.connection.execute(statement);
  }

  /** Every phase but `enumValue`: PostgreSQL refuses to use an enum value in the
   *  transaction that adds it, so a column added in the same pass could not
   *  carry it as a default. */
  transactionalPhase(phase: PlanPhase): boolean {
    return phase !== "enumValue";
  }

  async introspect(schema: string, tables: readonly string[]): Promise<LiveTable[]> {
    if (tables.length === 0) return [];
    const columns = await this.connection.execute<Record<string, unknown>>(
      `SELECT table_name, column_name, udt_name, is_nullable, column_default, ` +
        `character_maximum_length, numeric_precision, numeric_scale ` +
        `FROM information_schema.columns WHERE table_schema = $1 ORDER BY ordinal_position`,
      [schema],
    );
    // Index definitions, not names: which columns an index covers and whether it
    // is unique are what the declaration promises. `pg_index` carries both, and
    // marks the ones backing a constraint so they can be read for the column
    // flags and left out of the diff — nothing declared them, so nothing owns
    // them.
    const indexes = await this.connection.execute<Record<string, unknown>>(
      `SELECT t.relname AS table_name, i.relname AS index_name, ix.indisunique AS is_unique, ` +
        `ix.indisprimary AS is_primary, ` +
        `ix.indisunique AND (ix.indisprimary OR con.contype IS NOT NULL) AS backs_constraint, ` +
        `ARRAY(SELECT a.attname FROM unnest(ix.indkey) WITH ORDINALITY AS k(attnum, ord) ` +
        `JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum ORDER BY k.ord)::text[] AS columns ` +
        `FROM pg_index ix ` +
        `JOIN pg_class i ON i.oid = ix.indexrelid ` +
        `JOIN pg_class t ON t.oid = ix.indrelid ` +
        `JOIN pg_namespace n ON n.oid = t.relnamespace ` +
        `LEFT JOIN pg_constraint con ON con.conindid = ix.indexrelid ` +
        `WHERE n.nspname = $1`,
      [schema],
    );
    const foreignKeys = await this.connection.execute<Record<string, unknown>>(
      `SELECT c.conname AS name, t.relname AS table_name, rt.relname AS referenced_table, ` +
        `c.confdeltype AS on_delete, c.confupdtype AS on_update, ` +
        `ARRAY(SELECT a.attname FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord) ` +
        `JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum ORDER BY k.ord)::text[] AS columns, ` +
        `ARRAY(SELECT a.attname FROM unnest(c.confkey) WITH ORDINALITY AS k(attnum, ord) ` +
        `JOIN pg_attribute a ON a.attrelid = rt.oid AND a.attnum = k.attnum ORDER BY k.ord)::text[] AS referenced_columns ` +
        `FROM pg_constraint c ` +
        `JOIN pg_class t ON t.oid = c.conrelid ` +
        `JOIN pg_class rt ON rt.oid = c.confrelid ` +
        `JOIN pg_namespace n ON n.oid = t.relnamespace ` +
        `WHERE n.nspname = $1 AND c.contype = 'f'`,
      [schema],
    );

    // `contype = 'c'` is a CHECK; `convalidated` says whether it has been proven
    // against the rows already there, which is the state `validate: deferred`
    // leaves behind. Constraints PostgreSQL generates for a NOT NULL column are
    // excluded by `conname` never matching a declared one — they are matched by
    // name like every other check, and nothing declared them, so nothing owns
    // them.
    const checks = await this.connection.execute<Record<string, unknown>>(
      `SELECT c.conname AS name, t.relname AS table_name, c.convalidated AS validated, ` +
        `pg_get_constraintdef(c.oid) AS definition ` +
        `FROM pg_constraint c ` +
        `JOIN pg_class t ON t.oid = c.conrelid ` +
        `JOIN pg_namespace n ON n.oid = t.relnamespace ` +
        `WHERE n.nspname = $1 AND c.contype = 'c'`,
      [schema],
    );

    const declared = new Set(tables);
    const live = new Map<
      string,
      {
        columns: LiveColumn[];
        indexes: LiveIndex[];
        fks: LiveForeignKey[];
        checks: LiveCheck[];
      }
    >();
    const bucket = (name: string) => {
      let entry = live.get(name);
      if (!entry) live.set(name, (entry = { columns: [], indexes: [], fks: [], checks: [] }));
      return entry;
    };

    // Read before the columns are built, so a column can say whether a key or a
    // single-column unique constraint covers it.
    const keyed = new Map<string, Set<string>>();
    const uniqued = new Map<string, Set<string>>();
    for (const row of indexes.rows) {
      const table = String(row.table_name);
      if (!declared.has(table)) continue;
      const columns = (row.columns as string[]) ?? [];
      if (row.is_primary === true) {
        keyed.set(table, new Set([...(keyed.get(table) ?? []), ...columns]));
      } else if (row.is_unique === true && columns.length === 1) {
        uniqued.set(table, new Set([...(uniqued.get(table) ?? []), columns[0]!]));
      }
    }

    for (const row of columns.rows) {
      const table = String(row.table_name);
      if (!declared.has(table)) continue;
      const name = String(row.column_name);
      bucket(table).columns.push({
        name,
        typeSignature: liveSignature(row),
        nullable: String(row.is_nullable).toUpperCase() === "YES",
        hasDefault: row.column_default != null,
        primaryKey: keyed.get(table)?.has(name) ?? false,
        unique: uniqued.get(table)?.has(name) ?? false,
      });
    }
    for (const row of indexes.rows) {
      const table = String(row.table_name);
      if (!live.has(table) || row.backs_constraint === true) continue;
      bucket(table).indexes.push({
        name: String(row.index_name),
        columns: (row.columns as string[]) ?? [],
        unique: row.is_unique === true,
      });
    }
    for (const row of foreignKeys.rows) {
      const table = String(row.table_name);
      if (!live.has(table)) continue;
      bucket(table).fks.push({
        name: String(row.name),
        columns: (row.columns as string[]) ?? [],
        references: {
          table: String(row.referenced_table),
          columns: (row.referenced_columns as string[]) ?? [],
        },
        onDelete: REFERENTIAL_ACTIONS[String(row.on_delete)],
        onUpdate: REFERENTIAL_ACTIONS[String(row.on_update)],
      });
    }

    for (const row of checks.rows) {
      const table = String(row.table_name);
      if (!live.has(table)) continue;
      bucket(table).checks.push({
        name: String(row.name),
        // `pg_get_constraintdef` renders `CHECK ((expr)) NOT VALID`; the
        // predicate is what a declaration states, so the wrapper comes off here
        // rather than in the comparison.
        expression: predicateOf(String(row.definition)),
        validated: row.validated === true,
      });
    }

    return [...live].map(([name, entry]) => ({
      name,
      columns: entry.columns,
      indexes: entry.indexes,
      foreignKeys: entry.fks,
      checks: entry.checks,
    }));
  }

  /** PostgreSQL has a first-class enum type, so a domain is a schema object and
   *  a column simply names it. */
  readonly namedEnumTypes = true;

  async introspectEnums(schema: string, names: readonly string[]): Promise<LiveEnum[]> {
    if (names.length === 0) return [];
    const rows = await this.connection.execute<Record<string, unknown>>(
      `SELECT t.typname AS name, ` +
        `ARRAY(SELECT e.enumlabel FROM pg_enum e WHERE e.enumtypid = t.oid ` +
        `ORDER BY e.enumsortorder)::text[] AS values ` +
        `FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace ` +
        `WHERE n.nspname = $1 AND t.typtype = 'e'`,
      [schema],
    );
    const declared = new Set(names);
    return rows.rows
      .filter((row) => declared.has(String(row.name)))
      .map((row) => ({ name: String(row.name), values: (row.values as string[]) ?? [] }));
  }

  createEnum(schema: string, declared: DeclaredEnum): string[] {
    const values = declared.values.map((value) => literal(value)).join(", ");
    return [`CREATE TYPE ${this.qualify(schema, declared.typeName)} AS ENUM (${values})`];
  }

  addEnumValues(schema: string, declared: DeclaredEnum, values: readonly string[]): string[] {
    return values.map(
      (value) =>
        `ALTER TYPE ${this.qualify(schema, declared.typeName)} ADD VALUE IF NOT EXISTS ` +
        literal(value),
    );
  }

  renameEnum(schema: string, from: string, to: string): string[] {
    return [`ALTER TYPE ${this.qualify(schema, from)} RENAME TO ${this.quote(to)}`];
  }

  /** Instant, and it rewrites nothing: the rows stay where they are. */
  renameTable(schema: string, from: string, to: string): string[] {
    return [`ALTER TABLE ${this.qualify(schema, from)} RENAME TO ${this.quote(to)}`];
  }

  /** Nothing about an enum is unsafe to bring to its declaration on PostgreSQL:
   *  a value is added in place, and a REMOVAL is never planned by the shared half
   *  on any engine. */
  classifyEnumChange(): ChangeSafety {
    return { safe: true };
  }

  dropEnum(schema: string, name: string): string[] {
    return [`DROP TYPE IF EXISTS ${this.qualify(schema, name)}`];
  }

  readonly namedExtensions = true;

  async introspectExtensions(_schema: string, names: readonly string[]): Promise<string[]> {
    if (names.length === 0) return [];
    const rows = await this.connection.execute<Record<string, unknown>>(
      `SELECT extname AS name FROM pg_extension`,
    );
    const declared = new Set(names);
    return rows.rows.map((row) => String(row.name)).filter((name) => declared.has(name));
  }

  /**
   * Installed where the connection's `search_path` will find it, NOT into the
   * schema this resource owns.
   *
   * `SCHEMA <ns>` was the first thing tried and it is wrong: an extension's types
   * are then reachable only when qualified, so a column declared `citext` fails
   * with `type "citext" does not exist` while the extension provably exists. And
   * qualifying a type is not something the declaration can express — `citext` is
   * an entry in this engine's storage-class vocabulary, not a name the author
   * scoped.
   *
   * Unqualified is also the honest reading of what an extension IS: it is
   * database-wide and shared, which is the same fact `canReclaim` refuses a drop
   * over. `IF NOT EXISTS` is what makes two schema resources declaring the same
   * one idempotent rather than a race.
   */
  createExtension(_schema: string, name: string): string[] {
    return [`CREATE EXTENSION IF NOT EXISTS ${this.quote(name)}`];
  }

  /** Unreachable: `canReclaim` refuses an extension before the drop is planned. */
  dropExtension(_schema: string, name: string): string[] {
    throw new Error(`Postgres.Schema: extension '${name}' is never dropped automatically.`);
  }

  typeSignature(column: DeclaredColumn): string {
    // A column whose type is an enum reports back under the TYPE's name, which is
    // what `udt_name` carries — so the signature is that name and the comparison
    // needs nothing new.
    if (column.enum) {
      return column.array ? `_${column.enum.typeName}` : column.enum.typeName;
    }
    const entry = typeEntry(column.type);
    let signature = entry.udt;
    if (entry.lengthed && column.params.length != null) {
      signature += `(${Number(column.params.length)})`;
    }
    if (entry.precise && column.params.precision != null) {
      const scale = column.params.scale == null ? 0 : Number(column.params.scale);
      signature += `(${Number(column.params.precision)},${scale})`;
    }
    return column.array ? `_${signature}` : signature;
  }

  /** PostgreSQL cannot alter an index, so it is dropped and recreated. */
  classifyIndexChange(): ChangeSafety {
    return { safe: true };
  }

  /** A foreign key is dropped and re-added; the re-add revalidates the data,
   *  which is what makes a tightened constraint fail loudly rather than lie. */
  classifyForeignKeyChange(): ChangeSafety {
    return { safe: true };
  }

  classifyAlter(live: LiveColumn, declared: DeclaredColumn): ChangeSafety {
    const target = this.typeSignature(declared);
    if (live.typeSignature !== target) {
      const arrayChange = this.#arrayChange(live.typeSignature, target);
      if (arrayChange) return arrayChange;
      const from = baseType(live.typeSignature);
      const to = baseType(target);
      if (!widens(from, to)) {
        return {
          safe: false,
          reason:
            `changing ${live.typeSignature} to ${target} is not a widening conversion, so ` +
            `existing values may not survive it. Convert the data in a 'prepare:' ` +
            `entry first, or declare the wider type.`,
        };
      }
      if (from === to && !lengthGrows(live.typeSignature, target)) {
        return {
          safe: false,
          reason:
            `narrowing ${live.typeSignature} to ${target} would truncate existing values. ` +
            `Make the data fit in a 'prepare:' entry first.`,
        };
      }
    }
    if (live.primaryKey !== declared.primaryKey) {
      return {
        safe: false,
        reason:
          `the primary key cannot be added or dropped by altering a column ` +
          `(primaryKey ${live.primaryKey} → ${declared.primaryKey}). Change it in a ` +
          `'prepare:' entry, where the constraint can be named.`,
      };
    }
    if (live.unique !== declared.unique) {
      return {
        safe: false,
        reason:
          `uniqueness is a named constraint, not a column property that can be toggled in ` +
          `place (unique ${live.unique} → ${declared.unique}). Add or drop it in a ` +
          `'prepare:' entry — adding it fails if the column already holds duplicates, ` +
          `which is the check you want — or declare a unique index instead.`,
      };
    }
    if (live.nullable && !declared.nullable) {
      return {
        safe: false,
        reason:
          "adding NOT NULL to a column that is currently nullable fails if any row holds " +
          "NULL. Backfill it in a 'prepare:' entry first.",
      };
    }
    return { safe: true };
  }

  classifyCopy(live: LiveColumn, target: DeclaredColumn): ChangeSafety {
    const to = this.typeSignature(target);
    if (live.typeSignature === to) return { safe: true };
    const arrayChange = this.#arrayChange(live.typeSignature, to);
    if (arrayChange) return arrayChange;
    if (widens(baseType(live.typeSignature), baseType(to)) && lengthGrows(live.typeSignature, to)) {
      return { safe: true };
    }
    return {
      safe: false,
      reason:
        `copying ${live.typeSignature} values into a ${to} column is not a widening ` +
        `conversion, so PostgreSQL will either refuse the assignment or lose data. Convert ` +
        `the data in a 'prepare:' entry, or declare the same type.`,
    };
  }

  /**
   * Wrapping a column in an array — or unwrapping it — is not a conversion
   * PostgreSQL will perform on its own, and `baseType` strips the `_` prefix, so
   * `text` and `text[]` would otherwise compare as the same base and pass as a
   * widening. The engine then rejects the `ALTER … TYPE text[]` for want of a
   * `USING` clause, which is a driver error naming a statement the author never
   * wrote. Refused here instead, with what to do about it.
   */
  #arrayChange(from: string, to: string): ChangeSafety | undefined {
    const wasArray = from.startsWith("_");
    const isArray = to.startsWith("_");
    if (wasArray === isArray) return undefined;
    return {
      safe: false,
      reason: isArray
        ? `making ${from} an array is not a conversion PostgreSQL performs on its own. Add the ` +
          `column alongside and copy with an explicit cast in a 'prepare:' entry.`
        : `unwrapping the array ${from} into ${to} would discard every element but one at best. ` +
          `Convert the data in a 'prepare:' entry.`,
    };
  }

  #typeSql(schema: string, column: DeclaredColumn): string {
    // A named type is written schema-qualified like every other identifier here:
    // relying on `search_path` would let a session default decide which type a
    // column gets, with no error when it decides wrong.
    if (column.enum) {
      const sql = this.qualify(schema, column.enum.typeName);
      return column.array ? `${sql}[]` : sql;
    }
    const entry = typeEntry(column.type);
    let sql = entry.ddl ?? column.type;
    if (entry.lengthed && column.params.length != null) sql += `(${Number(column.params.length)})`;
    if (entry.precise && column.params.precision != null) {
      const scale = column.params.scale == null ? 0 : Number(column.params.scale);
      sql += `(${Number(column.params.precision)},${scale})`;
    }
    return column.array ? `${sql}[]` : sql;
  }

  #defaultSql(column: DeclaredColumn): string {
    if (column.defaultExpression !== undefined) return ` DEFAULT ${column.defaultExpression}`;
    if (column.default !== undefined) return ` DEFAULT ${literal(column.default)}`;
    return "";
  }

  #columnDefinition(schema: string, column: DeclaredColumn): string {
    // An identity column takes its values from the sequence; PostgreSQL rejects
    // a DEFAULT beside it rather than preferring one.
    if (column.identity && (column.default !== undefined || column.defaultExpression !== undefined)) {
      throw new Error(
        `Postgres.Table: column '${column.name}' declares identity and a default. An identity ` +
          `column takes its values from its own sequence — drop the default.`,
      );
    }
    const parts = [this.quote(column.name), this.#typeSql(schema, column)];
    if (column.identity) {
      parts.push(`GENERATED ${column.identity.toUpperCase()} AS IDENTITY`);
    }
    if (column.primaryKey) parts.push("PRIMARY KEY");
    if (!column.nullable) parts.push("NOT NULL");
    if (column.unique) parts.push("UNIQUE");
    return parts.join(" ") + this.#defaultSql(column);
  }

  createTable(schema: string, table: DeclaredTable): string[] {
    const parts = table.columns.map((column) => this.#columnDefinition(schema, column));
    return [
      `CREATE TABLE IF NOT EXISTS ${this.qualify(schema, table.name)} (\n  ` +
        `${parts.join(",\n  ")}\n)`,
    ];
  }

  addColumn(schema: string, table: string, column: DeclaredColumn): string[] {
    if (!column.nullable && column.default === undefined && column.defaultExpression === undefined) {
      throw new Error(
        `Postgres.Table: column '${table}.${column.name}' is NOT NULL with no default, which ` +
          `cannot be added to a table that already has rows. Give it a default, or add it ` +
          `nullable and backfill in a 'migrations:' entry.`,
      );
    }
    return [
      `ALTER TABLE ${this.qualify(schema, table)} ADD COLUMN IF NOT EXISTS ` +
        this.#columnDefinition(schema, column),
    ];
  }

  alterColumn(schema: string, table: string, live: LiveColumn, column: DeclaredColumn): string[] {
    const target = this.qualify(schema, table);
    const name = this.quote(column.name);
    const statements: string[] = [];
    if (live.typeSignature !== this.typeSignature(column)) {
      statements.push(
        `ALTER TABLE ${target} ALTER COLUMN ${name} TYPE ${this.#typeSql(schema, column)}`,
      );
    }
    if (live.nullable !== column.nullable) {
      statements.push(
        `ALTER TABLE ${target} ALTER COLUMN ${name} ` +
          (column.nullable ? "DROP NOT NULL" : "SET NOT NULL"),
      );
    }
    const declaresDefault =
      column.default !== undefined || column.defaultExpression !== undefined;
    if (live.hasDefault !== declaresDefault) {
      statements.push(
        `ALTER TABLE ${target} ALTER COLUMN ${name} ` +
          (declaresDefault ? `SET${this.#defaultSql(column)}` : "DROP DEFAULT"),
      );
    }
    return statements;
  }

  copyColumn(schema: string, table: string, from: string, to: string): string[] {
    return [
      `UPDATE ${this.qualify(schema, table)} SET ${this.quote(to)} = ${this.quote(from)} ` +
        `WHERE ${this.quote(to)} IS NULL`,
    ];
  }

  createIndex(schema: string, table: string, index: DeclaredIndex): string[] {
    const unique = index.unique ? "UNIQUE " : "";
    const method = typeof index.options.method === "string" ? ` USING ${index.options.method}` : "";
    const where = typeof index.options.where === "string" ? ` WHERE ${index.options.where}` : "";
    const columns = index.columns.map((c) => this.quote(c)).join(", ");
    return [
      `CREATE ${unique}INDEX IF NOT EXISTS ${this.quote(index.name)} ` +
        `ON ${this.qualify(schema, table)}${method} (${columns})${where}`,
    ];
  }

  dropIndex(schema: string, _table: string, index: string): string[] {
    return [`DROP INDEX IF EXISTS ${this.qualify(schema, index)}`];
  }

  addForeignKey(schema: string, table: string, fk: DeclaredForeignKey): string[] {
    const columns = fk.columns.map((c) => this.quote(c)).join(", ");
    const refColumns = fk.references.columns.map((c) => this.quote(c)).join(", ");
    let statement =
      `ALTER TABLE ${this.qualify(schema, table)} ADD CONSTRAINT ${this.quote(fk.name)} ` +
      `FOREIGN KEY (${columns}) REFERENCES ${this.qualify(schema, fk.references.table)} ` +
      `(${refColumns})`;
    if (fk.onDelete) statement += ` ON DELETE ${fk.onDelete.toUpperCase()}`;
    if (fk.onUpdate) statement += ` ON UPDATE ${fk.onUpdate.toUpperCase()}`;
    return [statement];
  }

  dropForeignKey(schema: string, table: string, name: string): string[] {
    return [
      `ALTER TABLE ${this.qualify(schema, table)} DROP CONSTRAINT IF EXISTS ${this.quote(name)}`,
    ];
  }

  /** PostgreSQL has `ADD CONSTRAINT`, so a check is an ordinary diff. */
  readonly checksInCreateTable = false;

  /**
   * PostgreSQL stores a NORMALIZED rendering of the predicate — `balance_cents
   * >= 0` comes back as `((balance_cents >= 0))` — so comparing the author's text
   * against it would replan the same constraint on every boot.
   *
   * Compared with whitespace and the engine's outer parentheses removed. That is
   * a heuristic rather than a parse, and it is the SAFE direction for a
   * constraint: a false "same" leaves a constraint the author edited in place,
   * which the ledger still records as declared, while a false "different" would
   * drop and re-add — revalidating every row — on every boot forever.
   */
  checkDiffers(live: LiveCheck, declared: DeclaredCheck): boolean {
    return normalizePredicate(live.expression) !== normalizePredicate(declared.expression);
  }

  /** A check is dropped and re-added; the re-add revalidates the data, which is
   *  what makes a tightened predicate fail loudly rather than lie. */
  classifyCheckChange(): ChangeSafety {
    return { safe: true };
  }

  addCheck(schema: string, table: string, check: DeclaredCheck): string[] {
    // `NOT VALID` enforces the predicate for new rows immediately and defers the
    // scan of the existing ones — which is what keeps adding a constraint to a
    // large table from holding a lock while every row is read.
    const notValid = check.validate === "deferred" ? " NOT VALID" : "";
    return [
      `ALTER TABLE ${this.qualify(schema, table)} ADD CONSTRAINT ${this.quote(check.name)} ` +
        `CHECK (${check.expression})${notValid}`,
    ];
  }

  dropCheck(schema: string, table: string, name: string): string[] {
    return [
      `ALTER TABLE ${this.qualify(schema, table)} DROP CONSTRAINT IF EXISTS ${this.quote(name)}`,
    ];
  }

  validateCheck(schema: string, table: string, name: string): string[] {
    return [
      `ALTER TABLE ${this.qualify(schema, table)} VALIDATE CONSTRAINT ${this.quote(name)}`,
    ];
  }

  /**
   * PostgreSQL can drop every object kind this design tracks EXCEPT an
   * extension, which is refused deliberately rather than for want of a
   * statement.
   *
   * An extension is database-wide and shared: something outside this schema may
   * be using it, and `DROP EXTENSION` takes every object that depends on it with
   * it. Tombstoned on removal rather than dropped, so the record exists and the
   * decision stays a person's.
   */
  canReclaim(id: SchemaObjectId): ChangeSafety {
    if (id.kind === "extension") {
      return {
        safe: false,
        reason:
          "an extension is database-wide, so something outside this schema may be using it and " +
          "DROP EXTENSION would take every dependent object with it. Removed from the " +
          "declaration it is recorded and left installed; drop it by hand when nothing needs it.",
      };
    }
    return { safe: true };
  }

  dropColumn(schema: string, table: string, column: string): string[] {
    return [
      `ALTER TABLE ${this.qualify(schema, table)} DROP COLUMN IF EXISTS ${this.quote(column)}`,
    ];
  }

  dropTable(schema: string, table: string): string[] {
    return [`DROP TABLE IF EXISTS ${this.qualify(schema, table)}`];
  }

  /** The dialect half of rendering a seed row — see `row-statements.ts`, which
   *  owns the statement SHAPE both engines share. */
  get #rowDialect(): RowDialect {
    return {
      quote: (name) => this.quote(name),
      literal,
      qualify: (schema, table) => this.qualify(schema, table),
      excludedAlias: "EXCLUDED",
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

/**
 * A declared value as PostgreSQL literal text.
 *
 * Structured values are SERIALIZED, never stringified. `String({})` is
 * `[object Object]` and `String([1,2])` is `1,2`, and a `json` / `jsonb` column
 * projects to an OPEN schema by design (a JSON column holds any JSON value), so
 * a structured seed value passed `telo check` and reached the database as that
 * text — silent corruption in the one place a seed row is most likely to carry
 * one. Serialized, it is exactly right for a JSON column and a loud type error
 * from the engine for anything else, which is the direction this design takes
 * everywhere else it cannot decide.
 *
 * Bytes get the engine's own hex form: `!include-bytes` resolves to a
 * `Uint8Array` before a controller sees it, and `String(...)` on one yields its
 * elements comma-joined.
 */
function literal(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (value instanceof Uint8Array) return `'\\x${Buffer.from(value).toString("hex")}'`;
  if (typeof value === "object") return quoted(JSON.stringify(value));
  return quoted(String(value));
}

/** Single quotes doubled — the only escape `standard_conforming_strings` (on by
 *  default since 9.1) requires. */
function quoted(text: string): string {
  return `'${text.replace(/'/g, "''")}'`;
}

function liveSignature(row: Record<string, unknown>): string {
  const udt = String(row.udt_name);
  if (row.character_maximum_length != null) return `${udt}(${Number(row.character_maximum_length)})`;
  if (udt === "numeric" && row.numeric_precision != null) {
    return `${udt}(${Number(row.numeric_precision)},${Number(row.numeric_scale ?? 0)})`;
  }
  return udt;
}

/** The predicate out of `CHECK ((…)) NOT VALID`, which is what a declaration
 *  states. The wrapper is the engine's rendering, not part of what was declared. */
function predicateOf(definition: string): string {
  const match = /^CHECK\s*\((.*)\)(?:\s+NOT VALID)?$/is.exec(definition.trim());
  return match ? match[1]! : definition;
}

/** Whitespace and the engine's own outer parentheses removed, so an author's
 *  `balance_cents >= 0` and the catalogue's `((balance_cents >= 0))` compare
 *  equal. See {@link PostgresSchemaDriver.checkDiffers} for why the heuristic is
 *  the safe direction here. */
function normalizePredicate(expression: string): string {
  let text = expression.replace(/\s+/g, "");
  while (text.startsWith("(") && text.endsWith(")") && balanced(text.slice(1, -1))) {
    text = text.slice(1, -1);
  }
  return text.toLowerCase();
}

/** True when every parenthesis in `text` closes within it — what makes stripping
 *  the outer pair safe rather than a way to mangle `(a)AND(b)`. */
function balanced(text: string): boolean {
  let depth = 0;
  for (const character of text) {
    if (character === "(") depth++;
    else if (character === ")" && --depth < 0) return false;
  }
  return depth === 0;
}

function baseType(signature: string): string {
  const bare = signature.startsWith("_") ? signature.slice(1) : signature;
  const paren = bare.indexOf("(");
  return paren < 0 ? bare : bare.slice(0, paren);
}

function sizeOf(signature: string): number | null {
  const match = /\((\d+)/.exec(signature);
  return match ? Number(match[1]) : null;
}

/** An unsized `text`-family target is unbounded, so growing into it is safe. */
function lengthGrows(from: string, to: string): boolean {
  const before = sizeOf(from);
  const after = sizeOf(to);
  if (after === null) return true;
  if (before === null) return false;
  return after >= before;
}
