import { createHmac, generateKeyPairSync, sign } from "node:crypto";
import { celDurationFromNanos, celTimestampFromMillis } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { create } from "../src/verifier-controller.js";
import type { KeyResource } from "../src/signature-keys.js";

const BASE = new TextEncoder().encode('"@method": POST\n"@signature-params": ("@method")');
const ctx = {} as never;
const secret = "shared-secret";
const mac = (key: string, base = BASE) => new Uint8Array(createHmac("sha256", key).update(base).digest());
const seconds = (n: number) => celDurationFromNanos(BigInt(n) * 1_000_000_000n);
const at = (offsetMs: number) => celTimestampFromMillis(Date.now() + offsetMs);

const ed = generateKeyPairSync("ed25519");
const jwk = ed.publicKey.export({ format: "jwk" }) as { kty: string; crv: string; x: string };

async function verifier(keys: KeyResource[], extra: Record<string, unknown> = {}) {
  return create({ metadata: { name: "v" }, keys, ...extra }, ctx);
}

const present = (over: Record<string, unknown> = {}) => ({
  presentation: { base: BASE, signatures: [mac(secret)], keyId: "k1", algorithm: null, created: null, expires: null, ...over },
});

const hmacKey = (id: string | undefined, key = secret, subject = "svc"): KeyResource => ({
  ...(id === undefined ? {} : { id }),
  subject,
  algorithm: "hmac-sha256",
  secret: key,
});

describe("key selection", () => {
  it("selects the key named by keyId and answers its subject", async () => {
    const v = await verifier([hmacKey("k0", "other", "a"), hmacKey("k1", secret, "b")]);
    expect(await v.invoke!(present())).toMatchObject({ principal: { subject: "b", kind: "service", via: "v" } });
  });

  it("refuses a keyId no key holds as unknownKey", async () => {
    const v = await verifier([hmacKey("k0")]);
    expect(await v.invoke!(present())).toMatchObject({ refused: true, reason: "unknownKey" });
  });

  it("an id-less signature selects only id-less keys, so a key can be rotated in by trying each", async () => {
    const v = await verifier([hmacKey(undefined, "old", "old"), hmacKey(undefined, secret, "new"), hmacKey("k1", "named", "named")]);
    expect(await v.invoke!(present({ keyId: null }))).toMatchObject({ principal: { subject: "new" } });
    const none = await verifier([hmacKey("k1")]);
    expect(await none.invoke!(present({ keyId: null }))).toMatchObject({ reason: "unknownKey" });
  });
});

describe("algorithm", () => {
  it("an alg claim that no selected key has is refused as algorithm", async () => {
    const v = await verifier([hmacKey("k1")]);
    expect(await v.invoke!(present({ algorithm: "ed25519" }))).toMatchObject({ refused: true, reason: "algorithm" });
  });

  it("a matching alg claim is accepted", async () => {
    const v = await verifier([hmacKey("k1")]);
    expect(await v.invoke!(present({ algorithm: "hmac-sha256" }))).toHaveProperty("principal");
  });
});

describe("signatures", () => {
  it("hmac-sha256 accepts the right mac and rejects a wrong or truncated one", async () => {
    const v = await verifier([hmacKey("k1")]);
    expect(await v.invoke!(present())).toHaveProperty("principal");
    expect(await v.invoke!(present({ signatures: [mac("wrong")] }))).toMatchObject({ reason: "signature" });
    expect(await v.invoke!(present({ signatures: [mac(secret).slice(0, 8)] }))).toMatchObject({ reason: "signature" });
  });

  it("accepts when any presented signature verifies", async () => {
    const v = await verifier([hmacKey("k1")]);
    expect(await v.invoke!(present({ signatures: [mac("wrong"), mac(secret)] }))).toHaveProperty("principal");
  });

  it("ed25519 accepts a signature of the base and rejects another base", async () => {
    const v = await verifier([{ id: "k1", subject: "edsvc", algorithm: "ed25519", jwk }]);
    const good = new Uint8Array(sign(null, BASE, ed.privateKey));
    const other = new Uint8Array(sign(null, new TextEncoder().encode("other"), ed.privateKey));
    expect(await v.invoke!(present({ signatures: [good], algorithm: "ed25519" }))).toMatchObject({ principal: { subject: "edsvc" } });
    expect(await v.invoke!(present({ signatures: [other] }))).toMatchObject({ reason: "signature" });
  });
});

describe("time", () => {
  it("without maxSignatureAge the created time is not required", async () => {
    const v = await verifier([hmacKey("k1")]);
    expect(await v.invoke!(present())).toHaveProperty("principal");
  });

  it("with maxSignatureAge a missing created is stale", async () => {
    const v = await verifier([hmacKey("k1")], { maxSignatureAge: seconds(300) });
    expect(await v.invoke!(present())).toMatchObject({ reason: "stale" });
  });

  it("with maxSignatureAge an old or future created is stale, a recent one is accepted", async () => {
    const v = await verifier([hmacKey("k1")], { maxSignatureAge: seconds(300) });
    expect(await v.invoke!(present({ created: at(-3_600_000) }))).toMatchObject({ reason: "stale" });
    expect(await v.invoke!(present({ created: at(3_600_000) }))).toMatchObject({ reason: "stale" });
    expect(await v.invoke!(present({ created: at(-60_000) }))).toHaveProperty("principal");
  });

  it("a signature past its expires is expired, beyond the clock tolerance only", async () => {
    const v = await verifier([hmacKey("k1")]);
    expect(await v.invoke!(present({ expires: at(-3_600_000) }))).toMatchObject({ reason: "expired" });
    expect(await v.invoke!(present({ expires: at(-5_000) }))).toHaveProperty("principal");
  });

  it("clockTolerance widens or narrows the window", async () => {
    const strict = await verifier([hmacKey("k1")], { clockTolerance: seconds(0) });
    expect(await strict.invoke!(present({ expires: at(-5_000) }))).toMatchObject({ reason: "expired" });
    const lax = await verifier([hmacKey("k1")], { maxSignatureAge: seconds(60), clockTolerance: seconds(600) });
    expect(await lax.invoke!(present({ created: at(-300_000) }))).toHaveProperty("principal");
  });
});
