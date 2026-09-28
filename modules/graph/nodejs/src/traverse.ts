import {
  InvokeError,
  integerInput,
  type InvokeContext,
  type ResourceContext,
  type ResourceInstance,
} from "@telorun/sdk";
import {
  assertNodeListed,
  assertRelationshipListed,
  assertTraversable,
  isTraversalDirection,
} from "./graph-model-rules.js";
import type {
  GraphNodeValue,
  GraphStore,
  PreparedTraversal,
  TraversalHop,
  TraversalSpec,
} from "./graph-store.js";
import {
  declaredName,
  describeOperation,
  filterOf,
  pageOf,
  quoteKey,
  resolveNodeType,
  resolveRelationshipType,
  resolveStore,
  type OperationManifest,
} from "./operation-binding.js";

interface HopManifest {
  relationship?: unknown;
  direction?: unknown;
  minHops?: unknown;
  maxHops?: unknown;
}

interface TraverseManifest extends OperationManifest {
  from?: unknown;
  to?: unknown;
  hops?: HopManifest[];
}

interface TraverseInputs {
  key?: unknown;
  where?: unknown;
  limit?: unknown;
  offset?: unknown;
}

class TraverseOperation implements ResourceInstance<TraverseInputs, { nodes: GraphNodeValue[] }> {
  constructor(
    private readonly describe: string,
    private readonly store: GraphStore,
    private readonly prepared: PreparedTraversal,
  ) {}

  async invoke(inputs: TraverseInputs, ctx?: InvokeContext): Promise<{ nodes: GraphNodeValue[] }> {
    const outcome = await this.store.traverse(
      this.prepared,
      inputs?.key,
      filterOf(inputs?.where),
      pageOf(inputs ?? {}, this.describe),
      ctx,
    );
    if (outcome.status === "absent") {
      throw new InvokeError(
        "GRAPH_NODE_NOT_FOUND",
        `${this.describe}: the start node — a '${declaredName(this.prepared.spec.from)}' with ` +
          `key ${quoteKey(inputs?.key)} — does not exist.`,
      );
    }
    return { nodes: outcome.value };
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

function hopBound(value: unknown, fallback: number, field: string, describe: string): number {
  if (value === undefined || value === null) return fallback;
  const bound = integerInput(value);
  if (bound === undefined || bound < 1) {
    throw new Error(`${describe}: '${field}' must be a positive integer literal.`);
  }
  return bound;
}

function readHops(
  resource: TraverseManifest,
  ctx: ResourceContext,
  describe: string,
): TraversalHop[] {
  return (resource.hops ?? []).map((hop, index) => {
    const at = `hops[${index}]`;
    const direction = hop.direction ?? "out";
    if (!isTraversalDirection(direction)) {
      throw new Error(`${describe}: '${at}.direction' must be one of out, in, both.`);
    }
    const minHops = hopBound(hop.minHops, 1, `${at}.minHops`, describe);
    return {
      relationship: resolveRelationshipType(hop.relationship, ctx, describe, `${at}.relationship`),
      direction,
      minHops,
      maxHops: hopBound(hop.maxHops, minHops, `${at}.maxHops`, describe),
    };
  });
}

export const Traverse = {
  register(): void {},
  async create(resource: TraverseManifest, ctx: ResourceContext): Promise<TraverseOperation> {
    const describe = describeOperation("Traverse", resource);
    const store = resolveStore(resource, ctx, describe);
    const spec: TraversalSpec = {
      from: resolveNodeType(resource.from, ctx, describe, "from"),
      to: resolveNodeType(resource.to, ctx, describe, "to"),
      hops: readHops(resource, ctx, describe),
    };
    if (spec.hops.length === 0) {
      throw new Error(`${describe}: 'hops' must list at least one hop.`);
    }
    assertNodeListed(describe, "from", spec.from, store.nodes, declaredName);
    assertNodeListed(describe, "to", spec.to, store.nodes, declaredName);
    spec.hops.forEach((hop, index) =>
      assertRelationshipListed(
        describe,
        `hops[${index}].relationship`,
        hop.relationship,
        store.relationships,
        declaredName,
      ),
    );
    assertTraversable(describe, spec, declaredName);
    return new TraverseOperation(describe, store, store.prepareTraversal(spec));
  },
};
