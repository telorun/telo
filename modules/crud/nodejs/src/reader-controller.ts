import {
  isParameterizedSql,
  RuntimeError,
  type InvokeContext,
  type ResourceContext,
  type ResourceInstance,
  type RuntimeResource,
} from "@telorun/sdk";
import { isSqlConnection, type SqlConnection } from "@telorun/sql";
import { planFacet, planQuery, sortText, type AcceptedQuery, type QueryInputs } from "./collection-query.js";
import { countStatement, facetStatement, pageStatement, type RowSource } from "./collection-statement.js";
import { decodeRow, decodeValue, modelProperties, type JsonSchema, type ModelProperty } from "./model-properties.js";
import { modelSchema } from "./model-schema.js";
import { encodeCursor, encodeFacetCursor } from "./page-cursor.js";

type ReaderResource = RuntimeResource & {
  connection: unknown;
  collection: unknown;
  table?: string;
  select?: unknown;
  row?: unknown;
  query?: AcceptedQuery;
};

/** What a collection publishes, as far as a read needs it. */
interface CollectionReading {
  model: { schema: JsonSchema };
  key: string;
  query: AcceptedQuery;
}

interface Publishing {
  snapshot(): unknown;
}

const isPublishing = (candidate: unknown): candidate is Publishing =>
  typeof (candidate as Publishing | null)?.snapshot === "function";

const isReading = (candidate: unknown): candidate is CollectionReading => {
  const reading = candidate as CollectionReading | null;
  return typeof reading?.key === "string" && typeof reading.model?.schema === "object" && Array.isArray(reading.query?.filters);
};

/** What a read is judged against, resolved once. */
interface Plan {
  readable: Map<string, ModelProperty>;
  returned: Map<string, ModelProperty>;
  accepted: AcceptedQuery;
  key: string;
}

export interface CollectionPage {
  rows: Record<string, unknown>[];
  total: number;
  next: string | null;
}

/** One page of a property's present values, each with how many rows hold it. */
export interface FacetPage {
  values: { value: unknown; count: number }[];
  next: string | null;
}

/**
 * Reads a table, or one fixed SELECT, as a collection: filtered, ordered, one
 * page at a time. A request may filter and sort only by what the collection's
 * query declares, with values typed by its model; a row holds the properties of
 * `row`, the model unless overridden. The statement is rendered through the
 * connection's dialect, so it is the same request on every engine.
 */
class Reader implements ResourceInstance {
  private plan?: Plan;

  constructor(
    private readonly resource: ReaderResource,
    private readonly ctx: ResourceContext,
  ) {}

  async invoke(inputs: QueryInputs, invokeCtx?: InvokeContext): Promise<CollectionPage | FacetPage> {
    const owner = `Crud.Reader '${this.resource.metadata.name}'`;
    const connection: SqlConnection = this.ctx.resolveRef(
      this.resource.connection,
      isSqlConnection,
      () => `'connection' of ${owner}`,
      "Sql.Connection",
    );
    const { readable, returned, accepted, key: keyName } = (this.plan ??= this.planned(owner));
    const source = this.source();
    if (inputs?.facet !== undefined && inputs.facet !== null) {
      return this.facet(connection, source, readable, accepted, inputs, invokeCtx);
    }
    const query = planQuery(readable, accepted, inputs ?? {}, keyName);

    // The key and the sorted property are read whatever the row shows: the next
    // cursor is made of them.
    const key = query.key;
    const selected = new Set([...returned.values(), key, query.sort.property]);
    const page = pageStatement(connection.dialect, source, selected, query);
    const fetched = await connection.execute<Record<string, unknown>>(page.sql, page.params, undefined, invokeCtx);
    const more = fetched.rows.length > query.limit;
    const stored = fetched.rows.slice(0, query.limit);
    const rows = stored.map((row) => decodeRow(returned, row));

    // A first page with nothing after it holds every match.
    let total = rows.length;
    if (query.after || more) {
      const count = countStatement(connection.dialect, source, query);
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
          id: decodeValue(key, last[key.name]) as string | number,
        })
      : null;
    return { rows, total, next };
  }

  /** The collection's model, key and query, and where rows come from. */
  private planned(owner: string): Plan {
    const instance = this.ctx.resolveRef(
      this.resource.collection,
      (candidate): candidate is Publishing | CollectionReading => isPublishing(candidate) || isReading(candidate),
      () => `'collection' of ${owner}`,
      "DataModel.Collection",
    );
    const reading = isPublishing(instance) ? instance.snapshot() : instance;
    if (!isReading(reading)) {
      throw new RuntimeError(
        "ERR_REF_UNRESOLVED",
        `${owner}: 'collection' publishes no record model, key and accepted query. Point it at a collection.`,
      );
    }
    const { table, select } = this.resource;
    if ((table === undefined) === (select === undefined)) {
      throw new RuntimeError("ERR_RESOURCE_SCHEMA_VALIDATION_FAILED", `${owner}: name exactly one of 'table' and 'select'.`);
    }
    // Over a SELECT, a column is aliased to its property's own name.
    const naming = select === undefined ? "column" : "name";
    const readable = modelProperties(reading.model.schema, naming);
    if (!readable.has(reading.key)) {
      throw new RuntimeError("ERR_REF_UNRESOLVED", `${owner}: the collection's model declares no key property '${reading.key}'.`);
    }
    const row = this.resource.row === undefined ? reading.model.schema : modelSchema(this.resource.row, this.ctx, owner, "row");
    return {
      readable,
      returned: modelProperties(row, naming),
      accepted: this.resource.query ?? reading.query,
      key: reading.key,
    };
  }

  /** Where rows come from. A SELECT is expanded per call, as its holes may read a changing value. */
  private source(): RowSource {
    const { table, select } = this.resource;
    if (table !== undefined) return table;
    const expanded = this.ctx.expandValue(select, {});
    return isParameterizedSql(expanded) ? expanded : { fragments: [String(expanded)], values: [] };
  }

  private async facet(
    connection: SqlConnection,
    source: RowSource,
    readable: Map<string, ModelProperty>,
    accepted: AcceptedQuery,
    inputs: QueryInputs,
    invokeCtx?: InvokeContext,
  ): Promise<FacetPage> {
    const query = planFacet(readable, accepted, inputs);
    const statement = facetStatement(connection.dialect, source, query);
    const fetched = await connection.execute<{ value: unknown; count: unknown }>(
      statement.sql,
      statement.params,
      undefined,
      invokeCtx,
    );
    const more = fetched.rows.length > query.limit;
    const values = fetched.rows
      .slice(0, query.limit)
      .map((row) => ({ value: decodeValue(query.property, row.value), count: Number(row.count) }));
    const next = more
      ? encodeFacetCursor({ property: query.property.name, value: values[values.length - 1].value })
      : null;
    return { values, next };
  }
}

export async function create(resource: ReaderResource, ctx: ResourceContext): Promise<ResourceInstance> {
  return new Reader(resource, ctx);
}
