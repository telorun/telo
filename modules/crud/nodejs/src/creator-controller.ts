import { RuntimeError, type InvokeContext, type ResourceContext, type ResourceInstance } from "@telorun/sdk";
import { insertStatement } from "./collection-statement.js";
import { decodeRow } from "./model-properties.js";
import { etagOf } from "./record-precondition.js";
import { Writer, type WriterResource } from "./writer.js";

/**
 * Inserts one row. The statement names the columns its shape declares and no
 * other, binds every value, and answers with the row as it was stored and its
 * validator.
 */
class Creator extends Writer implements ResourceInstance {
  async invoke(
    inputs: { data: Record<string, unknown> },
    invokeCtx?: InvokeContext,
  ): Promise<{ row: Record<string, unknown>; etag: string }> {
    const connection = this.connection();
    const statement = insertStatement(
      connection.dialect,
      this.resource.table,
      this.writable.values(),
      inputs.data ?? {},
      this.readable.values(),
    );
    const result = await connection.execute<Record<string, unknown>>(statement.sql, statement.params, undefined, invokeCtx);
    const stored = result.rows[0];
    if (!stored) {
      throw new RuntimeError(
        "ERR_CRUD_WRITE_UNREADABLE",
        `Crud.Creator '${this.resource.metadata.name}': the insert returned no row, so the created record cannot be answered. The connection must support INSERT … RETURNING.`,
      );
    }
    const row = decodeRow(this.readable, stored);
    return { row, etag: etagOf(row) };
  }
}

export async function create(resource: WriterResource, ctx: ResourceContext): Promise<ResourceInstance> {
  return new Creator(resource, ctx, `Crud.Creator '${resource.metadata.name}'`);
}
