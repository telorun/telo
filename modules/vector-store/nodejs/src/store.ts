/** A vector to index, with its id and optional metadata. */
export interface VectorRecord {
  id: string;
  vector: number[];
  metadata?: Record<string, unknown>;
}

/** A single nearest-neighbour hit. `vector` is present only when requested. */
export interface VectorMatch {
  id: string;
  score: number;
  metadata?: Record<string, unknown>;
  vector?: number[];
}

/** Per-query options for {@link VectorStoreHandle.query}. */
export interface QueryOptions {
  topK: number;
  includeVectors: boolean;
  metadataFilter?: MetadataFilter;
}

/**
 * MongoDB-style metadata filter — the documented operator subset shared by
 * Match and Removal. Top-level keys are ANDed; a bare scalar is `$eq`. Every
 * backend implements this subset identically (or throws on an operator it
 * cannot translate); see the module docs for the portability invariants.
 */
export type FilterScalar = string | number | boolean | null;

export interface FieldCondition {
  $eq?: FilterScalar;
  $ne?: FilterScalar;
  $gt?: number;
  $gte?: number;
  $lt?: number;
  $lte?: number;
  $in?: FilterScalar[];
  $nin?: FilterScalar[];
}

export interface MetadataFilter {
  $and?: MetadataFilter[];
  $or?: MetadataFilter[];
  $not?: MetadataFilter;
  [field: string]: FilterScalar | FieldCondition | MetadataFilter[] | MetadataFilter | undefined;
}

/**
 * The contract every vector-store backend (VectorStoreMemory.Store, …)
 * implements. The store owns its config and is authoritative for dimension
 * enforcement: `upsert` / `query` reject a vector whose length differs from the
 * store's configured `dimensions`. `dimensions` is exposed read-only purely for
 * introspection — the core invocables do not depend on it.
 */
export interface VectorStoreHandle {
  readonly dimensions?: number;
  upsert(items: VectorRecord[]): Promise<{ ids: string[] }>;
  query(vector: number[], opts: QueryOptions): Promise<{ matches: VectorMatch[] }>;
  delete(opts: { ids?: string[]; metadataFilter?: MetadataFilter }): Promise<{ removed: number }>;
}

/** True when a value already exposes the store contract (Phase-5 injected). */
export function isVectorStore(value: unknown): value is VectorStoreHandle {
  return (
    !!value &&
    typeof (value as VectorStoreHandle).upsert === "function" &&
    typeof (value as VectorStoreHandle).query === "function" &&
    typeof (value as VectorStoreHandle).delete === "function"
  );
}
