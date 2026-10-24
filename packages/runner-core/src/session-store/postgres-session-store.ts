import type { Pool, PoolClient } from "pg";

import {
  assertReadableVersion,
  ownerColumns,
  ownerFromColumns,
  SESSION_STORE_SCHEMA_VERSION,
  STORED_SESSION_STATUSES,
  storedStatus,
  type ChangeOwnerResult,
  type CreateSessionResult,
  type SessionOwner,
  type SessionRecord,
  type SessionRecordUpdate,
  type SessionStore,
} from "./session-store.js";

/** Named rather than read from the URL, which carries a password. */
const WHERE = "the Postgres session store (RUNNER_SESSION_STORE_URL)";

/** Serializes concurrent migrations of one database. */
const MIGRATION_LOCK = 0x74656c6f;

const OWNER_WORKSPACE_CONSTRAINT = "runner_sessions_owner_workspace";

const STATUS_LIST = STORED_SESSION_STATUSES.map((s) => `'${s}'`).join(", ");

/** Each entry moves the schema from `version - 1` to `version`, carrying every
 *  existing row forward. */
const MIGRATIONS: ReadonlyArray<{ version: number; up: string }> = [
  {
    version: 1,
    up: `
      CREATE TABLE runner_sessions (
        id text PRIMARY KEY,
        owner_key text NOT NULL,
        owner_iss text,
        owner_sub text,
        owner_secret_hash text,
        workspace text NOT NULL,
        agent text,
        apps jsonb NOT NULL,
        config jsonb NOT NULL,
        status text NOT NULL CHECK (status IN (${STATUS_LIST})),
        created_at bigint NOT NULL,
        last_active_at bigint NOT NULL,
        suspended_at bigint,
        CONSTRAINT ${OWNER_WORKSPACE_CONSTRAINT} UNIQUE (owner_key, workspace),
        CHECK (
          (owner_secret_hash IS NOT NULL AND owner_iss IS NULL AND owner_sub IS NULL) OR
          (owner_secret_hash IS NULL AND owner_iss IS NOT NULL AND owner_sub IS NOT NULL)
        )
      );
      CREATE INDEX runner_sessions_suspended ON runner_sessions (status, suspended_at);
      CREATE TABLE runner_dpop_jtis (
        jti text PRIMARY KEY,
        expires_at bigint NOT NULL
      );
      CREATE INDEX runner_dpop_jtis_expiry ON runner_dpop_jtis (expires_at);
    `,
  },
  {
    version: 2,
    up: "ALTER TABLE runner_sessions ADD COLUMN container_engine jsonb;",
  },
];

const COLUMNS =
  "id, owner_iss, owner_sub, owner_secret_hash, workspace, agent, apps, config, status, " +
  "created_at, last_active_at, suspended_at, container_engine";

/** How often `create` retries when the record it collided with is deleted
 *  before its id could be read. */
const CREATE_ATTEMPTS = 3;

export interface PostgresSessionStoreOptions {
  /** Receives an error raised on an idle pooled connection (the server
   *  restarting, a dropped link); the pool replaces the connection. */
  onIdleClientError(err: Error): void;
}

/** The session store in a Postgres database, in tables prefixed `runner_`. */
export class PostgresSessionStore implements SessionStore {
  private constructor(private readonly pool: Pool) {}

  /** Connects to `url` and migrates the database to the current schema. */
  static async open(url: string, options: PostgresSessionStoreOptions): Promise<PostgresSessionStore> {
    const { default: pg } = await import("pg");
    const pool = new pg.Pool({ connectionString: url });
    pool.on("error", (err) => options.onIdleClientError(err));
    try {
      await migrate(pool);
    } catch (err) {
      await pool.end();
      throw err;
    }
    return new PostgresSessionStore(pool);
  }

  async create(record: SessionRecord): Promise<CreateSessionResult> {
    const owner = ownerColumns(record.owner);
    for (let attempt = 0; attempt < CREATE_ATTEMPTS; attempt++) {
      const inserted = await this.pool.query(
        `INSERT INTO runner_sessions (owner_key, ${COLUMNS})
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         ON CONFLICT (owner_key, workspace) DO NOTHING`,
        [
          owner.ownerKey,
          record.id,
          owner.ownerIss,
          owner.ownerSub,
          owner.ownerSecretHash,
          record.workspace,
          record.agent,
          JSON.stringify(record.apps),
          JSON.stringify(record.config),
          record.status,
          record.createdAt.getTime(),
          record.lastActiveAt.getTime(),
          record.suspendedAt?.getTime() ?? null,
          encodeContainerEngine(record.containerEngine),
        ],
      );
      if (inserted.rowCount === 1) return { kind: "created", record: structuredClone(record) };
      const existing = await this.pool.query(
        "SELECT id FROM runner_sessions WHERE owner_key = $1 AND workspace = $2",
        [owner.ownerKey, record.workspace],
      );
      if (existing.rowCount === 1) return { kind: "exists", id: existing.rows[0].id };
    }
    throw new Error(
      `session '${record.id}' collided with a session for workspace '${record.workspace}' ` +
        `${CREATE_ATTEMPTS} times, and that session was deleted each time before it could be read`,
    );
  }

  async get(id: string): Promise<SessionRecord | undefined> {
    const result = await this.pool.query(`SELECT ${COLUMNS} FROM runner_sessions WHERE id = $1`, [id]);
    return result.rows[0] ? decode(result.rows[0]) : undefined;
  }

  async listByOwner(owner: SessionOwner): Promise<SessionRecord[]> {
    const result = await this.pool.query(
      `SELECT ${COLUMNS} FROM runner_sessions WHERE owner_key = $1 ORDER BY created_at, id`,
      [ownerColumns(owner).ownerKey],
    );
    return result.rows.map(decode);
  }

  async listAll(): Promise<SessionRecord[]> {
    const result = await this.pool.query(`SELECT ${COLUMNS} FROM runner_sessions ORDER BY created_at, id`);
    return result.rows.map(decode);
  }

  async listSuspendedBefore(cutoff: Date): Promise<SessionRecord[]> {
    const result = await this.pool.query(
      `SELECT ${COLUMNS} FROM runner_sessions
       WHERE status = 'suspended' AND suspended_at < $1 ORDER BY suspended_at, id`,
      [cutoff.getTime()],
    );
    return result.rows.map(decode);
  }

  async update(id: string, changes: SessionRecordUpdate): Promise<SessionRecord | undefined> {
    const sets: string[] = [];
    const values: Array<string | number | null> = [];
    const set = (column: string, value: string | number | null) => {
      values.push(value);
      sets.push(`${column} = $${values.length}`);
    };
    if (changes.status !== undefined) set("status", changes.status);
    if (changes.lastActiveAt !== undefined) set("last_active_at", changes.lastActiveAt.getTime());
    if (changes.suspendedAt !== undefined) set("suspended_at", changes.suspendedAt?.getTime() ?? null);
    if (changes.apps !== undefined) set("apps", JSON.stringify(changes.apps));
    if (changes.agent !== undefined) set("agent", changes.agent);
    if (changes.containerEngine !== undefined) {
      set("container_engine", encodeContainerEngine(changes.containerEngine));
    }
    if (sets.length === 0) return this.get(id);
    values.push(id);
    const result = await this.pool.query(
      `UPDATE runner_sessions SET ${sets.join(", ")} WHERE id = $${values.length} RETURNING ${COLUMNS}`,
      values,
    );
    return result.rows[0] ? decode(result.rows[0]) : undefined;
  }

  async changeOwner(id: string, owner: SessionOwner): Promise<ChangeOwnerResult> {
    const columns = ownerColumns(owner);
    try {
      const result = await this.pool.query(
        `UPDATE runner_sessions SET owner_key = $1, owner_iss = $2, owner_sub = $3, owner_secret_hash = $4
         WHERE id = $5 RETURNING ${COLUMNS}`,
        [columns.ownerKey, columns.ownerIss, columns.ownerSub, columns.ownerSecretHash, id],
      );
      return result.rows[0] ? { kind: "changed", record: decode(result.rows[0]) } : { kind: "not_found" };
    } catch (err) {
      if (!isOwnerWorkspaceConflict(err)) throw err;
      const clash = await this.pool.query(
        `SELECT other.id FROM runner_sessions other JOIN runner_sessions self
           ON self.id = $2 AND other.workspace = self.workspace
         WHERE other.owner_key = $1 AND other.id <> $2`,
        [columns.ownerKey, id],
      );
      if (clash.rowCount !== 1) throw err;
      return { kind: "exists", id: clash.rows[0].id };
    }
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.pool.query("DELETE FROM runner_sessions WHERE id = $1", [id]);
    return result.rowCount === 1;
  }

  async recordJti(jti: string, expiresAt: Date, now: Date): Promise<boolean> {
    const result = await this.pool.query(
      `INSERT INTO runner_dpop_jtis (jti, expires_at) VALUES ($1, $2)
       ON CONFLICT (jti) DO UPDATE SET expires_at = EXCLUDED.expires_at
       WHERE runner_dpop_jtis.expires_at <= $3`,
      [jti, expiresAt.getTime(), now.getTime()],
    );
    return result.rowCount === 1;
  }

  async purgeExpiredJtis(now: Date): Promise<number> {
    const result = await this.pool.query("DELETE FROM runner_dpop_jtis WHERE expires_at <= $1", [
      now.getTime(),
    ]);
    return result.rowCount ?? 0;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

async function migrate(pool: Pool): Promise<void> {
  if (MIGRATIONS[MIGRATIONS.length - 1]!.version !== SESSION_STORE_SCHEMA_VERSION) {
    throw new Error("the Postgres session store's migrations do not reach the current schema version");
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    try {
      await client.query("SELECT pg_advisory_xact_lock($1)", [MIGRATION_LOCK]);
      await client.query("CREATE TABLE IF NOT EXISTS runner_schema_version (version integer NOT NULL)");
      const found = await schemaVersion(client);
      assertReadableVersion(found, WHERE);
      for (const migration of MIGRATIONS) {
        if (migration.version <= found) continue;
        await client.query(migration.up);
      }
      if (found === 0) {
        await client.query("INSERT INTO runner_schema_version (version) VALUES ($1)", [
          SESSION_STORE_SCHEMA_VERSION,
        ]);
      } else if (found < SESSION_STORE_SCHEMA_VERSION) {
        await client.query("UPDATE runner_schema_version SET version = $1", [SESSION_STORE_SCHEMA_VERSION]);
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    }
  } finally {
    client.release();
  }
}

async function schemaVersion(client: PoolClient): Promise<number> {
  const result = await client.query("SELECT version FROM runner_schema_version");
  if (result.rowCount === 0) return 0;
  if (result.rowCount !== 1) {
    throw new Error(`${WHERE} holds ${result.rowCount} schema version rows; it must hold one`);
  }
  return Number(result.rows[0].version);
}

function isOwnerWorkspaceConflict(err: unknown): boolean {
  const e = err as { code?: unknown; constraint?: unknown };
  return e.code === "23505" && e.constraint === OWNER_WORKSPACE_CONSTRAINT;
}

interface SessionRow {
  id: string;
  owner_iss: string | null;
  owner_sub: string | null;
  owner_secret_hash: string | null;
  workspace: string;
  agent: string | null;
  apps: SessionRecord["apps"];
  config: SessionRecord["config"];
  status: string;
  created_at: string;
  last_active_at: string;
  suspended_at: string | null;
  container_engine: SessionRecord["containerEngine"];
}

function decode(row: SessionRow): SessionRecord {
  return {
    id: row.id,
    owner: ownerFromColumns(row.owner_iss, row.owner_sub, row.owner_secret_hash),
    workspace: row.workspace,
    agent: row.agent,
    apps: row.apps,
    config: row.config,
    status: storedStatus(row.status),
    createdAt: new Date(Number(row.created_at)),
    lastActiveAt: new Date(Number(row.last_active_at)),
    suspendedAt: row.suspended_at === null ? null : new Date(Number(row.suspended_at)),
    containerEngine: row.container_engine,
  };
}

function encodeContainerEngine(engine: SessionRecord["containerEngine"]): string | null {
  return engine === null ? null : JSON.stringify(engine);
}
