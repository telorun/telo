import { createHash, generateKeyPairSync, randomUUID, sign, type JsonWebKey } from "node:crypto";
import * as http from "node:http";
import type { AddressInfo } from "node:net";

import type { ProtectedResourceMetadata } from "@telorun/runner-protocol";
import type { RunnerCredentialAnswer, RunnerCredentialProvider, RunnerCredentialRequest } from "@telorun/share-tunnel";

/** A credential provider holding a generated ES256 key, as a sign-in would: opaque tokens, real RFC 9449 proofs. */
export class TestCredentialProvider implements RunnerCredentialProvider {
  readonly requests: RunnerCredentialRequest[] = [];
  private readonly keys = generateKeyPairSync("ec", { namedCurve: "P-256" });
  private readonly jwk: JsonWebKey = this.keys.publicKey.export({ format: "jwk" });

  async credential(request: RunnerCredentialRequest): Promise<RunnerCredentialAnswer> {
    this.requests.push(request);
    const accessToken = "test-access-token";
    return {
      outcome: "credential",
      credential: {
        accessToken,
        expiresAt: new Date(Date.now() + 600_000),
        proof: async ({ htm, htu }) => {
          const header = Buffer.from(JSON.stringify({ typ: "dpop+jwt", alg: "ES256", jwk: this.jwk })).toString("base64url");
          const ath = createHash("sha256").update(accessToken, "ascii").digest("base64url");
          const payload = Buffer.from(JSON.stringify({ jti: randomUUID(), htm, htu, iat: Math.floor(Date.now() / 1000), ath })).toString("base64url");
          const signature = sign("sha256", Buffer.from(`${header}.${payload}`), { key: this.keys.privateKey, dsaEncoding: "ieee-p1363" });
          return `${header}.${payload}.${signature.toString("base64url")}`;
        },
      },
    };
  }
}

export interface RecordedRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: unknown;
}

export interface FakeRunnerOptions {
  /** `features.shares` of `/v1/capabilities`; absent offers no shares. */
  shares?: { maxPerOwner: number; maxConnectedPerOwner: number; retentionSeconds: number };
  /** Answers one request; the default serves the share routes from `shareList`. */
  respond?: (request: RecordedRequest) => { status: number; body?: unknown } | undefined;
  /** The RFC 9728 identity it advertises, given its own URL; `null` advertises none.
   *  The default names the runner itself, the default accounts issuer and ES256. */
  identity?: ((url: string) => ProtectedResourceMetadata) | null;
}

/** The identity a runner at `url` advertises when it trusts `issuer`. */
export function runnerIdentity(url: string, issuer = "https://accounts.telo.run"): ProtectedResourceMetadata {
  return { resource: url, authorization_servers: [issuer], dpop_bound_access_tokens_required: true, dpop_signing_alg_values_supported: ["ES256"] };
}

/** A runner of `/v1` on loopback answering capabilities, shares, and whatever `respond` takes over. */
export class FakeRunner {
  readonly url: string;

  private constructor(
    private readonly server: http.Server,
    port: number,
    readonly requests: RecordedRequest[],
  ) {
    this.url = `http://127.0.0.1:${port}`;
  }

  static async start(options: FakeRunnerOptions = {}): Promise<FakeRunner> {
    const requests: RecordedRequest[] = [];
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const text = Buffer.concat(chunks).toString();
        const recorded: RecordedRequest = { method: req.method!, url: req.url!, headers: req.headers, body: text ? JSON.parse(text) : undefined };
        requests.push(recorded);
        const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        const identity = options.identity === null ? undefined : (options.identity ?? runnerIdentity)(url);
        const answer = recorded.url === "/v1/capabilities"
          ? { status: 200, body: { displayName: "fake", description: "", config: { schema: {} }, features: { io: [], ports: false, ...(options.shares ? { shares: options.shares } : {}) }, ...(identity ? { identity } : {}) } }
          : recorded.url === "/.well-known/oauth-protected-resource" && identity
            ? { status: 200, body: identity }
            : options.respond?.(recorded) ?? { status: 404, body: { error: "not_found", message: "no such route" } };
        res.writeHead(answer.status, { "content-type": "application/json" });
        res.end(answer.body === undefined ? undefined : JSON.stringify(answer.body));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return new FakeRunner(server, (server.address() as AddressInfo).port, requests);
  }

  async close(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}
