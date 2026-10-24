import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import pg from "pg";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { PostgresSessionStore } from "./postgres-session-store.js";
import {
  SESSION_STORE_SCHEMA_VERSION,
  SessionStoreSchemaError,
  type SessionOwner,
  type SessionRecord,
  type SessionStore,
} from "./session-store.js";
import { nodeSqlite, SQLITE_SESSION_STORE_FILENAME, SqliteSessionStore } from "./sqlite-session-store.js";

/**
 * Postgres runs only when `RUNNER_SESSION_STORE_TEST_URL` names a THROWAWAY
 * database: every test drops the store's `runner_*` tables there.
 */
const POSTGRES_URL = process.env.RUNNER_SESSION_STORE_TEST_URL?.trim() || undefined;

interface Backend {
  open(): Promise<SessionStore>;
  reset(): Promise<void>;
  setSchemaVersion(version: number): Promise<void>;
  /** Put the store back at schema version 1, as the runner that wrote it left it. */
  restoreVersion1(): Promise<void>;
  dispose(): Promise<void>;
}

function sqliteBackend(): Backend {
  let dir: string | undefined;
  return {
    open: () => SqliteSessionStore.open(dir!),
    async reset() {
      if (dir) await rm(dir, { recursive: true, force: true });
      dir = await mkdtemp(path.join(tmpdir(), "runner-session-store-"));
    },
    async setSchemaVersion(version) {
      const db = new (nodeSqlite().DatabaseSync)(path.join(dir!, SQLITE_SESSION_STORE_FILENAME));
      db.exec(`PRAGMA user_version = ${version}`);
      db.close();
    },
    async restoreVersion1() {
      const db = new (nodeSqlite().DatabaseSync)(path.join(dir!, SQLITE_SESSION_STORE_FILENAME));
      db.exec("ALTER TABLE runner_sessions DROP COLUMN container_engine; PRAGMA user_version = 1");
      db.close();
    },
    async dispose() {
      if (dir) await rm(dir, { recursive: true, force: true });
    },
  };
}

function postgresBackend(url: string): Backend {
  const admin = new pg.Pool({ connectionString: url });
  return {
    open: () =>
      PostgresSessionStore.open(url, {
        onIdleClientError: (err) => {
          throw err;
        },
      }),
    async reset() {
      await admin.query("DROP TABLE IF EXISTS runner_sessions, runner_dpop_jtis, runner_schema_version");
    },
    async setSchemaVersion(version) {
      await admin.query("UPDATE runner_schema_version SET version = $1", [version]);
    },
    async restoreVersion1() {
      await admin.query("ALTER TABLE runner_sessions DROP COLUMN container_engine");
      await admin.query("UPDATE runner_schema_version SET version = 1");
    },
    dispose: () => admin.end(),
  };
}

const ALICE: SessionOwner = { kind: "identity", iss: "https://id.example", sub: "alice" };
const BOB: SessionOwner = { kind: "identity", iss: "https://id.example", sub: "bob" };
const SECRET: SessionOwner = { kind: "secret", secretHash: "a".repeat(64) };

function record(id: string, owner: SessionOwner, workspace: string, at = 1_000): SessionRecord {
  return {
    id,
    owner,
    workspace,
    agent: "assistant",
    apps: [
      { name: "api", entryRelativePath: "api/telo.yaml", ports: [{ port: 8080, protocol: "tcp" }], telo: "0.121.0" },
      { name: "worker", entryRelativePath: "worker/telo.yaml", ports: [] },
    ],
    config: { image: "telorun/node:0.121.0-slim", nested: { flag: true } },
    status: "running",
    createdAt: new Date(at),
    lastActiveAt: new Date(at + 1),
    suspendedAt: null,
    containerEngine: null,
  };
}

const backends: Array<[string, () => Backend]> = [["sqlite", sqliteBackend]];
if (POSTGRES_URL) backends.push(["postgres", () => postgresBackend(POSTGRES_URL)]);

describe.each(backends)("%s session store", (_name, makeBackend) => {
  const backend = makeBackend();
  let store: SessionStore;

  beforeEach(async () => {
    await backend.reset();
    store = await backend.open();
  });
  afterEach(async () => {
    await store.close();
  });
  afterAll(async () => {
    await backend.dispose();
  });

  it("gives back a created record field for field, for both owner shapes", async () => {
    const byIdentity = record("s1", ALICE, "project-1");
    const bySecret = { ...record("s2", SECRET, "device-7"), agent: null, suspendedAt: new Date(5_000), status: "suspended" as const };
    expect(await store.create(byIdentity)).toEqual({ kind: "created", record: byIdentity });
    expect(await store.create(bySecret)).toEqual({ kind: "created", record: bySecret });
    expect(await store.get("s1")).toEqual(byIdentity);
    expect(await store.get("s2")).toEqual(bySecret);
    expect(await store.get("missing")).toBeUndefined();
  });

  it("holds one session per owner and workspace, reporting the existing id", async () => {
    await store.create(record("s1", ALICE, "project-1"));
    expect(await store.create(record("s2", ALICE, "project-1"))).toEqual({ kind: "exists", id: "s1" });
    expect((await store.create(record("s3", BOB, "project-1"))).kind).toBe("created");
    expect((await store.create(record("s4", ALICE, "project-2"))).kind).toBe("created");
    expect(await store.get("s2")).toBeUndefined();
  });

  it("lists by owner, and every record", async () => {
    await store.create(record("s1", ALICE, "project-1", 1_000));
    await store.create(record("s2", BOB, "project-1", 2_000));
    await store.create(record("s3", ALICE, "project-2", 3_000));
    expect((await store.listByOwner(ALICE)).map((r) => r.id)).toEqual(["s1", "s3"]);
    expect((await store.listByOwner(SECRET))).toEqual([]);
    expect((await store.listAll()).map((r) => r.id)).toEqual(["s1", "s2", "s3"]);
  });

  it("updates status, timestamps, app set, agent and container engine, leaving the rest", async () => {
    const original = record("s1", ALICE, "project-1");
    await store.create(original);
    const apps = [{ name: "web", entryRelativePath: "telo.yaml", ports: [{ port: 3000, protocol: "tcp" as const }] }];
    const containerEngine = {
      tokenHashes: ["b".repeat(64)],
      containers: [{ id: "c1", image: "postgres:16", labels: { "run.telo.session": "s1" }, ports: [5432], bound: [5432] }],
    };
    const updated = await store.update("s1", {
      status: "suspended",
      suspendedAt: new Date(9_000),
      lastActiveAt: new Date(8_000),
      apps,
      agent: null,
      containerEngine,
    });
    const expected = { ...original, status: "suspended", suspendedAt: new Date(9_000), lastActiveAt: new Date(8_000), apps, agent: null, containerEngine };
    expect(updated).toEqual(expected);
    expect(await store.get("s1")).toEqual(expected);
    expect(await store.update("s1", { suspendedAt: null, status: "running" })).toEqual({ ...expected, suspendedAt: null, status: "running" });
    expect(await store.update("missing", { status: "failed" })).toBeUndefined();
  });

  it("changes the owner unless the new owner already has the workspace", async () => {
    await store.create(record("s1", SECRET, "project-1"));
    await store.create(record("s2", ALICE, "project-2"));
    await store.create(record("s3", SECRET, "project-2"));

    expect(await store.changeOwner("s1", ALICE)).toEqual({ kind: "changed", record: { ...record("s1", ALICE, "project-1") } });
    expect((await store.listByOwner(SECRET)).map((r) => r.id)).toEqual(["s3"]);
    expect(await store.changeOwner("s3", ALICE)).toEqual({ kind: "exists", id: "s2" });
    expect((await store.get("s3"))?.owner).toEqual(SECRET);
    expect(await store.changeOwner("missing", ALICE)).toEqual({ kind: "not_found" });
  });

  it("deletes a record", async () => {
    await store.create(record("s1", ALICE, "project-1"));
    expect(await store.delete("s1")).toBe(true);
    expect(await store.delete("s1")).toBe(false);
    expect(await store.get("s1")).toBeUndefined();
    expect((await store.create(record("s2", ALICE, "project-1"))).kind).toBe("created");
  });

  it("lists suspended records older than a cutoff", async () => {
    await store.create({ ...record("old", ALICE, "w1"), status: "suspended", suspendedAt: new Date(1_000) });
    await store.create({ ...record("recent", ALICE, "w2"), status: "suspended", suspendedAt: new Date(5_000) });
    await store.create(record("running", ALICE, "w3"));
    expect((await store.listSuspendedBefore(new Date(3_000))).map((r) => r.id)).toEqual(["old"]);
  });

  it("refuses a jti seen within its window, and accepts it again once expired", async () => {
    expect(await store.recordJti("j1", new Date(2_000), new Date(1_000))).toBe(true);
    expect(await store.recordJti("j1", new Date(2_500), new Date(1_500))).toBe(false);
    expect(await store.recordJti("j1", new Date(4_000), new Date(3_000))).toBe(true);
    expect(await store.recordJti("j2", new Date(2_000), new Date(1_000))).toBe(true);
    expect(await store.purgeExpiredJtis(new Date(3_000))).toBe(1);
    expect(await store.recordJti("j2", new Date(5_000), new Date(3_000))).toBe(true);
    expect(await store.recordJti("j1", new Date(5_000), new Date(3_500))).toBe(false);
  });

  it("keeps every row across a reopen at the same schema version", async () => {
    const kept = record("s1", ALICE, "project-1");
    await store.create(kept);
    await store.recordJti("j1", new Date(9_000), new Date(1_000));
    await store.close();
    store = await backend.open();
    expect(await store.listAll()).toEqual([kept]);
    expect(await store.recordJti("j1", new Date(9_000), new Date(2_000))).toBe(false);
  });

  it("refuses a store a newer runner build migrated", async () => {
    await store.close();
    await backend.setSchemaVersion(SESSION_STORE_SCHEMA_VERSION + 1);
    await expect(backend.open()).rejects.toThrow(SessionStoreSchemaError);
    await backend.setSchemaVersion(SESSION_STORE_SCHEMA_VERSION);
    store = await backend.open();
  });

  it("carries every version 1 row forward with no container engine", async () => {
    const kept = record("s1", ALICE, "project-1");
    await store.create(kept);
    await store.close();
    await backend.restoreVersion1();
    store = await backend.open();
    expect(await store.listAll()).toEqual([kept]);
  });
});
