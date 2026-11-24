import { integerInput, type InvokeContext, type ResourceContext, type ResourceInstance, type ZoneEntry } from "@telorun/sdk";
import { lockStatement, replaceStatement } from "./collection-statement.js";
import { decodeRow } from "./model-properties.js";
import { etagOf, preconditionFailed, preconditionHolds } from "./record-precondition.js";
import { inTransaction } from "./write-transaction.js";
import { Writer, type WriterResource } from "./writer.js";

interface ReplaceInputs {
  id: unknown;
  data: Record<string, unknown>;
  ifMatch?: string | null;
}

interface Replaced {
  rowCount: number;
  row?: Record<string, unknown>;
  etag?: string;
}

/**
 * Replaces what its shape declares of one row. The statement names those
 * columns and no other, binds every value, and answers with the row as it is
 * now stored. Given an `If-Match`, the row is read under its write lock first
 * and replaced only while it still has that validator.
 */
class Updater extends Writer implements ResourceInstance {
  async invoke(inputs: ReplaceInputs, invokeCtx?: InvokeContext): Promise<Replaced> {
    const connection = this.connection();
    const owner = `Crud.Updater '${this.resource.metadata.name}'`;
    const id = integerInput(inputs.id) ?? inputs.id;
    const replace = replaceStatement(
      connection.dialect,
      this.resource.table,
      this.writable.values(),
      id,
      inputs.data ?? {},
      this.readable.values(),
    );
    const preconditioned = typeof inputs.ifMatch === "string" && inputs.ifMatch.trim() !== "";
    const write = async (zone: ZoneEntry | undefined): Promise<Replaced> => {
      if (preconditioned) {
        const lock = lockStatement(connection.dialect, this.resource.table, id, this.readable.values());
        const held = (await connection.execute<Record<string, unknown>>(lock.sql, lock.params, zone, invokeCtx)).rows[0];
        if (!held) return { rowCount: 0 };
        if (!preconditionHolds(inputs.ifMatch, etagOf(decodeRow(this.readable, held)))) throw preconditionFailed(owner);
      }
      const result = await connection.execute<Record<string, unknown>>(replace.sql, replace.params, zone, invokeCtx);
      const stored = result.rows[0];
      if (!stored) return { rowCount: 0 };
      const row = decodeRow(this.readable, stored);
      return { rowCount: 1, row, etag: etagOf(row) };
    };
    return preconditioned ? inTransaction(this.ctx, connection, invokeCtx, write) : write(undefined);
  }
}

export async function create(resource: WriterResource, ctx: ResourceContext): Promise<ResourceInstance> {
  return new Updater(resource, ctx, `Crud.Updater '${resource.metadata.name}'`);
}
