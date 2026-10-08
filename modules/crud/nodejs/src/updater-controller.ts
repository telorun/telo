import { integerInput, type InvokeContext, type ResourceContext, type ResourceInstance } from "@telorun/sdk";
import { replaceStatement } from "./collection-statement.js";
import { decodeRow } from "./model-properties.js";
import { Writer, type WriterResource } from "./writer.js";

interface ReplaceInputs {
  id: unknown;
  data: Record<string, unknown>;
}

/**
 * Replaces what its shape declares of one row. The statement names those
 * columns and no other, binds every value, and answers with the row as it is
 * now stored.
 */
class Updater extends Writer implements ResourceInstance {
  async invoke(inputs: ReplaceInputs, invokeCtx?: InvokeContext): Promise<{ rowCount: number; row?: Record<string, unknown> }> {
    const connection = this.connection();
    const statement = replaceStatement(
      connection.dialect,
      this.resource.table,
      this.writable.values(),
      integerInput(inputs.id) ?? inputs.id,
      inputs.data ?? {},
      this.readable.values(),
    );
    const result = await connection.execute<Record<string, unknown>>(statement.sql, statement.params, undefined, invokeCtx);
    const stored = result.rows[0];
    return stored ? { rowCount: 1, row: decodeRow(this.readable, stored) } : { rowCount: 0 };
  }
}

export async function create(resource: WriterResource, ctx: ResourceContext): Promise<ResourceInstance> {
  return new Updater(resource, ctx, `Crud.Updater '${resource.metadata.name}'`);
}
