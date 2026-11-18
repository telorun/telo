// An issuer and the DPoP credentials of its users, real enough for the runner's
// identity verifier: RFC 9068 access tokens signed by a published key, bound to
// an ES256 key that signs every RFC 9449 proof. Discovery and keys are answered
// in memory by `fetch`.

import { createHash, randomUUID } from "node:crypto";

import type {
  DpopProofRequest,
  RunnerCredentialAnswer,
  RunnerCredentialProvider,
  RunnerCredentialRequest,
} from "@telorun/share-tunnel";
import { calculateJwkThumbprint, exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JWK } from "jose";

import type { IdentityConfig } from "../config.js";

export const TEST_AUDIENCE = "https://runner.share.test";
export const TEST_ISSUER = "https://id.share.test";
export const TEST_IDENTITY: IdentityConfig = { audience: TEST_AUDIENCE, issuers: [TEST_ISSUER] };

interface Key {
  privateKey: CryptoKey;
  jwk: JWK;
}

async function es256(kid?: string): Promise<Key> {
  const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
  const jwk = await exportJWK(publicKey);
  return { privateKey, jwk: kid ? { ...jwk, kid, alg: "ES256", use: "sig" } : jwk };
}

export class TestIssuer {
  /** Answers the issuer's RFC 8414 metadata and its key set. */
  readonly fetch: typeof fetch = async (input) => {
    const url = String(input);
    if (url === `${TEST_ISSUER}/.well-known/oauth-authorization-server`) {
      return Response.json({ issuer: TEST_ISSUER, jwks_uri: `${TEST_ISSUER}/jwks` });
    }
    if (url === `${TEST_ISSUER}/jwks`) return Response.json({ keys: [this.key.jwk] });
    return new Response("not found", { status: 404 });
  };

  private constructor(private readonly key: Key) {}

  static async create(): Promise<TestIssuer> {
    return new TestIssuer(await es256("issuer-key"));
  }

  /** A user signed in as `sub`, holding a DPoP key of its own. */
  async user(sub: string, options: { lifetimeMs?: number } = {}): Promise<TestUser> {
    const dpop = await es256();
    return new TestUser(this, sub, dpop, await calculateJwkThumbprint(dpop.jwk, "sha256"), options.lifetimeMs ?? 10 * 60_000);
  }

  async accessToken(sub: string, jkt: string, expiresAt: Date): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({ iss: TEST_ISSUER, aud: TEST_AUDIENCE, iat: now, exp: Math.floor(expiresAt.getTime() / 1000), sub, cnf: { jkt } })
      .setProtectedHeader({ alg: "ES256", typ: "at+jwt", kid: "issuer-key" })
      .sign(this.key.privateKey);
  }
}

/** One signed-in user: the credential provider a share tunnel asks. */
export class TestUser implements RunnerCredentialProvider {
  /** Every access token handed out, in order. */
  readonly issued: Array<{ accessToken: string; expiresAt: Date }> = [];
  private current: { accessToken: string; expiresAt: Date } | undefined;

  constructor(
    private readonly issuer: TestIssuer,
    readonly sub: string,
    private readonly dpop: Key,
    private readonly jkt: string,
    /** How long each token lives. */
    public lifetimeMs: number,
  ) {}

  async credential(request: RunnerCredentialRequest): Promise<RunnerCredentialAnswer> {
    if (this.current === undefined || this.current.expiresAt.getTime() - Date.now() < Math.min(request.minLifetimeMs, this.lifetimeMs / 2)) {
      this.current = await this.token();
    }
    const { accessToken, expiresAt } = this.current;
    return {
      outcome: "credential",
      credential: { accessToken, expiresAt, proof: (proofRequest) => this.proof(accessToken, proofRequest) },
    };
  }

  /** A fresh access token. */
  async token(): Promise<{ accessToken: string; expiresAt: Date }> {
    const expiresAt = new Date(Date.now() + this.lifetimeMs);
    const token = { accessToken: await this.issuer.accessToken(this.sub, this.jkt, expiresAt), expiresAt };
    this.issued.push(token);
    return token;
  }

  /** A proof for `request`, bound to `accessToken`. */
  proof(accessToken: string, request: DpopProofRequest): Promise<string> {
    return new SignJWT({
      jti: randomUUID(),
      htm: request.htm,
      htu: request.htu,
      iat: Math.floor(Date.now() / 1000),
      ath: createHash("sha256").update(accessToken, "ascii").digest("base64url"),
    })
      .setProtectedHeader({ alg: "ES256", typ: "dpop+jwt", jwk: this.dpop.jwk })
      .sign(this.dpop.privateKey);
  }
}
