import type { ResourceContext, ResourceInstance } from "@telorun/sdk";
import {
  CompiledQuery,
  Migrator,
  type Kysely,
  type Migration,
  type MigrationProvider,
} from "kysely";
import type { SqlConnectionResource } from "./sql-connection-controller.js";
import { resolveSqlConnection } from "./sql-connection-ref.js";

interface SqlMigrationsManifest {
  metadata: { name: string; module: string };
  connection: SqlConnectionResource;
}

interface MigrationEntry {
  name: string;
  sql: string;
}

class TeloMigrationProvider implements MigrationProvider {
  constructor(private readonly migrations: MigrationEntry[]) {}

  async getMigrations(): Promise<Record<string, Migration>> {
    return Object.fromEntries(
      this.migrations.map((m) => [
        m.name,
        {
          async up(db: Kysely<any>): Promise<void> {
            await db.executeQuery(CompiledQuery.raw(m.sql));
          },
        },
      ]),
    );
  }
}

class SqlMigrationsResource implements ResourceInstance {
  constructor(
    private readonly manifest: SqlMigrationsManifest,
    private readonly ctx: ResourceContext,
  ) {}

  async run(): Promise<void> {
    const conn =
      resolveSqlConnection(this.manifest.connection, this.ctx) ?? failMissingConnection();

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

    const migrator = new Migrator({
      db: conn.kysely,
      provider: new TeloMigrationProvider(migrations),
      migrationTableName: "migrations",
      migrationLockTableName: "migration_locks",
    });

    const { error } = await migrator.migrateToLatest();
    if (error) {
      throw error;
    }
  }
}

function failMissingConnection(): never {
  throw new Error("Sql.Migrations: missing connection");
}

export function register(): void {}

export async function create(
  resource: SqlMigrationsManifest,
  ctx: ResourceContext,
): Promise<SqlMigrationsResource> {
  return new SqlMigrationsResource(resource, ctx);
}
