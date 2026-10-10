import type { ResourceContext } from "@telorun/sdk";
import {
  assertListedTable,
  resolveSqlConnection,
  runSchemaPass,
  type MigrationMap,
  type DeclaredTable,
  type ReclaimPolicy,
  type SqlConnection,
  type SqlInstantSchema,
} from "@telorun/sql";
import { PostgresSchemaDriver } from "./postgres-schema-driver.js";
import type { PostgresEnumResource } from "./enum-controller.js";
import type { PostgresTableResource } from "./table-controller.js";

interface PostgresSchemaManifest {
  metadata: { name: string; module: string };
  connection: SqlConnection;
  schema?: string;
  version?: string;
  ledger?: string;
  tables?: PostgresTableResource[];
  enums?: PostgresEnumResource[];
  extensions?: string[];
  prepare?: MigrationMap;
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
class PostgresSchemaResource implements SqlInstantSchema {
  constructor(
    private readonly manifest: PostgresSchemaManifest,
    private readonly ctx: ResourceContext,
    private readonly driver: PostgresSchemaDriver,
  ) {}

  /** Everything this resource knows is learned while running, so the snapshot is
   *  empty and the whole report arrives through `setStatus`. It still has to
   *  exist: a resource that publishes nothing is absent from `resources`. */
  snapshot(): Record<string, unknown> {
    return {};
  }

  private get namespace(): string {
    return this.manifest.schema ?? "public";
  }

  qualifiedTableName(table: DeclaredTable): string {
    assertListedTable(
      `Postgres.Schema "${this.manifest.metadata.name}"`,
      (this.manifest.tables ?? []).map((listed) => listed.declaration),
      table,
    );
    return this.driver.qualify(this.namespace, table.name);
  }

  /** `clock_timestamp()` rather than `now()`: the latter is the transaction's
   *  start, so two statements of one transaction would record one instant. */
  currentInstant(): string {
    return "clock_timestamp()";
  }

  async run(): Promise<void> {
    const status = await runSchemaPass(this.driver, this.ctx, {
      schema: this.namespace,
      ledger: this.manifest.ledger,
      version: this.manifest.version,
      tables: (this.manifest.tables ?? []).map((table) => table.declaration),
      enums: (this.manifest.enums ?? []).map((declared) => declared.declaration),
      extensions: this.manifest.extensions ?? [],
      prepare: this.manifest.prepare ?? {},
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
  const connection = resolveSqlConnection(
    resource.connection,
    ctx,
    () => `Postgres.Schema "${resource.metadata.name}": 'connection'`,
  );
  if (!connection) {
    throw new Error(`Postgres.Schema "${resource.metadata.name}": missing connection`);
  }
  return new PostgresSchemaResource(resource, ctx, new PostgresSchemaDriver(connection));
}
