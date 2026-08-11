import type { ResourceContext, ResourceInstance } from "@telorun/sdk";
import {
  CompiledQuery,
  Migrator,
  type Kysely,
  type Migration,
  type MigrationProvider,
} from "kysely";
import type { SqlConnection } from "./sql-connection.js";
import { resolveSqlConnection } from "./sql-connection-ref.js";

// A migration entry is one statement or an ordered list of statements; both
// forms normalize to a non-empty array of single statements.
interface MigrationEntry {
  statement?: string;
  statements?: string[];
}

interface SqlMigrationsManifest {
  metadata: { name: string; module: string };
  connection: SqlConnection;
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
      resolveSqlConnection(
        this.manifest.connection,
        this.ctx,
        () => `Sql.Migrations "${this.manifest.metadata.name}": 'connection'`,
      ) ?? failMissingConnection();

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

    if (!conn.kysely) {
      throw new Error(
        `Sql.Migrations '${this.manifest.metadata.name}': the referenced connection is not ` +
          `built on kysely, which this kind's migration runner requires. Use a backend that ` +
          `extends SqlConnectionBase, or run the statements through Sql.Command.`,
      );
    }

    const migrator = new Migrator({
      db: conn.kysely,
      provider: new TeloMigrationProvider(migrations),
      migrationTableName: "migrations",
      migrationLockTableName: "migration_locks",
    });

    const { error, results } = await migrator.migrateToLatest();
    // A schema change is the least reversible thing an app does at boot, and the
    // per-migration outcome was being discarded — so a run that applied four
    // migrations and a run that found none to apply looked identical afterwards.
    // `info`, because which migrations a deployment applied is the fact you go
    // looking for when a schema is not what you expected.
    // `sql.migration.name`, not `db.migration.name`: OTel owns `db.*` and defines
    // no migration attribute, and §6.2 forbids inventing keys inside a namespace
    // someone else governs.
    for (const applied of results ?? []) {
      if (applied.status === "Success") {
        this.ctx.log.info("Migration applied", { "sql.migration.name": applied.migrationName });
      } else if (applied.status === "Error") {
        // The cause rides on the record: this is the error-severity line an
        // operator finds first, and the migration name alone cannot say what
        // went wrong. `error` keeps the type, stack and cause chain (§4.2).
        this.ctx.log.error(
          "Migration failed",
          { "sql.migration.name": applied.migrationName },
          { error },
        );
      }
    }
    if (error) {
      throw error;
    }
    if (!results?.length) {
      this.ctx.log.debug("No pending migrations");
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
