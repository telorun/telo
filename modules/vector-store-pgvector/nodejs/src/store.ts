import type { ControllerContext, ResourceContext, ResourceInstance } from "@telorun/sdk";
import { type SqlConnection, resolveSqlConnection } from "@telorun/sql";
import { CompiledQuery, type Kysely } from "kysely";
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

/** Iterative index scans (`hnsw.iterative_scan`) arrived in pgvector 0.8.0. */
const MIN_PGVECTOR = [0, 8, 0] as const;

/** Parses pgvector's `extversion` (`0.8.0`) into numeric parts; `undefined`
 *  for a string it cannot read. */
function parseExtensionVersion(raw: string): number[] | undefined {
  const parts = raw.split(".");
  if (parts.length < 2 || parts.some((p) => !/^\d+$/.test(p))) return undefined;
  return parts.map(Number);
}

function versionAtLeast(version: number[], minimum: readonly number[]): boolean {
  for (let i = 0; i < minimum.length; i++) {
    const part = version[i] ?? 0;
    if (part !== minimum[i]) return part > minimum[i];
  }
  return true;
}

/** Makes the match statement an iterative HNSW scan in strict distance order:
 *  the metadata filter is applied as the index is walked, and the walk goes on
 *  until the LIMIT is met or `hnsw.max_scan_tuples` is reached, so an excluded
 *  row never takes a match's place and a LIMIT above `hnsw.ef_search` is met. */
const SCAN_SETTINGS = "SELECT set_config('hnsw.iterative_scan', 'strict_order', true)";

type MatchRow = {
  id: string;
  metadata: Record<string, unknown>;
  distance: number;
  embedding?: string;
};

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
  private readonly name: string;
  private readonly connection: SqlConnection;
  /** A match opens its own transaction on it, to scope its scan settings. */
  private readonly kysely: Kysely<any>;
  private readonly metric: Metric;
  private readonly table: string;
  readonly dimensions: number;

  constructor(resource: StoreResource, connection: SqlConnection, kysely: Kysely<any>) {
    this.name = resource.metadata.name;
    this.connection = connection;
    this.kysely = kysely;
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
    await this.assertPgvectorVersion();
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

  /** A match relies on iterative index scans; an older extension would ignore
   *  the setting and silently return fewer, or the wrong, rows. */
  private async assertPgvectorVersion(): Promise<void> {
    const result = await this.connection.execute<{ extversion: string }>(
      "SELECT extversion FROM pg_extension WHERE extname = 'vector'",
    );
    const installed = result.rows[0]?.extversion;
    if (installed === undefined) {
      throw new Error(
        `VectorStorePgvector.Store '${this.name}': the vector extension is not installed in this database after CREATE EXTENSION.`,
      );
    }
    const version = parseExtensionVersion(installed);
    if (!version || !versionAtLeast(version, MIN_PGVECTOR)) {
      throw new Error(
        `VectorStorePgvector.Store '${this.name}': pgvector ${installed} is installed, but this store requires pgvector >=${MIN_PGVECTOR.join(".")} ` +
          `(iterative index scans, so a filtered match returns the true nearest rows). Install pgvector 0.8.0 or later on the server and run ` +
          `ALTER EXTENSION vector UPDATE in this database.`,
      );
    }
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
    const rows = this.connection.hasOpenTransaction()
      ? await this.matchInOpenTransaction(sql, params)
      : await this.matchInOwnTransaction(sql, params);
    const matches: VectorMatch[] = rows.map((row) => {
      const match: VectorMatch = { id: row.id, score: score(Number(row.distance)) };
      if (row.metadata && Object.keys(row.metadata).length > 0) match.metadata = row.metadata;
      if (opts.includeVectors && row.embedding) match.vector = parseVectorLiteral(row.embedding);
      return match;
    });
    return { matches };
  }

  /** The scan settings are `SET LOCAL` (`set_config(…, true)`), so they end with
   *  this transaction and never reach the pooled session. */
  private async matchInOwnTransaction(sql: string, params: unknown[]): Promise<MatchRow[]> {
    return this.kysely.transaction().execute(async (trx) => {
      await trx.executeQuery(CompiledQuery.raw(SCAN_SETTINGS));
      const result = await trx.executeQuery<MatchRow>(CompiledQuery.raw(sql, params));
      return result.rows;
    });
  }

  /** Inside the caller's transaction the match joins it, as every statement of
   *  this store does, and the caller's setting is restored after the match so it
   *  does not outlive the statement. A failed match aborts that transaction,
   *  which discards the setting with it. */
  private async matchInOpenTransaction(sql: string, params: unknown[]): Promise<MatchRow[]> {
    const previous = await this.connection.execute<{ setting: string }>(
      "SELECT current_setting('hnsw.iterative_scan') AS setting",
    );
    await this.connection.execute(SCAN_SETTINGS);
    const result = await this.connection.execute<MatchRow>(sql, params);
    await this.connection.execute("SELECT set_config('hnsw.iterative_scan', $1, true)", [
      previous.rows[0]!.setting,
    ]);
    return result.rows;
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
    () => `VectorStorePgvector.Store "${resource.metadata.name}": 'connection'`,
  );
  if (!connection) {
    throw new Error(
      `VectorStorePgvector.Store '${resource.metadata.name}': 'connection' must reference an Sql.Connection.`,
    );
  }
  if (!connection.kysely) {
    throw new Error(
      `VectorStorePgvector.Store '${resource.metadata.name}': 'connection' exposes no kysely instance — a match needs one to scope its index-scan settings to its own transaction. Use a Postgres.Connection.`,
    );
  }
  return new PgvectorStore(resource, connection, connection.kysely);
}
