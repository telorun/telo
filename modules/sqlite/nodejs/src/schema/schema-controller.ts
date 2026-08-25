import type { ResourceContext, ResourceInstance } from "@telorun/sdk";
import {
  resolveSqlConnection,
  runSchemaPass,
  type MigrationMap,
  type ReclaimPolicy,
  type SqlConnection,
} from "@telorun/sql";
import { SqliteSchemaDriver } from "./sqlite-schema-driver.js";
import type { SqliteEnumResource } from "./enum-controller.js";
import type { SqliteTableResource } from "./table-controller.js";

interface SqliteSchemaManifest {
  metadata: { name: string; module: string };
  connection: SqlConnection;
  version?: string;
  ledger?: string;
  tables?: SqliteTableResource[];
  enums?: SqliteEnumResource[];
  prepare?: MigrationMap;
  migrations?: MigrationMap;
  reclaim?: ReclaimPolicy;
}

/**
 * `SQLite.Schema` — the single schema-change kind: declared tables and
 * imperative migrations reconciled in one boot pass, under one clock.
 *
 * SQLite has exactly one namespace, so unlike the PostgreSQL kind there is no
 * `schema:` field to name and nothing to create.
 */
class SqliteSchemaResource implements ResourceInstance {
  constructor(
    private readonly manifest: SqliteSchemaManifest,
    private readonly ctx: ResourceContext,
  ) {}

  /** Configured state is pulled, observed state is pushed — everything this
   *  resource knows is learned while running, so the snapshot is empty and the
   *  whole report arrives through `setStatus`. It still has to exist: a
   *  resource that publishes nothing is absent from the `resources` scope. */
  snapshot(): Record<string, unknown> {
    return {};
  }

  async run(): Promise<void> {
    const connection = resolveSqlConnection(
      this.manifest.connection,
      this.ctx,
      () => `SQLite.Schema "${this.manifest.metadata.name}": 'connection'`,
    );
    if (!connection) {
      throw new Error(`SQLite.Schema "${this.manifest.metadata.name}": missing connection`);
    }

    const status = await runSchemaPass(new SqliteSchemaDriver(connection), this.ctx, {
      schema: "main",
      ledger: this.manifest.ledger,
      version: this.manifest.version,
      tables: (this.manifest.tables ?? []).map((table) => table.declaration),
      enums: (this.manifest.enums ?? []).map((declared) => declared.declaration),
      prepare: this.manifest.prepare ?? {},
      migrations: this.manifest.migrations ?? {},
      reclaim: this.manifest.reclaim,
    });

    for (const key of status.orphanedMigrations) {
      // Deleting decade-old migrations from a manifest is normal, so an applied
      // key with no declaration is reported and never an error.
      this.ctx.log.info("Applied migration has no declaration", { "sql.migration.name": key });
    }
    this.ctx.setStatus({ ...status });
  }
}

export function register(): void {}

export async function create(
  resource: SqliteSchemaManifest,
  ctx: ResourceContext,
): Promise<SqliteSchemaResource> {
  return new SqliteSchemaResource(resource, ctx);
}
