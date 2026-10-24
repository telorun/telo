import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";

import { DPOP_KEY_DATABASE, DPOP_KEY_STORE, indexedDbDpopKeyStore } from "../dpop-key-store";

/** The record IndexedDB holds for `subject`, read as a later page load would. */
function storedRecord(factory: IDBFactory, subject: string): Promise<{ privateKey: CryptoKey } | undefined> {
  return new Promise((resolve, reject) => {
    const opening = factory.open(DPOP_KEY_DATABASE);
    opening.onerror = () => reject(opening.error);
    opening.onsuccess = () => {
      const read = opening.result.transaction(DPOP_KEY_STORE, "readonly").objectStore(DPOP_KEY_STORE).get(subject);
      read.onerror = () => reject(read.error);
      read.onsuccess = () => {
        opening.result.close();
        resolve(read.result as { privateKey: CryptoKey } | undefined);
      };
    };
  });
}

async function verifies(publicJwk: JsonWebKey, data: Uint8Array, signature: Uint8Array): Promise<boolean> {
  const publicKey = await crypto.subtle.importKey("jwk", publicJwk, { name: "ECDSA", namedCurve: "P-256" }, false, [
    "verify",
  ]);
  return crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, publicKey, signature as BufferSource, data as BufferSource);
}

describe("the DPoP key store", () => {
  it("makes a subject's key once and finds the same key after a reload", async () => {
    const factory = new IDBFactory();
    const store = indexedDbDpopKeyStore(() => factory);
    const [first, again] = await Promise.all([store.key("user-1"), store.key("user-1")]);
    expect(again.publicJwk).toEqual(first.publicJwk);

    const reloaded = await indexedDbDpopKeyStore(() => factory).key("user-1");
    expect(reloaded.publicJwk).toEqual(first.publicJwk);
    const data = new TextEncoder().encode("signed after a reload");
    expect(await verifies(first.publicJwk, data, await reloaded.sign(data))).toBe(true);
  });

  it("keeps the private key non-extractable through IndexedDB", async () => {
    const factory = new IDBFactory();
    await indexedDbDpopKeyStore(() => factory).key("user-1");
    const record = await storedRecord(factory, "user-1");
    expect(record!.privateKey).toBeInstanceOf(CryptoKey);
    expect(record!.privateKey.type).toBe("private");
    expect(record!.privateKey.extractable).toBe(false);
    await expect(crypto.subtle.exportKey("jwk", record!.privateKey)).rejects.toThrow();
  });

  it("gives another subject another key", async () => {
    const store = indexedDbDpopKeyStore(() => new IDBFactory());
    const one = await store.key("user-1");
    const two = await store.key("user-2");
    expect(two.publicJwk).not.toEqual(one.publicJwk);
  });

  it("deletes every other subject's key on a sign-in, and every key on sign-out", async () => {
    const factory = new IDBFactory();
    const store = indexedDbDpopKeyStore(() => factory);
    const one = await store.key("user-1");
    await store.key("user-2");

    await store.forgetAllBut("user-1");
    expect(await storedRecord(factory, "user-1")).toBeDefined();
    expect(await storedRecord(factory, "user-2")).toBeUndefined();
    expect((await store.key("user-1")).publicJwk).toEqual(one.publicJwk);

    await store.forgetAllBut(null);
    expect(await storedRecord(factory, "user-1")).toBeUndefined();
    expect((await indexedDbDpopKeyStore(() => factory).key("user-1")).publicJwk).not.toEqual(one.publicJwk);
  });

  it("fails visibly, with no key, when IndexedDB cannot be opened", async () => {
    const refused = indexedDbDpopKeyStore(() => {
      throw new DOMException("The user denied storage.", "SecurityError");
    });
    await expect(refused.key("user-1")).rejects.toThrow(/IndexedDB\): The user denied storage\./);
    const absent = indexedDbDpopKeyStore(() => undefined as unknown as IDBFactory);
    await expect(absent.key("user-1")).rejects.toThrow(/IndexedDB\): this browser offers no IndexedDB/);
  });
});
