import type { ResourceContext } from "@telorun/sdk";
import { openSqliteDatabase, SqlConnectionResource } from "./sql-connection-controller.js";

interface SqliteConnectionManifest {
  metadata: { name: string; module: string };
  /** File path, or omitted / `:memory:` for an in-memory database. */
  file?: string;
}

export function register(): void {}

export async function create(
  resource: SqliteConnectionManifest,
  ctx: ResourceContext,
): Promise<SqlConnectionResource> {
  const sqlite = await openSqliteDatabase(resource.file ?? ":memory:");
  return new SqlConnectionResource({ driver: "sqlite" }, sqlite);
}
