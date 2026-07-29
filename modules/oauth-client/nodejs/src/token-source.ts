import {
  parseDurationMs,
  RuntimeError,
  type ResourceContext,
  type ResourceInstance,
} from "@telorun/sdk";
import { KeyedClaim, newHolderToken, type KvStore } from "@telorun/kv-store";
import { isClient, type ClientResource } from "./client.js";
import type { TokenSet } from "./token-set.js";

interface TokenSourceManifest {
  metadata?: { name?: string };
  client: unknown;
  store: unknown;
  key?: string;
  grantTtl?: string;
  refreshSkew?: string;
  claimTtl?: string;
}

/** A pending authorization, keyed by its one-time `state`. Single-use: consuming
 *  it is a compare-and-delete, so a replayed callback finds nothing. */
export interface PendingAuthorization {
  codeVerifier: string;
  redirectUri: string;
  key: string;
  /** When the user's window to finish closes. Held in the VALUE, and the record
   *  is stored under a longer TTL, so a late callback can be told it is late
   *  rather than indistinguishable from one that never existed. */
  expiresAt: number;
}

/** Why a pending authorization could not be consumed, or the record itself. */
export type PendingLookup =
  | { state: "found"; pending: PendingAuthorization }
  | { state: "expired" }
  | { state: "missing" };

/** How long an expired pending record is retained purely so the callback that
 *  arrives late gets `expired` instead of `unknown_state`. */
const EXPIRY_GRACE_MS = 3_600_000;

function isKvStore(value: unknown): value is KvStore {
  const candidate = value as KvStore | undefined;
  return (
    !!candidate &&
    typeof candidate.get === "function" &&
    typeof candidate.putIfAbsent === "function" &&
    typeof candidate.compareAndSet === "function" &&
    typeof candidate.compareAndDelete === "function"
  );
}

export class TokenSourceResource implements ResourceInstance {
  readonly client: ClientResource;
  private readonly store: KvStore;
  private readonly claims: KeyedClaim;
  private readonly grantTtlMs: number;
  readonly refreshSkewMs: number;
  private readonly claimTtlMs: number;

  constructor(
    private readonly manifest: TokenSourceManifest,
    ctx: ResourceContext,
  ) {
    const describe = () => `OAuthClient.TokenSource "${manifest.metadata?.name ?? ""}"`;
    this.client = ctx.resolveRef(
      manifest.client,
      isClient,
      () => `${describe()}: 'client'`,
      "OAuthClient.Client",
    );
    this.store = ctx.resolveRef(
      manifest.store,
      isKvStore,
      () => `${describe()}: 'store'`,
      "KvStore.Store",
    );
    this.claims = new KeyedClaim(this.store);
    this.grantTtlMs = parseDurationMs(manifest.grantTtl, 8_760 * 3_600_000);
    this.refreshSkewMs = parseDurationMs(manifest.refreshSkew, 60_000);
    this.claimTtlMs = parseDurationMs(manifest.claimTtl, 30_000);
  }

  /** The caller's key, or this source's default. */
  grantKey(key?: string | null): string {
    return key && key.length > 0 ? key : (this.manifest.key ?? "default");
  }

  private grantRecordKey(key: string): string {
    return `oauth/grant/${key}`;
  }

  async readGrant(key: string): Promise<{ tokens: TokenSet; version: string } | null> {
    const record = await this.store.get(this.grantRecordKey(key));
    if (!record) return null;
    return { tokens: record.value as TokenSet, version: record.version };
  }

  /** Replace whatever is stored for `key`. Storage offers only conditional
   *  writes, so an unconditional replace is insert-or-compare-and-set; a lost
   *  race is retried once against the revision that won. */
  async writeGrant(key: string, tokens: TokenSet): Promise<void> {
    const recordKey = this.grantRecordKey(key);
    for (let attempt = 0; attempt < 2; attempt++) {
      const existing = await this.store.get(recordKey);
      const written = existing
        ? await this.store.compareAndSet(recordKey, existing.version, tokens, this.grantTtlMs)
        : await this.store.putIfAbsent(recordKey, tokens, this.grantTtlMs);
      if (written) return;
    }
    throw new RuntimeError(
      "ERR_OAUTH_GRANT_WRITE_CONTENDED",
      `Could not store the grant for key ${JSON.stringify(key)} — another writer kept winning. ` +
        `Something else is writing the same key concurrently.`,
    );
  }

  async clearGrant(key: string): Promise<boolean> {
    const recordKey = this.grantRecordKey(key);
    const existing = await this.store.get(recordKey);
    if (!existing) return false;
    return this.store.compareAndDelete(recordKey, existing.version);
  }

  async writePending(state: string, pending: PendingAuthorization): Promise<void> {
    const written = await this.store.putIfAbsent(
      `oauth/pending/${state}`,
      pending,
      pending.expiresAt - Date.now() + EXPIRY_GRACE_MS,
    );
    if (!written) {
      throw new RuntimeError(
        "ERR_OAUTH_STATE_COLLISION",
        "A pending authorization already exists for the generated state value.",
      );
    }
  }

  /** Consume a pending authorization. The compare-and-delete is what makes it
   *  single-use: a second callback carrying the same `state` finds nothing.
   *  An expired record is consumed too — it is spent either way, and reporting
   *  the difference is the whole reason it outlives its own deadline. */
  async consumePending(state: string): Promise<PendingLookup> {
    const record = await this.store.get(`oauth/pending/${state}`);
    if (!record) return { state: "missing" };
    const taken = await this.store.compareAndDelete(`oauth/pending/${state}`, record.version);
    if (!taken) return { state: "missing" };
    const pending = record.value as PendingAuthorization;
    return Date.now() > pending.expiresAt ? { state: "expired" } : { state: "found", pending };
  }

  /**
   * Run `refresh` with the key claimed, so only one refresh per grant is in
   * flight anywhere. A caller that loses runs `whenHeld` instead — normally
   * re-reading the grant the winner has by then written.
   *
   * Compare-and-set alone would make the *write* safe but not the *call*: both
   * refreshes still reach the server, and a provider that rotates refresh tokens
   * treats the second presentation as replay and may revoke the whole grant.
   */
  async withRefreshClaim<T>(
    key: string,
    refresh: () => Promise<T>,
    whenHeld: () => Promise<T>,
  ): Promise<T> {
    const claimKey = `oauth/refresh/${key}`;
    const holder = newHolderToken();
    const claim = await this.claims.claim(claimKey, holder, this.claimTtlMs);
    if (claim.state !== "new") return whenHeld();
    try {
      return await refresh();
    } finally {
      if (claim.version) await this.claims.release(claimKey, claim.version);
    }
  }

  async provide(): Promise<TokenSourceResource> {
    return this;
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

export function isTokenSource(value: unknown): value is TokenSourceResource {
  return value instanceof TokenSourceResource;
}

/** Every Invocable in this module resolves its `source` slot the same way. */
export function resolveSource(
  value: unknown,
  ctx: ResourceContext,
  describe: () => string,
): TokenSourceResource {
  return ctx.resolveRef(
    value,
    isTokenSource,
    () => `${describe()}: 'source'`,
    "OAuthClient.TokenSource",
  );
}

export const tokenSource = {
  schema: { type: "object", additionalProperties: true },
  async create(resource: TokenSourceManifest, ctx: ResourceContext) {
    return new TokenSourceResource(resource, ctx);
  },
};
