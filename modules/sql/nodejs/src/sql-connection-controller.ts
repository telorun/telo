import { Pool as PgPool } from "pg";
import type { ResourceContext, ResourceInstance } from "@telorun/sdk";
import type { SqliteDb } from "./sqlite-driver-interface.js";

interface PoolConfig {
  min?: number;
  max?: number;
  idleTimeoutMs?: number;
  connectionTimeoutMs?: number;
}

interface SqlConnectionManifest {
  metadata: { name: string; module: string };
  driver: "postgres" | "sqlite";
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  ssl?: boolean;
  file?: string;
  pool?: PoolConfig;
}

export class SqlConnectionResource implements ResourceInstance {
  readonly driver: "postgres" | "sqlite";
  private pool: PgPool | null = null;
  private db: SqliteDb | null = null;

  constructor(private readonly manifest: SqlConnectionManifest) {
    this.driver = manifest.driver;
  }

  async init(): Promise<void> {
    const m = this.manifest;
    if (m.driver === "postgres") {
      this.pool = new PgPool({
        host: m.host,
        port: m.port ?? 5432,
        database: m.database,
        user: m.user,
        password: m.password,
        ssl: m.ssl ? { rejectUnauthorized: false } : false,
        min: m.pool?.min ?? 1,
        max: m.pool?.max ?? 10,
        idleTimeoutMillis: m.pool?.idleTimeoutMs,
        connectionTimeoutMillis: m.pool?.connectionTimeoutMs,
      });
    } else {
      const { openDatabase } = await import("@telorun/sql/sqlite-driver");
      this.db = openDatabase(m.file ?? ":memory:");
    }
  }

  async teardown(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  getPool(): PgPool {
    if (!this.pool) throw new Error("Sql.Connection: not a PostgreSQL connection");
    return this.pool;
  }

  getDb(): SqliteDb {
    if (!this.db) throw new Error("Sql.Connection: not a SQLite connection");
    return this.db;
  }

  snapshot(): Record<string, unknown> {
    return { driver: this.driver };
  }
}

export function register(): void {}

export async function create(
  resource: SqlConnectionManifest,
  ctx: ResourceContext,
): Promise<SqlConnectionResource> {
  return new SqlConnectionResource(resource);
}
