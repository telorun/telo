import { describe, expect, it } from "vitest";
import { create as createGenerate } from "../src/generate-controller.js";
import { create as createIssue } from "../src/issue-controller.js";
import { create as createList } from "../src/list-controller.js";
import { create as createRevoke } from "../src/revoke-controller.js";
import { create as createRotate } from "../src/rotate-controller.js";
import { create as createDeclared } from "../src/declared-keys-controller.js";
import { create as createVerifier } from "../src/verifier-controller.js";
import { parseKey, publicIdOf, mintKey } from "../src/key-format.js";
import { durationOfMillis, millisOfTimestamp, timestampOfMillis } from "../src/instants.js";
import { directCtx, FakeStore } from "./fakes.js";

const owner = { type: "user", id: "alice" } as const;

function resourceOver(store: FakeStore) {
  return { metadata: { name: "op" }, store };
}

describe("key operations over a store", () => {
  it("issues a key once, in the format, refusing unknown scopes and lifetimes beyond the maximum", async () => {
    const store = new FakeStore("tk", ["read", "write"], 3_600_000);
    const issue = await createIssue(resourceOver(store), directCtx);
    const expiresAt = timestampOfMillis(Date.now() + 60_000);
    const out = (await issue.invoke({ owner, scopes: ["read"], expiresAt })) as { key: string; id: string };
    const parsed = parseKey(out.key);
    expect(parsed.ok && publicIdOf(parsed.uuid)).toBe(out.id);
    expect([...store.keys.values()].some((stored) => Object.values(stored).includes(out.key))).toBe(false);

    await expect(issue.invoke({ owner, scopes: ["admin"], expiresAt })).rejects.toMatchObject({ code: "ERR_API_KEY_SCOPE_UNKNOWN" });
    await expect(issue.invoke({ owner, scopes: ["read"], expiresAt: timestampOfMillis(Date.now() + 7_200_000) })).rejects.toMatchObject({
      code: "ERR_API_KEY_LIFETIME_EXCEEDED",
    });
    await expect(issue.invoke({ owner, scopes: ["read"] })).rejects.toMatchObject({ code: "ERR_API_KEY_LIFETIME_EXCEEDED" });
  });

  it("lists an owner's keys in pages by an opaque cursor bound to the owner", async () => {
    const store = new FakeStore();
    const issue = await createIssue(resourceOver(store), directCtx);
    for (let i = 0; i < 3; i++) {
      await issue.invoke({ owner, scopes: [] });
      store.now += 1;
    }
    const list = await createList(resourceOver(store), directCtx);
    const first = (await list.invoke({ owner, limit: 2 })) as { keys: unknown[]; next?: string };
    expect(first.keys).toHaveLength(2);
    expect(first.next).toBeTypeOf("string");
    const second = (await list.invoke({ owner, limit: 2, cursor: first.next })) as { keys: unknown[]; next?: string };
    expect(second.keys).toHaveLength(1);
    expect(second.next).toBeUndefined();
    expect(first.keys.every((entry) => !("digest" in (entry as object)))).toBe(true);
    await expect(list.invoke({ owner: { type: "user", id: "bob" }, cursor: first.next })).rejects.toMatchObject({
      code: "ERR_API_KEY_CURSOR_INVALID",
    });
    await expect(list.invoke({ owner, cursor: "garbage" })).rejects.toMatchObject({ code: "ERR_API_KEY_CURSOR_INVALID" });
  });

  it("revokes idempotently, keeping the first revocation, and refuses an unknown id", async () => {
    const store = new FakeStore();
    const issue = await createIssue(resourceOver(store), directCtx);
    const { id } = (await issue.invoke({ owner, scopes: [] })) as { id: string };
    const revoke = await createRevoke(resourceOver(store), directCtx);
    const first = (await revoke.invoke({ id, by: "admin" })) as { revokedAt: unknown; revokedBy: string };
    store.now += 5000;
    const again = (await revoke.invoke({ id, by: "someone-else" })) as { revokedAt: unknown; revokedBy: string };
    expect(again).toEqual({ id, revokedAt: first.revokedAt, revokedBy: "admin" });
    await expect(revoke.invoke({ id: publicIdOf(mintKey("tk").uuid) })).rejects.toMatchObject({ code: "ERR_API_KEY_NOT_FOUND" });
    await expect(revoke.invoke({ id: "apk_!!" })).rejects.toMatchObject({ code: "ERR_API_KEY_NOT_FOUND" });
  });

  it("rotates into a successor and caps the old key at now plus the overlap", async () => {
    const store = new FakeStore();
    const issue = await createIssue(resourceOver(store), directCtx);
    const old = (await issue.invoke({ owner, scopes: ["read"], label: "ci" })) as { id: string };
    const rotate = await createRotate(resourceOver(store), directCtx);
    const out = (await rotate.invoke({ id: old.id, overlap: durationOfMillis(60_000) })) as {
      key: string;
      id: string;
      scopes: string[];
      label: string;
      previous: { id: string; expiresAt: never };
    };
    expect(out.id).not.toBe(old.id);
    expect(out.scopes).toEqual(["read"]);
    expect(out.label).toBe("ci");
    expect(out.previous.id).toBe(old.id);
    expect(millisOfTimestamp(out.previous.expiresAt)).toBe(store.now + 60_000);
    await expect(rotate.invoke({ id: publicIdOf(mintKey("tk").uuid) })).rejects.toMatchObject({ code: "ERR_API_KEY_NOT_FOUND" });

    const revoke = await createRevoke(resourceOver(store), directCtx);
    await revoke.invoke({ id: out.id });
    await expect(rotate.invoke({ id: out.id })).rejects.toMatchObject({ code: "ERR_API_KEY_REVOKED" });
  });

  it("generates a key whose entry a declared source accepts and the verifier passes", async () => {
    const generate = await createGenerate();
    const { key, id, digest } = await generate.invoke({ prefix: "dk" });
    const source = await createDeclared({
      metadata: { name: "declared" },
      prefix: "dk",
      scopes: ["read"],
      keys: [{ id, digest, owner, scopes: ["read"] }],
    });
    const verifier = await createVerifier({ metadata: { name: "v" }, sources: [source] }, directCtx);
    const out = await verifier.invoke({ presentation: { type: "token", token: key } });
    expect(out).toMatchObject({ principal: { subject: "alice", kind: "user", claims: { apiKeyId: id } } });
  });

  it("refuses a declared scope outside the vocabulary and a repeated id at creation", async () => {
    const { id, digest } = await (await createGenerate()).invoke({ prefix: "dk" });
    const base = { metadata: { name: "declared" }, prefix: "dk", scopes: ["read"] };
    await expect(createDeclared({ ...base, keys: [{ id, digest, owner, scopes: ["admin"] }] })).rejects.toMatchObject({
      code: "ERR_API_KEY_SCOPE_UNKNOWN",
    });
    const entry = { id, digest, owner, scopes: ["read"] };
    await expect(createDeclared({ ...base, keys: [entry, entry] })).rejects.toMatchObject({ code: "ERR_API_KEY_ID_DUPLICATE" });
  });
});
