import type { InvokeContext, ResourceContext, ResourceInstance, RuntimeResource } from "@telorun/sdk";
import { isSqlConnection, type SqlConnection } from "@telorun/sql";
import { planQuery, sortText, type QueryInputs } from "./collection-query.js";
import { countStatement, pageStatement } from "./collection-statement.js";
import { decodeRow, decodeValue, modelProperties, type ModelProperty } from "./model-properties.js";
import { modelSchema } from "./model-schema.js";
import { encodeCursor } from "./page-cursor.js";

type ReaderResource = RuntimeResource & {
  connection: unknown;
  table: string;
  model: unknown;
};

export interface CollectionPage {
  rows: Record<string, unknown>[];
  total: number;
  next: string | null;
}

/**
 * Reads a table as a collection: filtered, ordered, one page at a time. The
 * statement is built from the model's declared properties and rendered through
 * the connection's dialect, so it is the same request on every engine.
 */
class Reader implements ResourceInstance {
  private properties?: Map<string, ModelProperty>;

  constructor(
    private readonly resource: ReaderResource,
    private readonly ctx: ResourceContext,
  ) {}

  async invoke(inputs: QueryInputs, invokeCtx?: InvokeContext): Promise<CollectionPage> {
    const owner = `Crud.Reader '${this.resource.metadata.name}'`;
    const connection: SqlConnection = this.ctx.resolveRef(
      this.resource.connection,
      isSqlConnection,
      () => `'connection' of ${owner}`,
      "Sql.Connection",
    );
    this.properties ??= modelProperties(modelSchema(this.resource.model, this.ctx, owner));
    const properties = this.properties;
    const query = planQuery(properties, inputs ?? {});

    const page = pageStatement(connection.dialect, this.resource.table, properties.values(), query);
    const fetched = await connection.execute<Record<string, unknown>>(page.sql, page.params, undefined, invokeCtx);
    const more = fetched.rows.length > query.limit;
    const stored = fetched.rows.slice(0, query.limit);
    const rows = stored.map((row) => decodeRow(properties, row));

    // A first page with nothing after it holds every match.
    let total = rows.length;
    if (query.after || more) {
      const count = countStatement(connection.dialect, this.resource.table, query);
      const counted = await connection.execute<{ total: unknown }>(count.sql, count.params, undefined, invokeCtx);
      total = Number(counted.rows[0]?.total);
    }

    // The cursor holds what the column holds: a NULL sorts as one whatever the
    // record shows in its place.
    const sorted = query.sort.property;
    const next = more
      ? encodeCursor({
          sort: sortText(query.sort),
          value: decodeValue(sorted, stored[stored.length - 1][sorted.name]),
          id: rows[rows.length - 1].id as number,
        })
      : null;
    return { rows, total, next };
  }
}

export async function create(resource: ReaderResource, ctx: ResourceContext): Promise<ResourceInstance> {
  return new Reader(resource, ctx);
}
