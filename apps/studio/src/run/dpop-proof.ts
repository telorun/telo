/**
 * RFC 9449 proofs of possession. The private half is generated
 * non-extractable: no script can read it, so a token bound to it is worthless
 * anywhere else. Where the key lives is `dpop-key-store.ts`.
 */

export interface DpopPublicJwk {
  kty: "EC";
  crv: "P-256";
  x: string;
  y: string;
}

export interface DpopKey {
  readonly publicJwk: DpopPublicJwk;
  /** An ES256 signature over `data`, in the JWS form (r ‖ s). */
  sign(data: Uint8Array): Promise<Uint8Array>;
}

export interface DpopKeyPair {
  /** Non-extractable, usable for `sign` only. */
  privateKey: CryptoKey;
  publicJwk: DpopPublicJwk;
}

export async function generateDpopKeyPair(): Promise<DpopKeyPair> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  const exported = await crypto.subtle.exportKey("jwk", pair.publicKey);
  if (typeof exported.x !== "string" || typeof exported.y !== "string") {
    throw new Error("The browser exported a DPoP public key with no coordinates.");
  }
  return { privateKey: pair.privateKey, publicJwk: { kty: "EC", crv: "P-256", x: exported.x, y: exported.y } };
}

export function dpopKeyOf({ privateKey, publicJwk }: DpopKeyPair): DpopKey {
  return {
    publicJwk,
    async sign(data) {
      // WebCrypto's ECDSA signature is already r ‖ s, which is what JWS wants.
      const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, data as BufferSource);
      return new Uint8Array(signature);
    },
  };
}

/** A key kept nowhere. */
export async function createDpopKey(): Promise<DpopKey> {
  return dpopKeyOf(await generateDpopKeyPair());
}

export interface DpopProofRequest {
  method: string;
  /** The request's URL; its query and fragment are not part of `htu`. */
  url: string;
  /** Present on a request to a resource: the proof then names the token. */
  accessToken?: string;
  /** A nonce the server handed out (`DPoP-Nonce`). */
  nonce?: string;
}

/** `htu`: the request URL without query and fragment, as written. */
export function dpopHtu(url: string): string {
  const end = url.search(/[?#]/);
  return end === -1 ? url : url.slice(0, end);
}

/** One proof. Each call has its own `jti` and `iat`, so a retry is never a
 *  replay. */
export async function signDpopProof(key: DpopKey, request: DpopProofRequest, now = Date.now()): Promise<string> {
  const header = { typ: "dpop+jwt", alg: "ES256", jwk: key.publicJwk };
  const payload: Record<string, unknown> = {
    jti: crypto.randomUUID(),
    htm: request.method.toUpperCase(),
    htu: dpopHtu(request.url),
    iat: Math.floor(now / 1000),
  };
  if (request.accessToken !== undefined) payload.ath = await accessTokenHash(request.accessToken);
  if (request.nonce !== undefined) payload.nonce = request.nonce;
  const signingInput = `${base64UrlText(JSON.stringify(header))}.${base64UrlText(JSON.stringify(payload))}`;
  const signature = await key.sign(new TextEncoder().encode(signingInput));
  return `${signingInput}.${base64Url(signature)}`;
}

/** `ath`: the base64url SHA-256 of the access token's ASCII. */
export async function accessTokenHash(accessToken: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(accessToken));
  return base64Url(new Uint8Array(digest));
}

function base64UrlText(text: string): string {
  return base64Url(new TextEncoder().encode(text));
}

export function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
