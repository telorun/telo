import { base64UrlEncode, randomToken } from "@/base64url";

/** The key a token is bound to (RFC 9449). The private half cannot be exported,
 *  so a token read out of the page is useless anywhere else. It lives in memory
 *  only: every page load authorizes again and binds its token to a new key. */
export interface DpopKey {
  privateKey: CryptoKey;
  publicJwk: { kty: string; crv: string; x: string; y: string };
}

export async function generateDpopKey(): Promise<DpopKey> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, [
    "sign",
  ]);
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  if (!jwk.kty || !jwk.crv || !jwk.x || !jwk.y) {
    throw new Error("The browser generated a DPoP key without its public coordinates.");
  }
  return { privateKey: pair.privateKey, publicJwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y } };
}

function segment(value: object): string {
  return base64UrlEncode(new TextEncoder().encode(JSON.stringify(value)));
}

/** A proof for one request. `url` is sent without its query and fragment. */
export async function dpopProof(
  key: DpopKey,
  request: { method: string; url: string; nonce?: string },
): Promise<string> {
  const target = new URL(request.url);
  target.search = "";
  target.hash = "";
  const header = segment({ typ: "dpop+jwt", alg: "ES256", jwk: key.publicJwk });
  const payload = segment({
    jti: randomToken(),
    htm: request.method.toUpperCase(),
    htu: target.href,
    iat: Math.floor(Date.now() / 1000),
    ...(request.nonce ? { nonce: request.nonce } : {}),
  });
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key.privateKey,
    new TextEncoder().encode(`${header}.${payload}`),
  );
  return `${header}.${payload}.${base64UrlEncode(new Uint8Array(signature))}`;
}
