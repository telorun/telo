import type { IdentityConfig } from "../config.js";
import type { SessionStore } from "../session-store/session-store.js";
import { verifyAccessToken } from "./access-token-verification.js";
import { verifyDpopProof } from "./dpop-proof.js";
import { IdentityRefusal } from "./identity-refusal.js";
import { IssuerKeys } from "./issuer-keys.js";
import { dpopChallenge, protectedResourceMetadataUrl } from "./protected-resource-metadata.js";

export interface IdentityVerifierDeps {
  config: IdentityConfig;
  /** Holds every seen proof `jti` for its window, across restarts. */
  store: SessionStore;
  log: { warn(obj: unknown, msg: string): void };
  fetch?: typeof fetch;
  now?: () => number;
}

/** The parts of a request an identity is judged from. */
export interface IdentityRequest {
  method: string;
  /** The request target as the runner received it, query included. */
  url: string;
  headers: Record<string, string | string[] | undefined>;
}

/**
 * Who a request carrying `Authorization: DPoP <token>` and a `DPoP` proof is:
 * the token's `(iss, sub)`, once the token, the proof and the proof's
 * freshness all hold.
 */
export class IdentityVerifier {
  readonly metadataUrl: string;
  private readonly keys: IssuerKeys;
  private readonly now: () => number;

  constructor(private readonly deps: IdentityVerifierDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.metadataUrl = protectedResourceMetadataUrl(deps.config.audience);
    this.keys = new IssuerKeys({ fetch: deps.fetch ?? fetch, now: this.now, log: deps.log });
  }

  /** `WWW-Authenticate` for a 401, with the refusal's error when there is one. */
  challenge(refusal?: IdentityRefusal): string {
    return dpopChallenge(
      this.metadataUrl,
      refusal ? { code: refusal.code, description: refusal.message } : undefined,
    );
  }

  /** Throws `IdentityRefusal` or `IdentityProviderUnavailable`. */
  async verify(request: IdentityRequest, accessToken: string): Promise<{ iss: string; sub: string }> {
    const proof = singleProof(request.headers.dpop);
    const token = await verifyAccessToken(accessToken, {
      audience: this.deps.config.audience,
      issuers: this.deps.config.issuers,
      keys: this.keys,
      now: this.now,
    });
    const path = request.url.split("?", 1)[0]!;
    const verified = await verifyDpopProof(proof, {
      method: request.method,
      htu: this.deps.config.audience + path,
      accessToken,
      jkt: token.jkt,
      now: this.now,
    });
    // Keyed by the binding key too: a `jti` is unique per key, not globally.
    const fresh = await this.deps.store.recordJti(
      `${token.jkt}.${verified.jti}`,
      verified.replayableUntil,
      new Date(this.now()),
    );
    if (!fresh) throw new IdentityRefusal("invalid_dpop_proof", "the DPoP proof's 'jti' was already used");
    return { iss: token.iss, sub: token.sub };
  }
}

function singleProof(header: string | string[] | undefined): string {
  if (header === undefined || (typeof header === "string" && header.trim() === "")) {
    throw new IdentityRefusal(
      "invalid_dpop_proof",
      "the request carries a DPoP access token and no `DPoP` proof header",
    );
  }
  // Repeated headers arrive joined by commas, which a compact JWT never holds.
  if (Array.isArray(header) || header.includes(",")) {
    throw new IdentityRefusal("invalid_dpop_proof", "the request carries more than one `DPoP` proof");
  }
  return header.trim();
}
