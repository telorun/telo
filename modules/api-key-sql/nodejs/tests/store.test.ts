import { celDurationFromNanos, type ResourceContext } from "@telorun/sdk";
import { quoteAnsiIdentifier, SqlFragments, type SqlConnection } from "@telorun/sql";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { claimStoreName } from "../src/store-name-claims.js";
import { SqlApiKeyStore } from "../src/store.js";
import { COLUMN_NAMES } from "../src/store-table.js";

const seconds = (n: number) => celDurationFromNanos(BigInt(n) * 1_000_000_000n);

const VISIBLE = '("ends_at" IS NULL OR "ends_at" >= NOW-RETENTION)';

const row = {
  key_id: "0192a000-0000-7000-8000-000000000001",
  digest: "d".repeat(43),
  owner_type: "user",
  owner_id: "alice",
  scopes: '["read"]',
  label: null,
  created_at: "2026-11-06T10:00:00.000Z",
  expires_at: null,
  revoked_at: null,
  revoked_by: null,
  last_used_at: null,
  rotated_from: null,
};

function build(answers: (statement: string) => Array<Record<string, unknown>>) {
  const statements: string[] = [];
  const connection = {
    dialect: { quoteIdentifier: quoteAnsiIdentifier },
    runInTransaction: async (body: (bind: (entry: unknown) => void) => Promise<unknown>) => body(() => {}),
    executeTemplate: async (fragments: string[]) => {
      const statement = fragments.join("?");
      statements.push(statement);
      return { rows: answers(statement) };
    },
    toRowCount: (result: { rows: unknown[] }) => result.rows.length,
  } as unknown as SqlConnection;
  const schema = {
    qualifiedTableName: () => '"api_keys"',
    currentInstant: () => "NOW",
    currentInstantPlus: (duration: { seconds: bigint }) =>
      new SqlFragments().text(duration.seconds === -3600n ? "NOW-RETENTION" : `NOW+(${duration.seconds})`),
    instantParameter: () => new SqlFragments().text("INSTANT"),
    skipLockedClause: () => "SKIP LOCKED",
  };
  const effects: Array<() => unknown> = [];
  const ctx = {
    self: { ref: { kind: "Test.Store" } },
    log: { warn: () => {} },
    effect: (_reason: string, body: () => Promise<{ inverse: () => unknown }>) => ({
      perform: async () => effects.push((await body()).inverse),
    }),
  } as unknown as ResourceContext;
  const table = {
    declaration: { name: "api_keys", columns: [], internalColumns: [...COLUMN_NAMES] },
  };
  const store = new SqlApiKeyStore(
    'Test.Store "main"',
    ctx,
    connection,
    schema as never,
    table as never,
    "main",
    seconds(3600),
    { prefix: "tk", scopes: ["read"], maxLifetimeMs: null },
  );
  return { store, statements, effects, table };
}

describe("SqlApiKeyStore", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("issues no statement until it is called, and a lookup is one read with no delete", async () => {
    const { store, statements } = build(() => [row]);
    expect(statements).toEqual([]);
    await store.lookup(row.key_id);
    expect(statements).toHaveLength(1);
    expect(statements[0]).toMatch(/^SELECT /);
  });

  it("judges retention in every statement it issues", async () => {
    const { store, statements } = build((statement) => (statement.startsWith("SELECT") || statement.includes("RETURNING") ? [row] : []));
    await store.lookup(row.key_id);
    await store.touch(row.key_id, seconds(60));
    await store.list({ owner: { type: "user", id: "alice" }, limit: 10 });
    await store.revoke(row.key_id, { by: null });
    await store.rotate({
      id: row.key_id,
      successor: { id: "0192a000-0000-7000-8000-000000000002", digest: "e".repeat(43), expiresAt: null },
      overlap: seconds(0),
    });
    const judged = statements.filter((statement) => !statement.startsWith("INSERT"));
    expect(judged.length).toBeGreaterThanOrEqual(5);
    for (const statement of judged) expect(statement).toContain(VISIBLE);
  });

  it("records a use with one conditional write and reads again only when nothing was written", async () => {
    const answers: Array<Array<Record<string, unknown>>> = [[{ key_id: row.key_id }], [], [row]];
    const { store, statements } = build(() => answers.shift() ?? []);
    expect(await store.touch(row.key_id, seconds(60))).toEqual({ outcome: "touched" });
    expect(statements).toHaveLength(1);
    expect(statements[0]).toMatch(/^UPDATE .*"last_used_at" IS NULL OR "last_used_at" <= NOW\+\(-60\)\) RETURNING/);

    expect(await store.touch(row.key_id, seconds(60))).toEqual({ outcome: "fresh" });
    expect(statements).toHaveLength(3);
  });

  it("claims its first call's sweep once, which reads only this store's ended range", async () => {
    const { store, statements, effects } = build(() => []);
    await store.lookup(row.key_id);
    await store.lookup(row.key_id);
    expect(effects).toHaveLength(1);
    statements.length = 0;

    await vi.advanceTimersByTimeAsync(60_000);
    const sweep = statements.find((statement) => statement.startsWith("DELETE"));
    expect(sweep).toBeDefined();
    const where = sweep!.slice(sweep!.indexOf("WHERE"));
    const columns = COLUMN_NAMES.filter((name) => where.includes(`"${name}"`));
    expect(columns.sort()).toEqual(["ends_at", "key_id", "store_name"]);
    expect(sweep).toContain('"ends_at" < NOW-RETENTION ORDER BY "ends_at" LIMIT ?');
    expect(sweep).toContain("SKIP LOCKED");
  });

  it("stops its sweep at teardown", async () => {
    const { store, statements, effects } = build(() => []);
    await store.lookup(row.key_id);
    await effects[0]!();
    statements.length = 0;
    await vi.advanceTimersByTimeAsync(180_000);
    expect(statements).toEqual([]);
  });

  it("refuses a cursor that is no key id before any statement", async () => {
    const { store, statements } = build(() => []);
    const answer = await store.list({ owner: { type: "user", id: "alice" }, limit: 5, after: "nope" });
    expect(answer).toEqual({ outcome: "cursorInvalid" });
    expect(statements).toEqual([]);
  });

  it("answers next only when another key exists beyond the page", async () => {
    const second = { ...row, key_id: "0192a000-0000-7000-8000-000000000002" };
    const { store } = build(() => [row, second]);
    const page = await store.list({ owner: { type: "user", id: "alice" }, limit: 1 });
    expect(page).toMatchObject({ outcome: "page", next: row.key_id });
    const last = build(() => [row]);
    const whole = await last.store.list({ owner: { type: "user", id: "alice" }, limit: 1 });
    expect(whole).not.toHaveProperty("next");
  });
});

describe("store name claims", () => {
  it("refuses a second owner of one name in one table and frees it on release", () => {
    const table = {};
    const release = claimStoreName(table, "api_keys", "main", {}, "first");
    expect(() => claimStoreName(table, "api_keys", "main", {}, "second")).toThrow(/ERR_API_KEY_STORE_NAME_DUPLICATE|already claims/);
    release();
    expect(() => claimStoreName(table, "api_keys", "main", {}, "second")).not.toThrow();
    expect(() => claimStoreName({}, "other", "main", {}, "elsewhere")).not.toThrow();
  });
});
