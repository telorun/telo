import type { ResourceContext } from "@telorun/sdk";
import { SqlConnectionResource } from "./sql-connection-controller.js";

interface PoolConfig {
  min?: number;
  max?: number;
  idleTimeoutMs?: number;
  connectionTimeoutMs?: number;
}

interface PostgresConnectionManifest {
  metadata: { name: string; module: string };
  connectionString: string;
  pool?: PoolConfig;
}

export function register(): void {}

export async function create(
  resource: PostgresConnectionManifest,
  ctx: ResourceContext,
): Promise<SqlConnectionResource> {
  return new SqlConnectionResource({
    driver: "postgres",
    connectionString: resource.connectionString,
    pool: resource.pool,
  });
}
