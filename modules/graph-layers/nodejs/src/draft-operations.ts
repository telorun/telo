import {
  celTimestampFromMillis,
  InvokeError,
  isCelTimestamp,
  type InvokeContext,
  type ResourceContext,
  type ResourceInstance,
} from "@telorun/sdk";
import {
  isDraftedGraphStore,
  type Actor,
  type DraftedGraphStore,
  type DraftHandle,
} from "./drafted-graph-store.js";
import { boundName, declaredName, GraphListing } from "@telorun/graph";

interface DraftOperationManifest {
  metadata: { name: string; module?: string };
  store?: unknown;
}

interface DraftInputs {
  draft?: unknown;
  message?: unknown;
  actor?: unknown;
  limit?: unknown;
  cursor?: unknown;
}

/** The store slot of a drafting kind: a drafted store, never a lower level. */
export function resolveDraftedStore(
  value: unknown,
  ctx: ResourceContext,
  describe: string,
): DraftedGraphStore {
  return ctx.resolveRef(
    value,
    isDraftedGraphStore,
    () => `${describe}: 'store'`,
    "GraphLayers.DraftedStore",
  );
}

/** An instant as an operation returns it: a native timestamp. */
export function instant(describe: string, date: Date): unknown {
  const value = celTimestampFromMillis(date.getTime());
  if (!isCelTimestamp(value)) {
    throw new Error(`${describe}: the store returned an instant outside the timestamp range.`);
  }
  return value;
}

export function actorOf(value: unknown): Actor | undefined {
  const actor = value as Partial<Actor> | undefined | null;
  return actor && typeof actor.type === "string" && typeof actor.id === "string"
    ? { type: actor.type, id: actor.id }
    : undefined;
}

export function draftIdOf(describe: string, value: unknown): string {
  if (typeof value !== "string" || value === "") {
    throw new Error(`${describe}: 'draft' must be a draft id.`);
  }
  return value;
}

export function draftNotFound(describe: string, store: DraftedGraphStore, draft: string): never {
  throw new InvokeError(
    "GRAPH_DRAFT_NOT_FOUND",
    `${describe}: layer '${store.layer}' of store '${declaredName(store)}' has no draft '${draft}'.`,
    { draft },
  );
}

function draftValue(describe: string, draft: DraftHandle): Record<string, unknown> {
  return {
    id: draft.id,
    parentRevision: draft.parentRevision,
    createdAt: instant(describe, draft.createdAt),
  };
}

type DraftCall = (
  describe: string,
  store: DraftedGraphStore,
  inputs: DraftInputs,
  ctx: InvokeContext | undefined,
) => Promise<Record<string, unknown>>;

class DraftOperation implements ResourceInstance<DraftInputs, Record<string, unknown>> {
  constructor(
    private readonly describe: string,
    private readonly store: DraftedGraphStore,
    private readonly call: DraftCall,
  ) {}

  invoke(inputs: DraftInputs, ctx?: InvokeContext): Promise<Record<string, unknown>> {
    return this.call(this.describe, this.store, inputs ?? {}, ctx);
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

function draftOperation(kind: string, call: DraftCall) {
  return {
    register(): void {},
    async create(resource: DraftOperationManifest, ctx: ResourceContext): Promise<DraftOperation> {
      const describe = `GraphLayers.${kind} "${resource.metadata.name}"`;
      return new DraftOperation(describe, resolveDraftedStore(resource.store, ctx, describe), call);
    },
  };
}

export const OpenDraft = draftOperation("OpenDraft", async (describe, store, inputs, ctx) => {
  const { value } = await store.openDraft(
    {
      ...(typeof inputs.message === "string" ? { message: inputs.message } : {}),
      actor: actorOf(inputs.actor),
    },
    ctx,
  );
  return { draft: draftValue(describe, value.draft), opened: value.opened };
});

export const Publish = draftOperation("Publish", async (describe, store, inputs, ctx) => {
  const draft = draftIdOf(describe, inputs.draft);
  const outcome = await store.publish(
    draft,
    {
      ...(typeof inputs.message === "string" ? { message: inputs.message } : {}),
      actor: actorOf(inputs.actor),
    },
    ctx,
  );
  switch (outcome.status) {
    case "found":
      return {
        revision: {
          number: outcome.value.revision.number,
          publishedAt: instant(describe, outcome.value.revision.publishedAt),
        },
        changed: outcome.value.changed,
      };
    case "draftNotFound":
      return draftNotFound(describe, store, draft);
    case "draftClosed":
      throw new InvokeError(
        "GRAPH_DRAFT_DISCARDED",
        `${describe}: draft '${draft}' was discarded, so it holds nothing to publish.`,
        { draft },
      );
    case "draftStale":
      throw new InvokeError(
        "GRAPH_DRAFT_STALE",
        `${describe}: draft '${draft}' stands on revision ${outcome.parentRevision} of layer ` +
          `'${store.layer}', which is now at ${outcome.headRevision}. Rebase the draft, decide ` +
          `its conflicts, and publish again.`,
        {
          draft,
          parentRevision: outcome.parentRevision,
          headRevision: outcome.headRevision,
        },
      );
    case "draftConflicted":
      throw new InvokeError(
        "GRAPH_DRAFT_CONFLICTED",
        `${describe}: draft '${draft}' has conflicts left undecided, or states a relationship ` +
          `whose endpoint does not resolve. List them inside a session on the draft and ` +
          `resolve each.`,
        { draft },
      );
  }
});

export const DiscardDraft = draftOperation("DiscardDraft", async (describe, store, inputs, ctx) => {
  const draft = draftIdOf(describe, inputs.draft);
  const outcome = await store.discardDraft(draft, { actor: actorOf(inputs.actor) }, ctx);
  if (outcome.status === "draftNotFound") return draftNotFound(describe, store, draft);
  if (outcome.status === "draftClosed") {
    throw new InvokeError(
      "GRAPH_DRAFT_PUBLISHED",
      `${describe}: draft '${draft}' was published, so there is nothing left to discard.`,
      { draft, ...(outcome.revision === undefined ? {} : { revision: outcome.revision }) },
    );
  }
  return {};
});

export function draftClosed(
  describe: string,
  draft: string,
  closed: { closedAs: "published" | "discarded"; revision?: bigint },
): never {
  throw new InvokeError(
    "GRAPH_DRAFT_CLOSED",
    `${describe}: draft '${draft}' is no longer open — it was ${closed.closedAs}.`,
    {
      draft,
      closedAs: closed.closedAs,
      ...(closed.revision === undefined ? {} : { revision: closed.revision }),
    },
  );
}

/** A stack that would hold one layer at two revisions. */
export function baseRevisionConflict(
  describe: string,
  outcome: { readonly layer: string; readonly revisions: readonly bigint[] },
  remedy: string,
): never {
  throw new InvokeError(
    "GRAPH_BASE_REVISION_CONFLICT",
    `${describe}: the stack would hold layer '${outcome.layer}' at revisions ` +
      `${outcome.revisions.join(" and ")}. ${remedy}`,
    { layer: outcome.layer, revisions: [...outcome.revisions] },
  );
}

/** A stack that would hold more layers than it may. */
export function baseLimit(describe: string, outcome: { readonly limit: number }): never {
  throw new InvokeError(
    "GRAPH_BASE_LIMIT",
    `${describe}: the stack would hold more than ${outcome.limit} layers, the store's own included.`,
    { limit: outcome.limit },
  );
}

export const RebaseDraft = draftOperation("RebaseDraft", async (describe, store, inputs, ctx) => {
  const draft = draftIdOf(describe, inputs.draft);
  const outcome = await store.rebaseDraft(draft, ctx);
  switch (outcome.status) {
    case "found":
      return { ...outcome.value };
    case "draftNotFound":
      return draftNotFound(describe, store, draft);
    case "draftClosed":
      return draftClosed(describe, draft, outcome);
    case "baseRevisionConflict":
      return baseRevisionConflict(
        describe,
        outcome,
        "The draft's own pin changes do not fit the pins the layer now has: nothing was " +
          "changed. Pin again inside the draft and rebase.",
      );
    case "baseLimit":
      return baseLimit(describe, outcome);
  }
});

export const ListDrafts = draftOperation("ListDrafts", async (describe, store, inputs, ctx) => {
  const listing = new GraphListing(describe, inputs, {
    operation: "GraphLayers.ListDrafts",
    store: boundName(store, describe, "store"),
  });
  const { items, next } = listing.result(await store.listDrafts(listing.page, ctx));
  return {
    drafts: items.map((draft) => ({
      ...draftValue(describe, draft),
      stale: draft.stale,
      ...(draft.message === undefined ? {} : { message: draft.message }),
      createdBy: draft.createdBy,
    })),
    ...(next === undefined ? {} : { next }),
  };
});
