import { describe, expect, it } from "vitest";

import { accessTokenHash, base64Url, createDpopKey, signDpopProof } from "../dpop-proof";

function decode(part: string): Record<string, unknown> {
  const base64 = part.replace(/-/g, "+").replace(/_/g, "/");
  return JSON.parse(atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4))) as Record<string, unknown>;
}

function bytes(part: string): Uint8Array {
  const base64 = part.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4)), (c) => c.charCodeAt(0));
}

describe("a DPoP proof", () => {
  it("names the method, the URL without query or fragment, the time, the token's hash and the nonce, signed by the page key", async () => {
    const key = await createDpopKey();
    const proof = await signDpopProof(
      key,
      { method: "post", url: "https://runner.test/v1/sessions/s1/reload?app=api#x", accessToken: "at-1", nonce: "n-1" },
      1_700_000_000_500,
    );
    const [header, payload, signature] = proof.split(".");
    expect(decode(header!)).toEqual({ typ: "dpop+jwt", alg: "ES256", jwk: key.publicJwk });
    expect(key.publicJwk).not.toHaveProperty("d");
    const claims = decode(payload!);
    expect(claims).toEqual({
      jti: expect.any(String),
      htm: "POST",
      htu: "https://runner.test/v1/sessions/s1/reload",
      iat: 1_700_000_000,
      ath: await accessTokenHash("at-1"),
      nonce: "n-1",
    });
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("at-1")));
    expect(claims.ath).toBe(base64Url(digest));

    const publicKey = await crypto.subtle.importKey("jwk", key.publicJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    const verified = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      publicKey,
      bytes(signature!) as BufferSource,
      new TextEncoder().encode(`${header}.${payload}`),
    );
    expect(verified).toBe(true);
  });

  it("has a fresh jti every time, and no ath for a token request", async () => {
    const key = await createDpopKey();
    const first = decode((await signDpopProof(key, { method: "POST", url: "https://issuer.test/token" })).split(".")[1]!);
    const second = decode((await signDpopProof(key, { method: "POST", url: "https://issuer.test/token" })).split(".")[1]!);
    expect(first.jti).not.toBe(second.jti);
    expect(first).not.toHaveProperty("ath");
    expect(first).not.toHaveProperty("nonce");
  });
});
