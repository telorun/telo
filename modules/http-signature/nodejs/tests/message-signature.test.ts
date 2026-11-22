import { createHmac, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { timestampNanos } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { readMessageSignature, type RequestDescription } from "../src/index.js";

// RFC 9421 Appendix B.2: the test request and keys.
const DIGEST = "sha-512=:WZDPaVn/7XgHaAy8pmojAkGWoRx2UFChF41A2svX+TaPm+AbwAgBWnrIiYllu7BNNyealdVLvRwEmTHWXvJwew==:";
const body = new TextEncoder().encode('{"hello": "world"}');
const rfcRequest = (extra: Record<string, string>): RequestDescription => ({
  method: "POST",
  targetUri: "https://example.com/foo?param=Value&Pet=dog",
  headers: {
    Host: "example.com",
    Date: "Tue, 20 Apr 2021 02:07:55 GMT",
    "Content-Type": "application/json",
    "Content-Digest": DIGEST,
    "Content-Length": "18",
    ...extra,
  },
  body,
});
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const SHARED_SECRET = Buffer.from(
  "uzvJfB4u3N0Jy4T7NZ75MDVcr8zSTInedJtkgcu46YW4XByzNJjxBdtjUkdJPBtbmHhIDi6pcl8jsasjlTMtDQ==",
  "base64",
);
const ED25519_PRIVATE = createPrivateKey(
  "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIJ+DYvh6SEqVTm50DFtMDoQikTmiCqirVv9mWG9qfSnF\n-----END PRIVATE KEY-----",
);
const ED25519_PUBLIC = createPublicKey(
  "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAJrQLj5P/89iXES9+vFgrIy29clF9CC/oPPsw3c5D0bs=\n-----END PUBLIC KEY-----",
);

function ok(reading: ReturnType<typeof readMessageSignature>) {
  if (reading.status !== "ok") throw new Error(`expected a presentation, got ${JSON.stringify(reading)}`);
  return reading.presentation;
}

describe("RFC 9421 Appendix B signature bases", () => {
  it("B.2.5 hmac-sha256: the base and the published signature", () => {
    const request = rfcRequest({
      "Signature-Input": 'sig-b25=("date" "@authority" "content-type");created=1618884473;keyid="test-shared-secret"',
      Signature: "sig-b25=:pxcQw6G3AjtMBQjwo8XzkZf/bws5LelbaMk5rGIGtE8=:",
    });
    const presentation = ok(readMessageSignature(request, { components: ["date", "@authority", "content-type"] }));
    expect(text(presentation.base)).toBe(
      [
        '"date": Tue, 20 Apr 2021 02:07:55 GMT',
        '"@authority": example.com',
        '"content-type": application/json',
        '"@signature-params": ("date" "@authority" "content-type");created=1618884473;keyid="test-shared-secret"',
      ].join("\n"),
    );
    expect(presentation.keyId).toBe("test-shared-secret");
    expect(presentation.algorithm).toBeNull();
    expect(timestampNanos(presentation.created!)).toBe(1618884473n * 1_000_000_000n);
    expect(presentation.expires).toBeNull();
    const mac = createHmac("sha256", SHARED_SECRET).update(presentation.base).digest();
    expect(Buffer.from(presentation.signatures[0]!).equals(mac)).toBe(true);
  });

  it("B.2.6 ed25519: the base and the published signature", () => {
    const request = rfcRequest({
      "Signature-Input":
        'sig-b26=("date" "@method" "@path" "@authority" "content-type" "content-length");created=1618884473;keyid="test-key-ed25519"',
      Signature:
        "sig-b26=:wqcAqbmYJ2ji2glfAMaRy4gruYYnx2nEFN2HN6jrnDnQCK1u02Gb04v9EDgwUPiu4A0w6vuQv5lIp5WPpBKRCw==:",
    });
    const presentation = ok(readMessageSignature(request, { label: "sig-b26", components: ["@method", "@path"] }));
    expect(text(presentation.base)).toBe(
      [
        '"date": Tue, 20 Apr 2021 02:07:55 GMT',
        '"@method": POST',
        '"@path": /foo',
        '"@authority": example.com',
        '"content-type": application/json',
        '"content-length": 18',
        '"@signature-params": ("date" "@method" "@path" "@authority" "content-type" "content-length");created=1618884473;keyid="test-key-ed25519"',
      ].join("\n"),
    );
    expect(verify(null, presentation.base, ED25519_PUBLIC, presentation.signatures[0]!)).toBe(true);
    expect(Buffer.from(sign(null, presentation.base, ED25519_PRIVATE)).equals(Buffer.from(presentation.signatures[0]!))).toBe(true);
  });

  it("B.2.3 covers a query, a digest and several derived components", () => {
    const request = rfcRequest({
      "Signature-Input":
        'sig-b23=("date" "@method" "@path" "@query" "@authority" "content-type" "content-digest" "content-length");created=1618884473;keyid="test-key-rsa-pss"',
      Signature: "sig-b23=:AAAA:",
    });
    expect(text(ok(readMessageSignature(request, { components: ["@query", "content-digest"] })).base)).toBe(
      [
        '"date": Tue, 20 Apr 2021 02:07:55 GMT',
        '"@method": POST',
        '"@path": /foo',
        '"@query": ?param=Value&Pet=dog',
        '"@authority": example.com',
        '"content-type": application/json',
        `"content-digest": ${DIGEST}`,
        '"content-length": 18',
        '"@signature-params": ("date" "@method" "@path" "@query" "@authority" "content-type" "content-digest" "content-length");created=1618884473;keyid="test-key-rsa-pss"',
      ].join("\n"),
    );
  });

  it("derives @query-param, @request-target and @scheme", () => {
    const request = rfcRequest({
      "Signature-Input": 'sig=("@query-param";name="Pet" "@request-target" "@scheme");alg="ed25519";expires=1618884773',
      Signature: "sig=:AAAA:",
    });
    const presentation = ok(readMessageSignature(request, { components: ['@query-param;name="Pet"'] }));
    expect(text(presentation.base)).toBe(
      [
        '"@query-param";name="Pet": dog',
        '"@request-target": /foo?param=Value&Pet=dog',
        '"@scheme": https',
        '"@signature-params": ("@query-param";name="Pet" "@request-target" "@scheme");alg="ed25519";expires=1618884773',
      ].join("\n"),
    );
    expect(presentation.algorithm).toBe("ed25519");
    expect(timestampNanos(presentation.expires!)).toBe(1618884773n * 1_000_000_000n);
  });
});

describe("selecting and refusing", () => {
  const input = 'sig=("@method");created=1618884473';
  const base = rfcRequest({});

  it("a request without a Signature header carries no credential", () => {
    expect(readMessageSignature(base, { components: ["@method"] })).toEqual({ status: "absent" });
  });

  it("a named label that is not present carries no credential; without one two signatures are malformed", () => {
    const two = rfcRequest({ "Signature-Input": `a=("@method"), b=("@method")`, Signature: "a=:AAAA:, b=:AAAA:" });
    expect(readMessageSignature(two, { label: "c", components: [] }).status).toBe("absent");
    expect(readMessageSignature(two, { components: [] }).status).toBe("malformed");
    expect(readMessageSignature(two, { label: "b", components: ["@method"] }).status).toBe("ok");
  });

  it("a signature covering less than required, or using an unsupported parameter, is malformed", () => {
    const request = rfcRequest({ "Signature-Input": input, Signature: "sig=:AAAA:" });
    expect(readMessageSignature(request, { components: ["@method", "@path"] })).toMatchObject({ status: "malformed" });
    const sf = rfcRequest({ "Signature-Input": 'sig=("content-type";sf)', Signature: "sig=:AAAA:" });
    expect(readMessageSignature(sf, { components: [] })).toMatchObject({ status: "malformed" });
  });

  it("a covered header the request lacks, and a Signature without Signature-Input, are malformed", () => {
    const missing = rfcRequest({ "Signature-Input": 'sig=("x-absent")', Signature: "sig=:AAAA:" });
    expect(readMessageSignature(missing, { components: [] })).toMatchObject({ status: "malformed" });
    expect(readMessageSignature(rfcRequest({ Signature: "sig=:AAAA:" }), { components: [] })).toMatchObject({ status: "malformed" });
  });

  it("a Signature that is not a byte sequence is malformed", () => {
    expect(readMessageSignature(rfcRequest({ "Signature-Input": input, Signature: "sig=abc" }), { components: [] })).toMatchObject({
      status: "malformed",
    });
  });
});

describe("Content-Digest", () => {
  const signed = (digest: string, requestBody: Uint8Array) => ({
    ...rfcRequest({ "Content-Digest": digest, "Signature-Input": 'sig=("content-digest")', Signature: "sig=:AAAA:" }),
    body: requestBody,
  });

  it("sha-512 matches the body", () => {
    expect(readMessageSignature(signed(DIGEST, body), { components: ["content-digest"], verifyContentDigest: true }).status).toBe("ok");
  });

  it("sha-256 matches the body", () => {
    const sha256 = "sha-256=:X48E9qOokqqrvdts8nOJRJN3OWDUoyWxBf7kbu9DBPE=:";
    expect(readMessageSignature(signed(sha256, new TextEncoder().encode('{"hello": "world"}')), { components: ["content-digest"], verifyContentDigest: true }).status).toBe("ok");
  });

  it("a changed body is malformed, and the reason never repeats the digest", () => {
    const reading = readMessageSignature(signed(DIGEST, new TextEncoder().encode('{"hello": "World"}')), { components: ["content-digest"], verifyContentDigest: true });
    expect(reading).toEqual({ status: "malformed", reason: "Content-Digest does not hold for the body (mismatch)" });
  });

  it("a covered digest is only a base line while verification is off", () => {
    const reading = readMessageSignature({ ...signed(DIGEST, body), body: null }, { components: [] });
    expect(reading.status).toBe("ok");
  });

  it("a covered digest is checked against the body when verification is on", () => {
    const wrong = new TextEncoder().encode('{"hello": "World"}');
    expect(readMessageSignature(signed(DIGEST, wrong), { components: [], verifyContentDigest: true })).toMatchObject({ status: "malformed" });
  });

  it("a digest in an algorithm this does not compute is malformed", () => {
    expect(readMessageSignature(signed("md5=:AAAA:", body), { components: ["content-digest"], verifyContentDigest: true })).toMatchObject({ status: "malformed" });
  });
});
