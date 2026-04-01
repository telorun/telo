import type { ResourceContext, ResourceInstance } from "@telorun/sdk";
import type { SqlConnectionResource } from "./sql-connection-controller.js";

interface SqlMigrationsManifest {
  metadata: { name: string; module: string };
  connection: SqlConnectionResource;
}

interface MigrationEntry {
  name: string;
  sql: string;
}

class SqlMigrationsResource implements ResourceInstance {
  constructor(
    private readonly manifest: SqlMigrationsManifest,
    private readonly ctx: ResourceContext,
  ) {}

  async run(): Promise<void> {
    const conn = this.manifest.connection;

    const migrations: MigrationEntry[] = [];
    for (const [, { resource }] of this.ctx.moduleContext.resourceInstances) {
      if (resource.kind === "Sql.Migration") {
        migrations.push({
          name: resource.metadata.name as string,
          sql: resource.sql as string,
        });
      }
    }
    migrations.sort((a, b) => a.name.localeCompare(b.name));

    await this.runMigrations(conn, migrations);
  }

  private async runMigrations(
    conn: SqlConnectionResource,
    migrations: MigrationEntry[],
  ): Promise<void> {
    const binding = conn.driver === "postgres" ? "$1" : "?";

    await conn.execute(
      `CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
    );

    for (const migration of migrations) {
      const existing = await conn.execute(
        `SELECT 1 FROM schema_migrations WHERE name = ${binding}`,
        [migration.name],
      );

      if (existing.rows.length === 0) {
        await conn.transaction(async () => {
          await this.applyMigrationSql(conn, migration.sql);
          await conn.execute(
            `INSERT INTO schema_migrations (name) VALUES (${binding})`,
            [migration.name],
          );
        });
      }
    }
  }

  private async applyMigrationSql(conn: SqlConnectionResource, migrationSql: string): Promise<void> {
    await conn.executeScript(migrationSql);
  }
}

export function register(): void {}

export async function create(
  resource: SqlMigrationsManifest,
  ctx: ResourceContext,
): Promise<SqlMigrationsResource> {
  return new SqlMigrationsResource(resource, ctx);
}
