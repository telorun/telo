import {
  InvokeError,
  type InvokeContext,
  type ResourceContext,
  type ResourceInstance,
} from "@telorun/sdk";
import {
  assertNodeListed,
  assertRelationshipListed,
  boundName,
  declaredName,
  GraphListing,
  isGraphNodeType,
  isGraphRelationshipType,
  quoteKey,
  type Absent,
  type Found,
  type GraphNodeType,
  type GraphRelationshipType,
} from "@telorun/graph";
import type {
  ConflictDecision,
  ConflictNotFound,
  DraftedGraphStore,
  ResolutionInvalid,
} from "./drafted-graph-store.js";
import { actorOf, resolveDraftedStore } from "./draft-operations.js";

interface ConflictManifest {
  metadata: { name: string; module?: string };
  store?: unknown;
  node?: unknown;
  relationship?: unknown;
}

interface ConflictInputs {
  key?: unknown;
  source?: unknown;
  target?: unknown;
  take?: unknown;
  set?: unknown;
  token?: unknown;
  resolvedBy?: unknown;
  limit?: unknown;
  cursor?: unknown;
}

interface Bound<Type> {
  readonly describe: string;
  readonly store: DraftedGraphStore;
  readonly type: Type;
}

type ConflictCall<Type> = (
  bound: Bound<Type>,
  inputs: ConflictInputs,
  ctx: InvokeContext | undefined,
) => Promise<Record<string, unknown>>;

/**
 * A conflict is listed and decided inside a session on the operation's store —
 * `x-telo-requires-zone` on `store`, asserted here against the context the
 * call arrived with before the store is asked anything.
 */
class ConflictOperation<Type> implements ResourceInstance<ConflictInputs, Record<string, unknown>> {
  constructor(
    private readonly ctx: ResourceContext,
    private readonly bound: Bound<Type>,
    private readonly call: ConflictCall<Type>,
  ) {}

  invoke(inputs: ConflictInputs, ctx?: InvokeContext): Promise<Record<string, unknown>> {
    this.ctx.requireZone("store", ctx);
    return this.call(this.bound, inputs ?? {}, ctx);
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

function conflictOperation<Type extends object>(
  kind: string,
  field: "node" | "relationship",
  guard: (value: unknown) => value is Type,
  expects: string,
  assertListed: (describe: string, type: Type, store: DraftedGraphStore) => void,
  call: ConflictCall<Type>,
) {
  return {
    register(): void {},
    async create(
      resource: ConflictManifest,
      ctx: ResourceContext,
    ): Promise<ConflictOperation<Type>> {
      const describe = `GraphLayers.${kind} "${resource.metadata.name}"`;
      const store = resolveDraftedStore(resource.store, ctx, describe);
      const type = ctx.resolveRef(resource[field], guard, () => `${describe}: '${field}'`, expects);
      assertListed(describe, type, store);
      return new ConflictOperation(ctx, { describe, store, type }, call);
    },
  };
}

function decisionOf(describe: string, inputs: ConflictInputs): ConflictDecision {
  if (inputs.take !== "mine" && inputs.take !== "theirs") {
    throw new Error(`${describe}: 'take' must be 'mine' or 'theirs'.`);
  }
  return {
    take: inputs.take,
    ...(inputs.set && typeof inputs.set === "object"
      ? { set: inputs.set as Record<string, unknown> }
      : {}),
    ...(typeof inputs.token === "string" ? { token: inputs.token } : {}),
    resolvedBy: actorOf(inputs.resolvedBy),
  };
}

/** The codes a decision's outcomes earn; what is left is the resolved value. */
function decided<T>(
  describe: string,
  subject: string,
  outcome: Found<T> | Absent | ConflictNotFound | ResolutionInvalid,
): T | undefined {
  if (outcome.status === "conflictNotFound") {
    throw new InvokeError(
      "GRAPH_CONFLICT_NOT_FOUND",
      `${describe}: no conflict stands on ${subject}, or the token names one that has since ` +
        `changed. List the conflicts again.`,
    );
  }
  if (outcome.status === "resolutionInvalid") {
    throw new InvokeError(
      "GRAPH_RESOLUTION_INVALID",
      `${describe}: the decision cannot apply to the conflict on ${subject}: ${outcome.reason}`,
    );
  }
  return outcome.status === "found" ? outcome.value : undefined;
}

const nodeConflictOperation = (kind: string, call: ConflictCall<GraphNodeType>) =>
  conflictOperation(
    kind,
    "node",
    isGraphNodeType,
    "Graph.Node",
    (describe, type, store) => assertNodeListed(describe, "node", type, store.nodes, declaredName),
    call,
  );

const relationshipConflictOperation = (kind: string, call: ConflictCall<GraphRelationshipType>) =>
  conflictOperation(
    kind,
    "relationship",
    isGraphRelationshipType,
    "Graph.Relationship",
    (describe, type, store) =>
      assertRelationshipListed(describe, "relationship", type, store.relationships, declaredName),
    call,
  );

export const NodeConflicts = nodeConflictOperation("NodeConflicts", async (bound, inputs, ctx) => {
  const listing = new GraphListing(bound.describe, inputs, {
    operation: "GraphLayers.NodeConflicts",
    store: boundName(bound.store, bound.describe, "store"),
    type: boundName(bound.type, bound.describe, "node"),
  });
  const { items, next } = listing.result(
    await bound.store.nodeConflicts(bound.type, listing.page, ctx),
  );
  return { conflicts: items, ...(next === undefined ? {} : { next }) };
});

export const RelationshipConflicts = relationshipConflictOperation(
  "RelationshipConflicts",
  async (bound, inputs, ctx) => {
    const listing = new GraphListing(bound.describe, inputs, {
      operation: "GraphLayers.RelationshipConflicts",
      store: boundName(bound.store, bound.describe, "store"),
      type: boundName(bound.type, bound.describe, "relationship"),
    });
    const { items, next } = listing.result(
      await bound.store.relationshipConflicts(bound.type, listing.page, ctx),
    );
    return { conflicts: items, ...(next === undefined ? {} : { next }) };
  },
);

export const ResolveNodeConflict = nodeConflictOperation(
  "ResolveNodeConflict",
  async (bound, inputs, ctx) => {
    const node = decided(
      bound.describe,
      `'${declaredName(bound.type)}' key ${quoteKey(inputs.key)}`,
      await bound.store.resolveNodeConflict(
        bound.type,
        inputs.key,
        decisionOf(bound.describe, inputs),
        ctx,
      ),
    );
    return node ? { node } : {};
  },
);

export const ResolveRelationshipConflict = relationshipConflictOperation(
  "ResolveRelationshipConflict",
  async (bound, inputs, ctx) => {
    const relationship = decided(
      bound.describe,
      `the '${declaredName(bound.type)}' relationship ${quoteKey(inputs.source)} -> ` +
        `${quoteKey(inputs.target)}`,
      await bound.store.resolveRelationshipConflict(
        bound.type,
        inputs.source,
        inputs.target,
        decisionOf(bound.describe, inputs),
        ctx,
      ),
    );
    return relationship ? { relationship } : {};
  },
);
