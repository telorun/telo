import { durationMs, InvokeError, RuntimeError, type ResourceContext, type ResourceInstance } from "@telorun/sdk";
import type { KvStore } from "@telorun/kv-store";
import { timestampOfMillis } from "./instants.js";
import { codeDigest, digestsEqual, mintCode, mintLinkSecret, sha256 } from "./one-time-digests.js";
import { claimTokenName } from "./one-time-name-claims.js";
import { contended, GuardedStore } from "./one-time-store.js";

export type RedemptionReason = "unknown" | "holderMismatch" | "mismatch" | "exhausted";

export type Issuance =
  | { issued: true; token: string; expiresAt: ReturnType<typeof timestampOfMillis> }
  | { issued: false; retryAfter: number };

export type Redemption =
  | { redeemed: true; subject: string; data: unknown }
  | { redeemed: false; reason: RedemptionReason };

/** Writes that lose to a concurrent writer are reread and reapplied this many times. */
const MAX_ATTEMPTS = 8;
const DEFAULT_REISSUE_MS = 60_000;

/** One live token per subject, at `<name>/t/<sha256(subject)>`. A null `digest` is a code that used up its attempts and only holds the subject back. */
interface TokenRecord {
  subject: string;
  digest: string | null;
  data: unknown;
  holder: string | null;
  issuedAt: number;
  expiresAt: number;
  attemptsLeft: number | null;
}

export interface TokenSettings {
  readonly name: string;
  readonly expiresInMs: number;
  readonly reissueMs: number;
  readonly dataTyped: boolean;
}

export interface IssueInput {
  subject: string;
  data?: unknown;
  holder?: string | null;
}

/**
 * A set of single-use tokens over a `KvStore.Store`. The subject record is the
 * live token: every redemption, replacement and revocation is one conditional
 * write on it, so a token works once across every replica sharing the store.
 */
export abstract class TokenSet implements ResourceInstance {
  protected readonly store: KvStore;

  constructor(
    private readonly backing: KvStore,
    protected readonly config: TokenSettings,
    protected readonly describe: string,
    protected readonly clock: () => number = Date.now,
  ) {
    this.store = new GuardedStore(backing, describe);
  }

  /** Claims the set's name on its store for as long as the set lives. */
  init(ctx: ResourceContext) {
    return ctx.effect("one-time name claim", async () => ({
      result: undefined,
      inverse: claimTokenName(this.backing, this.config.name, this, this.describe),
    }));
  }

  /** Refuses an issue that omits the `data` a set with a `dataType` must carry, before anything is read or written. */
  requireData(data: unknown): void {
    if (this.config.dataTyped && (data ?? null) === null) {
      throw new InvokeError(
        "ERR_INPUT_INVALID",
        `${this.describe}: 'data' is required because the set declares 'dataType'; pass the data its redemption answers with.`,
      );
    }
  }

  /** A fresh secret and the digest that is stored in its place. */
  protected abstract mint(subject: string): { token: string; digest: string };

  /** The lookup key a token's digest is reachable by; null for a set with none. */
  protected abstract lookupKey(digest: string): string | null;

  protected subjectKey(subject: string): string {
    return `${this.config.name}/t/${sha256(subject)}`;
  }

  protected ttlOf(record: TokenRecord, now: number): number {
    return Math.max(Math.max(record.expiresAt, record.issuedAt + this.config.reissueMs) - now, 1);
  }

  protected attemptsAtIssue(): number | null {
    return null;
  }

  protected async read(subject: string): Promise<{ record: TokenRecord; version: string } | null> {
    const stored = await this.store.get(this.subjectKey(subject));
    return stored ? { record: stored.value as TokenRecord, version: stored.version } : null;
  }

  protected static holderMatches(bound: string | null, presented: string | null | undefined): boolean {
    if (bound === null) return presented === undefined || presented === null;
    return typeof presented === "string" && digestsEqual(bound, sha256(presented));
  }

  /** Whether a record holds a token that can still be redeemed. */
  protected static live(record: TokenRecord, now: number): record is TokenRecord & { digest: string } {
    return record.digest !== null && now < record.expiresAt;
  }

  /**
   * Replaces the subject's token unless one was issued within `reissueAfter`.
   * A new link is reachable first, then the record is replaced in one conditional
   * write and the old link's lookup removed, so a crash leaves a lookup that reads
   * as unknown, never two redeemable tokens.
   */
  async issue(input: IssueInput): Promise<Issuance> {
    const key = this.subjectKey(input.subject);
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const now = this.clock();
      const existing = await this.store.get(key);
      const previous = existing ? (existing.value as TokenRecord) : null;
      if (previous && now < previous.issuedAt + this.config.reissueMs) {
        return { issued: false, retryAfter: Math.max(Math.ceil((previous.issuedAt + this.config.reissueMs - now) / 1000), 1) };
      }
      const minted = this.mint(input.subject);
      const record: TokenRecord = {
        subject: input.subject,
        digest: minted.digest,
        data: input.data ?? null,
        holder: typeof input.holder === "string" ? sha256(input.holder) : null,
        issuedAt: now,
        expiresAt: now + this.config.expiresInMs,
        attemptsLeft: this.attemptsAtIssue(),
      };
      const lookup = this.lookupKey(minted.digest);
      if (lookup !== null) {
        const claimed = await this.store.putIfAbsent(lookup, { subject: sha256(input.subject) }, this.config.expiresInMs);
        if (claimed === null) continue;
      }
      const written = existing
        ? await this.store.compareAndSet(key, existing.version, record, this.ttlOf(record, now))
        : await this.store.putIfAbsent(key, record, this.ttlOf(record, now));
      if (written === null) {
        if (lookup !== null) await this.dropLookup(lookup);
        continue;
      }
      const oldLookup = previous?.digest ? this.lookupKey(previous.digest) : null;
      if (oldLookup !== null) await this.dropLookup(oldLookup);
      return { issued: true, token: minted.token, expiresAt: timestampOfMillis(record.expiresAt) };
    }
    throw contended(this.describe, "issuing a token");
  }

  protected async dropLookup(lookup: string): Promise<void> {
    const found = await this.store.get(lookup);
    if (found) await this.store.compareAndDelete(lookup, found.version);
  }

  /** Withdraws the subject's live token; an exhausted code keeps holding the subject back. */
  async revoke(subject: string): Promise<boolean> {
    const key = this.subjectKey(subject);
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const found = await this.read(subject);
      if (!found || !TokenSet.live(found.record, this.clock())) return false;
      if (await this.store.compareAndDelete(key, found.version)) return true;
    }
    throw contended(this.describe, "revoking a token");
  }

  snapshot(): Record<string, unknown> {
    return { name: this.config.name, expiresIn: this.config.expiresInMs, reissueAfter: this.config.reissueMs };
  }
}

export class LinkSet extends TokenSet {
  constructor(
    backing: KvStore,
    config: TokenSettings,
    private readonly bytes: number,
    describe: string,
    clock?: () => number,
  ) {
    super(backing, config, describe, clock);
  }

  protected mint() {
    const token = mintLinkSecret(this.bytes);
    return { token, digest: sha256(token) };
  }

  protected lookupKey(digest: string): string {
    return `${this.config.name}/l/${digest}`;
  }

  /** Opens a link once: the lookup finds the subject record, which must still hold the link's digest. */
  async redeemLink(token: string, holder?: string | null): Promise<Redemption> {
    const digest = sha256(token);
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const lookup = await this.store.get(this.lookupKey(digest));
      if (!lookup) return { redeemed: false, reason: "unknown" };
      const subjectDigest = (lookup.value as { subject: string }).subject;
      const stored = await this.store.get(`${this.config.name}/t/${subjectDigest}`);
      const record = stored ? (stored.value as TokenRecord) : null;
      if (!record || !TokenSet.live(record, this.clock()) || !digestsEqual(record.digest, digest)) {
        return { redeemed: false, reason: "unknown" };
      }
      if (!TokenSet.holderMatches(record.holder, holder)) return { redeemed: false, reason: "holderMismatch" };
      if (await this.store.compareAndDelete(`${this.config.name}/t/${subjectDigest}`, stored!.version)) {
        return { redeemed: true, subject: record.subject, data: record.data };
      }
    }
    throw contended(this.describe, "redeeming a link");
  }
}

export class CodeSet extends TokenSet {
  constructor(
    backing: KvStore,
    config: TokenSettings,
    private readonly digits: number,
    private readonly maxAttempts: number,
    describe: string,
    clock?: () => number,
  ) {
    super(backing, config, describe, clock);
  }

  protected mint(subject: string) {
    const token = mintCode(this.digits);
    return { token, digest: codeDigest(subject, token) };
  }

  protected lookupKey(): null {
    return null;
  }

  protected attemptsAtIssue(): number {
    return this.maxAttempts;
  }

  /**
   * Checks a code. A wrong one is one conditional write on the record that takes
   * an attempt; the last attempt leaves the record with no code, keeping its
   * `issuedAt` so exhausting a code does not open an immediate reissue.
   */
  async redeemCode(subject: string, code: string, holder?: string | null): Promise<Redemption> {
    const key = this.subjectKey(subject);
    const presented = codeDigest(subject, code);
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const found = await this.read(subject);
      const now = this.clock();
      if (!found || !TokenSet.live(found.record, now)) return { redeemed: false, reason: "unknown" };
      const { record, version } = found;
      if (!TokenSet.holderMatches(record.holder, holder)) return { redeemed: false, reason: "holderMismatch" };
      if (digestsEqual(record.digest, presented)) {
        if (await this.store.compareAndDelete(key, version)) return { redeemed: true, subject: record.subject, data: record.data };
        continue;
      }
      const left = (record.attemptsLeft ?? 1) - 1;
      if (left > 0) {
        const next = { ...record, attemptsLeft: left };
        if ((await this.store.compareAndSet(key, version, next, this.ttlOf(next, now))) !== null) {
          return { redeemed: false, reason: "mismatch" };
        }
        continue;
      }
      const spent: TokenRecord = { ...record, digest: null, data: null, holder: null, attemptsLeft: 0 };
      const holdsUntil = record.issuedAt + this.config.reissueMs;
      const settled =
        holdsUntil > now
          ? (await this.store.compareAndSet(key, version, spent, holdsUntil - now)) !== null
          : await this.store.compareAndDelete(key, version);
      if (settled) return { redeemed: false, reason: "exhausted" };
    }
    throw contended(this.describe, "checking a code");
  }
}

/** Whether a resolved reference is a token set, by what it can do rather than by class. */
export function isTokenSet(value: unknown): value is TokenSet {
  const v = value as Record<string, unknown> | null;
  return typeof v === "object" && v !== null && typeof v.issue === "function" && typeof v.revoke === "function";
}

export function isLinkSet(value: unknown): value is LinkSet {
  return isTokenSet(value) && typeof (value as unknown as Record<string, unknown>).redeemLink === "function";
}

export function isCodeSet(value: unknown): value is CodeSet {
  return isTokenSet(value) && typeof (value as unknown as Record<string, unknown>).redeemCode === "function";
}

export function isKvStore(value: unknown): value is KvStore {
  const v = value as Record<string, unknown> | null;
  return typeof v === "object" && v !== null && ["get", "putIfAbsent", "compareAndSet", "compareAndDelete"].every((m) => typeof v[m] === "function");
}

export interface TokenSetResource {
  metadata: { name: string };
  store: unknown;
  name: string;
  expiresIn: unknown;
  reissueAfter?: unknown;
  dataType?: unknown;
}

export function settingsOf(resource: TokenSetResource, describe: string): TokenSettings {
  const expiresInMs = durationMs(resource.expiresIn);
  if (expiresInMs === undefined || expiresInMs <= 0) {
    throw new RuntimeError("ERR_INVALID_VALUE", `${describe}: 'expiresIn' must be a positive duration.`);
  }
  const reissueMs = resource.reissueAfter === undefined ? DEFAULT_REISSUE_MS : durationMs(resource.reissueAfter);
  if (reissueMs === undefined || reissueMs < 0) {
    throw new RuntimeError("ERR_INVALID_VALUE", `${describe}: 'reissueAfter' must be a duration of zero or more.`);
  }
  return { name: resource.name, expiresInMs, reissueMs, dataTyped: resource.dataType !== undefined && resource.dataType !== null };
}

