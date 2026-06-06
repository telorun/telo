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

// A migration entry is one statement or an ordered list of statements; both
// forms normalize to a non-empty array of single statements.
interface MigrationEntry {
  statement?: string;
  statements?: string[];
}

interface SqlMigrationsManifest {
  metadata: { name: string; module: string };
  connection: SqlConnectionResource;
  migrations?: Record<string, MigrationEntry>;
}

function entryStatements(entry: MigrationEntry): string[] {
  return entry.statements ?? (entry.statement != null ? [entry.statement] : []);
}

class TeloMigrationProvider implements MigrationProvider {
  constructor(private readonly migrations: Record<string, string[]>) {}

  async getMigrations(): Promise<Record<string, Migration>> {
    return Object.fromEntries(
      Object.entries(this.migrations).map(([name, statements]) => [
        name,
        {
          // Each statement runs as its own prepared statement on the migration
          // transaction's connection, so a migration may hold multiple
          // statements while the whole batch stays a single transaction.
          async up(db: Kysely<any>): Promise<void> {
            for (const statement of statements) {
              await db.executeQuery(CompiledQuery.raw(statement));
            }
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

    const migrations: Record<string, string[]> = {};
    // Legacy: standalone `Sql.Migration` resources in the same module scope.
    for (const [, { resource }] of this.ctx.moduleContext.resourceInstances) {
      if (resource.kind === "Sql.Migration") {
        const version = (resource.version ?? resource.metadata.name) as string;
        migrations[version] = [resource.sql as string];
      }
    }
    // Preferred: the keyed `migrations` map on this resource.
    for (const [name, entry] of Object.entries(this.manifest.migrations ?? {})) {
      const statements = entryStatements(entry);
      if (statements.length === 0) {
        throw new Error(
          `Sql.Migrations: migration '${name}' has no statement(s) — ` +
            `set 'statement' or a non-empty 'statements'`,
        );
      }
      migrations[name] = statements;
    }

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
