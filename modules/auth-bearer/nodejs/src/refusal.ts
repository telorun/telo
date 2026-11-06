/** Why an access token was refused; the closed list `docs/refusals.md` documents. */
export type RefusalReason =
  | "malformed"
  | "algorithm"
  | "unknownKey"
  | "signature"
  | "expired"
  | "notBefore"
  | "issuer"
  | "audience"
  | "type"
  | "claims"
  | "inactive"
  | "revoked"
  | "dpopRequired"
  | "dpopInvalid"
  | "dpopReplayed"
  | "confirmationMismatch";

export interface Refusal {
  refused: true;
  reason: RefusalReason;
  challenge: { scheme: string; parameters: Record<string, string> };
}

/** The DPoP challenge a refusal carries when the token is, or must be, DPoP-bound. */
export interface DpopChallenge {
  algorithms: string[];
}

// Fixed texts: a challenge says which check failed, never what the token held.
const DESCRIPTIONS: Record<RefusalReason, string> = {
  malformed: "The access token is malformed",
  algorithm: "The access token is signed with an algorithm that is not accepted",
  unknownKey: "The access token is signed with a key that is not trusted",
  signature: "The access token signature is invalid",
  expired: "The access token has expired",
  notBefore: "The access token is not yet valid",
  issuer: "The access token was issued by an issuer that is not accepted",
  audience: "The access token is not for this resource",
  type: "The access token has the wrong type",
  claims: "The access token lacks a required claim or carries an invalid one",
  inactive: "The access token is not active",
  revoked: "The access token has been revoked",
  dpopRequired: "The access token must be bound to a DPoP key",
  dpopInvalid: "The DPoP proof is missing or invalid",
  dpopReplayed: "The DPoP proof has already been used",
  confirmationMismatch: "The access token is not bound to the presenter's key or certificate",
};

const DPOP_ERRORS: ReadonlySet<RefusalReason> = new Set(["dpopInvalid", "dpopReplayed"]);

export function refuse(reason: RefusalReason, dpop: DpopChallenge | null): Refusal {
  const parameters: Record<string, string> = {
    error: DPOP_ERRORS.has(reason) ? "invalid_dpop_proof" : "invalid_token",
    error_description: DESCRIPTIONS[reason],
  };
  if (dpop) parameters.algs = dpop.algorithms.join(" ");
  return { refused: true, reason, challenge: { scheme: dpop ? "DPoP" : "Bearer", parameters } };
}

/**
 * The challenges this verifier publishes in its reading, for a transport asking
 * a request that presented no token: `Bearer`, plus `DPoP` with the accepted
 * proof algorithms when DPoP proofs are verified.
 */
export function publishedChallenges(dpop: DpopChallenge | null): Array<{ scheme: string; parameters: Record<string, string> }> {
  const challenges = [{ scheme: "Bearer", parameters: {} as Record<string, string> }];
  if (dpop) challenges.push({ scheme: "DPoP", parameters: { algs: dpop.algorithms.join(" ") } });
  return challenges;
}
