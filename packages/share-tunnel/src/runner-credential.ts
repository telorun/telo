// The runner credential provider: the one port through which the tunnel engine
// obtains a DPoP-bound access token and its proofs. The engine reads no file and
// no environment, holds no key and never decodes a token; whoever owns the
// sign-in implements this.

/** What the caller asks for. */
export interface RunnerCredentialRequest {
  /** The runner the credential is for, as the user named it. */
  runnerUrl: string;
  /**
   * The least remaining lifetime the caller needs, in milliseconds. A provider
   * holding a token that expires sooner refreshes it first.
   */
  minLifetimeMs: number;
  /** Aborted when the caller no longer wants the answer. */
  signal: AbortSignal;
}

/** What one DPoP proof is for (RFC 9449 §4.2). */
export interface DpopProofRequest {
  /** The request method. */
  htm: string;
  /** The request URL, without query and fragment. */
  htu: string;
  /** A nonce the server supplied, when it supplied one. */
  nonce?: string;
}

/** A DPoP-bound access token the caller may present. */
export interface RunnerCredential {
  /** Opaque to the caller. */
  accessToken: string;
  /** When the token expires, as the token response said. */
  expiresAt: Date;
  /**
   * A fresh proof on every call — a new `jti`, `iat` now, `ath` the hash of
   * this credential's `accessToken` — signed by the key the token is bound to.
   */
  proof(request: DpopProofRequest): Promise<string>;
}

/**
 * One answer per call, as data. A provider makes one attempt per call; the
 * caller decides whether and when to ask again. A token request whose answer was
 * lost is settled within that same attempt, never left to the caller's next one.
 * It rejects only when the request's signal is aborted.
 */
export type RunnerCredentialAnswer =
  | { outcome: "credential"; credential: RunnerCredential }
  /** No usable grant: the user has to sign in. Asking again cannot help until they do. */
  | { outcome: "sign-in-required"; runnerUrl: string; command: string }
  /** The provider could not answer this time (the token endpoint is unreachable, say); asking again may. */
  | { outcome: "unavailable"; message: string };

export interface RunnerCredentialProvider {
  credential(request: RunnerCredentialRequest): Promise<RunnerCredentialAnswer>;
}
