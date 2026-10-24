import { mkdir } from "node:fs/promises";
import * as path from "node:path";
import type { DatabaseSync, SQLOutputValue } from "node:sqlite";

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

/** The database file inside the runner's state directory. */
export const SQLITE_SESSION_STORE_FILENAME = "sessions.sqlite";

const STATUS_LIST = STORED_SESSION_STATUSES.map((s) => `'${s}'`).join(", ");

/** Each entry moves the schema from `version - 1` to `version`, carrying every
 *  existing row forward. */
const MIGRATIONS: ReadonlyArray<{ version: number; up: string }> = [
  {
    version: 1,
    up: `
      CREATE TABLE runner_sessions (
        id TEXT PRIMARY KEY,
        owner_key TEXT NOT NULL,
        owner_iss TEXT,
        owner_sub TEXT,
        owner_secret_hash TEXT,
        workspace TEXT NOT NULL,
        agent TEXT,
        apps TEXT NOT NULL,
        config TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN (${STATUS_LIST})),
        created_at INTEGER NOT NULL,
        last_active_at INTEGER NOT NULL,
        suspended_at INTEGER,
        UNIQUE (owner_key, workspace),
        CHECK (
          (owner_secret_hash IS NOT NULL AND owner_iss IS NULL AND owner_sub IS NULL) OR
          (owner_secret_hash IS NULL AND owner_iss IS NOT NULL AND owner_sub IS NOT NULL)
        )
      );
      CREATE INDEX runner_sessions_suspended ON runner_sessions (status, suspended_at);
      CREATE TABLE runner_dpop_jtis (
        jti TEXT PRIMARY KEY,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX runner_dpop_jtis_expiry ON runner_dpop_jtis (expires_at);
    `,
  },
  {
    version: 2,
    up: "ALTER TABLE runner_sessions ADD COLUMN container_engine TEXT;",
  },
];

const COLUMNS =
  "id, owner_iss, owner_sub, owner_secret_hash, workspace, agent, apps, config, status, " +
  "created_at, last_active_at, suspended_at, container_engine";

/** The session store on Node's built-in SQLite, in one file under the runner's
 *  state directory. */
export class SqliteSessionStore implements SessionStore {
  private constructor(private readonly db: DatabaseSync) {}

  /** Opens (creating when absent) the store in `directory` and migrates it to
   *  the current schema. */
  static async open(directory: string): Promise<SqliteSessionStore> {
    await mkdir(directory, { recursive: true });
    const file = path.join(directory, SQLITE_SESSION_STORE_FILENAME);
    const db = new (nodeSqlite().DatabaseSync)(file);
    try {
      db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
      migrate(db, file);
    } catch (err) {
      db.close();
      throw err;
    }
    return new SqliteSessionStore(db);
  }

  async create(record: SessionRecord): Promise<CreateSessionResult> {
    const owner = ownerColumns(record.owner);
    return this.transaction(() => {
      const inserted = this.db
        .prepare(
          `INSERT INTO runner_sessions (owner_key, ${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (owner_key, workspace) DO NOTHING`,
        )
        .run(
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
        );
      if (Number(inserted.changes) === 1) return { kind: "created", record: structuredClone(record) };
      return { kind: "exists", id: this.idFor(owner.ownerKey, record.workspace) };
    });
  }

  async get(id: string): Promise<SessionRecord | undefined> {
    const row = this.db.prepare(`SELECT ${COLUMNS} FROM runner_sessions WHERE id = ?`).get(id);
    return row ? decode(row) : undefined;
  }

  async listByOwner(owner: SessionOwner): Promise<SessionRecord[]> {
    return this.db
      .prepare(`SELECT ${COLUMNS} FROM runner_sessions WHERE owner_key = ? ORDER BY created_at, id`)
      .all(ownerColumns(owner).ownerKey)
      .map(decode);
  }

  async listAll(): Promise<SessionRecord[]> {
    return this.db
      .prepare(`SELECT ${COLUMNS} FROM runner_sessions ORDER BY created_at, id`)
      .all()
      .map(decode);
  }

  async listSuspendedBefore(cutoff: Date): Promise<SessionRecord[]> {
    return this.db
      .prepare(
        `SELECT ${COLUMNS} FROM runner_sessions
         WHERE status = 'suspended' AND suspended_at < ? ORDER BY suspended_at, id`,
      )
      .all(cutoff.getTime())
      .map(decode);
  }

  async update(id: string, changes: SessionRecordUpdate): Promise<SessionRecord | undefined> {
    const sets: string[] = [];
    const values: Array<string | number | null> = [];
    if (changes.status !== undefined) {
      sets.push("status = ?");
      values.push(changes.status);
    }
    if (changes.lastActiveAt !== undefined) {
      sets.push("last_active_at = ?");
      values.push(changes.lastActiveAt.getTime());
    }
    if (changes.suspendedAt !== undefined) {
      sets.push("suspended_at = ?");
      values.push(changes.suspendedAt?.getTime() ?? null);
    }
    if (changes.apps !== undefined) {
      sets.push("apps = ?");
      values.push(JSON.stringify(changes.apps));
    }
    if (changes.agent !== undefined) {
      sets.push("agent = ?");
      values.push(changes.agent);
    }
    if (changes.containerEngine !== undefined) {
      sets.push("container_engine = ?");
      values.push(encodeContainerEngine(changes.containerEngine));
    }
    return this.transaction(() => {
      if (sets.length > 0) {
        this.db.prepare(`UPDATE runner_sessions SET ${sets.join(", ")} WHERE id = ?`).run(...values, id);
      }
      const row = this.db.prepare(`SELECT ${COLUMNS} FROM runner_sessions WHERE id = ?`).get(id);
      return row ? decode(row) : undefined;
    });
  }

  async changeOwner(id: string, owner: SessionOwner): Promise<ChangeOwnerResult> {
    const columns = ownerColumns(owner);
    return this.transaction(() => {
      const current = this.db.prepare("SELECT workspace FROM runner_sessions WHERE id = ?").get(id);
      if (!current) return { kind: "not_found" };
      const workspace = current.workspace as string;
      const clash = this.db
        .prepare("SELECT id FROM runner_sessions WHERE owner_key = ? AND workspace = ? AND id <> ?")
        .get(columns.ownerKey, workspace, id);
      if (clash) return { kind: "exists", id: clash.id as string };
      this.db
        .prepare(
          `UPDATE runner_sessions SET owner_key = ?, owner_iss = ?, owner_sub = ?, owner_secret_hash = ?
           WHERE id = ?`,
        )
        .run(columns.ownerKey, columns.ownerIss, columns.ownerSub, columns.ownerSecretHash, id);
      const row = this.db.prepare(`SELECT ${COLUMNS} FROM runner_sessions WHERE id = ?`).get(id);
      return { kind: "changed", record: decode(row!) };
    });
  }

  async delete(id: string): Promise<boolean> {
    return Number(this.db.prepare("DELETE FROM runner_sessions WHERE id = ?").run(id).changes) === 1;
  }

  async recordJti(jti: string, expiresAt: Date, now: Date): Promise<boolean> {
    const result = this.db
      .prepare(
        `INSERT INTO runner_dpop_jtis (jti, expires_at) VALUES (?, ?)
         ON CONFLICT (jti) DO UPDATE SET expires_at = excluded.expires_at
         WHERE runner_dpop_jtis.expires_at <= ?`,
      )
      .run(jti, expiresAt.getTime(), now.getTime());
    return Number(result.changes) === 1;
  }

  async purgeExpiredJtis(now: Date): Promise<number> {
    return Number(
      this.db.prepare("DELETE FROM runner_dpop_jtis WHERE expires_at <= ?").run(now.getTime()).changes,
    );
  }

  async close(): Promise<void> {
    this.db.close();
  }

  private idFor(ownerKey: string, workspace: string): string {
    const row = this.db
      .prepare("SELECT id FROM runner_sessions WHERE owner_key = ? AND workspace = ?")
      .get(ownerKey, workspace);
    if (!row) throw new Error(`no session conflicts on owner and workspace '${workspace}'`);
    return row.id as string;
  }

  private transaction<T>(body: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = body();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }
}

/** Read through `process.getBuiltinModule`, which no bundler or test transform
 *  rewrites: an `import` of `node:sqlite` is resolved as a package `sqlite`. */
export function nodeSqlite(): typeof import("node:sqlite") {
  const sqlite = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite") | undefined;
  if (!sqlite) {
    throw new Error(
      `the SQLite session store needs Node's built-in node:sqlite, which Node ${process.version} lacks — run the runner on Node 24 or newer`,
    );
  }
  return sqlite;
}

function migrate(db: DatabaseSync, file: string): void {
  if (MIGRATIONS[MIGRATIONS.length - 1]!.version !== SESSION_STORE_SCHEMA_VERSION) {
    throw new Error("the SQLite session store's migrations do not reach the current schema version");
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    const found = Number(db.prepare("PRAGMA user_version").get()!.user_version);
    assertReadableVersion(found, file);
    for (const migration of MIGRATIONS) {
      if (migration.version <= found) continue;
      db.exec(migration.up);
      db.exec(`PRAGMA user_version = ${migration.version}`);
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

function decode(row: Record<string, SQLOutputValue>): SessionRecord {
  return {
    id: row.id as string,
    owner: ownerFromColumns(
      row.owner_iss as string | null,
      row.owner_sub as string | null,
      row.owner_secret_hash as string | null,
    ),
    workspace: row.workspace as string,
    agent: row.agent as string | null,
    apps: JSON.parse(row.apps as string),
    config: JSON.parse(row.config as string),
    status: storedStatus(row.status as string),
    createdAt: new Date(Number(row.created_at)),
    lastActiveAt: new Date(Number(row.last_active_at)),
    suspendedAt: row.suspended_at === null ? null : new Date(Number(row.suspended_at)),
    containerEngine: row.container_engine === null ? null : JSON.parse(row.container_engine as string),
  };
}

function encodeContainerEngine(engine: SessionRecord["containerEngine"]): string | null {
  return engine === null ? null : JSON.stringify(engine);
}
