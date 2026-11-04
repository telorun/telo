import { describe, expect, it } from "vitest";
import { store } from "../src/sql-conversation-store.js";
import { context, sqliteConnection } from "./sqlite-connection.js";

async function started(connection: unknown, createTables = true) {
  const instance = await store.create(
    { metadata: { name: "store" }, connection, createTables } as never,
    context,
  );
  await instance.init();
  return instance;
}

const versionOf = (db: ReturnType<typeof sqliteConnection>["db"]) =>
  (db.prepare("SELECT version FROM ai_conversation_schema WHERE id = 1").all()[0] as { version: number }).version;

describe("AiConversationSql.Store schema version", () => {
  it("records version 3 on a fresh database", async () => {
    const { connection, db } = sqliteConnection();
    await started(connection);
    expect(versionOf(db)).toBe(3);
  });

  it("upgrades version 2 in place, adding the attachments table and keeping the conversations", async () => {
    const { connection, db } = sqliteConnection();
    const first = await started(connection);
    await first.create({ id: "cnv_kept" });
    db.exec("DROP TABLE ai_conversation_attachments");
    db.exec("UPDATE ai_conversation_schema SET version = 2 WHERE id = 1");
    const instance = await started(connection);
    expect(versionOf(db)).toBe(3);
    expect((await instance.read("cnv_kept")).id).toBe("cnv_kept");
    expect((await instance.registerAttachment({ id: "att_new" })).conversation).toBeNull();
  });

  it("upgrades version 1 in place, adding the index the unfiltered listing orders by", async () => {
    const { connection, db } = sqliteConnection();
    await started(connection);
    db.exec("DROP INDEX ai_conversation_conversations_updated");
    db.exec("UPDATE ai_conversation_schema SET version = 1 WHERE id = 1");
    const instance = await started(connection);
    expect(versionOf(db)).toBe(3);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'ai_conversation_conversations_updated'").all()).toHaveLength(1);
    expect(await instance.read("cnv_none").catch((error) => error.code)).toBe("ERR_CONVERSATION_NOT_FOUND");
  });

  it("upgrades tables with no recorded version in place, keeping their rows", async () => {
    const { connection, db } = sqliteConnection();
    // Version 0: the tables exist, the schema table holds no version.
    db.exec("CREATE TABLE ai_conversation_schema (id INTEGER PRIMARY KEY, version INTEGER NOT NULL)");
    db.exec(
      `CREATE TABLE ai_conversation_conversations (id TEXT PRIMARY KEY, title TEXT, archived INTEGER NOT NULL DEFAULT 0,
       turn TEXT, version BIGINT NOT NULL, next_sequence BIGINT NOT NULL, created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL)`,
    );
    db.exec("INSERT INTO ai_conversation_conversations VALUES ('cnv_old', 'kept', 0, NULL, 3, 0, 1, 2)");
    const instance = await started(connection);
    expect(versionOf(db)).toBe(3);
    const header = await instance.read("cnv_old");
    expect(header).toMatchObject({ id: "cnv_old", title: "kept", version: 3 });
    // The tables the old layout lacked now exist and work.
    const created = await instance.create({ id: "cnv_new" });
    expect(created.version).toBe(1);
  });

  it("refuses a newer recorded version and leaves the tables untouched", async () => {
    const { connection, db } = sqliteConnection();
    db.exec("CREATE TABLE ai_conversation_schema (id INTEGER PRIMARY KEY, version INTEGER NOT NULL)");
    db.exec("INSERT INTO ai_conversation_schema VALUES (1, 99)");
    await expect(started(connection)).rejects.toMatchObject({ code: "ERR_CONVERSATION_SCHEMA_NEWER" });
    expect(versionOf(db)).toBe(99);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'ai_conversation_entries'").all()).toEqual([]);
  });

  it("refuses a newer version even when it does not own the tables", async () => {
    const { connection, db } = sqliteConnection();
    db.exec("CREATE TABLE ai_conversation_schema (id INTEGER PRIMARY KEY, version INTEGER NOT NULL)");
    db.exec("INSERT INTO ai_conversation_schema VALUES (1, 4)");
    await expect(started(connection, false)).rejects.toMatchObject({ code: "ERR_CONVERSATION_SCHEMA_NEWER" });
  });

  it("does not upgrade tables it does not own", async () => {
    const { connection, db } = sqliteConnection();
    db.exec("CREATE TABLE ai_conversation_schema (id INTEGER PRIMARY KEY, version INTEGER NOT NULL)");
    await expect(started(connection, false)).rejects.toMatchObject({ code: "ERR_CONVERSATION_SCHEMA_OUTDATED" });
  });
});

describe("AiConversationSql.Store schema setup under a concurrent start", () => {
  it("runs the pass again when another instance's DDL collided with it, and reports a second failure", async () => {
    const { connection } = sqliteConnection();
    const collision = Object.assign(new Error('duplicate key value violates unique constraint "pg_type_typname_nsp_index"'), {
      code: "23505",
    });
    let failures = 1;
    const colliding = {
      ...(connection as object),
      runInTransaction: async (body: (bind: (entry: unknown) => void) => Promise<unknown>) => {
        if (failures-- > 0) throw collision;
        return (connection as any).runInTransaction(body);
      },
    };
    await expect(started(colliding)).resolves.toBeDefined();
    failures = 2;
    await expect(started(colliding)).rejects.toBe(collision);
  });
});
