import type { SqlConnection } from "../sql-connection.js";
import type { SchemaDriver } from "./schema-driver.js";
import type { SchemaObjectId } from "./declared-schema.js";
import type { DeclarationSnapshot } from "./declaration-snapshot.js";

/**
 * The ledger lives in the target schema, not in the repository: one manifest
 * deploys to many databases and each has its own history, so the database is
 * the authority. Three tables — what has been applied, what versions have been
 * observed, and what is tombstoned awaiting reclamation.
 *
 * Which ledger a schema resource writes to is chosen by NAME (see
 * {@link ledgerTables}), not recorded in a column, so two resources over one
 * namespace keep separate histories by keeping separate tables.
 *
 * Timestamps are ISO-8601 UTC text so ordering is lexicographic on every
 * engine and no driver has to agree about a timestamp type.
 */

/**
 * The reserved root for everything Telo keeps in someone else's database.
 *
 * `telo_` reserves the root and `schema` names the domain, so a later subsystem
 * that needs SQL bookkeeping of its own (a durable journal, a lease table) sits
 * beside this one under one convention rather than inventing a second. Fixed:
 * moving it would mean a rename on every deployed database, which is why the
 * per-set name is a SUFFIX the author chooses and this part is not.
 */
const LEDGER_ROOT = "telo_schema";

/** The three tables one ledger is kept in. */
export interface LedgerTables {
  readonly migrations: string;
  readonly versions: string;
  readonly tombstones: string;
}

/**
 * Where a schema resource keeps its history.
 *
 * A namespace can be reached by more than one schema resource — two libraries in
 * one application, or two applications over one database — and each needs its
 * own history, because the ledger records the DECLARATION and a shared one would
 * make each read the other's tables as removed. Separating them by TABLE NAME is
 * how every tool in this space does it (`flyway.table`, `databaseChangeLogTableName`,
 * Alembic's `version_table`, kysely's `migrationTableName`), and it has the
 * property an owner column lacks: the identity is written down, so renaming the
 * resource that declares it changes nothing.
 */
export function ledgerTables(ledger?: string): LedgerTables {
  const stem = ledger ? `${LEDGER_ROOT}_${ledger}` : LEDGER_ROOT;
  return {
    migrations: `${stem}_migrations`,
    versions: `${stem}_versions`,
    tombstones: `${stem}_tombstones`,
  };
}

/** One observation of a deployed `(version, digest)` pair, with the declaration
 *  that produced it — the record of which objects this schema resource owns. */
export interface VersionRecord {
  readonly sequence: number;
  readonly version: string;
  readonly digest: string;
  readonly firstSeenAt: string;
  readonly declaration: DeclarationSnapshot;
}

export interface TombstoneRecord {
  readonly objectKey: string;
  readonly kind: string;
  readonly tableName: string;
  readonly name: string | null;
  /** The object's last-known definition, kept so reclamation can report what it is dropping. */
  readonly definition: string;
  readonly missingSinceVersion: string;
  readonly missingSinceSequence: number;
  readonly missingSinceAt: string;
}

function num(value: unknown): number {
  return typeof value === "bigint" ? Number(value) : Number(value ?? 0);
}

function text(value: unknown): string {
  return value == null ? "" : String(value);
}

/** A SQL string literal. Standard doubling of the quote, which every engine here reads. */
function sqlText(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function parseDeclaration(value: unknown): DeclarationSnapshot {
  if (value == null || value === "") return {};
  if (typeof value === "object") return value as DeclarationSnapshot;
  return JSON.parse(String(value)) as DeclarationSnapshot;
}

export class SchemaLedger {
  readonly #conn: SqlConnection;
  readonly #driver: SchemaDriver;
  readonly #schema: string;
  readonly #tables: LedgerTables;

  constructor(driver: SchemaDriver, schema: string, tables: LedgerTables) {
    this.#driver = driver;
    this.#conn = driver.connection;
    this.#schema = schema;
    this.#tables = tables;
  }

  #table(name: string): string {
    return this.#driver.qualify(this.#schema, name);
  }

  async ensureTables(): Promise<void> {
    for (const statement of this.#driver.ledgerStatements(this.#schema, this.#tables)) {
      await this.#conn.execute(statement);
    }
  }

  // --- applied migrations -------------------------------------------------

  async appliedMigrationKeys(): Promise<Set<string>> {
    const result = await this.#conn.execute<{ key: string }>(
      `SELECT key FROM ${this.#table(this.#tables.migrations)}`,
    );
    return new Set(result.rows.map((row) => text(row.key)));
  }

  /**
   * The ledger row for an applied migration, as a STATEMENT rather than an
   * executed write — so it can join the migration's own atomic group.
   *
   * Recording it separately would leave a window in which the migration has run
   * and the ledger does not know: a crash there re-runs a migration that may not
   * be idempotent. Literals rather than bound parameters because this statement
   * is grouped with DDL the driver executes as one unit; both values are
   * escaped, and the key is already constrained to `[A-Za-z0-9_.-]`.
   */
  migrationRecordStatement(key: string, at: string): string {
    return (
      `INSERT INTO ${this.#table(this.#tables.migrations)} (key, applied_at) ` +
      `VALUES (${sqlText(key)}, ${sqlText(at)})`
    );
  }

  // --- observed version sequence -----------------------------------------

  async versionHistory(): Promise<VersionRecord[]> {
    const result = await this.#conn.execute<Record<string, unknown>>(
      `SELECT sequence, version, digest, first_seen_at, declaration FROM ` +
        `${this.#table(this.#tables.versions)} ORDER BY sequence ASC`,
    );
    return result.rows.map((row) => ({
      sequence: num(row.sequence),
      version: text(row.version),
      digest: text(row.digest),
      firstSeenAt: text(row.first_seen_at),
      declaration: parseDeclaration(row.declaration),
    }));
  }

  /**
   * Record this boot's `(version, digest)`.
   *
   * The *sequence* is recorded rather than a counter, so going backwards is
   * visible: an older version booting proves older code is live, which is
   * exactly the condition a grace window exists to survive. A boot at the
   * version already at the head updates its digest in place and advances
   * nothing — so forgetting to bump costs grace progress rather than causing
   * harm, and local iteration accrues no budget.
   */
  /**
   * A schema with no `reclaim:` policy declares no version, so its rows carry an
   * empty label: the head is then always "the same version", updated in place,
   * and the sequence never advances. That is the honest degenerate case — there
   * is no clock because nothing is counting — and the declaration and digest,
   * which are what ownership rests on, are recorded either way.
   */
  /**
   * The version row as a STATEMENT, for the group that also carries its
   * tombstones, plus the row it will write so the caller can stamp with it.
   *
   * The *sequence* is recorded rather than a counter, so going backwards is
   * visible: an older version booting proves older code is live, which is
   * exactly the condition a grace window exists to survive. A boot at the
   * version already at the head updates its digest in place and advances
   * nothing — so forgetting to bump costs grace progress rather than causing
   * harm, and local iteration accrues no budget.
   *
   * A schema with no `reclaim:` policy declares no version, so its rows carry an
   * empty label: the head is then always "the same version", updated in place,
   * and the sequence never advances. That is the honest degenerate case — there
   * is no clock because nothing is counting — and the declaration and digest,
   * which are what ownership rests on, are recorded either way.
   */
  versionRecordStatements(
    version: string,
    declaration: DeclarationSnapshot,
    digest: string,
    at: string,
    history: readonly VersionRecord[],
  ): { record: VersionRecord; statements: string[] } {
    const head = history[history.length - 1];
    const encoded = JSON.stringify(declaration);
    if (head && head.version === version) {
      if (head.digest === digest) return { record: head, statements: [] };
      return {
        record: { ...head, digest, declaration },
        statements: [
          `UPDATE ${this.#table(this.#tables.versions)} SET digest = ${sqlText(digest)}, ` +
            `declaration = ${sqlText(encoded)} WHERE sequence = ${head.sequence}`,
        ],
      };
    }
    const record: VersionRecord = {
      sequence: (head?.sequence ?? 0) + 1,
      version,
      digest,
      firstSeenAt: at,
      declaration,
    };
    return {
      record,
      statements: [
        `INSERT INTO ${this.#table(this.#tables.versions)} ` +
          `(sequence, version, digest, first_seen_at, declaration) VALUES (` +
          `${record.sequence}, ${sqlText(version)}, ${sqlText(digest)}, ` +
          `${sqlText(at)}, ${sqlText(encoded)})`,
      ],
    };
  }

  // --- tombstones ---------------------------------------------------------

  async tombstones(): Promise<TombstoneRecord[]> {
    const result = await this.#conn.execute<Record<string, unknown>>(
      `SELECT object_key, kind, table_name, name, definition, missing_since_version, ` +
        `missing_since_sequence, missing_since_at FROM ${this.#table(this.#tables.tombstones)} ` +
        `ORDER BY object_key ASC`,
    );
    return result.rows.map((row) => ({
      objectKey: text(row.object_key),
      kind: text(row.kind),
      tableName: text(row.table_name),
      name: row.name == null ? null : text(row.name),
      definition: text(row.definition),
      missingSinceVersion: text(row.missing_since_version),
      missingSinceSequence: num(row.missing_since_sequence),
      missingSinceAt: text(row.missing_since_at),
    }));
  }

  /**
   * The row for a tombstone, as a STATEMENT — so it can be committed with the
   * version row that stamps it.
   *
   * Recording them separately leaves a window in which the new declaration is
   * `owned` and the removals are not yet tombstoned. A crash there loses them
   * for good: the next boot's `owned` no longer mentions them, so nothing is
   * ever tombstoned for those objects again and they sit in the database
   * untracked, invisible to `pendingReclamation` and undroppable without
   * hand-written SQL. The whole ownership model rests on that snapshot being the
   * PREVIOUS declaration.
   *
   * `ON CONFLICT DO NOTHING` because two passes can race where the engine has no
   * cross-process lock (SQLite): recording the same tombstone twice is a
   * convergent no-op, and a primary-key error there would be a failure over
   * agreement.
   */
  tombstoneRecordStatement(
    id: SchemaObjectId,
    objectKey: string,
    definition: string,
    version: VersionRecord,
    at: string,
  ): string {
    const values = [
      objectKey,
      id.kind,
      id.table,
      id.name,
      definition,
      version.version,
      String(version.sequence),
      at,
    ];
    const encoded = values
      .map((value, index) =>
        value == null ? "NULL" : index === 6 ? String(value) : sqlText(String(value)),
      )
      .join(", ");
    return (
      `INSERT INTO ${this.#table(this.#tables.tombstones)} (object_key, kind, table_name, ` +
      `name, definition, missing_since_version, missing_since_sequence, missing_since_at) ` +
      `VALUES (${encoded}) ON CONFLICT DO NOTHING`
    );
  }

  /** A tombstoned object that came back — the declaration is authoritative again. */
  async clearTombstone(objectKey: string): Promise<void> {
    await this.#conn.executeTemplate(
      [`DELETE FROM ${this.#table(this.#tables.tombstones)} WHERE object_key = `, ``],
      [objectKey],
    );
  }
}
