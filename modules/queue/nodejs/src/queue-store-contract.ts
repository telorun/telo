import type { CelDuration, CelTimestamp, InvokeContext } from "@telorun/sdk";

/**
 * The queue store contract (normative: `docs/store-contract.md`).
 *
 * A store stores. Every error code, every retry and dead-letter decision, the
 * byte bound, id minting and the body encoding are the operation kinds' —
 * decided once for every backend. A method answers with an OUTCOME, never a
 * code; a failure of the storage itself is thrown as it arrives, and the
 * operation raises it as `ERR_QUEUE_UNAVAILABLE`.
 *
 * Every method takes the calling invocation's context last, so a remote call
 * can be cancelled with it. Every instant is the STORE's clock: a backend is
 * handed durations and renders "now plus this" itself.
 */
export interface QueueStore {
  /** What the queue was configured with, as the operations need it. A backend
   *  computes it once at creation — `queueSettingsOf` does that for it. */
  settings(): QueueSettings;
  /** Store a batch, one outcome per item in order. An item is `stored` once it
   *  is durable; on an addressable store an id already holding a message (not
   *  expired) is `duplicate` when the digests agree and `conflict` otherwise.
   *  A base store never answers `duplicate` or `conflict`. */
  enqueue(items: readonly EnqueueRequest[], ctx?: InvokeContext): Promise<EnqueueOutcome[]>;
  /** Claim up to `limit` visible messages under a lease of `lease`, each claim
   *  counting as an attempt. May purge settled rows past retention in the same
   *  transaction, in a bounded batch. Answers no message when none is visible. */
  claim(request: ClaimRequest, ctx?: InvokeContext): Promise<ClaimOutcome>;
  /** Extend a held claim's lease to now + `lease`. `cancelled` means a cancel
   *  was requested for the message: the store has settled it `cancelled` in
   *  the same step, and the claim is over. */
  renew(claim: string, lease: CelDuration, ctx?: InvokeContext): Promise<RenewOutcome>;
  /** Settle a held claim as completed: a base store removes the message, an
   *  addressable one keeps it until `retention` has passed. */
  complete(claim: string, ctx?: InvokeContext): Promise<SettleOutcome>;
  /** Hand a held claim back, visible again after `visibleAfter`. */
  release(claim: string, release: ReleaseRequest, ctx?: InvokeContext): Promise<SettleOutcome>;
  /** Settle a held claim as dead, recording `error`. A dead message is never
   *  claimed again and is kept. */
  kill(claim: string, error: QueueError, ctx?: InvokeContext): Promise<SettleOutcome>;
  /** Counts per state and the age of the oldest pending message. */
  stats(ctx?: InvokeContext): Promise<QueueStats>;
}

/** The addressable level: an id names at most one message until `retention`
 *  has passed after it completed or was cancelled. */
export interface AddressableQueueStore extends QueueStore {
  /** The message under `id`, or absent (a settled message past retention is
   *  absent). */
  get(id: string, ctx?: InvokeContext): Promise<StoredMessageFound | StoredMessageAbsent>;
  /** A page of the messages in `state`, oldest first. `after` is a tail this
   *  store returned as `next`; one it cannot read as its own is `cursorInvalid`. */
  list(request: ListRequest, ctx?: InvokeContext): Promise<ListOutcome>;
  /** Cancel the message under `id`. */
  cancel(id: string, reason: string | null, ctx?: InvokeContext): Promise<CancelOutcome>;
  /** Make a dead message pending again, its attempts reset and its place in
   *  its group kept. */
  requeue(id: string, ctx?: InvokeContext): Promise<RequeueOutcome>;
}

export interface QueueSettings {
  /** The resolved JSON Schema every message has. */
  readonly messageType: Record<string, unknown>;
  /** The largest encoded body, in UTF-8 bytes. */
  readonly maxMessageBytes: number;
}

/** A failure as it is recorded with a message. */
export interface QueueError {
  readonly code: string;
  readonly message: string;
  readonly data?: unknown;
}

export interface EnqueueRequest {
  readonly id: string;
  /** The body: canonical plain JSON text of the message. Opaque to the store. */
  readonly body: string;
  /** Lower-case hex SHA-256 of `body`: what "the same message" compares. */
  readonly digest: string;
  /** The envelope generation the body was written under. */
  readonly generation: number;
  /** When it first becomes visible: a duration from the store's now, or an
   *  instant. Absent: now. */
  readonly after?: CelDuration | CelTimestamp;
  /** W3C Trace Context of the enqueuing span, absent when tracing was off. */
  readonly traceparent?: string;
  readonly tracestate?: string;
}

export type EnqueueOutcome =
  | { readonly status: "stored" }
  | { readonly status: "duplicate" }
  | { readonly status: "conflict" };

export interface ClaimRequest {
  /** The most messages to claim; at least 1. */
  readonly limit: number;
  /** How long each claim holds its message before it lapses. */
  readonly lease: CelDuration;
}

export interface ClaimOutcome {
  readonly messages: readonly ClaimedMessage[];
}

export interface ClaimedMessage {
  readonly id: string;
  /** Opaque token naming this claim; renew / complete / release / kill take it. */
  readonly claim: string;
  readonly body: string;
  readonly generation: number;
  /** This claim's attempt number: every claim counts, the first is 1. */
  readonly attempt: number;
  readonly enqueuedAt: CelTimestamp;
  /** Whether the previous claim's lease lapsed with the message unsettled. */
  readonly lapsed: boolean;
  /** Set when a previous claim decided the message is dead and its dead-letter
   *  handler did not finish: the failure that decided it. */
  readonly dying?: QueueError;
  readonly traceparent?: string;
  readonly tracestate?: string;
}

export type RenewOutcome =
  | { readonly status: "held" }
  /** The claim is no longer this one's: its lease lapsed and another may hold
   *  the message, or it was settled. Nothing must be settled through it. */
  | { readonly status: "lost" }
  | { readonly status: "cancelled" };

export type SettleOutcome = { readonly status: "settled" } | { readonly status: "lost" };

export interface ReleaseRequest {
  /** Visible again after this, from the store's now. */
  readonly visibleAfter: CelDuration;
  /** The failure of the attempt being handed back; null records none. */
  readonly error: QueueError | null;
  /** Do not count this claim's attempt: the message was handed back unfinished
   *  at shutdown. */
  readonly giveBack: boolean;
  /** The message is dead and its dead-letter handler did not finish: the next
   *  claim carries it as `dying`. */
  readonly dying?: QueueError;
}

export interface QueueStats {
  readonly pending: number;
  readonly scheduled: number;
  readonly running: number;
  readonly dead: number;
  readonly oldestPendingAge: CelDuration | null;
  /** Whether the counts are exact rather than an estimate. */
  readonly exact: boolean;
}

export type MessageState = "scheduled" | "pending" | "running" | "completed" | "dead" | "cancelled";

export interface StoredMessage {
  readonly id: string;
  readonly state: MessageState;
  readonly attempts: number;
  readonly enqueuedAt: CelTimestamp;
  readonly visibleAt?: CelTimestamp;
  readonly settledAt?: CelTimestamp;
  readonly lastError?: QueueError;
  readonly reason?: string;
  readonly body: string;
  readonly generation: number;
}

export interface StoredMessageFound {
  readonly status: "found";
  readonly message: StoredMessage;
}

export interface StoredMessageAbsent {
  readonly status: "absent";
}

export interface ListRequest {
  readonly state: MessageState;
  readonly limit: number;
  readonly after?: string;
}

export type ListOutcome =
  | {
      readonly status: "page";
      readonly messages: readonly Omit<StoredMessage, "body" | "generation" | "reason">[];
      /** The tail the next page starts after; absent on the last page. */
      readonly next?: string;
    }
  | { readonly status: "cursorInvalid" };

export type CancelOutcome =
  /** Cancelled now (it was scheduled, pending or dead). */
  | { readonly status: "cancelled" }
  /** Running: cancelled at its handler's next lease renewal. */
  | { readonly status: "requested" }
  /** Completed or already cancelled: nothing changed. */
  | { readonly status: "unchanged"; readonly state: MessageState }
  | { readonly status: "absent" };

export type RequeueOutcome =
  | { readonly status: "requeued" }
  | { readonly status: "unchanged"; readonly state: MessageState }
  | { readonly status: "absent" };

const QUEUE_METHODS = [
  "settings",
  "enqueue",
  "claim",
  "renew",
  "complete",
  "release",
  "kill",
  "stats",
] as const;
const ADDRESSABLE_METHODS = ["get", "list", "cancel", "requeue"] as const;

function hasMethods(value: unknown, methods: readonly string[]): boolean {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return methods.every((method) => typeof candidate[method] === "function");
}

/** A store is recognised by its methods alone — never by its class or by having
 *  imported this file, since a backend may live in another repository. */
export function isQueueStore(value: unknown): value is QueueStore {
  return hasMethods(value, QUEUE_METHODS);
}

export function isAddressableQueueStore(value: unknown): value is AddressableQueueStore {
  return hasMethods(value, QUEUE_METHODS) && hasMethods(value, ADDRESSABLE_METHODS);
}
