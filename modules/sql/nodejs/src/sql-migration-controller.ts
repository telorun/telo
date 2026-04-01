import type { ResourceInstance } from "@telorun/sdk";

interface SqlMigrationManifest {
  metadata: { name: string; module: string };
  sql: string;
}

class SqlMigrationResource implements ResourceInstance {
  constructor(readonly manifest: SqlMigrationManifest) {}

  snapshot(): Record<string, unknown> {
    return {};
  }
}

export function register(): void {}

export async function create(resource: SqlMigrationManifest): Promise<SqlMigrationResource> {
  return new SqlMigrationResource(resource);
}
