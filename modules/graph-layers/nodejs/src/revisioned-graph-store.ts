import type { InvokeContext } from "@telorun/sdk";
import type { CursorInvalid, Found, GraphPage, GraphPageResult } from "@telorun/graph";
import {
  isDraftedGraphStore,
  type Actor,
  type BaseLimit,
  type BaseRevisionConflict,
  type DraftConflicted,
  type DraftedGraphStore,
} from "./drafted-graph-store.js";

/** The most layers one resolved stack holds, the store's own included. */
export const BASE_STACK_LIMIT = 32;

const REVISION_LABEL = /^[A-Za-z0-9._+-]*[A-Za-z._+-][A-Za-z0-9._+-]*$/;

/** A label: 1 to 128 letters, digits, `.`, `_`, `+` or `-`, at least one of
 *  them no digit — so a label is never read as a revision number. */
export function isRevisionLabel(value: unknown): value is string {
  return typeof value === "string" && value.length <= 128 && REVISION_LABEL.test(value);
}

/** One layer another is directly built on, at the revision it is pinned to. */
export interface PinnedBase {
  readonly layer: string;
  readonly revision: bigint;
  /** The pinned revision's label, when it has one. */
  readonly label?: string;
  readonly position: number;
}

/** One pin to set. `revision`: a number, a label, or — omitted — the base's
 *  head at the call. `position` omitted keeps an already-pinned layer's place
 *  and appends a new one. */
export interface BasePinRequest {
  readonly layer: string;
  readonly revision?: bigint | string;
  readonly position?: number;
}

/** One published revision of a layer, as its history lists it. */
export interface RevisionSummary {
  readonly number: bigint;
  readonly label?: string;
  readonly message?: string;
  readonly publishedAt: Date;
  readonly publishedBy: Actor;
  /** The revision's direct pins, in position order. */
  readonly bases: readonly PinnedBase[];
}

export const REVISION_ORDERS = ["descending", "ascending"] as const;
export type RevisionOrder = (typeof REVISION_ORDERS)[number];

export type LayerNotFound = { readonly status: "layerNotFound"; readonly layer: string };
export type RevisionNotFound = {
  readonly status: "revisionNotFound";
  readonly layer: string;
  readonly revision: bigint | string;
};
/** The store's own layer would lie beneath itself, reached through `layer`. */
export type BaseCycle = { readonly status: "baseCycle"; readonly layer: string };
export type BaseNotPinned = { readonly status: "baseNotPinned"; readonly layer: string };
/** The label names another revision of the layer: `revision`. */
export type RevisionLabelExists = {
  readonly status: "revisionLabelExists";
  readonly label: string;
  readonly revision: bigint;
};
/** The revision carries another label: `label`. */
export type RevisionLabelled = {
  readonly status: "revisionLabelled";
  readonly revision: bigint;
  readonly label: string;
};

/** A base list after a move, with what the move did to the layer's own
 *  statements. A move that changed nothing answers the list with both zero. */
export type BasesMoved = Found<{
  readonly bases: readonly PinnedBase[];
  readonly merged: number;
  readonly conflicts: number;
}>;

/**
 * The third level of the layered contract: a layer that keeps every revision it
 * published. Everything `DraftedGraphStore` promises holds, and this is
 * promised on top:
 *
 * - a draft is isolated at its parent revision — a session reads the draft over
 *   the layer as that revision left it, whatever is published meanwhile — and
 *   any number of drafts are open on a layer at once, so `openDraft` always
 *   opens one;
 * - rebasing merges three ways, per property, against the row the draft was
 *   written over, and a conflict carries that ancestor as `base`;
 * - a read outside a session stays on the revision its first page was read at;
 * - the layers beneath are PINNED: the stack is the layer, then each direct
 *   base in position order followed by that base's own base list at the pinned
 *   revision. A base publishing again changes nothing above until a pin moves,
 *   and a moved pin is merged like a moved layer.
 *
 * `pinBases`, `unpinBase` and `listBases` follow the session: inside one they
 * act on the draft, outside one on the layer's head — where a change is one
 * published revision, refused as `draftConflicted` with nothing changed when it
 * would leave a conflict. `labelRevision` and `listRevisions` do not.
 *
 * As beneath, each member answers with a value or an OUTCOME, never a code, and
 * is atomic.
 */
export interface RevisionedGraphStore extends DraftedGraphStore {
  /**
   * The published revisions of `layer` — the store's own when omitted, else any
   * layer registered in the same tables — in `order`, those numbered above
   * `after` when it is given. Numbers are consecutive from 1, so a reader that
   * holds revision N and is answered N + 2 first has missed one.
   */
  listRevisions(
    request: {
      readonly order: RevisionOrder;
      readonly after?: bigint;
      readonly layer?: string;
    },
    page: GraphPage,
    ctx?: InvokeContext,
  ): Promise<Found<GraphPageResult<RevisionSummary>> | CursorInvalid | LayerNotFound>;

  /** Set several pins as one move. A layer named twice is a revision conflict. */
  pinBases(
    bases: readonly BasePinRequest[],
    ctx?: InvokeContext,
  ): Promise<
    | BasesMoved
    | LayerNotFound
    | RevisionNotFound
    | BaseCycle
    | BaseRevisionConflict
    | BaseLimit
    | DraftConflicted
  >;

  unpinBase(
    layer: string,
    ctx?: InvokeContext,
  ): Promise<BasesMoved | BaseNotPinned | DraftConflicted>;

  /** The direct pins, whole: a stack is bounded. */
  listBases(ctx?: InvokeContext): Promise<Found<readonly PinnedBase[]>>;

  /** Names a published revision of the store's own layer, for good. Found also
   *  when the label already names that revision. */
  labelRevision(
    request: { readonly revision: bigint; readonly label: string; readonly actor?: Actor },
    ctx?: InvokeContext,
  ): Promise<
    | Found<{ readonly number: bigint; readonly label: string }>
    | RevisionNotFound
    | RevisionLabelExists
    | RevisionLabelled
  >;
}

export function isRevisionedGraphStore(value: unknown): value is RevisionedGraphStore {
  const store = value as RevisionedGraphStore | undefined;
  return (
    isDraftedGraphStore(value) &&
    typeof store?.listRevisions === "function" &&
    typeof store.pinBases === "function" &&
    typeof store.unpinBase === "function" &&
    typeof store.listBases === "function" &&
    typeof store.labelRevision === "function"
  );
}
