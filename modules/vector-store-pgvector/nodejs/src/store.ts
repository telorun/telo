import type { ControllerContext, ResourceContext, ResourceInstance } from "@telorun/sdk";
import { type SqlConnectionResource, resolveSqlConnection } from "@telorun/sql";
import type {
  MetadataFilter,
  QueryOptions,
  VectorMatch,
  VectorRecord,
  VectorStoreHandle,
} from "@telorun/vector-store";
import { compileFilter } from "./filter.js";

type Metric = "cosine" | "dot" | "euclidean";

interface StoreResource {
  metadata: { name: string; module?: string };
  connection: unknown;
  dimensions: number;
  metric?: Metric;
  table?: string;
}

/** pgvector distance operator + ANN index opclass per metric. `score` always
 *  higher-is-better, so each distance is turned back into a similarity. */
const METRICS: Record<Metric, { op: string; opclass: string; score: (d: number) => number }> = {
  cosine: { op: "<=>", opclass: "vector_cosine_ops", score: (d) => 1 - d },
  dot: { op: "<#>", opclass: "vector_ip_ops", score: (d) => -d },
  euclidean: { op: "<->", opclass: "vector_l2_ops", score: (d) => -d },
};

const TABLE_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** pgvector text literal — `[1,2,3]`, bound as a param and cast `::vector`. */
function toVectorLiteral(vector: number[]): string {
  return `[${vector.join(",")}]`;
}

function parseVectorLiteral(raw: string): number[] {
  return raw
    .slice(1, -1)
    .split(",")
    .filter((s) => s.length > 0)
    .map(Number);
}

/**
 * Postgres/pgvector vector index. Owns a single table (name configurable) inside
 * an existing Sql.Connection and provisions the `vector` extension, table, and
 * ANN index on init. Ranking runs through the pgvector distance operator for the
 * configured metric; higher `score` is always better.
 */
class PgvectorStore implements ResourceInstance, VectorStoreHandle {
  private readonly connection: SqlConnectionResource;
  private readonly metric: Metric;
  private readonly table: string;
  readonly dimensions: number;

  constructor(resource: StoreResource, connection: SqlConnectionResource) {
    this.connection = connection;
    this.metric = resource.metric ?? "cosine";
    this.dimensions = resource.dimensions;
    const table = resource.table ?? "vectors";
    if (!TABLE_PATTERN.test(table)) {
      throw new Error(`VectorStorePgvector: invalid table name '${table}'.`);
    }
    this.table = table;
  }

  private get quotedTable(): string {
    return `"${this.table}"`;
  }

  async init(): Promise<void> {
    const { opclass } = METRICS[this.metric];
    await this.connection.execute("CREATE EXTENSION IF NOT EXISTS vector");
    await this.connection.execute(
      `CREATE TABLE IF NOT EXISTS ${this.quotedTable} (` +
        `id TEXT PRIMARY KEY, ` +
        `embedding vector(${this.dimensions}) NOT NULL, ` +
        `metadata JSONB NOT NULL DEFAULT '{}'::jsonb)`,
    );
    await this.connection.execute(
      `CREATE INDEX IF NOT EXISTS "${this.table}_embedding_idx" ` +
        `ON ${this.quotedTable} USING hnsw (embedding ${opclass})`,
    );
  }

  private assertDimensions(vector: number[]): void {
    if (vector.length !== this.dimensions) {
      throw new Error(
        `VectorStorePgvector: expected vector of length ${this.dimensions}, got ${vector.length}.`,
      );
    }
  }

  async upsert(items: VectorRecord[]): Promise<{ ids: string[] }> {
    if (items.length === 0) return { ids: [] };
    // Validate every vector before any write so a bad length fails the whole
    // batch rather than leaving an earlier chunk committed.
    for (const item of items) this.assertDimensions(item.vector);
    // 3 bound params per row; chunk well under Postgres's 65535-parameter
    // ceiling so an arbitrarily large batch degrades to several statements
    // instead of an opaque driver error.
    const CHUNK = 10_000;
    for (let start = 0; start < items.length; start += CHUNK) {
      const params: unknown[] = [];
      const rows: string[] = [];
      for (const item of items.slice(start, start + CHUNK)) {
        const idP = `$${params.push(item.id)}`;
        const vecP = `$${params.push(toVectorLiteral(item.vector))}`;
        const metaP = `$${params.push(JSON.stringify(item.metadata ?? {}))}`;
        rows.push(`(${idP}, ${vecP}::vector, ${metaP}::jsonb)`);
      }
      await this.connection.execute(
        `INSERT INTO ${this.quotedTable} (id, embedding, metadata) VALUES ${rows.join(", ")} ` +
          `ON CONFLICT (id) DO UPDATE SET embedding = EXCLUDED.embedding, metadata = EXCLUDED.metadata`,
        params,
      );
    }
    return { ids: items.map((i) => i.id) };
  }

  async query(vector: number[], opts: QueryOptions): Promise<{ matches: VectorMatch[] }> {
    this.assertDimensions(vector);
    const { op, score } = METRICS[this.metric];
    const params: unknown[] = [toVectorLiteral(vector)];
    const filter = compileFilter(opts.metadataFilter, 2);
    if (filter) params.push(...filter.params);
    const limitP = `$${params.push(opts.topK)}`;
    const columns = opts.includeVectors
      ? "id, metadata, embedding"
      : "id, metadata";
    const sql =
      `SELECT ${columns}, (embedding ${op} $1::vector) AS distance ` +
      `FROM ${this.quotedTable} ` +
      (filter ? `WHERE ${filter.sql} ` : "") +
      `ORDER BY embedding ${op} $1::vector LIMIT ${limitP}`;
    const result = await this.connection.execute<{
      id: string;
      metadata: Record<string, unknown>;
      distance: number;
      embedding?: string;
    }>(sql, params);
    const matches: VectorMatch[] = result.rows.map((row) => {
      const match: VectorMatch = { id: row.id, score: score(Number(row.distance)) };
      if (row.metadata && Object.keys(row.metadata).length > 0) match.metadata = row.metadata;
      if (opts.includeVectors && row.embedding) match.vector = parseVectorLiteral(row.embedding);
      return match;
    });
    return { matches };
  }

  async delete(opts: { ids?: string[]; metadataFilter?: MetadataFilter }): Promise<{
    removed: number;
  }> {
    let removed = 0;
    if (opts.ids && opts.ids.length > 0) {
      const result = await this.connection.execute(
        `DELETE FROM ${this.quotedTable} WHERE id = ANY($1)`,
        [opts.ids],
      );
      removed += this.connection.toRowCount(result);
    }
    if (opts.metadataFilter) {
      const filter = compileFilter(opts.metadataFilter, 1);
      // A filter with no field conditions ({}, {$and:[]}, …) compiles to a
      // tautology that would delete every row — every real condition binds at
      // least its field name, so zero bound params means it constrains nothing.
      // There is no "delete all" in the contract, so refuse it loudly rather
      // than silently wiping the table (persistent data).
      if (!filter || filter.params.length === 0) {
        throw new Error(
          "VectorStorePgvector.delete: metadataFilter constrains no rows — refusing an " +
            "unbounded delete. Pass `ids` or a filter with at least one condition.",
        );
      }
      const result = await this.connection.execute(
        `DELETE FROM ${this.quotedTable} WHERE ${filter.sql}`,
        filter.params,
      );
      removed += this.connection.toRowCount(result);
    }
    return { removed };
  }

  async provide(): Promise<PgvectorStore> {
    return this;
  }

  // The connection is owned by the Sql.Connection resource; do not destroy it.
  async teardown(): Promise<void> {}

  snapshot(): Record<string, unknown> {
    return {};
  }
}

export function register(_ctx: ControllerContext): void {}

export async function create(
  resource: StoreResource,
  ctx: ResourceContext,
): Promise<PgvectorStore> {
  const connection = resolveSqlConnection(
    resource.connection as Parameters<typeof resolveSqlConnection>[0],
    ctx,
  );
  if (!connection) {
    throw new Error(
      `VectorStorePgvector.Store '${resource.metadata.name}': 'connection' must reference an Sql.Connection.`,
    );
  }
  return new PgvectorStore(resource, connection);
}
