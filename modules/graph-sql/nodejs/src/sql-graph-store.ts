import {
  getRefIdentity,
  type InvokeContext,
  type ResourceContext,
  type ResourceInstance,
} from "@telorun/sdk";
import {
  assertEndpointsListed,
  decodeKeyTail,
  encodeKeyTail,
  type Absent,
  type CursorInvalid,
  type EndpointAbsent,
  type Exists,
  type Found,
  type GraphFilter,
  type GraphNodeType,
  type GraphNodeValue,
  type GraphPage,
  type GraphPageResult,
  type GraphRelationshipType,
  type GraphRelationshipValue,
  type GraphStore,
  type PreparedTraversal,
  type TraversalSpec,
} from "@telorun/graph";
import {
  isSqlSchema,
  resolveSqlConnection,
  SqlFragments,
  sqlWhere,
  type SqlConnection,
  type SqlSchema,
} from "@telorun/sql";
import {
  compileNode,
  compileRelationship,
  namedColumns,
  nodeValue,
  relationshipValue,
  type CompiledNode,
  type CompiledRelationship,
} from "./compiled-types.js";
import { assertSchemaHoldsTables } from "./declared-references.js";
import { refuse } from "./declared-table.js";
import {
  deleteNode,
  deleteRelationship,
  endpointsPresent,
  insertNode,
  insertRelationship,
  pageLimit,
  selectNode,
  updateNode,
  updateRelationship,
} from "./graph-statements.js";
import { isSqlNodeType, type SqlNodeType } from "./node-type.js";
import { filterConditions } from "./compiled-types.js";
import { isSqlRelationshipType, type SqlRelationshipType } from "./relationship-type.js";
import {
  prepareTraversal,
  traversalStatement,
  type SqlPreparedTraversal,
} from "./traversal-statement.js";

interface StoreManifest {
  metadata: { name: string; module?: string };
  connection?: unknown;
  schema?: unknown;
  nodes?: unknown[];
  relationships?: unknown[];
}

type Row = Record<string, unknown>;

function nameOf(type: object): string {
  return getRefIdentity(type)?.name ?? "(inline)";
}

/**
 * `GraphSql.Store` — the graph over one connection, in the standard SQL both
 * engines speak. Every identifier comes from a declaration, fixed when the
 * store is created: tables as its schema addresses them, columns quoted by the
 * connection's dialect; every value is bound. Every operation's effect is one
 * statement, so it is atomic on its own and joins the caller's transaction when
 * one is open on this connection.
 */
class SqlGraphStore implements GraphStore, ResourceInstance {
  private readonly nodeTables = new Map<GraphNodeType, CompiledNode>();
  private readonly relationshipTables = new Map<GraphRelationshipType, CompiledRelationship>();

  constructor(
    private readonly describe: string,
    private readonly connection: SqlConnection,
    schema: SqlSchema,
    readonly nodes: readonly SqlNodeType[],
    readonly relationships: readonly SqlRelationshipType[],
  ) {
    const dialect = connection.dialect;
    for (const node of nodes) this.nodeTables.set(node, compileNode(dialect, schema, node));
    for (const relationship of relationships) {
      this.relationshipTables.set(
        relationship,
        compileRelationship(
          dialect,
          schema,
          relationship,
          this.node(relationship.source),
          this.node(relationship.target),
        ),
      );
    }
  }

  snapshot(): Record<string, unknown> {
    return {};
  }

  private node(type: GraphNodeType): CompiledNode {
    const compiled = this.nodeTables.get(type);
    if (!compiled) {
      throw new Error(`${this.describe} does not list node type '${nameOf(type)}' in 'nodes:'.`);
    }
    return compiled;
  }

  private relationship(type: GraphRelationshipType): CompiledRelationship {
    const compiled = this.relationshipTables.get(type);
    if (!compiled) {
      throw new Error(
        `${this.describe} does not list relationship type '${nameOf(type)}' in 'relationships:'.`,
      );
    }
    return compiled;
  }

  private async rows(sql: SqlFragments, ctx: InvokeContext | undefined): Promise<Row[]> {
    const result = await this.connection.executeTemplate<Row>(
      sql.fragments,
      sql.boundValues,
      undefined,
      ctx,
    );
    return result.rows;
  }

  private assignments(
    typeName: string,
    columns: CompiledNode["properties"],
    properties: Record<string, unknown>,
  ) {
    return namedColumns(this.describe, typeName, columns, properties);
  }

  async createNode(
    type: GraphNodeType,
    key: unknown,
    properties: Record<string, unknown>,
    ctx?: InvokeContext,
  ): Promise<Found<GraphNodeValue> | Exists> {
    const node = this.node(type);
    const set = this.assignments(nameOf(type), node.properties, properties);
    const [row] = await this.rows(insertNode(node, key, set, "nothing"), ctx);
    return row ? { status: "found", value: nodeValue(node, row) } : { status: "exists" };
  }

  async mergeNode(
    type: GraphNodeType,
    key: unknown,
    properties: Record<string, unknown>,
    ctx?: InvokeContext,
  ): Promise<Found<GraphNodeValue>> {
    const node = this.node(type);
    const set = this.assignments(nameOf(type), node.properties, properties);
    const [row] = await this.rows(insertNode(node, key, set, "update"), ctx);
    if (!row) {
      throw new Error(`${this.describe}: merging '${nameOf(type)}' returned no row.`);
    }
    return { status: "found", value: nodeValue(node, row) };
  }

  async updateNode(
    type: GraphNodeType,
    key: unknown,
    properties: Record<string, unknown>,
    ctx?: InvokeContext,
  ): Promise<Found<GraphNodeValue> | Absent> {
    const node = this.node(type);
    const set = this.assignments(nameOf(type), node.properties, properties);
    if (set.length === 0) {
      throw new Error(`${this.describe}: updating '${nameOf(type)}' needs at least one property.`);
    }
    const [row] = await this.rows(updateNode(node, key, set), ctx);
    return row ? { status: "found", value: nodeValue(node, row) } : { status: "absent" };
  }

  async deleteNode(
    type: GraphNodeType,
    key: unknown,
    ctx?: InvokeContext,
  ): Promise<Found<GraphNodeValue> | Absent> {
    const node = this.node(type);
    const [row] = await this.rows(deleteNode(node, key), ctx);
    return row ? { status: "found", value: nodeValue(node, row) } : { status: "absent" };
  }

  async getNode(
    type: GraphNodeType,
    key: unknown,
    ctx?: InvokeContext,
  ): Promise<Found<GraphNodeValue> | Absent> {
    const node = this.node(type);
    const [row] = await this.rows(selectNode(node, key), ctx);
    return row ? { status: "found", value: nodeValue(node, row) } : { status: "absent" };
  }

  /** A page cut from one row more than it holds: the items, and the tail of the
   *  last one when that extra row says more exist. */
  private page<T>(
    rows: readonly Row[],
    limit: number,
    value: (row: Row) => T,
    keys: (row: Row) => unknown[],
  ): Found<GraphPageResult<T>> {
    const kept = rows.slice(0, limit);
    const items = kept.map(value);
    return rows.length > limit
      ? { status: "found", value: { items, next: encodeKeyTail(keys(kept[kept.length - 1])) } }
      : { status: "found", value: { items } };
  }

  async findNodes(
    type: GraphNodeType,
    where: GraphFilter,
    page: GraphPage,
    ctx?: InvokeContext,
  ): Promise<Found<GraphPageResult<GraphNodeValue>> | CursorInvalid> {
    const node = this.node(type);
    const conditions = filterConditions(this.describe, nameOf(type), where, node.properties, "");
    if (page.after !== undefined) {
      const after = decodeKeyTail(page.after, 1);
      if (!after) return { status: "cursorInvalid" };
      conditions.push(new SqlFragments().text(`${node.key.sql} > `).value(after[0]));
    }
    const sql = new SqlFragments()
      .text(`SELECT ${node.returning} FROM ${node.table}`)
      .append(sqlWhere(conditions))
      .text(` ORDER BY ${node.key.sql}`)
      .append(pageLimit(page.limit));
    return this.page(
      await this.rows(sql, ctx),
      page.limit,
      (row) => nodeValue(node, row),
      (row) => [row[node.key.name]],
    );
  }

  async createRelationship(
    type: GraphRelationshipType,
    source: unknown,
    target: unknown,
    properties: Record<string, unknown>,
    ctx?: InvokeContext,
  ): Promise<Found<GraphRelationshipValue> | Exists | EndpointAbsent> {
    const relationship = this.relationship(type);
    const set = this.assignments(nameOf(type), relationship.properties, properties);
    const [row] = await this.rows(
      insertRelationship(relationship, source, target, set, "nothing"),
      ctx,
    );
    if (row) return { status: "found", value: relationshipValue(relationship, row) };

    // Nothing inserted: a conflict, or an endpoint the insert found no row for.
    const quote = (name: string) => this.connection.dialect.quoteIdentifier(name);
    const [present] = await this.rows(endpointsPresent(relationship, quote, source, target), ctx);
    if (Number(present?.source) === 0) return { status: "endpointAbsent", endpoint: "source" };
    if (Number(present?.target) === 0) return { status: "endpointAbsent", endpoint: "target" };
    return { status: "exists" };
  }

  async mergeRelationship(
    type: GraphRelationshipType,
    source: unknown,
    target: unknown,
    properties: Record<string, unknown>,
    ctx?: InvokeContext,
  ): Promise<Found<GraphRelationshipValue> | Absent> {
    const relationship = this.relationship(type);
    const set = this.assignments(nameOf(type), relationship.properties, properties);
    const [row] = await this.rows(
      insertRelationship(relationship, source, target, set, "update"),
      ctx,
    );
    return row
      ? { status: "found", value: relationshipValue(relationship, row) }
      : { status: "absent" };
  }

  async updateRelationship(
    type: GraphRelationshipType,
    source: unknown,
    target: unknown,
    properties: Record<string, unknown>,
    ctx?: InvokeContext,
  ): Promise<Found<GraphRelationshipValue> | Absent> {
    const relationship = this.relationship(type);
    const set = this.assignments(nameOf(type), relationship.properties, properties);
    if (set.length === 0) {
      throw new Error(`${this.describe}: updating '${nameOf(type)}' needs at least one property.`);
    }
    const [row] = await this.rows(updateRelationship(relationship, source, target, set), ctx);
    return row
      ? { status: "found", value: relationshipValue(relationship, row) }
      : { status: "absent" };
  }

  async deleteRelationship(
    type: GraphRelationshipType,
    source: unknown,
    target: unknown,
    ctx?: InvokeContext,
  ): Promise<Found<GraphRelationshipValue> | Absent> {
    const relationship = this.relationship(type);
    const [row] = await this.rows(deleteRelationship(relationship, source, target), ctx);
    return row
      ? { status: "found", value: relationshipValue(relationship, row) }
      : { status: "absent" };
  }

  async findRelationships(
    type: GraphRelationshipType,
    endpoints: { readonly source?: unknown; readonly target?: unknown },
    where: GraphFilter,
    page: GraphPage,
    ctx?: InvokeContext,
  ): Promise<Found<GraphPageResult<GraphRelationshipValue>> | CursorInvalid> {
    const relationship = this.relationship(type);
    const { sourceColumn: s, targetColumn: t } = relationship;
    const conditions: SqlFragments[] = [];
    if (endpoints.source !== undefined) {
      conditions.push(new SqlFragments().text(`${s.sql} = `).value(endpoints.source));
    }
    if (endpoints.target !== undefined) {
      conditions.push(new SqlFragments().text(`${t.sql} = `).value(endpoints.target));
    }
    if (page.after !== undefined) {
      const after = decodeKeyTail(page.after, 2);
      if (!after) return { status: "cursorInvalid" };
      // The seek names only the columns still free, so it continues along the
      // index that already satisfied the endpoint filter.
      if (endpoints.source !== undefined && endpoints.target === undefined) {
        conditions.push(new SqlFragments().text(`${t.sql} > `).value(after[1]));
      } else if (endpoints.target !== undefined && endpoints.source === undefined) {
        conditions.push(new SqlFragments().text(`${s.sql} > `).value(after[0]));
      } else {
        conditions.push(
          new SqlFragments()
            .text(`(${s.sql}, ${t.sql}) > (`)
            .value(after[0])
            .text(", ")
            .value(after[1])
            .text(")"),
        );
      }
    }
    conditions.push(
      ...filterConditions(this.describe, nameOf(type), where, relationship.properties, ""),
    );
    const sql = new SqlFragments()
      .text(`SELECT ${relationship.returning} FROM ${relationship.table}`)
      .append(sqlWhere(conditions))
      .text(` ORDER BY ${s.sql}, ${t.sql}`)
      .append(pageLimit(page.limit));
    return this.page(
      await this.rows(sql, ctx),
      page.limit,
      (row) => relationshipValue(relationship, row),
      (row) => [row[s.name], row[t.name]],
    );
  }

  prepareTraversal(spec: TraversalSpec): PreparedTraversal {
    const tableNames = new Set([
      ...[...this.nodeTables.values()].map((node) => node.name),
      ...[...this.relationshipTables.values()].map((relationship) => relationship.name),
    ]);
    return prepareTraversal(
      spec,
      this.node(spec.from),
      this.node(spec.to),
      spec.hops.map((hop) => ({
        relationship: this.relationship(hop.relationship),
        direction: hop.direction,
        minHops: hop.minHops,
        maxHops: hop.maxHops,
      })),
      tableNames,
      (name) => this.connection.dialect.quoteIdentifier(name),
    );
  }

  async traverse(
    prepared: PreparedTraversal,
    key: unknown,
    where: GraphFilter,
    page: GraphPage,
    ctx?: InvokeContext,
  ): Promise<Found<GraphPageResult<GraphNodeValue>> | Absent | CursorInvalid> {
    const compiled = prepared as SqlPreparedTraversal;
    const after = page.after === undefined ? undefined : decodeKeyTail(page.after, 1);
    if (page.after !== undefined && !after) return { status: "cursorInvalid" };
    const rows = await this.rows(
      traversalStatement(
        this.describe,
        nameOf(prepared.spec.to),
        compiled,
        key,
        where,
        page.limit,
        after?.[0],
      ),
      ctx,
    );
    if (Number(rows[0]?.[compiled.presentAlias] ?? 0) === 0) return { status: "absent" };
    const end = compiled.end;
    return this.page(
      rows.filter((row) => row[end.key.name] !== null && row[end.key.name] !== undefined),
      page.limit,
      (row) => nodeValue(end, row),
      (row) => [row[end.key.name]],
    );
  }
}

/** The store's schema instance, which addresses every table a statement names.
 *  An engine module that predates table addressing is refused: its tables
 *  would be reached unqualified, through the session's default namespace. */
function resolveSchema(value: unknown, ctx: ResourceContext, describe: string): SqlSchema {
  const schema = ctx.resolveRef(
    value,
    // Any live instance, so one without the member is refused below by name.
    (candidate): candidate is object =>
      isSqlSchema(candidate) ||
      (typeof candidate === "object" && candidate !== null && !!getRefIdentity(candidate)),
    () => `${describe}: 'schema'`,
    "Sql.Schema",
  );
  if (!isSqlSchema(schema)) {
    const identity = getRefIdentity(schema);
    throw new Error(
      `${describe}: 'schema' references '${identity?.name ?? "(inline)"}' of kind ` +
        `'${identity?.kind ?? "(unknown)"}', whose engine module predates table addressing — ` +
        `its schema instance cannot say how its tables are named in their namespace. Upgrade ` +
        `the module that declares that kind.`,
    );
  }
  return schema;
}

/** `GRAPH_TABLE_SHARED` — each type is its own table, by table resource. */
function assertTablesDistinct(
  describe: string,
  nodes: readonly SqlNodeType[],
  relationships: readonly SqlRelationshipType[],
): void {
  const owner = new Map<object, { type: object; field: string }>();
  const types: [object, object, string][] = [
    ...nodes.map((type, index): [object, object, string] => [type, type.tableResource, `nodes[${index}]`]),
    ...relationships.map((type, index): [object, object, string] => [
      type,
      type.tableResource,
      `relationships[${index}]`,
    ]),
  ];
  for (const [type, table, field] of types) {
    const first = owner.get(table);
    if (first) {
      refuse(
        "GRAPH_TABLE_SHARED",
        `${describe} lists '${nameOf(first.type)}' at '${first.field}' and '${nameOf(type)}' at ` +
          `'${field}' over the same table. Each type is its own table, so a row belongs to ` +
          `exactly one type.`,
      );
    }
    owner.set(table, { type, field });
  }
}

export function register(): void {}

export async function create(resource: StoreManifest, ctx: ResourceContext): Promise<SqlGraphStore> {
  const describe = `GraphSql.Store "${resource.metadata.name}"`;
  const connection = resolveSqlConnection(
    resource.connection as SqlConnection | undefined,
    ctx,
    () => `${describe}: 'connection'`,
  );
  if (!connection) throw new Error(`${describe}: 'connection' is required.`);
  const nodes = (resource.nodes ?? []).map((value, index) =>
    ctx.resolveRef(value, isSqlNodeType, () => `${describe}: 'nodes[${index}]'`, "GraphSql.Node"),
  );
  const relationships = (resource.relationships ?? []).map((value, index) =>
    ctx.resolveRef(
      value,
      isSqlRelationshipType,
      () => `${describe}: 'relationships[${index}]'`,
      "GraphSql.Relationship",
    ),
  );

  assertSchemaHoldsTables(ctx, resource.metadata.name, describe);
  assertTablesDistinct(describe, nodes, relationships);
  assertEndpointsListed(describe, nodes, relationships, nameOf);
  const schema = resolveSchema(resource.schema, ctx, describe);
  return new SqlGraphStore(describe, connection, schema, nodes, relationships);
}
