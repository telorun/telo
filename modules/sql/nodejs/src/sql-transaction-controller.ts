import type { Invocable, ResourceContext, ResourceInstance } from "@telorun/sdk";
import type { SqlConnectionResource } from "./sql-connection-controller.js";
import { resolveSqlConnection } from "./sql-connection-ref.js";
import { currentTxId } from "./transaction-store.js";

interface SqlTransactionManifest {
  metadata: { name: string; module: string };
  connection: SqlConnectionResource;
  steps: Invocable;
  inputs?: Record<string, unknown>;
}

export class SqlTransactionResource implements ResourceInstance {
  constructor(
    private readonly manifest: SqlTransactionManifest,
    private readonly ctx: ResourceContext,
  ) {}

  getConnection(): SqlConnectionResource {
    return (
      resolveSqlConnection(this.manifest.connection, this.ctx) ??
      failMissingConnection(this.manifest.metadata.name)
    );
  }

  assertActive(): void {
    if (!currentTxId()) {
      throw new Error(
        `Sql.Transaction '${this.manifest.metadata.name}': used outside an active transaction`,
      );
    }
  }

  async invoke(input: unknown): Promise<unknown> {
    const m = this.manifest;
    const ctx = this.ctx;

    // Flat nesting: if already inside a transaction, reuse it
    if (currentTxId()) {
      const expandedInputs = ctx.expandValue(m.inputs ?? {}, input ?? {});
      return m.steps.invoke(expandedInputs);
    }

    const conn = this.getConnection();
    const expandedInputs = ctx.expandValue(m.inputs ?? {}, input ?? {});

    return conn.transaction(() => m.steps.invoke(expandedInputs));
  }
}

function failMissingConnection(name: string): never {
  throw new Error(`Sql.Transaction '${name}': missing connection`);
}

export function register(): void {}

export async function create(
  resource: SqlTransactionManifest,
  ctx: ResourceContext,
): Promise<SqlTransactionResource> {
  return new SqlTransactionResource(resource, ctx);
}
