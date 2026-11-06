import {
  durationMs,
  InvokeError,
  isCelTimestamp,
  RuntimeError,
  type ResourceContext,
  type ResourceInstance,
} from "@telorun/sdk";
import type { KvStore } from "@telorun/kv-store";
import { createHash } from "node:crypto";
import { millisOfTimestamp, timestampOfMillis } from "./instants.js";
import { RETENTION_MS, updateIndex } from "./session-index.js";
import { claimSessionName } from "./session-name-claims.js";
import { GuardedStore, storeInconsistent } from "./session-store.js";
import {
  indexKey,
  sessionKey,
  type IndexEntry,
  type SessionRecord,
  type StoredPrincipal,
} from "./session-records.js";
import { digestOf, digestsEqual, idOfPublicId, mintToken, parseToken, publicIdOf } from "./session-token.js";

export const ERR_SESSION_NOT_FOUND = "ERR_SESSION_NOT_FOUND";
export const ERR_SESSION_LIFETIME_INVALID = "ERR_SESSION_LIFETIME_INVALID";

/** The reasons the verifier refuses; the closed list `docs/verifier.md` documents. */
export type RefusalReason = "malformed" | "unknown" | "ended" | "expired";

/** A write at most this fraction of the idle timeout apart keeps a session alive: about ten per idle period. */
const SLIDE_DIVISOR = 10;

export interface Lifetimes {
  readonly idleMs: number;
  readonly absoluteMs: number;
}

export interface SessionsSettings {
  readonly name: string;
  readonly normal: Lifetimes;
  readonly persistent: Lifetimes | null;
  readonly maxPerSubject: number;
}

interface PrincipalInput {
  subject: string;
  issuer: string | null;
  kind: "user" | "service";
  claims: Record<string, unknown>;
  scopes: string[];
  roles: string[];
  permissions: string[];
  org: string | null;
  amr: string[];
  acr: string | null;
  authenticatedAt: unknown;
}

export interface StartInput {
  principal: PrincipalInput;
  persistent?: boolean;
  userAgent?: string | null;
  address?: string | null;
}

export interface RotateInput {
  sessionId: string;
  subject: string;
  principal?: PrincipalInput;
}

export interface Issued {
  token: string;
  sessionId: string;
  expiresAt: ReturnType<typeof timestampOfMillis>;
  cookieExpiresAt: ReturnType<typeof timestampOfMillis> | null;
}

export type Verification =
  | { readonly accepted: true; readonly id: string; readonly record: SessionRecord }
  | { readonly accepted: false; readonly reason: RefusalReason };

const subjectDigest = (subject: string): string => createHash("sha256").update(subject, "utf8").digest("base64url");

/** The moment a session stops being accepted if nothing keeps it alive. */
const deadlineOf = (record: SessionRecord): number => Math.min(record.lastSeenAt + record.idleMs, record.expiresAt);

/**
 * Session.Sessions — server-side sessions kept in a `KvStore.Store` as two kinds
 * of record: one per session, and one per subject listing the sessions it may
 * still use. A session is accepted only while it is listed, so ending a session
 * (or all of a subject's) is one write to the index.
 */
export class Sessions implements ResourceInstance {
  private readonly store: KvStore;

  constructor(
    private readonly backing: KvStore,
    private readonly config: SessionsSettings,
    private readonly describe: string,
    private readonly clock: () => number = Date.now,
  ) {
    this.store = new GuardedStore(backing, describe);
  }

  /** Claims the set's name on its store for as long as the set lives. */
  init(ctx: ResourceContext) {
    return ctx.effect("session name claim", async () => ({
      result: undefined,
      inverse: claimSessionName(this.backing, this.config.name, this, this.describe),
    }));
  }

  get maxPerSubject(): number {
    return this.config.maxPerSubject;
  }

  private lifetimes(persistent: boolean): Lifetimes {
    if (!persistent) return this.config.normal;
    if (this.config.persistent === null) {
      throw new InvokeError(
        "ERR_INPUT_INVALID",
        `${this.describe}: 'persistent' is true but the resource declares no 'persistent' lifetimes.`,
      );
    }
    return this.config.persistent;
  }

  private indexKeyOf(subject: string): string {
    return indexKey(this.config.name, subjectDigest(subject));
  }

  private ttlOf(record: SessionRecord, now: number): number {
    return Math.max(deadlineOf(record) - now, 0) + RETENTION_MS;
  }

  private issued(id: string, token: string, record: SessionRecord, now: number): Issued {
    return {
      token,
      sessionId: publicIdOf(id),
      expiresAt: timestampOfMillis(Math.min(now + record.idleMs, record.expiresAt)),
      cookieExpiresAt: record.persistent ? timestampOfMillis(record.expiresAt) : null,
    };
  }

  /** Starts a session under a fresh id; past the cap the oldest sessions are ended. */
  async start(input: StartInput): Promise<Issued & { ended: string[] }> {
    const lifetimes = this.lifetimes(input.persistent === true);
    const minted = mintToken();
    const now = this.clock();
    const record: SessionRecord = {
      digest: minted.digest,
      principal: storedPrincipal(input.principal),
      amr: [...input.principal.amr],
      acr: input.principal.acr,
      authenticatedAt: isCelTimestamp(input.principal.authenticatedAt)
        ? millisOfTimestamp(input.principal.authenticatedAt)
        : now,
      createdAt: now,
      userAgent: input.userAgent ?? null,
      address: input.address ?? null,
      persistent: input.persistent === true,
      idleMs: lifetimes.idleMs,
      lastSeenAt: now,
      expiresAt: now + lifetimes.absoluteMs,
    };
    // Listed first: a crash before the record is written leaves a harmless entry
    // naming nothing, never a live session no one can revoke.
    const dropped = await this.append(record.principal.subject, { id: minted.id, expiresAt: record.expiresAt });
    const written = await this.store.putIfAbsent(sessionKey(this.config.name, minted.id), record, this.ttlOf(record, now));
    // Never retried: a retry would list another entry and could push out the subject's real sessions.
    if (written === null) throw storeInconsistent(this.describe, "a freshly minted session id was already taken");
    return { ...this.issued(minted.id, minted.token, record, now), ended: dropped.map(publicIdOf) };
  }

  /** Lists `entry` last, dropping lapsed entries and then the oldest beyond the cap; returns the ids dropped for the cap. */
  private append(subject: string, entry: IndexEntry): Promise<string[]> {
    return updateIndex(this.store, this.indexKeyOf(subject), this.describe, this.clock, (entries, now) => {
      const live = entries.filter((e) => e.expiresAt > now);
      const next = [...live, entry];
      const dropped = next.splice(0, Math.max(next.length - this.config.maxPerSubject, 0));
      return { next, result: dropped.map((e) => e.id) };
    });
  }

  /** Replaces a session of `subject` by a fresh one in one index write; refused when it is not one of its live sessions. */
  async rotate(input: RotateInput): Promise<Issued> {
    const oldId = idOfPublicId(input.sessionId);
    if (oldId === undefined) throw this.notFound(input.sessionId);
    const stored = await this.store.get(sessionKey(this.config.name, oldId));
    const old = stored?.value as SessionRecord | undefined;
    const now = this.clock();
    if (!old || old.principal.subject !== input.subject || deadlineOf(old) <= now) throw this.notFound(input.sessionId);
    if (input.principal && input.principal.subject !== input.subject) {
      throw new InvokeError("ERR_INPUT_INVALID", `${this.describe}: a rotated session keeps its subject; 'principal.subject' differs from 'subject'.`);
    }

    const minted = mintToken();
    const record: SessionRecord = {
      ...old,
      digest: minted.digest,
      principal: input.principal ? storedPrincipal(input.principal) : old.principal,
      amr: input.principal ? [...input.principal.amr] : old.amr,
      acr: input.principal ? input.principal.acr : old.acr,
      lastSeenAt: now,
    };
    const swapped = await updateIndex(this.store, this.indexKeyOf(input.subject), this.describe, this.clock, (entries, at) => {
      const listed = entries.find((e) => e.id === oldId);
      if (!listed) return { next: null, result: false };
      const kept = entries.filter((e) => e.id !== oldId && e.expiresAt > at);
      return { next: [...kept, { id: minted.id, expiresAt: listed.expiresAt }], result: true };
    });
    if (!swapped) throw this.notFound(input.sessionId);
    const written = await this.store.putIfAbsent(sessionKey(this.config.name, minted.id), record, this.ttlOf(record, now));
    if (written === null) throw storeInconsistent(this.describe, "a freshly minted session id was already taken");
    return this.issued(minted.id, minted.token, record, now);
  }

  private notFound(sessionId: string): InvokeError {
    return new InvokeError(
      ERR_SESSION_NOT_FOUND,
      `${this.describe}: the subject holds no live session "${sessionId}"; it ended, expired or belongs to someone else.`,
    );
  }

  /** Ends one session of `subject`; false when the subject has no such session. */
  async end(subject: string, sessionId: string): Promise<boolean> {
    const id = idOfPublicId(sessionId);
    if (id === undefined) return false;
    return updateIndex(this.store, this.indexKeyOf(subject), this.describe, this.clock, (entries) =>
      entries.some((e) => e.id === id)
        ? { next: entries.filter((e) => e.id !== id), result: true }
        : { next: null, result: false },
    );
  }

  /** Ends every session of `subject` but `except`, in one write to the index. */
  async endAll(subject: string, except?: string): Promise<string[]> {
    const kept = except === undefined ? undefined : idOfPublicId(except);
    return updateIndex(this.store, this.indexKeyOf(subject), this.describe, this.clock, (entries) => {
      const removed = entries.filter((e) => e.id !== kept);
      return removed.length === 0
        ? { next: null, result: [] as string[] }
        : { next: entries.filter((e) => e.id === kept), result: removed.map((e) => publicIdOf(e.id)) };
    });
  }

  /** The subject's live sessions, oldest first; the set is bounded by `maxPerSubject`. */
  async list(subject: string) {
    const index = await this.store.get(this.indexKeyOf(subject));
    const entries = ((index?.value as { entries?: IndexEntry[] } | undefined)?.entries ?? []) as IndexEntry[];
    const now = this.clock();
    const found = await Promise.all(
      entries.map(async (entry) => ({
        entry,
        stored: await this.store.get(sessionKey(this.config.name, entry.id)),
      })),
    );
    const sessions = [];
    for (const { entry, stored } of found) {
      const record = stored?.value as SessionRecord | undefined;
      if (!record || deadlineOf(record) <= now) continue;
      sessions.push({
        id: publicIdOf(entry.id),
        createdAt: timestampOfMillis(record.createdAt),
        lastSeenAt: timestampOfMillis(record.lastSeenAt),
        expiresAt: timestampOfMillis(deadlineOf(record)),
        authenticatedAt: timestampOfMillis(record.authenticatedAt),
        amr: [...record.amr],
        acr: record.acr,
        userAgent: record.userAgent,
        address: record.address,
        persistent: record.persistent,
      });
    }
    return sessions.sort((a, b) => millisOfTimestamp(a.createdAt) - millisOfTimestamp(b.createdAt));
  }

  /**
   * Judges a presented token: two reads (the session, then its subject's index),
   * and at most one write to slide the idle deadline, once a tenth of the idle
   * timeout has passed since the last. A slide that loses to another replica's
   * write is an outcome, not an error: that write extended the deadline too.
   */
  async verify(text: string): Promise<Verification> {
    const parsed = parseToken(text);
    if (!parsed.ok) return { accepted: false, reason: "malformed" };
    const key = sessionKey(this.config.name, parsed.id);
    const stored = await this.store.get(key);
    const record = stored?.value as SessionRecord | undefined;
    if (!stored || !record || !digestsEqual(digestOf(parsed.validator), record.digest)) {
      return { accepted: false, reason: "unknown" };
    }
    const now = this.clock();
    if (deadlineOf(record) <= now) return { accepted: false, reason: "expired" };

    const index = await this.store.get(this.indexKeyOf(record.principal.subject));
    const listed = ((index?.value as { entries?: IndexEntry[] } | undefined)?.entries ?? []).some((e) => e.id === parsed.id);
    if (!listed) return { accepted: false, reason: "ended" };

    if (now - record.lastSeenAt >= record.idleMs / SLIDE_DIVISOR) {
      const slid = { ...record, lastSeenAt: now };
      await this.store.compareAndSet(key, stored.version, slid, this.ttlOf(slid, now));
      return { accepted: true, id: parsed.id, record: slid };
    }
    return { accepted: true, id: parsed.id, record };
  }

  snapshot(): Record<string, unknown> {
    return {
      name: this.config.name,
      maxPerSubject: this.config.maxPerSubject,
      persistent: this.config.persistent !== null,
    };
  }
}

function storedPrincipal(p: PrincipalInput): StoredPrincipal {
  return {
    subject: p.subject,
    issuer: p.issuer,
    kind: p.kind,
    claims: p.claims,
    scopes: [...p.scopes],
    roles: [...p.roles],
    permissions: [...p.permissions],
    org: p.org,
  };
}

/** Whether a resolved reference is a `Sessions`, by what it can do rather than by class. */
export function isSessions(value: unknown): value is Sessions {
  const v = value as Record<string, unknown> | null;
  return typeof v === "object" && v !== null && ["start", "rotate", "end", "endAll", "list", "verify"].every((m) => typeof v[m] === "function");
}

function isKvStore(value: unknown): value is KvStore {
  const v = value as Record<string, unknown> | null;
  return typeof v === "object" && v !== null && ["get", "putIfAbsent", "compareAndSet", "compareAndDelete"].every((m) => typeof v[m] === "function");
}

interface SessionsResource {
  metadata: { name: string };
  store: unknown;
  name: string;
  idleTimeout: unknown;
  absoluteLifetime: unknown;
  persistent?: { idleTimeout: unknown; absoluteLifetime: unknown };
  maxPerSubject?: number;
}

function lifetimesOf(describe: string, where: string, idle: unknown, absolute: unknown): Lifetimes {
  const idleMs = durationMs(idle);
  const absoluteMs = durationMs(absolute);
  if (idleMs === undefined || idleMs <= 0 || absoluteMs === undefined || absoluteMs <= 0) {
    throw new RuntimeError("ERR_INVALID_VALUE", `${describe}: ${where} lifetimes must be positive durations.`);
  }
  // The creation-time twin of the SESSION_LIFETIME_INVALID rule.
  if (idleMs > absoluteMs) {
    throw new RuntimeError(
      ERR_SESSION_LIFETIME_INVALID,
      `${describe}: ${where} idle timeout is longer than its absolute lifetime, so the idle timeout could never be reached.`,
    );
  }
  return { idleMs, absoluteMs };
}

export function settingsOf(resource: SessionsResource, describe: string): SessionsSettings {
  return {
    name: resource.name,
    normal: lifetimesOf(describe, "the", resource.idleTimeout, resource.absoluteLifetime),
    persistent: resource.persistent
      ? lifetimesOf(describe, "the 'persistent'", resource.persistent.idleTimeout, resource.persistent.absoluteLifetime)
      : null,
    maxPerSubject: resource.maxPerSubject ?? 50,
  };
}

export async function create(resource: SessionsResource, ctx: ResourceContext): Promise<Sessions> {
  const describe = `Session.Sessions "${resource.metadata.name}"`;
  const settings = settingsOf(resource, describe);
  const store = ctx.resolveRef(resource.store, isKvStore, () => `${describe}: 'store'`, "KvStore.Store");
  return new Sessions(store, settings, describe);
}

export function register(): void {}
