import type { ResourceContext } from "@telorun/sdk";
import {
  assertListedTable,
  resolveSqlConnection,
  runSchemaPass,
  type MigrationMap,
  type DeclaredTable,
  type ReclaimPolicy,
  type SqlConnection,
  type SqlSchema,
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
class SqliteSchemaResource implements SqlSchema {
  constructor(
    private readonly manifest: SqliteSchemaManifest,
    private readonly ctx: ResourceContext,
    private readonly driver: SqliteSchemaDriver,
  ) {}

  /** Configured state is pulled, observed state is pushed — everything this
   *  resource knows is learned while running, so the snapshot is empty and the
   *  whole report arrives through `setStatus`. It still has to exist: a
   *  resource that publishes nothing is absent from the `resources` scope. */
  snapshot(): Record<string, unknown> {
    return {};
  }

  private get namespace(): string {
    return "main";
  }

  qualifiedTableName(table: DeclaredTable): string {
    assertListedTable(
      `SQLite.Schema "${this.manifest.metadata.name}"`,
      (this.manifest.tables ?? []).map((listed) => listed.declaration),
      table,
    );
    return this.driver.qualify(this.namespace, table.name);
  }

  async run(): Promise<void> {
    const status = await runSchemaPass(this.driver, this.ctx, {
      schema: this.namespace,
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
  const connection = resolveSqlConnection(
    resource.connection,
    ctx,
    () => `SQLite.Schema "${resource.metadata.name}": 'connection'`,
  );
  if (!connection) {
    throw new Error(`SQLite.Schema "${resource.metadata.name}": missing connection`);
  }
  return new SqliteSchemaResource(resource, ctx, new SqliteSchemaDriver(connection));
}
