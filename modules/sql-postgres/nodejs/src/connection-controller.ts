import type { ResourceContext } from "@telorun/sdk";
import { createSqlConnection, type SqlConnectionResource } from "@telorun/sql";
import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";

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

type SslOption =
  | false
  | { rejectUnauthorized: boolean; checkServerIdentity?: () => undefined };

function sslFromSslmode(mode: string | null): SslOption {
  switch (mode) {
    case null:
    case "disable":
      return false;
    case "require":
      return { rejectUnauthorized: false };
    case "verify-ca":
      // libpq `verify-ca` validates the CA chain but not the hostname; Node's
      // default `checkServerIdentity` enforces the hostname, so disable it.
      return { rejectUnauthorized: true, checkServerIdentity: () => undefined };
    case "verify-full":
      return { rejectUnauthorized: true };
    default:
      throw new Error(
        `SqlPostgres.Connection: unsupported sslmode '${mode}'. ` +
          `Use 'disable', 'require', 'verify-ca', or 'verify-full'.`,
      );
  }
}

export function register(): void {}

export async function create(
  resource: PostgresConnectionManifest,
  _ctx: ResourceContext,
): Promise<SqlConnectionResource> {
  if (!resource.connectionString) {
    throw new Error("SqlPostgres.Connection requires a connectionString");
  }
  const url = new URL(resource.connectionString);
  const ssl = sslFromSslmode(url.searchParams.get("sslmode"));
  url.searchParams.delete("sslmode");

  const db = new Kysely<any>({
    dialect: new PostgresDialect({
      pool: new Pool({
        connectionString: url.toString(),
        ssl,
        min: resource.pool?.min ?? 1,
        max: resource.pool?.max ?? 10,
        idleTimeoutMillis: resource.pool?.idleTimeoutMs,
        connectionTimeoutMillis: resource.pool?.connectionTimeoutMs,
      }),
    }),
  });

  return createSqlConnection("postgres", db);
}
