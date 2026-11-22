import { createHmac } from "node:crypto";
import { timestampNanos } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { readBodySignature, type BodySignatureOptions, type RequestDescription } from "../src/index.js";

const payload = '{"id":"evt_1","amount":4999}';
const body = new TextEncoder().encode(payload);
const mac = (secret: string | Buffer, text: string) => createHmac("sha256", secret).update(text).digest();
const request = (headers: Record<string, string>): RequestDescription => ({
  method: "POST",
  targetUri: "https://api.acme.test/hooks",
  headers,
  body,
});
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

function ok(reading: ReturnType<typeof readBodySignature>) {
  if (reading.status !== "ok") throw new Error(`expected a presentation, got ${JSON.stringify(reading)}`);
  return reading.presentation;
}

const STRIPE: BodySignatureOptions = {
  signature: { header: "Stripe-Signature", pattern: "(?:^|,)v1=([0-9a-f]+)", encoding: "hex" },
  timestamp: { header: "Stripe-Signature", pattern: "(?:^|,)t=(\\d+)", unit: "seconds" },
  base: [
    { type: "header", header: "Stripe-Signature", pattern: "(?:^|,)t=(\\d+)" },
    { type: "literal", value: "." },
    { type: "body" },
  ],
};

describe("the vendor shapes", () => {
  it("Stripe: every v1 signature is presented, the timestamp is read, the base is t.body", () => {
    const first = mac("whsec", `1700000000.${payload}`).toString("hex");
    const rotated = mac("whsec-new", `1700000000.${payload}`).toString("hex");
    const presentation = ok(
      readBodySignature(request({ "Stripe-Signature": `t=1700000000,v1=${first},v0=ab,v1=${rotated}` }), STRIPE),
    );
    expect(text(presentation.base)).toBe(`1700000000.${payload}`);
    expect(presentation.signatures.map((s) => Buffer.from(s).toString("hex"))).toEqual([first, rotated]);
    expect(timestampNanos(presentation.created!)).toBe(1700000000n * 1_000_000_000n);
    expect(presentation).toMatchObject({ keyId: null, algorithm: null, expires: null });
  });

  it("Stripe: a header with no t= is malformed", () => {
    expect(readBodySignature(request({ "Stripe-Signature": "v1=00" }), STRIPE)).toMatchObject({ status: "malformed" });
  });

  it("GitHub: the body alone, no timestamp, hex after a prefix", () => {
    const sig = mac("gh", payload).toString("hex");
    const presentation = ok(
      readBodySignature(request({ "X-Hub-Signature-256": `sha256=${sig}` }), {
        signature: { header: "X-Hub-Signature-256", pattern: "sha256=([0-9a-f]+)", encoding: "hex" },
        base: [{ type: "body" }],
      }),
    );
    expect(text(presentation.base)).toBe(payload);
    expect(presentation.created).toBeNull();
    expect(Buffer.from(presentation.signatures[0]!).equals(mac("gh", payload))).toBe(true);
  });

  it("Slack: v0:timestamp:body with the timestamp in its own header", () => {
    const sig = mac("slack", `v0:1531420618:${payload}`).toString("hex");
    const presentation = ok(
      readBodySignature(request({ "X-Slack-Signature": `v0=${sig}`, "X-Slack-Request-Timestamp": "1531420618" }), {
        signature: { header: "X-Slack-Signature", pattern: "v0=([0-9a-f]+)", encoding: "hex" },
        timestamp: { header: "X-Slack-Request-Timestamp", unit: "seconds" },
        base: [
          { type: "literal", value: "v0:" },
          { type: "header", header: "X-Slack-Request-Timestamp" },
          { type: "literal", value: ":" },
          { type: "body" },
        ],
      }),
    );
    expect(text(presentation.base)).toBe(`v0:1531420618:${payload}`);
    expect(Buffer.from(presentation.signatures[0]!).toString("hex")).toBe(sig);
    expect(timestampNanos(presentation.created!)).toBe(1531420618n * 1_000_000_000n);
  });

  it("Shopify: the whole header is a base64 signature over the body", () => {
    const presentation = ok(
      readBodySignature(request({ "X-Shopify-Hmac-Sha256": mac("shop", payload).toString("base64") }), {
        signature: { header: "X-Shopify-Hmac-Sha256", encoding: "base64" },
        base: [{ type: "body" }],
      }),
    );
    expect(Buffer.from(presentation.signatures[0]!).equals(mac("shop", payload))).toBe(true);
  });

  it("Standard Webhooks: id.timestamp.body, several space-separated v1 signatures, a base64 secret", () => {
    const secret = Buffer.from("MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw", "base64");
    const signed = `msg_1.1614265330.${payload}`;
    const one = mac(secret, signed).toString("base64");
    const presentation = ok(
      readBodySignature(
        request({ "webhook-id": "msg_1", "webhook-timestamp": "1614265330", "webhook-signature": `v1,${one} v1a,xyz v1,${mac("other", signed).toString("base64")}` }),
        {
          signature: { header: "webhook-signature", pattern: "(?:^|\\s)v1,([A-Za-z0-9+/=]+)", encoding: "base64" },
          timestamp: { header: "webhook-timestamp", unit: "seconds" },
          base: [
            { type: "header", header: "webhook-id" },
            { type: "literal", value: "." },
            { type: "header", header: "webhook-timestamp" },
            { type: "literal", value: "." },
            { type: "body" },
          ],
        },
      ),
    );
    expect(text(presentation.base)).toBe(signed);
    expect(presentation.signatures).toHaveLength(2);
    expect(Buffer.from(presentation.signatures[0]!).equals(mac(secret, signed))).toBe(true);
  });
});

describe("what a source refuses", () => {
  it("no signature header is no credential", () => {
    expect(readBodySignature(request({}), STRIPE)).toEqual({ status: "absent" });
  });

  it("a header the pattern finds no signature in, an undecodable signature and a missing base header are malformed", () => {
    expect(readBodySignature(request({ "Stripe-Signature": "t=1" }), STRIPE)).toMatchObject({ status: "malformed" });
    expect(readBodySignature(request({ "Stripe-Signature": "t=1,v1=zz" }), STRIPE)).toMatchObject({ status: "malformed" });
    expect(
      readBodySignature(request({ "X-Sig": "aa" }), {
        signature: { header: "X-Sig", encoding: "hex" },
        base: [{ type: "header", header: "X-Absent" }, { type: "body" }],
      }),
    ).toMatchObject({ status: "malformed" });
  });

  it("a timestamp in milliseconds is read as milliseconds", () => {
    const presentation = ok(
      readBodySignature(request({ "X-Sig": "aa", "X-Ts": "1700000000123" }), {
        signature: { header: "X-Sig", encoding: "hex" },
        timestamp: { header: "X-Ts", unit: "milliseconds" },
        base: [{ type: "body" }],
      }),
    );
    expect(timestampNanos(presentation.created!)).toBe(1700000000123n * 1_000_000n);
  });
});
