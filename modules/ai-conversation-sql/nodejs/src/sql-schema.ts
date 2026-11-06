import { InvokeError, isInvokeError } from "@telorun/sdk";
import type { SqlNames } from "./sql-names.js";

/** The schema version this module writes. Version 0 is any state before a version is recorded: no tables, or the tables with no version row. */
export const SCHEMA_VERSION = 3;

export const ERR_CONVERSATION_SCHEMA_NEWER = "ERR_CONVERSATION_SCHEMA_NEWER";
export const ERR_CONVERSATION_SCHEMA_OUTDATED = "ERR_CONVERSATION_SCHEMA_OUTDATED";

interface Migration {
  /** The version the migration leaves the tables at. */
  readonly to: number;
  readonly statements: (n: SqlNames) => string[];
}

/** Idempotent, so it also adopts tables present before a version was recorded. */
const MIGRATIONS: readonly Migration[] = [
  {
    to: 1,
    statements: (n) => [
      `CREATE TABLE IF NOT EXISTS ${n.conversations} (
         id TEXT PRIMARY KEY,
         title TEXT,
         archived INTEGER NOT NULL DEFAULT 0,
         turn TEXT,
         version BIGINT NOT NULL,
         next_sequence BIGINT NOT NULL,
         created_at BIGINT NOT NULL,
         updated_at BIGINT NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS ${n.conversationsRecentIndex} ON ${n.conversations} (archived, updated_at, id)`,
      `CREATE TABLE IF NOT EXISTS ${n.entries} (
         id TEXT PRIMARY KEY,
         conversation_id TEXT NOT NULL,
         parent_id TEXT NOT NULL,
         seq BIGINT NOT NULL,
         depth BIGINT NOT NULL,
         turn TEXT NOT NULL,
         message TEXT NOT NULL,
         created_at BIGINT NOT NULL
       )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS ${n.entriesSequenceIndex} ON ${n.entries} (conversation_id, seq)`,
      `CREATE INDEX IF NOT EXISTS ${n.entriesBranchIndex} ON ${n.entries} (conversation_id, parent_id, seq)`,
      `CREATE TABLE IF NOT EXISTS ${n.approvals} (
         conversation_id TEXT NOT NULL,
         approval_id TEXT NOT NULL,
         entry_id TEXT NOT NULL,
         tool_call_id TEXT NOT NULL,
         requested_at BIGINT NOT NULL,
         decided_at BIGINT,
         approved INTEGER,
         reason TEXT,
         decided_turn TEXT,
         PRIMARY KEY (conversation_id, approval_id)
       )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS ${n.approvalsCallIndex} ON ${n.approvals} (conversation_id, entry_id, tool_call_id)`,
    ],
  },
  {
    to: 2,
    statements: (n) => [`CREATE INDEX IF NOT EXISTS ${n.conversationsUpdatedIndex} ON ${n.conversations} (updated_at, id)`],
  },
  {
    to: 3,
    statements: (n) => [
      `CREATE TABLE IF NOT EXISTS ${n.attachments} (
         id TEXT PRIMARY KEY,
         conversation_id TEXT,
         name TEXT,
         created_at BIGINT NOT NULL,
         bound_at BIGINT,
         released_at BIGINT
       )`,
      `CREATE INDEX IF NOT EXISTS ${n.attachmentsHolderIndex} ON ${n.attachments} (conversation_id, released_at, created_at)`,
      `CREATE INDEX IF NOT EXISTS ${n.attachmentsReleasedIndex} ON ${n.attachments} (released_at)`,
    ],
  },
];

export interface SchemaExecutor {
  query(sql: string, params?: unknown[]): Promise<Array<Record<string, unknown>>>;
  inTransaction<T>(body: (exec: SchemaExecutor) => Promise<T>): Promise<T>;
}

async function recordedVersion(exec: SchemaExecutor, n: SqlNames): Promise<number> {
  const rows = await exec.query(`SELECT version FROM ${n.schema} WHERE id = 1`);
  return rows.length === 0 ? 0 : Number(rows[0]!.version);
}

function newer(describe: string, recorded: number): InvokeError {
  return new InvokeError(
    ERR_CONVERSATION_SCHEMA_NEWER,
    `${describe}: the tables record schema version ${recorded}, newer than the ${SCHEMA_VERSION} this module reads. Upgrade the module; the tables are untouched.`,
  );
}

/**
 * Brings the tables to {@link SCHEMA_VERSION}: creates and upgrades them in
 * place when `create`, otherwise only verifies the recorded version. A newer
 * recorded version is refused either way.
 */
export async function ensureSchema(
  exec: SchemaExecutor,
  n: SqlNames,
  create: boolean,
  describe: string,
): Promise<void> {
  if (!create) {
    const recorded = await recordedVersion(exec, n);
    if (recorded > SCHEMA_VERSION) throw newer(describe, recorded);
    if (recorded < SCHEMA_VERSION) {
      throw new InvokeError(
        ERR_CONVERSATION_SCHEMA_OUTDATED,
        `${describe}: the tables record schema version ${recorded}, not ${SCHEMA_VERSION}, and 'createTables' is false so nothing upgrades them. Migrate them or set 'createTables' to true.`,
      );
    }
    return;
  }
  // Every statement is idempotent, so two instances starting on an empty
  // database may collide on the DDL (PostgreSQL refuses a concurrent
  // `CREATE … IF NOT EXISTS` of one name with a unique violation): the loser
  // runs the pass again, now over what the winner created. Its own failure is
  // not retried.
  try {
    await createAndMigrate(exec, n, describe);
  } catch (err) {
    if (isInvokeError(err)) throw err;
    await createAndMigrate(exec, n, describe);
  }
}

async function createAndMigrate(exec: SchemaExecutor, n: SqlNames, describe: string): Promise<void> {
  await exec.query(
    `CREATE TABLE IF NOT EXISTS ${n.schema} (id INTEGER PRIMARY KEY, version INTEGER NOT NULL)`,
  );
  await exec.inTransaction(async (tx) => {
    const recorded = await recordedVersion(tx, n);
    if (recorded > SCHEMA_VERSION) throw newer(describe, recorded);
    if (recorded === SCHEMA_VERSION) return;
    for (const migration of MIGRATIONS.filter((m) => m.to > recorded)) {
      for (const statement of migration.statements(n)) await tx.query(statement);
    }
    await tx.query(`DELETE FROM ${n.schema} WHERE id = 1`);
    await tx.query(`INSERT INTO ${n.schema} (id, version) VALUES (1, ${SCHEMA_VERSION})`);
  });
}
