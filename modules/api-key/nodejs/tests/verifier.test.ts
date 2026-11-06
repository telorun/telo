import { describe, expect, it } from "vitest";
import { create } from "../src/verifier-controller.js";
import { mintKey } from "../src/key-format.js";
import { timestampOfMillis } from "../src/instants.js";
import { directCtx, FakeStore, plainSource } from "./fakes.js";

const token = (value: string) => ({ presentation: { type: "token", token: value }, confirmation: {}, resource: null });

async function verifierOver(store: FakeStore, extra: object = {}) {
  return create({ metadata: { name: "keys" }, sources: [store], ...extra }, directCtx);
}

async function issued(store: FakeStore, expiresAt: number | null = null) {
  const minted = mintKey("tk");
  await store.issue({
    id: minted.uuid,
    digest: minted.digest,
    owner: { type: "organization", id: "acme" },
    scopes: ["read"],
    label: null,
    expiresAt: expiresAt === null ? null : timestampOfMillis(expiresAt),
  });
  return minted;
}

describe("ApiKey.Verifier", () => {
  it("refuses a key with a changed checksum without asking the store", async () => {
    const store = new FakeStore();
    const minted = await issued(store);
    const verifier = await verifierOver(store);
    const last = minted.key.length - 1;
    const forged = minted.key.slice(0, last) + (minted.key[last] === "0" ? "1" : "0");
    expect(await verifier.invoke(token(forged))).toEqual({ refused: true, reason: "malformed", challenge: null });
    expect(store.calls).toEqual([]);
  });

  it("answers the principal of the owner, with the key's scopes and public id", async () => {
    const store = new FakeStore();
    const minted = await issued(store);
    const verifier = await verifierOver(store);
    const output = await verifier.invoke(token(minted.key));
    expect(output).toMatchObject({
      principal: {
        subject: "acme",
        kind: "service",
        org: "acme",
        scopes: ["read"],
        claims: { apiKeyId: minted.id },
        issuer: null,
        via: "keys",
      },
    });
  });

  it("refuses a non-token presentation, an unknown key, a revoked one and an expired one", async () => {
    const store = new FakeStore();
    const revoked = await issued(store);
    await store.revoke(revoked.uuid, { by: null });
    const expired = await issued(store, Date.now() - 1000);
    const verifier = await verifierOver(store);
    const reason = async (value: unknown) => ((await verifier.invoke(value as never)) as { reason?: string }).reason;
    expect(await reason({ presentation: { type: "basic", username: "a", password: "b" } })).toBe("malformed");
    expect(await reason(token(mintKey("tk").key))).toBe("unknown");
    expect(await reason(token(mintKey("zz").key))).toBe("malformed");
    expect(await reason(token(revoked.key))).toBe("revoked");
    expect(await reason(token(expired.key))).toBe("expired");
  });

  it("refuses a key whose id exists but whose secret differs", async () => {
    const store = new FakeStore();
    const minted = await issued(store);
    const other = mintKey("tk");
    store.keys.set(other.uuid, { ...store.keys.get(minted.uuid)!, id: other.uuid });
    const verifier = await verifierOver(store);
    expect(((await verifier.invoke(token(other.key))) as { reason: string }).reason).toBe("unknown");
  });

  it("records last use once per resolution and not for a source that tracks none", async () => {
    const store = new FakeStore();
    const minted = await issued(store);
    const verifier = await verifierOver(store);
    await verifier.invoke(token(minted.key));
    await verifier.invoke(token(minted.key));
    expect(store.calls.filter((call) => call === "touch")).toHaveLength(1);

    const plain = new FakeStore();
    const plainKey = await issued(plain);
    const untracked = await create({ metadata: { name: "keys" }, sources: [plainSource(plain)] }, directCtx);
    expect((await untracked.invoke(token(plainKey.key))) as object).toHaveProperty("principal");
  });

  it("routes by prefix across sources and refuses two with one prefix", async () => {
    const first = new FakeStore("aa");
    const second = new FakeStore("bb");
    const firstKey = mintKey("aa");
    const secondKey = mintKey("bb");
    for (const [store, minted] of [[first, firstKey], [second, secondKey]] as const) {
      await store.issue({ id: minted.uuid, digest: minted.digest, owner: { type: "user", id: "u" }, scopes: [], label: null, expiresAt: null });
    }
    const verifier = await create({ metadata: { name: "keys" }, sources: [first, second] }, directCtx);
    expect(await verifier.invoke(token(firstKey.key))).toHaveProperty("principal");
    expect(await verifier.invoke(token(secondKey.key))).toHaveProperty("principal");
    await expect(create({ metadata: { name: "keys" }, sources: [first, new FakeStore("aa")] }, directCtx)).rejects.toMatchObject({
      code: "ERR_API_KEY_PREFIX_DUPLICATE",
    });
  });

  it("throws a store failure instead of refusing", async () => {
    const store = new FakeStore();
    const minted = await issued(store);
    store.lookup = async () => {
      throw new Error("connection reset");
    };
    const verifier = await verifierOver(store);
    await expect(verifier.invoke(token(minted.key))).rejects.toMatchObject({ code: "ERR_API_KEY_STORE_UNAVAILABLE" });
  });
});
