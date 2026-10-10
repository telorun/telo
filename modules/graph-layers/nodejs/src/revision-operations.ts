import {
  InvokeError,
  type InvokeContext,
  type ResourceContext,
  type ResourceInstance,
} from "@telorun/sdk";
import { boundName, declaredName, GraphListing } from "@telorun/graph";
import { instant } from "./draft-operations.js";
import {
  isRevisionedGraphStore,
  REVISION_ORDERS,
  type PinnedBase,
  type RevisionedGraphStore,
  type RevisionOrder,
} from "./revisioned-graph-store.js";

interface RevisionOperationManifest {
  metadata: { name: string; module?: string };
  store?: unknown;
}

interface ListRevisionsInputs {
  order?: unknown;
  after?: unknown;
  layer?: unknown;
  limit?: unknown;
  cursor?: unknown;
}

/** The store slot of a kind that reads history: a revisioned store, never a
 *  lower level. */
export function resolveRevisionedStore(
  value: unknown,
  ctx: ResourceContext,
  describe: string,
): RevisionedGraphStore {
  return ctx.resolveRef(
    value,
    isRevisionedGraphStore,
    () => `${describe}: 'store'`,
    "GraphLayers.RevisionedStore",
  );
}

function orderOf(describe: string, value: unknown): RevisionOrder {
  if (value === undefined || value === null) return "descending";
  const order = REVISION_ORDERS.find((known) => known === value);
  if (!order) {
    throw new Error(`${describe}: 'order' must be one of ${REVISION_ORDERS.join(", ")}.`);
  }
  return order;
}

/** A revision number as an input holds it: an int64 from CEL or a plain integer. */
function revisionOf(describe: string, value: unknown): bigint | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "bigint" && value >= 0n) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  throw new Error(`${describe}: 'after' must be a revision number, got ${String(value)}.`);
}

/** A base list as an operation returns it. */
export function basesValue(bases: readonly PinnedBase[]): Record<string, unknown>[] {
  return bases.map((base) => ({
    layer: base.layer,
    revision: base.revision,
    ...(base.label === undefined ? {} : { label: base.label }),
    position: base.position,
  }));
}

export function layerNotFound(
  describe: string,
  store: RevisionedGraphStore,
  layer: string,
): never {
  throw new InvokeError(
    "GRAPH_LAYER_NOT_FOUND",
    `${describe}: no layer '${layer}' is registered in the tables of store ` +
      `'${declaredName(store)}'. A layer is registered when a store naming it is first used.`,
    { layer },
  );
}

class ListRevisionsOperation
  implements ResourceInstance<ListRevisionsInputs, Record<string, unknown>>
{
  constructor(
    private readonly describe: string,
    private readonly store: RevisionedGraphStore,
  ) {}

  async invoke(
    inputs: ListRevisionsInputs,
    ctx?: InvokeContext,
  ): Promise<Record<string, unknown>> {
    const { describe, store } = this;
    const order = orderOf(describe, inputs?.order);
    const after = revisionOf(describe, inputs?.after);
    const layer = typeof inputs?.layer === "string" && inputs.layer !== "" ? inputs.layer : undefined;
    // The layer, the order and the lower bound select the listing, so a cursor
    // is bound to all three: one read newest-first is never followed
    // oldest-first, nor one layer's over another's.
    const listing = new GraphListing(describe, inputs ?? {}, {
      operation: "GraphLayers.ListRevisions",
      store: boundName(store, describe, "store"),
      layer: layer ?? null,
      order,
      after: after === undefined ? null : after.toString(),
    });
    const outcome = await store.listRevisions(
      { order, ...(after === undefined ? {} : { after }), ...(layer === undefined ? {} : { layer }) },
      listing.page,
      ctx,
    );
    if (outcome.status === "layerNotFound") return layerNotFound(describe, store, outcome.layer);
    const { items, next } = listing.result(outcome);
    return {
      revisions: items.map((revision) => ({
        number: revision.number,
        ...(revision.label === undefined ? {} : { label: revision.label }),
        ...(revision.message === undefined ? {} : { message: revision.message }),
        publishedAt: instant(describe, revision.publishedAt),
        publishedBy: revision.publishedBy,
        bases: basesValue(revision.bases),
      })),
      ...(next === undefined ? {} : { next }),
    };
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

export const ListRevisions = {
  register(): void {},
  async create(
    resource: RevisionOperationManifest,
    ctx: ResourceContext,
  ): Promise<ListRevisionsOperation> {
    const describe = `GraphLayers.ListRevisions "${resource.metadata.name}"`;
    return new ListRevisionsOperation(
      describe,
      resolveRevisionedStore(resource.store, ctx, describe),
    );
  },
};
