import { randomUUID } from "crypto";
import type { ResourceContext, ResourceInstance } from "@telorun/sdk";
import type { SqlConnectionResource } from "./sql-connection-controller.js";
import { currentTxId, deleteTx, getTx, setTx, txStorage } from "./transaction-store.js";

interface SqlTransactionManifest {
  metadata: { name: string; module: string };
  connection: string;
  steps: string;
  inputs?: Record<string, unknown>;
}

export class SqlTransactionResource implements ResourceInstance {
  constructor(
    private readonly manifest: SqlTransactionManifest,
    private readonly ctx: ResourceContext,
  ) {}

  getClient(): { client: unknown; driver: "postgres" | "sqlite" } {
    const txId = currentTxId();
    if (!txId) {
      throw new Error(
        `Sql.Transaction '${this.manifest.metadata.name}': getClient() called outside an active transaction`,
      );
    }
    const entry = getTx(txId);
    if (!entry) {
      throw new Error(
        `Sql.Transaction '${this.manifest.metadata.name}': no active transaction for id ${txId}`,
      );
    }
    return entry;
  }

  async invoke(input: unknown): Promise<unknown> {
    const m = this.manifest;
    const ctx = this.ctx;

    // Flat nesting: if already inside a transaction, reuse it
    if (currentTxId()) {
      const stepsInvokable = ctx.moduleContext.getInvokable(m.steps);
      const expandedInputs = ctx.expandValue(m.inputs ?? {}, input ?? {});
      return stepsInvokable.invoke(expandedInputs);
    }

    const conn = ctx.moduleContext.getInstance(m.connection) as SqlConnectionResource;
    const txId = randomUUID();
    const expandedInputs = ctx.expandValue(m.inputs ?? {}, input ?? {});
    const stepsInvokable = ctx.moduleContext.getInvokable(m.steps);

    if (conn.driver === "postgres") {
      const pgClient = await conn.getPool().connect();
      try {
        await pgClient.query("BEGIN");
        setTx(txId, { client: pgClient, driver: "postgres" });
        try {
          const result = await txStorage.run(txId, () => stepsInvokable.invoke(expandedInputs));
          await pgClient.query("COMMIT");
          return result;
        } catch (err) {
          await pgClient.query("ROLLBACK");
          throw err;
        } finally {
          deleteTx(txId);
        }
      } finally {
        pgClient.release();
      }
    } else {
      const db = conn.getDb();
      return txStorage.run(txId, async () => {
        db.exec("BEGIN");
        setTx(txId, { client: db, driver: "sqlite" });
        try {
          const result = await stepsInvokable.invoke(expandedInputs);
          db.exec("COMMIT");
          return result;
        } catch (err) {
          db.exec("ROLLBACK");
          throw err;
        } finally {
          deleteTx(txId);
        }
      });
    }
  }
}

export function register(): void {}

export async function create(
  resource: SqlTransactionManifest,
  ctx: ResourceContext,
): Promise<SqlTransactionResource> {
  return new SqlTransactionResource(resource, ctx);
}
