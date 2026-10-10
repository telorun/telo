import type { CancellationSource, InvokeContext, ZoneEntry } from "@telorun/sdk";
import type {
  Absent,
  CursorInvalid,
  Found,
  GraphNodeType,
  GraphNodeValue,
  GraphPage,
  GraphPageResult,
  GraphRelationshipType,
  GraphRelationshipValue,
} from "@telorun/graph";
import { isLayeredGraphStore, type LayeredGraphStore } from "./layered-graph-store.js";

/** Who did something to a layer. Omitted, it is the store itself —
 *  {@link storeActor}. */
export interface Actor {
  readonly type: string;
  readonly id: string;
}

/**
 * The actor of what a store does on nobody's behalf — a write outside a
 * session, a publish or a draft with no `actor` given: type `store`, and the
 * store's declared name. Every strategy records this one, so an audit row
 * reads the same whatever alias an application imports the strategy under.
 */
export function storeActor(name: string): Actor {
  return { type: "store", id: name };
}

/** A draft as its opener sees it. `id` is the public id; no internal id ever
 *  leaves a store. */
export interface DraftHandle {
  readonly id: string;
  readonly parentRevision: bigint;
  readonly createdAt: Date;
}

export interface DraftSummary extends DraftHandle {
  /** The layer has moved past the draft's parent: it must be rebased to publish. */
  readonly stale: boolean;
  readonly message?: string;
  readonly createdBy: Actor;
}

export interface PublishedRevision {
  readonly number: bigint;
  readonly publishedAt: Date;
}

export const CONFLICT_CLASSES = [
  "changed-both",
  "changed-removed",
  "removed-changed",
  "added-both",
  "endpoint-missing",
] as const;
export type ConflictClass = (typeof CONFLICT_CLASSES)[number];

/**
 * One undecided conflict of a draft. `mine` is what the draft states and
 * `theirs` what the layer now publishes, each absent when that side states no
 * value; `base` is their common ancestor, present only where the strategy
 * keeps one. `token` identifies the conflict in this state: it stops matching
 * once either side moves.
 */
interface Conflict {
  readonly class: ConflictClass;
  /** For `changed-both`: the properties the two sides disagree on. */
  readonly properties?: readonly string[];
  readonly mine?: Record<string, unknown>;
  readonly theirs?: Record<string, unknown>;
  readonly base?: Record<string, unknown>;
  readonly token: string;
}

export interface NodeConflict extends Conflict {
  readonly key: unknown;
}

export interface RelationshipConflict extends Conflict {
  readonly source: unknown;
  readonly target: unknown;
}

/** How one conflict is decided: a side, optionally with property values applied
 *  on top of it. `token`, when given, must still name the conflict. */
export interface ConflictDecision {
  readonly take: "mine" | "theirs";
  readonly set?: Record<string, unknown>;
  readonly token?: string;
  readonly resolvedBy?: Actor;
}

export type DraftNotFound = { readonly status: "draftNotFound" };
/** The draft is no longer open. */
export type DraftClosed = {
  readonly status: "draftClosed";
  readonly closedAs: "published" | "discarded";
  readonly revision?: bigint;
};
/** The draft belongs to another layer. */
export type DraftForeign = { readonly status: "draftForeign" };
export type DraftStale = {
  readonly status: "draftStale";
  readonly parentRevision: bigint;
  readonly headRevision: bigint;
};
export type DraftConflicted = { readonly status: "draftConflicted" };
/** No conflict stands on the key, or the token names one that has since changed. */
export type ConflictNotFound = { readonly status: "conflictNotFound" };
/** The decision cannot apply to this conflict; nothing was written. */
export type ResolutionInvalid = { readonly status: "resolutionInvalid"; readonly reason: string };
export type SessionOpened = { readonly status: "opened" };
/** A stack would hold one layer at two revisions. Answered only by a store
 *  whose layer is built on pinned revisions of others. */
export type BaseRevisionConflict = {
  readonly status: "baseRevisionConflict";
  readonly layer: string;
  readonly revisions: readonly bigint[];
};
/** A stack would hold more layers than it may. Answered only by a store whose
 *  layer is built on pinned revisions of others. */
export type BaseLimit = { readonly status: "baseLimit"; readonly limit: number };

/**
 * The second level of the layered contract: a layer edited in drafts and
 * published atomically. Everything `LayeredGraphStore` promises holds, with one
 * addition to how its operations are reached: inside a draft session on this
 * store they read and write that draft, and outside one they read the published
 * state and write it in place.
 *
 * As beneath, each member answers with a value or an OUTCOME, never a code, and
 * is atomic. A revisioned store extends this interface; no member here changes
 * meaning there.
 *
 * ## Sessions
 *
 * A session is a region of execution, opened by the kind that provides the
 * zone and identified by the zone entry it mints. The store keeps what it knows
 * about a session in a map of its own keyed on that entry — nothing
 * store-private rides the entry — and recognises a call made inside one by the
 * zones correlated on the store in the call's context.
 *
 * `openSession` hands the store the session's own cancellation source. When an
 * operation inside the session finds the draft no longer open, the store
 * cancels that source and the operation stops as a cancellation, so nothing in
 * the body can catch it and continue against a draft that is gone.
 * `closeSession` ends the store's record of the session and reports whether the
 * store closed it, and as what.
 */
export interface DraftedGraphStore extends LayeredGraphStore {
  /** The layer's open draft, opened now when it has none. A store that keeps
   *  one draft per layer answers with the open one and `opened: false`. */
  openDraft(
    request: { readonly message?: string; readonly actor?: Actor },
    ctx?: InvokeContext,
  ): Promise<Found<{ readonly draft: DraftHandle; readonly opened: boolean }>>;

  openSession(
    entry: ZoneEntry,
    draft: string,
    cancellation: CancellationSource,
    ctx?: InvokeContext,
  ): Promise<SessionOpened | DraftNotFound | DraftClosed | DraftForeign>;

  /** Present only when the store itself ended the session, because the draft
   *  was closed under it. */
  closeSession(entry: ZoneEntry): DraftClosed | undefined;

  /**
   * Apply every statement of the draft at once as the layer's next revision.
   * Publishing a published draft answers with its revision; a draft with no
   * change creates none and answers `changed: false`.
   */
  publish(
    draft: string,
    request: { readonly message?: string; readonly actor?: Actor },
    ctx?: InvokeContext,
  ): Promise<
    | Found<{ readonly revision: PublishedRevision; readonly changed: boolean }>
    | DraftNotFound
    | DraftClosed
    | DraftStale
    | DraftConflicted
  >;

  /** `draftClosed` only for a published draft; discarding a discarded one is found. */
  discardDraft(
    draft: string,
    request: { readonly actor?: Actor },
    ctx?: InvokeContext,
  ): Promise<Found<Record<string, never>> | DraftNotFound | DraftClosed>;

  /** Move the draft onto the layer's current revision, merging what merges
   *  cleanly and leaving the rest as conflicts. A store whose layer pins its
   *  bases refuses, with nothing changed, a rebase that would leave the draft
   *  an illegal stack. */
  rebaseDraft(
    draft: string,
    ctx?: InvokeContext,
  ): Promise<
    | Found<{
        readonly parentRevision: bigint;
        readonly merged: number;
        readonly conflicts: number;
      }>
    | DraftNotFound
    | DraftClosed
    | BaseRevisionConflict
    | BaseLimit
  >;

  listDrafts(
    page: GraphPage,
    ctx?: InvokeContext,
  ): Promise<Found<GraphPageResult<DraftSummary>> | CursorInvalid>;

  /** The undecided conflicts of the session's draft on one node type, in key
   *  order. Called inside a session only. */
  nodeConflicts(
    type: GraphNodeType,
    page: GraphPage,
    ctx?: InvokeContext,
  ): Promise<Found<GraphPageResult<NodeConflict>> | CursorInvalid>;

  relationshipConflicts(
    type: GraphRelationshipType,
    page: GraphPage,
    ctx?: InvokeContext,
  ): Promise<Found<GraphPageResult<RelationshipConflict>> | CursorInvalid>;

  /**
   * Decide one conflict of the session's draft, as one conditional write: of
   * two callers deciding the same conflict exactly one applies. Found with the
   * value the session now resolves for the key, absent when it resolves none.
   */
  resolveNodeConflict(
    type: GraphNodeType,
    key: unknown,
    decision: ConflictDecision,
    ctx?: InvokeContext,
  ): Promise<Found<GraphNodeValue> | Absent | ConflictNotFound | ResolutionInvalid>;

  resolveRelationshipConflict(
    type: GraphRelationshipType,
    source: unknown,
    target: unknown,
    decision: ConflictDecision,
    ctx?: InvokeContext,
  ): Promise<Found<GraphRelationshipValue> | Absent | ConflictNotFound | ResolutionInvalid>;
}

export function isDraftedGraphStore(value: unknown): value is DraftedGraphStore {
  const store = value as DraftedGraphStore | undefined;
  return (
    isLayeredGraphStore(value) &&
    typeof store?.openDraft === "function" &&
    typeof store.openSession === "function" &&
    typeof store.closeSession === "function" &&
    typeof store.publish === "function" &&
    typeof store.resolveNodeConflict === "function"
  );
}
