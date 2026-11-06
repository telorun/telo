import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { celTimestampFromMillis, type CelTimestamp } from "@telorun/sdk";
import { afterEach, describe, expect, it } from "vitest";
import { store } from "../src/sql-conversation-store.js";
import { context, sharedSqliteConnections, sqliteConnection } from "./sqlite-connection.js";

type Store = Awaited<ReturnType<typeof store.create>>;

async function started(connection: unknown): Promise<Store> {
  const instance = await store.create({ metadata: { name: "store" }, connection } as never, context);
  await instance.init();
  return instance;
}

const at = (millis: number) => celTimestampFromMillis(millis) as CelTimestamp;
const longAgo = at(0);
const codeOf = (promise: Promise<unknown>) => promise.then(() => "bound", (err) => err.code as string);

/** A conversation with an admitted turn, at version 2. */
async function conversation(s: Store, id: string) {
  await s.create({ id });
  return s.admit({ conversation: id, version: 1, turn: `trn_${id}`, attachments: [], expiredBefore: longAgo });
}

const dirs: string[] = [];
const handles: Array<{ close(): void }> = [];
afterEach(() => {
  for (const handle of handles.splice(0)) handle.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Two stores over one database file, each on its own connection. */
async function twoStores(): Promise<[Store, Store]> {
  const dir = mkdtempSync(join(tmpdir(), "ai-conversation-sql-"));
  dirs.push(dir);
  const [a, b] = sharedSqliteConnections(join(dir, "store.sqlite"), 2);
  handles.push(a, b);
  const first = await started(a);
  return [first, await started(b)];
}

describe("AiConversationSql.Store attachments", () => {
  it("binds a pending file to exactly one of two admissions racing for it", async () => {
    const [a, b] = await twoStores();
    await conversation(a, "cnv_a");
    await conversation(a, "cnv_b");
    const file = await a.registerAttachment({ id: "att_race", name: "dot.png" });
    const outcomes = await Promise.all([
      codeOf(a.admit({ conversation: "cnv_a", version: 2, turn: "trn_a2", attachments: [file.id], expiredBefore: longAgo })),
      codeOf(b.admit({ conversation: "cnv_b", version: 2, turn: "trn_b2", attachments: [file.id], expiredBefore: longAgo })),
    ]);
    expect([...outcomes].sort()).toEqual(["ERR_CONVERSATION_ATTACHMENT_NOT_FOUND", "bound"]);
    const [winner, loser] = outcomes[0] === "bound" ? ["cnv_a", "cnv_b"] : ["cnv_b", "cnv_a"];
    expect((await a.readAttachment(file.id)).conversation).toBe(winner);
    // The refused admission changed nothing: its header keeps its turn and version.
    expect(await a.read(loser)).toMatchObject({ version: 2, turn: `trn_${loser}` });
  });

  it("either binds or releases a file an expiry pass races an admission over, never both", async () => {
    // Each order of reaching the write lock, the admission first and the pass first.
    for (const passFirst of [false, true]) {
      const [a, b] = await twoStores();
      await conversation(a, "cnv_a");
      const file = await a.registerAttachment({ id: "att_1" });
      const admit = () =>
        codeOf(a.admit({ conversation: "cnv_a", version: 2, turn: "trn_a2", attachments: [file.id], expiredBefore: longAgo }));
      const expire = () => b.expireAttachments({ expiredBefore: at(Date.now() + 60_000), limit: 10 });
      const [admitted, expired] = passFirst
        ? await Promise.all([expire(), admit()]).then(([e, a]) => [a, e] as const)
        : await Promise.all([admit(), expire()]);
      expect(admitted).toBe(passFirst ? "ERR_CONVERSATION_ATTACHMENT_NOT_FOUND" : "bound");
      if (admitted === "bound") {
        expect(expired.ids).toEqual([]);
        expect((await a.readAttachment(file.id)).conversation).toBe("cnv_a");
      } else {
        expect(admitted).toBe("ERR_CONVERSATION_ATTACHMENT_NOT_FOUND");
        expect(expired.ids).toEqual([file.id]);
      }
    }
  });

  it("leaves the files pending when an admission loses its version", async () => {
    const { connection } = sqliteConnection();
    const s = await started(connection);
    await conversation(s, "cnv_a");
    const file = await s.registerAttachment({ id: "att_2" });
    await expect(
      s.admit({ conversation: "cnv_a", version: 1, turn: "trn_late", attachments: [file.id], expiredBefore: longAgo }),
    ).rejects.toMatchObject({ code: "ERR_CONVERSATION_CONFLICT" });
    expect(await s.readAttachment(file.id)).toMatchObject({ conversation: null, boundAt: null });
  });

  it("refuses an expired pending file before any pass runs, and allows one bound to the same conversation", async () => {
    const { connection } = sqliteConnection();
    const s = await started(connection);
    await conversation(s, "cnv_a");
    const file = await s.registerAttachment({ id: "att_3" });
    const future = at(Date.now() + 60_000);
    await expect(
      s.admit({ conversation: "cnv_a", version: 2, turn: "trn_2", attachments: [file.id], expiredBefore: future }),
    ).rejects.toMatchObject({ code: "ERR_CONVERSATION_ATTACHMENT_NOT_FOUND", data: { attachment: file.id } });
    const bound = await s.admit({ conversation: "cnv_a", version: 2, turn: "trn_2", attachments: [file.id], expiredBefore: longAgo });
    const first = await s.readAttachment(file.id);
    // Named again by the same conversation (a retry, a regenerate), it stays bound as it was.
    await s.admit({ conversation: "cnv_a", version: bound.version, turn: "trn_3", attachments: [file.id], expiredBefore: future });
    expect(await s.readAttachment(file.id)).toEqual(first);
  });

  it("binds the files an append names, and a superseded turn's append never", async () => {
    const { connection } = sqliteConnection();
    const s = await started(connection);
    await conversation(s, "cnv_a");
    const kept = await s.registerAttachment({ id: "att_4" });
    const late = await s.registerAttachment({ id: "att_5" });
    const message = { role: "assistant", content: "here" };
    await s.append({ conversation: "cnv_a", id: "ent_1", parent: null, turn: "trn_cnv_a", message, attachments: [kept.id] });
    await s.admit({ conversation: "cnv_a", version: 2, turn: "trn_next", attachments: [], expiredBefore: longAgo });
    await expect(
      s.append({ conversation: "cnv_a", id: "ent_2", parent: null, turn: "trn_cnv_a", message, attachments: [late.id] }),
    ).rejects.toMatchObject({ code: "ERR_CONVERSATION_CONFLICT" });
    expect((await s.readAttachment(kept.id)).conversation).toBe("cnv_a");
    expect((await s.readAttachment(late.id)).conversation).toBeNull();
  });

  it("registers a running turn's file bound, beyond any expiry pass, and a superseded turn's not at all", async () => {
    const { connection } = sqliteConnection();
    const s = await started(connection);
    await conversation(s, "cnv_a");
    const produced = await s.registerAttachment({ id: "att_8", binding: { conversation: "cnv_a", turn: "trn_cnv_a" } });
    expect(produced).toMatchObject({ conversation: "cnv_a" });
    expect(produced.boundAt).not.toBeNull();
    expect(await s.expireAttachments({ expiredBefore: at(Date.now() + 60_000), limit: 10 })).toEqual({ ids: [] });
    expect((await s.readAttachment(produced.id)).conversation).toBe("cnv_a");
    await s.admit({ conversation: "cnv_a", version: 2, turn: "trn_next", attachments: [], expiredBefore: longAgo });
    await expect(
      s.registerAttachment({ id: "att_9", binding: { conversation: "cnv_a", turn: "trn_cnv_a" } }),
    ).rejects.toMatchObject({ code: "ERR_CONVERSATION_CONFLICT" });
    await expect(s.readAttachment("att_9")).rejects.toMatchObject({ code: "ERR_CONVERSATION_ATTACHMENT_NOT_FOUND" });
  });

  it("answers an existing id only as the registration would have left it", async () => {
    const { connection } = sqliteConnection();
    const s = await started(connection);
    await conversation(s, "cnv_a");
    await conversation(s, "cnv_b");
    const pending = await s.registerAttachment({ id: "att_10", name: "dot.png" });
    expect(await s.registerAttachment({ id: "att_10" })).toEqual(pending);
    const bound = await s.registerAttachment({ id: "att_11", binding: { conversation: "cnv_a", turn: "trn_cnv_a" } });
    expect(await s.registerAttachment({ id: "att_11", binding: { conversation: "cnv_a", turn: "trn_cnv_a" } })).toEqual(bound);
    const refused = { code: "ERR_CONVERSATION_ATTACHMENT_NOT_FOUND", data: { attachment: "att_11" } };
    await expect(s.registerAttachment({ id: "att_11" })).rejects.toMatchObject(refused);
    await expect(
      s.registerAttachment({ id: "att_11", binding: { conversation: "cnv_b", turn: "trn_cnv_b" } }),
    ).rejects.toMatchObject(refused);
    await s.delete("cnv_a");
    await expect(
      s.registerAttachment({ id: "att_11", binding: { conversation: "cnv_b", turn: "trn_cnv_b" } }),
    ).rejects.toMatchObject(refused);
  });

  it("releases a deleted conversation's files at once, and a pass returns them until they are forgotten", async () => {
    const { connection } = sqliteConnection();
    const s = await started(connection);
    await conversation(s, "cnv_a");
    await conversation(s, "cnv_b");
    const mine = await s.registerAttachment({ id: "att_6" });
    const theirs = await s.registerAttachment({ id: "att_7" });
    await s.admit({ conversation: "cnv_a", version: 2, turn: "trn_a2", attachments: [mine.id], expiredBefore: longAgo });
    await s.admit({ conversation: "cnv_b", version: 2, turn: "trn_b2", attachments: [theirs.id], expiredBefore: longAgo });
    await s.delete("cnv_a");
    await expect(s.readAttachment(mine.id)).rejects.toMatchObject({ code: "ERR_CONVERSATION_ATTACHMENT_NOT_FOUND" });
    expect((await s.readAttachment(theirs.id)).conversation).toBe("cnv_b");
    expect(await s.expireAttachments({ expiredBefore: longAgo, limit: 10 })).toEqual({ ids: [mine.id] });
    await s.forgetAttachments({ ids: [mine.id, theirs.id] });
    expect(await s.expireAttachments({ expiredBefore: longAgo, limit: 10 })).toEqual({ ids: [] });
    // Forgetting leaves an unreleased file alone.
    expect((await s.readAttachment(theirs.id)).conversation).toBe("cnv_b");
  });
});
