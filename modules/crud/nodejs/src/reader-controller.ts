import type { InvokeContext, ResourceContext, ResourceInstance, RuntimeResource } from "@telorun/sdk";
import { isSqlConnection, type SqlConnection } from "@telorun/sql";
import { planQuery, sortText, type AcceptedQuery, type QueryInputs } from "./collection-query.js";
import { countStatement, pageStatement } from "./collection-statement.js";
import { decodeRow, decodeValue, KEY, modelProperties, type ModelProperty } from "./model-properties.js";
import { modelSchema } from "./model-schema.js";
import { encodeCursor } from "./page-cursor.js";

type ReaderResource = RuntimeResource & {
  connection: unknown;
  table: string;
  model: unknown;
  row: unknown;
  query: AcceptedQuery;
};

export interface CollectionPage {
  rows: Record<string, unknown>[];
  total: number;
  next: string | null;
}

/**
 * Reads a table as a collection: filtered, ordered, one page at a time. A
 * request may filter and sort only by what `query` declares, with values typed
 * by `model`; a row holds the properties of `row`. The statement is rendered
 * through the connection's dialect, so it is the same request on every engine.
 */
class Reader implements ResourceInstance {
  private readable?: Map<string, ModelProperty>;
  private returned?: Map<string, ModelProperty>;

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
    this.readable ??= modelProperties(modelSchema(this.resource.model, this.ctx, owner));
    this.returned ??= modelProperties(modelSchema(this.resource.row, this.ctx, owner, "row"));
    const readable = this.readable;
    const returned = this.returned;
    const query = planQuery(readable, this.resource.query, inputs ?? {});

    // The key and the sorted property are read whatever the row shows: the next
    // cursor is made of them.
    const key = readable.get(KEY)!;
    const selected = new Set([...returned.values(), key, query.sort.property]);
    const page = pageStatement(connection.dialect, this.resource.table, selected, query);
    const fetched = await connection.execute<Record<string, unknown>>(page.sql, page.params, undefined, invokeCtx);
    const more = fetched.rows.length > query.limit;
    const stored = fetched.rows.slice(0, query.limit);
    const rows = stored.map((row) => decodeRow(returned, row));

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
    const last = stored[stored.length - 1];
    const next = more
      ? encodeCursor({
          sort: sortText(query.sort),
          value: decodeValue(sorted, last[sorted.name]),
          id: decodeValue(key, last[KEY]) as string | number,
        })
      : null;
    return { rows, total, next };
  }
}

export async function create(resource: ReaderResource, ctx: ResourceContext): Promise<ResourceInstance> {
  return new Reader(resource, ctx);
}
