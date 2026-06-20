import type { ControllerContext, ResourceContext, ResourceInstance } from "@telorun/sdk";
import type {
  MetadataFilter,
  QueryOptions,
  VectorMatch,
  VectorRecord,
  VectorStoreHandle,
} from "@telorun/vector-store";
import { matchesFilter } from "./filter.js";

type Metric = "cosine" | "dot" | "euclidean";

interface StoreResource {
  metadata: { name: string; module?: string };
  metric?: Metric;
  dimensions?: number;
  maxEntries?: number;
}

interface Entry {
  vector: number[];
  metadata?: Record<string, unknown>;
}

function dot(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

function norm(a: number[]): number {
  return Math.sqrt(dot(a, a));
}

/**
 * In-process vector index. Holds entries in a Map (insertion order = write
 * order, used for FIFO eviction) and ranks matches by the configured metric.
 * Higher `score` is always better — for euclidean the negated distance is used.
 */
class MemoryVectorStore implements ResourceInstance, VectorStoreHandle {
  private readonly entries = new Map<string, Entry>();
  private readonly metric: Metric;
  private readonly maxEntries?: number;
  readonly dimensions?: number;

  constructor(resource: StoreResource) {
    this.metric = resource.metric ?? "cosine";
    this.dimensions = resource.dimensions;
    this.maxEntries = resource.maxEntries;
  }

  private assertDimensions(vector: number[]): void {
    if (this.dimensions !== undefined && vector.length !== this.dimensions) {
      throw new Error(
        `VectorStoreMemory "${this.metric}": expected vector of length ${this.dimensions}, got ${vector.length}.`,
      );
    }
  }

  async upsert(items: VectorRecord[]): Promise<{ ids: string[] }> {
    const ids: string[] = [];
    for (const item of items) {
      this.assertDimensions(item.vector);
      // Re-insert at the tail so recency reflects the latest write.
      this.entries.delete(item.id);
      this.entries.set(item.id, { vector: item.vector, metadata: item.metadata });
      ids.push(item.id);
    }
    if (this.maxEntries !== undefined) {
      while (this.entries.size > this.maxEntries) {
        const oldest = this.entries.keys().next().value;
        if (oldest === undefined) break;
        this.entries.delete(oldest);
      }
    }
    return { ids };
  }

  private score(query: number[], candidate: number[]): number {
    switch (this.metric) {
      case "dot":
        return dot(query, candidate);
      case "euclidean": {
        let sum = 0;
        for (let i = 0; i < query.length; i++) {
          const d = query[i] - candidate[i];
          sum += d * d;
        }
        return -Math.sqrt(sum);
      }
      case "cosine": {
        const denom = norm(query) * norm(candidate);
        return denom === 0 ? 0 : dot(query, candidate) / denom;
      }
    }
  }

  async query(vector: number[], opts: QueryOptions): Promise<{ matches: VectorMatch[] }> {
    this.assertDimensions(vector);
    const scored: VectorMatch[] = [];
    for (const [id, entry] of this.entries) {
      if (!matchesFilter(opts.metadataFilter, entry.metadata)) continue;
      const match: VectorMatch = { id, score: this.score(vector, entry.vector) };
      if (entry.metadata !== undefined) match.metadata = entry.metadata;
      if (opts.includeVectors) match.vector = entry.vector;
      scored.push(match);
    }
    scored.sort((a, b) => b.score - a.score);
    return { matches: scored.slice(0, opts.topK) };
  }

  async delete(opts: { ids?: string[]; metadataFilter?: MetadataFilter }): Promise<{
    removed: number;
  }> {
    let removed = 0;
    if (opts.ids) {
      for (const id of opts.ids) {
        if (this.entries.delete(id)) removed++;
      }
    }
    if (opts.metadataFilter) {
      for (const [id, entry] of [...this.entries]) {
        if (matchesFilter(opts.metadataFilter, entry.metadata)) {
          this.entries.delete(id);
          removed++;
        }
      }
    }
    return { removed };
  }

  async provide(): Promise<MemoryVectorStore> {
    return this;
  }

  async teardown(): Promise<void> {
    this.entries.clear();
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

export function register(_ctx: ControllerContext): void {}

export async function create(
  resource: StoreResource,
  _ctx: ResourceContext,
): Promise<MemoryVectorStore> {
  return new MemoryVectorStore(resource);
}
