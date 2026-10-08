import type { ResourceContext, RuntimeResource } from "@telorun/sdk";
import { isSqlConnection, type SqlConnection } from "@telorun/sql";
import { modelProperties, type ModelProperty } from "./model-properties.js";
import { modelSchema } from "./model-schema.js";

export type WriterResource = RuntimeResource & {
  connection: unknown;
  table: string;
  model: unknown;
  record: unknown;
};

/** What both write routes share: the shape a body is written by, and the shape
 *  the written row is answered in. */
export class Writer {
  private written?: Map<string, ModelProperty>;
  private returned?: Map<string, ModelProperty>;

  constructor(
    protected readonly resource: WriterResource,
    protected readonly ctx: ResourceContext,
    private readonly owner: string,
  ) {}

  protected connection(): SqlConnection {
    return this.ctx.resolveRef(
      this.resource.connection,
      isSqlConnection,
      () => `'connection' of ${this.owner}`,
      "Sql.Connection",
    );
  }

  protected get writable(): Map<string, ModelProperty> {
    return (this.written ??= modelProperties(modelSchema(this.resource.model, this.ctx, this.owner)));
  }

  protected get readable(): Map<string, ModelProperty> {
    return (this.returned ??= modelProperties(modelSchema(this.resource.record, this.ctx, this.owner, "record")));
  }
}
