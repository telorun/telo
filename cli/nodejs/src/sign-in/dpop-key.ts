import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, sign, type KeyObject } from "node:crypto";

/** An ES256 key as `credentials.json` keeps it: the private JWK. */
export interface DpopPrivateJwk {
  kty: "EC";
  crv: "P-256";
  x: string;
  y: string;
  d: string;
}

/** What one RFC 9449 proof is for. */
export interface DpopProofFor {
  htm: string;
  /** The request URL; query and fragment are dropped. */
  htu: string;
  /** Present on a request to a resource: the proof then names the token (`ath`). */
  accessToken?: string;
  nonce?: string;
}

/** The key a sign-in's tokens are bound to. */
export class DpopKey {
  private readonly privateKey: KeyObject;
  private readonly publicJwk: { kty: "EC"; crv: "P-256"; x: string; y: string };

  private constructor(readonly jwk: DpopPrivateJwk) {
    this.privateKey = createPrivateKey({ key: { ...jwk }, format: "jwk" });
    this.publicJwk = { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y };
  }

  /** A fresh key, generated at login. */
  static generate(): DpopKey {
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    return new DpopKey(privateKey.export({ format: "jwk" }) as DpopPrivateJwk);
  }

  /** The key a stored record holds; throws when the JWK is not an ES256 private key. */
  static fromJwk(jwk: DpopPrivateJwk): DpopKey {
    const key = new DpopKey(jwk);
    const derived = createPublicKey(key.privateKey).export({ format: "jwk" });
    if (derived.x !== jwk.x || derived.y !== jwk.y) throw new Error("the DPoP key's public half does not match its private half");
    return key;
  }

  /** The RFC 7638 thumbprint, sent as `dpop_jkt`. */
  thumbprint(): string {
    const { crv, kty, x, y } = this.publicJwk;
    return createHash("sha256").update(JSON.stringify({ crv, kty, x, y })).digest("base64url");
  }

  /** One proof: its own `jti` and `iat` now, so a resend is never a replay. */
  proof(request: DpopProofFor): string {
    const header = { typ: "dpop+jwt", alg: "ES256", jwk: this.publicJwk };
    const payload: Record<string, unknown> = {
      jti: randomUUID(),
      htm: request.htm.toUpperCase(),
      htu: request.htu.replace(/[?#].*$/s, ""),
      iat: Math.floor(Date.now() / 1000),
    };
    if (request.accessToken !== undefined) payload.ath = createHash("sha256").update(request.accessToken, "ascii").digest("base64url");
    if (request.nonce !== undefined) payload.nonce = request.nonce;
    const input = `${base64UrlJson(header)}.${base64UrlJson(payload)}`;
    const signature = sign("sha256", Buffer.from(input), { key: this.privateKey, dsaEncoding: "ieee-p1363" });
    return `${input}.${signature.toString("base64url")}`;
  }
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}
