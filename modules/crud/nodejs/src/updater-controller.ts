import { integerInput, type InvokeContext, type ResourceContext, type ResourceInstance, type RuntimeResource } from "@telorun/sdk";
import { isSqlConnection, type SqlConnection } from "@telorun/sql";
import { replaceStatement } from "./collection-statement.js";
import { modelProperties, type ModelProperty } from "./model-properties.js";
import { modelSchema } from "./model-schema.js";

type UpdaterResource = RuntimeResource & {
  connection: unknown;
  table: string;
  model: unknown;
};

interface ReplaceInputs {
  id: unknown;
  data: Record<string, unknown>;
}

/**
 * Replaces one row with a whole record. The statement names the model's
 * declared columns and no other, binds every value, and is rendered through the
 * connection's dialect.
 */
class Updater implements ResourceInstance {
  private properties?: Map<string, ModelProperty>;

  constructor(
    private readonly resource: UpdaterResource,
    private readonly ctx: ResourceContext,
  ) {}

  async invoke(inputs: ReplaceInputs, invokeCtx?: InvokeContext): Promise<{ rowCount: number }> {
    const owner = `Crud.Updater '${this.resource.metadata.name}'`;
    const connection: SqlConnection = this.ctx.resolveRef(
      this.resource.connection,
      isSqlConnection,
      () => `'connection' of ${owner}`,
      "Sql.Connection",
    );
    this.properties ??= modelProperties(modelSchema(this.resource.model, this.ctx, owner));
    const statement = replaceStatement(
      connection.dialect,
      this.resource.table,
      this.properties.values(),
      integerInput(inputs.id) as number,
      inputs.data,
    );
    const result = await connection.execute(statement.sql, statement.params, undefined, invokeCtx);
    return { rowCount: connection.toRowCount(result) };
  }
}

export async function create(resource: UpdaterResource, ctx: ResourceContext): Promise<ResourceInstance> {
  return new Updater(resource, ctx);
}
