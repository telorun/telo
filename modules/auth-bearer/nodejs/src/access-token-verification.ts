import type { KvStore } from "@telorun/kv-store";
import type { ResourceContext } from "@telorun/sdk";
import { isRecord } from "./claim-readers.js";
import { checkDpopProof, sha256Base64Url } from "./dpop-proof.js";
import { isRevoked } from "./revocation.js";
import { refuse, type DpopChallenge, type Refusal } from "./refusal.js";
import { buildPrincipal, ClaimsUnreadable } from "./principal-mapping.js";
import type { AccessTokenSettings } from "./access-token-settings.js";
import { RuntimeError } from "@telorun/sdk";

export interface Confirmation {
  certificateThumbprint?: string;
  dpop?: { proof: string; method: string; uri: string };
}

/** What a verifier established about a token before the checks they share. */
export interface VerifiedToken {
  token: string;
  claims: Record<string, unknown>;
  issuer: string;
}

export function isKvStore(value: unknown): value is KvStore {
  const candidate = value as KvStore | undefined;
  return (
    !!candidate &&
    typeof candidate.get === "function" &&
    typeof candidate.putIfAbsent === "function" &&
    typeof candidate.compareAndSet === "function" &&
    typeof candidate.compareAndDelete === "function"
  );
}

/** The challenge scheme a refusal before the token's claims are known uses. */
export function defaultChallenge(settings: AccessTokenSettings): DpopChallenge | null {
  return settings.dpop?.required ? { algorithms: settings.dpop.algorithms } : null;
}

/**
 * The checks every access-token verifier shares, on claims already proven
 * genuine: revocation, then the confirmation the token carries (certificate
 * thumbprint, DPoP key), then the principal, and last — so a refused token
 * never uses up a proof — the DPoP replay record.
 */
export async function completeVerification(
  ctx: ResourceContext,
  settings: AccessTokenSettings,
  verified: VerifiedToken,
  confirmation: Confirmation,
  nowMs: number,
) {
  const { claims, token } = verified;
  const cnf = claims.cnf;
  if (cnf !== undefined && !isRecord(cnf)) return refuse("claims", defaultChallenge(settings));
  const jkt = cnf?.jkt;
  const thumbprint = cnf?.["x5t#S256"];
  if ((jkt !== undefined && typeof jkt !== "string") || (thumbprint !== undefined && typeof thumbprint !== "string")) {
    return refuse("claims", defaultChallenge(settings));
  }
  const dpop = settings.dpop;
  const dpopChallenge: DpopChallenge | null =
    dpop && (dpop.required || jkt !== undefined) ? { algorithms: dpop.algorithms } : null;

  if (settings.revocationStore !== undefined) {
    const jti = claims.jti;
    if (typeof jti !== "string" || jti === "") return refuse("claims", dpopChallenge);
    const store = ctx.resolveRef(
      settings.revocationStore,
      isKvStore,
      () => `${settings.describe}: 'revocation.store'`,
      "KvStore.Store",
    );
    if (await isRevoked(store, jti)) return refuse("revoked", dpopChallenge);
  }

  if (thumbprint !== undefined || settings.certificateBound) {
    if (thumbprint === undefined || thumbprint !== confirmation.certificateThumbprint) {
      return refuse("confirmationMismatch", dpopChallenge);
    }
  }

  if (dpop?.required && jkt === undefined) return refuse("dpopRequired", dpopChallenge);
  if (jkt !== undefined && !dpop) return refuse("confirmationMismatch", null);

  let proofId: string | null = null;
  if (jkt !== undefined) {
    if (!confirmation.dpop) return refuse("dpopInvalid", dpopChallenge);
    const outcome = await checkDpopProof(confirmation.dpop, token, jkt, dpop!, nowMs);
    if (!outcome.valid) return refuse("dpopInvalid", dpopChallenge);
    proofId = sha256Base64Url(`${outcome.jkt}.${outcome.jti}`);
  }

  let principal;
  try {
    principal = buildPrincipal(ctx, settings, claims, verified.issuer);
  } catch (err) {
    if (err instanceof ClaimsUnreadable) return refuse("claims", dpopChallenge);
    throw err;
  }

  if (proofId !== null) {
    const replay = ctx.resolveRef(
      dpop!.replay,
      isKvStore,
      () => `${settings.describe}: 'confirmation.dpop.replay'`,
      "KvStore.Store",
    );
    // A proof is acceptable for as long as its `iat` is, in either direction.
    const recorded = await replay.putIfAbsent(`auth-bearer:dpop-proof:${proofId}`, 1, dpop!.maxProofAgeMs * 2);
    if (recorded === null) return refuse("dpopReplayed", dpopChallenge);
  }
  return { principal };
}

/** The audiences a token must be for: the `audience` setting evaluated over `resource`. */
export function resolveAudience(
  ctx: ResourceContext,
  settings: AccessTokenSettings,
  resource: string | null,
): string[] {
  const value = ctx.expandValue(settings.audience, { resource: resource ?? "" });
  const list = typeof value === "string" ? [value] : value;
  if (!Array.isArray(list) || !list.every((entry) => typeof entry === "string")) {
    throw new RuntimeError(
      "ERR_AUTH_BEARER_AUDIENCE_INVALID",
      `${settings.describe}: 'audience' must evaluate to a string or a list of strings.`,
    );
  }
  // An empty entry is a transport with no resource; it names no audience.
  return list.filter((entry) => entry !== "");
}

export type CompletedVerification = Refusal | { principal: unknown };
