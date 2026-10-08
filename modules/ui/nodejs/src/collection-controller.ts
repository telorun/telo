import type { ResourceInstance, RuntimeResource } from "@telorun/sdk";

export type Operator = "eq" | "contains" | "gt" | "gte" | "lt" | "lte" | "in";

/** What a collection's list request accepts. */
export interface CollectionQuery {
  filters: { property: string; operator: Operator }[];
  sort: { property: string }[];
}

/** Anything a `collection:` slot accepts: this kind, or a kind extending it. */
export interface CollectionInstance {
  query: CollectionQuery;
}

export function isCollection(candidate: unknown): candidate is CollectionInstance {
  const query = (candidate as CollectionInstance | null)?.query;
  return Array.isArray(query?.filters) && Array.isArray(query?.sort);
}

type CollectionResource = RuntimeResource & { query: CollectionQuery };

class Collection implements ResourceInstance, CollectionInstance {
  readonly query: CollectionQuery;

  constructor(resource: CollectionResource) {
    this.query = resource.query;
  }

  snapshot(): Record<string, unknown> {
    return { query: this.query };
  }
}

export async function create(resource: CollectionResource): Promise<ResourceInstance> {
  return new Collection(resource);
}
