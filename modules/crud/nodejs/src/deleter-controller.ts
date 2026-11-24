import { integerInput, type InvokeContext, type ResourceContext, type ResourceInstance, type ZoneEntry } from "@telorun/sdk";
import { deleteStatement, lockStatement } from "./collection-statement.js";
import { decodeRow } from "./model-properties.js";
import { etagOf, preconditionFailed, preconditionHolds } from "./record-precondition.js";
import { inTransaction } from "./write-transaction.js";
import { Writer, type WriterResource } from "./writer.js";

/**
 * Deletes one row. Given an `If-Match`, the row is read under its write lock
 * first and deleted only while it still has that validator.
 */
class Deleter extends Writer implements ResourceInstance {
  async invoke(inputs: { id: unknown; ifMatch?: string | null }, invokeCtx?: InvokeContext): Promise<{ rowCount: number }> {
    const connection = this.connection();
    const owner = `Crud.Deleter '${this.resource.metadata.name}'`;
    const id = integerInput(inputs.id) ?? inputs.id;
    const remove = deleteStatement(connection.dialect, this.resource.table, id);
    const preconditioned = typeof inputs.ifMatch === "string" && inputs.ifMatch.trim() !== "";
    const write = async (zone: ZoneEntry | undefined): Promise<{ rowCount: number }> => {
      if (preconditioned) {
        const lock = lockStatement(connection.dialect, this.resource.table, id, this.readable.values());
        const held = (await connection.execute<Record<string, unknown>>(lock.sql, lock.params, zone, invokeCtx)).rows[0];
        if (!held) return { rowCount: 0 };
        if (!preconditionHolds(inputs.ifMatch, etagOf(decodeRow(this.readable, held)))) throw preconditionFailed(owner);
      }
      const result = await connection.execute(remove.sql, remove.params, zone, invokeCtx);
      return { rowCount: connection.toRowCount(result) };
    };
    return preconditioned ? inTransaction(this.ctx, connection, invokeCtx, write) : write(undefined);
  }
}

export async function create(resource: WriterResource, ctx: ResourceContext): Promise<ResourceInstance> {
  return new Deleter(resource, ctx, `Crud.Deleter '${resource.metadata.name}'`);
}
