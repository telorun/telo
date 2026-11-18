// A runner credential provider holding a generated ES256 key, as a sign-in
// would: tokens are opaque strings, proofs real RFC 9449 JWTs.

import { createHash, createPublicKey, generateKeyPairSync, randomUUID, sign, verify, type JsonWebKey } from "node:crypto";

import type {
  DpopProofRequest,
  RunnerCredentialAnswer,
  RunnerCredentialProvider,
  RunnerCredentialRequest,
} from "../../src/index.js";

export type ProviderMode = "credential" | "sign-in-required" | "unavailable";

export class TestCredentialProvider implements RunnerCredentialProvider {
  mode: ProviderMode = "credential";
  readonly requests: RunnerCredentialRequest[] = [];
  readonly issued: Array<{ accessToken: string; expiresAt: Date }> = [];

  private readonly keys = generateKeyPairSync("ec", { namedCurve: "P-256" });
  private readonly jwk: JsonWebKey = this.keys.publicKey.export({ format: "jwk" });
  private current: { accessToken: string; expiresAt: Date } | undefined;

  constructor(private readonly lifetimeMs = 10 * 60_000) {}

  async credential(request: RunnerCredentialRequest): Promise<RunnerCredentialAnswer> {
    this.requests.push(request);
    if (this.mode === "sign-in-required") {
      return { outcome: "sign-in-required", runnerUrl: request.runnerUrl, command: `telo auth login --runner ${request.runnerUrl}` };
    }
    if (this.mode === "unavailable") return { outcome: "unavailable", message: "the token endpoint answered 503" };
    if (this.current === undefined || this.current.expiresAt.getTime() - Date.now() < request.minLifetimeMs) {
      this.current = { accessToken: `token-${this.issued.length + 1}`, expiresAt: new Date(Date.now() + this.lifetimeMs) };
      this.issued.push(this.current);
    }
    const { accessToken, expiresAt } = this.current;
    return {
      outcome: "credential",
      credential: { accessToken, expiresAt, proof: async (proofRequest) => this.proof(accessToken, proofRequest) },
    };
  }

  private proof(accessToken: string, request: DpopProofRequest): string {
    const header = { typ: "dpop+jwt", alg: "ES256", jwk: this.jwk };
    const payload = {
      jti: randomUUID(),
      htm: request.htm,
      htu: request.htu,
      iat: Math.floor(Date.now() / 1000),
      ath: tokenHash(accessToken),
      ...(request.nonce === undefined ? {} : { nonce: request.nonce }),
    };
    const signingInput = `${encode(header)}.${encode(payload)}`;
    const signature = sign("sha256", Buffer.from(signingInput), { key: this.keys.privateKey, dsaEncoding: "ieee-p1363" });
    return `${signingInput}.${signature.toString("base64url")}`;
  }
}

export interface ReadProof {
  header: { typ: string; alg: string; jwk: JsonWebKey };
  payload: { jti: string; htm: string; htu: string; iat: number; ath: string };
  signed: boolean;
}

/** A proof's parts, and whether its signature holds for the key it carries. */
export function readProof(proof: string): ReadProof {
  const [header, payload, signature] = proof.split(".");
  const parsed = {
    header: JSON.parse(Buffer.from(header!, "base64url").toString()) as ReadProof["header"],
    payload: JSON.parse(Buffer.from(payload!, "base64url").toString()) as ReadProof["payload"],
  };
  const key = createPublicKey({ key: parsed.header.jwk, format: "jwk" });
  const signed = verify("sha256", Buffer.from(`${header}.${payload}`), { key, dsaEncoding: "ieee-p1363" }, Buffer.from(signature!, "base64url"));
  return { ...parsed, signed };
}

export function tokenHash(accessToken: string): string {
  return createHash("sha256").update(accessToken, "ascii").digest("base64url");
}

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}
