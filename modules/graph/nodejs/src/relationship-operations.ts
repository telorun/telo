import {
  InvokeError,
  type InvokeContext,
  type ResourceContext,
  type ResourceInstance,
} from "@telorun/sdk";
import { assertRelationshipListed } from "./graph-model-rules.js";
import type { GraphRelationshipType, GraphRelationshipValue, GraphStore } from "./graph-store.js";
import {
  declaredName,
  quoteKey,
  describeOperation,
  filterOf,
  pageOf,
  propertiesOf,
  resolveRelationshipType,
  resolveStore,
  type OperationManifest,
} from "./operation-binding.js";

interface RelationshipOperationManifest extends OperationManifest {
  relationship?: unknown;
}

interface RelationshipInputs {
  source?: unknown;
  target?: unknown;
  properties?: unknown;
  where?: unknown;
  limit?: unknown;
  offset?: unknown;
}

interface BoundRelationshipOperation {
  readonly describe: string;
  readonly store: GraphStore;
  readonly type: GraphRelationshipType;
}

type RelationshipCall<Output> = (
  bound: BoundRelationshipOperation,
  inputs: RelationshipInputs,
  ctx: InvokeContext | undefined,
) => Promise<Output>;

class RelationshipOperation<Output> implements ResourceInstance<RelationshipInputs, Output> {
  constructor(
    private readonly bound: BoundRelationshipOperation,
    private readonly call: RelationshipCall<Output>,
  ) {}

  invoke(inputs: RelationshipInputs, ctx?: InvokeContext): Promise<Output> {
    return this.call(this.bound, inputs ?? {}, ctx);
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

function relationshipOperation<Output>(kind: string, call: RelationshipCall<Output>) {
  return {
    register(): void {},
    async create(
      resource: RelationshipOperationManifest,
      ctx: ResourceContext,
    ): Promise<RelationshipOperation<Output>> {
      const describe = describeOperation(kind, resource);
      const store = resolveStore(resource, ctx, describe);
      const type = resolveRelationshipType(resource.relationship, ctx, describe, "relationship");
      assertRelationshipListed(describe, "relationship", type, store.relationships, declaredName);
      return new RelationshipOperation({ describe, store, type }, call);
    },
  };
}

function pair(inputs: RelationshipInputs): string {
  return `${quoteKey(inputs.source)} -> ${quoteKey(inputs.target)}`;
}

function relationshipNotFound(bound: BoundRelationshipOperation, inputs: RelationshipInputs): never {
  throw new InvokeError(
    "GRAPH_RELATIONSHIP_NOT_FOUND",
    `${bound.describe}: no '${declaredName(bound.type)}' relationship joins ${pair(inputs)}.`,
  );
}

export const CreateRelationship = relationshipOperation<{ relationship: GraphRelationshipValue }>(
  "CreateRelationship",
  async (bound, inputs, ctx) => {
    const outcome = await bound.store.createRelationship(
      bound.type,
      inputs.source,
      inputs.target,
      propertiesOf(inputs.properties),
      ctx,
    );
    switch (outcome.status) {
      case "found":
        return { relationship: outcome.value };
      case "exists":
        throw new InvokeError(
          "GRAPH_RELATIONSHIP_EXISTS",
          `${bound.describe}: a '${declaredName(bound.type)}' relationship already joins ` +
            `${pair(inputs)}.`,
        );
      case "endpointAbsent": {
        const nodeType = bound.type[outcome.endpoint];
        throw new InvokeError(
          "GRAPH_NODE_NOT_FOUND",
          `${bound.describe}: the ${outcome.endpoint} node — a '${declaredName(nodeType)}' ` +
            `with key ${quoteKey(inputs[outcome.endpoint])} — does not exist.`,
          { endpoint: outcome.endpoint },
        );
      }
    }
  },
);

export const MergeRelationship = relationshipOperation<{ relationship: GraphRelationshipValue }>(
  "MergeRelationship",
  async (bound, inputs, ctx) => {
    const outcome = await bound.store.mergeRelationship(
      bound.type,
      inputs.source,
      inputs.target,
      propertiesOf(inputs.properties),
      ctx,
    );
    if (outcome.status === "absent") {
      throw new InvokeError(
        "GRAPH_NODE_NOT_FOUND",
        `${bound.describe}: the source '${declaredName(bound.type.source)}' node ` +
          `${quoteKey(inputs.source)} or the target '${declaredName(bound.type.target)}' ` +
          `node ${quoteKey(inputs.target)} does not exist.`,
      );
    }
    return { relationship: outcome.value };
  },
);

export const UpdateRelationship = relationshipOperation<{ relationship: GraphRelationshipValue }>(
  "UpdateRelationship",
  async (bound, inputs, ctx) => {
    const outcome = await bound.store.updateRelationship(
      bound.type,
      inputs.source,
      inputs.target,
      propertiesOf(inputs.properties),
      ctx,
    );
    if (outcome.status === "absent") relationshipNotFound(bound, inputs);
    return { relationship: outcome.value };
  },
);

export const DeleteRelationship = relationshipOperation<{ relationship: GraphRelationshipValue }>(
  "DeleteRelationship",
  async (bound, inputs, ctx) => {
    const outcome = await bound.store.deleteRelationship(
      bound.type,
      inputs.source,
      inputs.target,
      ctx,
    );
    if (outcome.status === "absent") relationshipNotFound(bound, inputs);
    return { relationship: outcome.value };
  },
);

export const FindRelationships = relationshipOperation<{
  relationships: GraphRelationshipValue[];
}>("FindRelationships", async (bound, inputs, ctx) => ({
  relationships: await bound.store.findRelationships(
    bound.type,
    { source: inputs.source, target: inputs.target },
    filterOf(inputs.where),
    pageOf(inputs, bound.describe),
    ctx,
  ),
}));
