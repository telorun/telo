import { createLocalJWKSet, type JSONWebKeySet } from "jose";

import { IdentityProviderUnavailable } from "./identity-refusal.js";

/** A cached key set is refetched once it is this old. */
const KEY_SET_MAX_AGE_MS = 10 * 60_000;
/** An unknown `kid` refetches the key set at most this often per issuer. */
const UNKNOWN_KEY_REFETCH_MS = 30_000;
/** After a failed fetch, the issuer is not asked again for this long. */
const FAILED_FETCH_RETRY_MS = 5_000;
const FETCH_TIMEOUT_MS = 5_000;

export type KeySetLookup = ReturnType<typeof createLocalJWKSet>;

export interface IssuerKeysDeps {
  fetch: typeof fetch;
  now: () => number;
  log: { warn(obj: unknown, msg: string): void };
}

interface IssuerState {
  keys?: { lookup: KeySetLookup; fetchedAt: number };
  attemptedAt?: number;
  failure?: IdentityProviderUnavailable;
  inflight?: Promise<void>;
}

/**
 * Each configured issuer's signing keys, found through RFC 8414 discovery (then
 * OIDC discovery) and cached per issuer. A stale set is refreshed on use; when
 * the refresh fails the stale set keeps answering, and only an issuer with no
 * set at all is unavailable.
 */
export class IssuerKeys {
  private readonly issuers = new Map<string, IssuerState>();

  constructor(private readonly deps: IssuerKeysDeps) {}

  /** The issuer's key set, fetched when absent or stale. */
  async lookup(issuer: string): Promise<KeySetLookup> {
    const state = this.state(issuer);
    const now = this.deps.now();
    const fresh = state.keys && now - state.keys.fetchedAt < KEY_SET_MAX_AGE_MS;
    const backingOff =
      state.failure !== undefined &&
      state.attemptedAt !== undefined &&
      now - state.attemptedAt < FAILED_FETCH_RETRY_MS;
    if (!fresh && !backingOff) await this.refresh(issuer, state);
    if (state.keys) return state.keys.lookup;
    throw state.failure!;
  }

  /**
   * A token named a key the cached set lacks: refetch, at most once per
   * interval. The refreshed set, or undefined when the interval forbids it. A
   * failed refetch is unavailability: the set in hand cannot decide the token.
   */
  async refreshForUnknownKey(issuer: string): Promise<KeySetLookup | undefined> {
    const state = this.state(issuer);
    if (state.attemptedAt !== undefined && this.deps.now() - state.attemptedAt < UNKNOWN_KEY_REFETCH_MS) {
      return undefined;
    }
    await this.refresh(issuer, state);
    if (state.failure) throw state.failure;
    return state.keys!.lookup;
  }

  private state(issuer: string): IssuerState {
    let state = this.issuers.get(issuer);
    if (!state) {
      state = {};
      this.issuers.set(issuer, state);
    }
    return state;
  }

  private refresh(issuer: string, state: IssuerState): Promise<void> {
    state.inflight ??= (async () => {
      state.attemptedAt = this.deps.now();
      try {
        const lookup = await this.fetchKeySet(issuer);
        state.keys = { lookup, fetchedAt: this.deps.now() };
        state.failure = undefined;
      } catch (err) {
        if (!(err instanceof IdentityProviderUnavailable)) throw err;
        state.failure = err;
        this.deps.log.warn(
          { issuer, err: err.message, cached: state.keys !== undefined },
          state.keys
            ? "the issuer's keys could not be refreshed; the cached set keeps answering"
            : "the issuer's keys could not be fetched",
        );
      }
    })().finally(() => {
      state.inflight = undefined;
    });
    return state.inflight;
  }

  private async fetchKeySet(issuer: string): Promise<KeySetLookup> {
    const metadata = await this.discover(issuer);
    if (metadata.issuer !== issuer) {
      throw new IdentityProviderUnavailable(
        issuer,
        `the issuer's metadata names issuer '${String(metadata.issuer)}', not '${issuer}'`,
      );
    }
    const jwksUri = metadata.jwks_uri;
    if (typeof jwksUri !== "string" || !jwksUri.startsWith("https://")) {
      throw new IdentityProviderUnavailable(
        issuer,
        `the issuer's metadata carries no https 'jwks_uri'`,
      );
    }
    const response = await this.get(issuer, jwksUri);
    if (!response.ok) {
      throw new IdentityProviderUnavailable(issuer, `${jwksUri} answered ${response.status}`);
    }
    const jwks = await this.json(issuer, jwksUri, response);
    try {
      return createLocalJWKSet(jwks as JSONWebKeySet);
    } catch (err) {
      throw new IdentityProviderUnavailable(
        issuer,
        `${jwksUri} is not a JSON Web Key Set: ${(err as Error).message}`,
      );
    }
  }

  /** RFC 8414 metadata, else OIDC discovery's. */
  private async discover(issuer: string): Promise<Record<string, unknown>> {
    const url = new URL(issuer);
    const path = url.pathname.replace(/\/+$/, "");
    const candidates = [
      `${url.origin}/.well-known/oauth-authorization-server${path}`,
      `${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`,
    ];
    const answers: string[] = [];
    for (const candidate of candidates) {
      const response = await this.get(issuer, candidate);
      if (response.ok) {
        const body = await this.json(issuer, candidate, response);
        if (body === null || typeof body !== "object" || Array.isArray(body)) {
          throw new IdentityProviderUnavailable(issuer, `${candidate} is not a JSON object`);
        }
        return body as Record<string, unknown>;
      }
      answers.push(`${candidate} answered ${response.status}`);
    }
    throw new IdentityProviderUnavailable(issuer, `no authorization server metadata: ${answers.join("; ")}`);
  }

  private async get(issuer: string, url: string): Promise<Response> {
    try {
      return await this.deps.fetch(url, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (err) {
      throw new IdentityProviderUnavailable(issuer, `${url} could not be reached: ${(err as Error).message}`);
    }
  }

  private async json(issuer: string, url: string, response: Response): Promise<unknown> {
    try {
      return await response.json();
    } catch (err) {
      throw new IdentityProviderUnavailable(issuer, `${url} answered no JSON: ${(err as Error).message}`);
    }
  }
}
