import type { ResourceContext, ResourceInstance } from "@telorun/sdk";
import {
  resolveSqlConnection,
  runSchemaPass,
  type MigrationMap,
  type ReclaimPolicy,
  type SqlConnection,
} from "@telorun/sql";
import { PostgresSchemaDriver } from "./postgres-schema-driver.js";
import type { PostgresTableResource } from "./table-controller.js";

interface PostgresSchemaManifest {
  metadata: { name: string; module: string };
  connection: SqlConnection;
  schema?: string;
  version?: string;
  ledger?: string;
  tables?: PostgresTableResource[];
  beforeMigrations?: MigrationMap;
  migrations?: MigrationMap;
  reclaim?: ReclaimPolicy;
}

/**
 * `Postgres.Schema` — the single schema-change kind, and exactly one namespace.
 * A table belongs to whichever schema resource lists it, so there is no
 * per-table override and no precedence question; tables in two namespaces means
 * two schema resources, and schema-per-tenant falls out as one per tenant, each
 * with its own migration history and reclaim clock.
 */
class PostgresSchemaResource implements ResourceInstance {
  constructor(
    private readonly manifest: PostgresSchemaManifest,
    private readonly ctx: ResourceContext,
  ) {}

  /** Everything this resource knows is learned while running, so the snapshot is
   *  empty and the whole report arrives through `setStatus`. It still has to
   *  exist: a resource that publishes nothing is absent from `resources`. */
  snapshot(): Record<string, unknown> {
    return {};
  }

  async run(): Promise<void> {
    const connection = resolveSqlConnection(
      this.manifest.connection,
      this.ctx,
      () => `Postgres.Schema "${this.manifest.metadata.name}": 'connection'`,
    );
    if (!connection) {
      throw new Error(`Postgres.Schema "${this.manifest.metadata.name}": missing connection`);
    }

    const status = await runSchemaPass(new PostgresSchemaDriver(connection), this.ctx, {
      schema: this.manifest.schema ?? "public",
      ledger: this.manifest.ledger,
      version: this.manifest.version,
      tables: (this.manifest.tables ?? []).map((table) => table.declaration),
      beforeMigrations: this.manifest.beforeMigrations ?? {},
      migrations: this.manifest.migrations ?? {},
      reclaim: this.manifest.reclaim,
    });

    for (const key of status.orphanedMigrations) {
      this.ctx.log.info("Applied migration has no declaration", { "sql.migration.name": key });
    }
    this.ctx.setStatus({ ...status });
  }
}

export function register(): void {}

export async function create(
  resource: PostgresSchemaManifest,
  ctx: ResourceContext,
): Promise<PostgresSchemaResource> {
  return new PostgresSchemaResource(resource, ctx);
}
