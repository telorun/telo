import {
  InvokeError,
  type InvokeContext,
  type ResourceContext,
  type ResourceInstance,
} from "@telorun/sdk";
import {
  assertNodeListed,
  assertRelationshipListed,
  declaredName,
  isGraphNodeType,
  isGraphRelationshipType,
  quoteKey,
  type GraphNodeType,
  type GraphNodeValue,
  type GraphRelationshipType,
  type GraphRelationshipValue,
} from "@telorun/graph";
import { isLayeredGraphStore, type LayeredGraphStore } from "./layered-graph-store.js";

interface RetractManifest {
  metadata: { name: string; module?: string };
  store?: unknown;
  node?: unknown;
  relationship?: unknown;
}

/** The store slot of a lifecycle kind: a layered store, never a plain one. */
export function resolveLayeredStore(
  value: unknown,
  ctx: ResourceContext,
  describe: string,
): LayeredGraphStore {
  return ctx.resolveRef(value, isLayeredGraphStore, () => `${describe}: 'store'`, "GraphLayers.Store");
}

class RetractNodeOperation implements ResourceInstance {
  constructor(
    private readonly describe: string,
    private readonly store: LayeredGraphStore,
    private readonly type: GraphNodeType,
  ) {}

  async invoke(
    inputs: { key?: unknown },
    ctx?: InvokeContext,
  ): Promise<{ node?: GraphNodeValue }> {
    const outcome = await this.store.retractNode(this.type, inputs?.key, ctx);
    if (outcome.status === "notStated") {
      throw new InvokeError(
        "GRAPH_NODE_NOT_STATED",
        `${this.describe}: layer '${this.store.layer}' states nothing for '${declaredName(this.type)}' ` +
          `key ${quoteKey(inputs?.key)}.`,
      );
    }
    return outcome.status === "found" ? { node: outcome.value } : {};
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

class RetractRelationshipOperation implements ResourceInstance {
  constructor(
    private readonly describe: string,
    private readonly store: LayeredGraphStore,
    private readonly type: GraphRelationshipType,
  ) {}

  async invoke(
    inputs: { source?: unknown; target?: unknown },
    ctx?: InvokeContext,
  ): Promise<{ relationship?: GraphRelationshipValue }> {
    const outcome = await this.store.retractRelationship(
      this.type,
      inputs?.source,
      inputs?.target,
      ctx,
    );
    if (outcome.status === "notStated") {
      throw new InvokeError(
        "GRAPH_RELATIONSHIP_NOT_STATED",
        `${this.describe}: layer '${this.store.layer}' states nothing for the ` +
          `'${declaredName(this.type)}' relationship ${quoteKey(inputs?.source)} -> ` +
          `${quoteKey(inputs?.target)}.`,
      );
    }
    return outcome.status === "found" ? { relationship: outcome.value } : {};
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

export const RetractNode = {
  register(): void {},
  async create(resource: RetractManifest, ctx: ResourceContext): Promise<RetractNodeOperation> {
    const describe = `GraphLayers.RetractNode "${resource.metadata.name}"`;
    const store = resolveLayeredStore(resource.store, ctx, describe);
    const type = ctx.resolveRef(
      resource.node,
      isGraphNodeType,
      () => `${describe}: 'node'`,
      "Graph.Node",
    );
    assertNodeListed(describe, "node", type, store.nodes, declaredName);
    return new RetractNodeOperation(describe, store, type);
  },
};

export const RetractRelationship = {
  register(): void {},
  async create(
    resource: RetractManifest,
    ctx: ResourceContext,
  ): Promise<RetractRelationshipOperation> {
    const describe = `GraphLayers.RetractRelationship "${resource.metadata.name}"`;
    const store = resolveLayeredStore(resource.store, ctx, describe);
    const type = ctx.resolveRef(
      resource.relationship,
      isGraphRelationshipType,
      () => `${describe}: 'relationship'`,
      "Graph.Relationship",
    );
    assertRelationshipListed(describe, "relationship", type, store.relationships, declaredName);
    return new RetractRelationshipOperation(describe, store, type);
  },
};
