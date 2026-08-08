import type { Invocable, ResourceContext, ResourceInstance } from "@telorun/sdk";
import type { SqlConnection } from "./sql-connection.js";
import { resolveSqlConnection } from "./sql-connection-ref.js";
import { currentTxId } from "./transaction-store.js";

interface SqlTransactionManifest {
  metadata: { name: string; module: string };
  connection: SqlConnection;
  steps: Invocable;
  inputs?: Record<string, unknown>;
}

export class SqlTransactionResource implements ResourceInstance {
  constructor(
    private readonly manifest: SqlTransactionManifest,
    private readonly ctx: ResourceContext,
  ) {}

  getConnection(): SqlConnection {
    return (
      resolveSqlConnection(
        this.manifest.connection,
        this.ctx,
        () => `Sql.Transaction "${this.manifest.metadata.name}": 'connection'`,
      ) ?? failMissingConnection(this.manifest.metadata.name)
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

    // The declared `inputs:` map's CEL reads the caller's invocation input as
    // `inputs.<field>` — the same variable name a Run.Sequence step's inputs
    // read, and what the slot's `inputs: /inputs` pointer names.
    const celScope = { inputs: input ?? {} };

    // Flat nesting: if already inside a transaction, reuse it
    if (currentTxId()) {
      return m.steps.invoke(ctx.expandValue(m.inputs ?? {}, celScope));
    }

    const conn = this.getConnection();
    const expandedInputs = ctx.expandValue(m.inputs ?? {}, celScope);

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
