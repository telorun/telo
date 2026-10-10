import {
  InvokeError,
  type InvokeContext,
  type ResourceContext,
  type ResourceInstance,
} from "@telorun/sdk";
import { assertNodeListed } from "./graph-model-rules.js";
import type { GraphNodeType, GraphNodeValue, GraphStore } from "./graph-store.js";
import {
  boundName,
  declaredName,
  quoteKey,
  describeOperation,
  Listing,
  propertiesOf,
  resolveNodeType,
  resolveStore,
  type OperationManifest,
} from "./operation-binding.js";

interface NodeOperationManifest extends OperationManifest {
  node?: unknown;
}

interface NodeInputs {
  key?: unknown;
  properties?: unknown;
  where?: unknown;
  limit?: unknown;
  cursor?: unknown;
}

/** What one node operation does with the store, given the bound type. */
type NodeCall<Output> = (
  bound: BoundNodeOperation,
  inputs: NodeInputs,
  ctx: InvokeContext | undefined,
) => Promise<Output>;

interface BoundNodeOperation {
  readonly describe: string;
  readonly store: GraphStore;
  readonly type: GraphNodeType;
}

class NodeOperation<Output> implements ResourceInstance<NodeInputs, Output> {
  constructor(
    private readonly bound: BoundNodeOperation,
    private readonly call: NodeCall<Output>,
  ) {}

  invoke(inputs: NodeInputs, ctx?: InvokeContext): Promise<Output> {
    return this.call(this.bound, inputs ?? {}, ctx);
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

function nodeOperation<Output>(kind: string, call: NodeCall<Output>) {
  return {
    register(): void {},
    async create(
      resource: NodeOperationManifest,
      ctx: ResourceContext,
    ): Promise<NodeOperation<Output>> {
      const describe = describeOperation(kind, resource);
      const store = resolveStore(resource, ctx, describe);
      const type = resolveNodeType(resource.node, ctx, describe, "node");
      assertNodeListed(describe, "node", type, store.nodes, declaredName);
      return new NodeOperation({ describe, store, type }, call);
    },
  };
}

function notFound(bound: BoundNodeOperation, key: unknown): never {
  throw new InvokeError(
    "GRAPH_NODE_NOT_FOUND",
    `${bound.describe}: no '${declaredName(bound.type)}' node has key ${quoteKey(key)}.`,
  );
}

export const CreateNode = nodeOperation<{ node: GraphNodeValue }>(
  "CreateNode",
  async (bound, inputs, ctx) => {
    const outcome = await bound.store.createNode(
      bound.type,
      inputs.key,
      propertiesOf(inputs.properties),
      ctx,
    );
    if (outcome.status === "exists") {
      throw new InvokeError(
        "GRAPH_NODE_EXISTS",
        `${bound.describe}: a '${declaredName(bound.type)}' node already has key ` +
          `${quoteKey(inputs.key)}.`,
      );
    }
    return { node: outcome.value };
  },
);

export const MergeNode = nodeOperation<{ node: GraphNodeValue }>(
  "MergeNode",
  async (bound, inputs, ctx) => {
    const outcome = await bound.store.mergeNode(
      bound.type,
      inputs.key,
      propertiesOf(inputs.properties),
      ctx,
    );
    return { node: outcome.value };
  },
);

export const UpdateNode = nodeOperation<{ node: GraphNodeValue }>(
  "UpdateNode",
  async (bound, inputs, ctx) => {
    const outcome = await bound.store.updateNode(
      bound.type,
      inputs.key,
      propertiesOf(inputs.properties),
      ctx,
    );
    if (outcome.status === "absent") notFound(bound, inputs.key);
    return { node: outcome.value };
  },
);

export const DeleteNode = nodeOperation<{ node: GraphNodeValue }>(
  "DeleteNode",
  async (bound, inputs, ctx) => {
    const outcome = await bound.store.deleteNode(bound.type, inputs.key, ctx);
    if (outcome.status === "absent") notFound(bound, inputs.key);
    return { node: outcome.value };
  },
);

export const GetNode = nodeOperation<{ node: GraphNodeValue }>(
  "GetNode",
  async (bound, inputs, ctx) => {
    const outcome = await bound.store.getNode(bound.type, inputs.key, ctx);
    if (outcome.status === "absent") notFound(bound, inputs.key);
    return { node: outcome.value };
  },
);

export const FindNodes = nodeOperation<{ nodes: GraphNodeValue[]; next?: string }>(
  "FindNodes",
  async (bound, inputs, ctx) => {
    const listing = new Listing(bound.describe, inputs, {
      operation: "FindNodes",
      store: boundName(bound.store, bound.describe, "store"),
      type: boundName(bound.type, bound.describe, "node"),
    });
    const { items, ...more } = listing.result(
      await bound.store.findNodes(bound.type, listing.where, listing.page, ctx),
    );
    return { nodes: items, ...more };
  },
);
