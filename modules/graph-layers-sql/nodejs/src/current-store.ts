import {
  getRefIdentity,
  type InvokeContext,
  type ResourceContext,
  type ResourceInstance,
  type ZoneEntry,
} from "@telorun/sdk";
import {
  decodeKeyTail,
  encodeKeyTail,
  assertEndpointsListed,
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
  type PreparedTraversal,
  type TraversalSpec,
} from "@telorun/graph";
import type { LayeredGraphStore, NotStated } from "@telorun/graph-layers";
import { isSqlSchema, resolveSqlConnection, type SqlConnection, type SqlSchema } from "@telorun/sql";
import {
  compileNode,
  compileRelationship,
  namedColumns,
  nodeValue,
  relationshipValue,
  type Assignment,
  type CompiledColumn,
  type CompiledNode,
  type CompiledRelationship,
  type CompiledTable,
} from "./compiled-types.js";
import { assertSchemaHoldsTables } from "./declared-references.js";
import { refuse, REMOVED, STATED } from "./declared-table.js";
import {
  resolvesAmong,
  selectPage,
  selectWinner,
  stackOver,
  type LayerStack,
  type StackView,
} from "./layer-overlay.js";
import {
  changeBeneath,
  deleteOwn,
  deleteStatedTouching,
  insertStated,
  mergeShown,
  removeBeneath,
  stateNew,
  updateStated,
} from "./layered-statements.js";
import { isLayeredNodeType, type LayeredNodeType } from "./node-type.js";
import { filterConditions } from "./compiled-types.js";
import {
  isLayeredRelationshipType,
  type LayeredRelationshipType,
} from "./relationship-type.js";
import { SqlFragments } from "@telorun/sql";
import {
  prepareTraversal,
  traversalStatement,
  type LayeredPreparedTraversal,
} from "./traversal-statement.js";

interface StoreManifest {
  kind: string;
  metadata: { name: string; module?: string };
  connection?: unknown;
  schema?: unknown;
  layer?: string;
  bases?: unknown[];
  nodes?: unknown[];
  relationships?: unknown[];
}

type Row = Record<string, unknown>;

/** Runs one statement of an operation, inside whichever transaction the
 *  operation runs in. */
type Run = (sql: SqlFragments) => Promise<Row[]>;

/** The winning statement for one identity in a stack. */
interface Winner {
  readonly row: Row;
  readonly layer: string;
  readonly stated: boolean;
}

function nameOf(type: object): string {
  return getRefIdentity(type)?.name ?? "(inline)";
}

/**
 * One layer of a graph kept in layered tables, with no versioning: the layer
 * holds only its current statements and a write is immediate.
 *
 * A read resolves the stack against whatever the layers hold now: a node is in
 * the view when the first statement for its key is `stated`, a relationship
 * when its first statement is `stated` and both its endpoint nodes resolve. A
 * write states only in this layer: a value from beneath is changed by copying
 * its row here with the change, and hidden by a `removed` row; a node write
 * states nothing about relationships. Every identifier comes from a
 * declaration, fixed when the store is created; every value, layer names
 * included, is bound.
 */
export class CurrentLayerStore implements LayeredGraphStore, ResourceInstance {
  /** This layer, then every layer beneath it in precedence order. */
  readonly stack: LayerStack;
  private readonly view: StackView;
  private readonly beneath: StackView;
  private readonly nodeTables = new Map<GraphNodeType, CompiledNode>();
  private readonly relationshipTables = new Map<GraphRelationshipType, CompiledRelationship>();
  /** For a node table, each relationship endpoint column holding its keys. */
  private readonly touching = new Map<
    CompiledNode,
    { relationship: CompiledRelationship; endpoint: CompiledColumn }[]
  >();

  constructor(
    private readonly describe: string,
    private readonly ctx: ResourceContext,
    readonly connection: SqlConnection,
    readonly schema: SqlSchema,
    readonly layer: string,
    bases: readonly CurrentLayerStore[],
    readonly nodes: readonly LayeredNodeType[],
    readonly relationships: readonly LayeredRelationshipType[],
  ) {
    this.stack = stackOver(
      layer,
      bases.map((base) => base.stack),
    );
    this.view = { layers: this.stack };
    this.beneath = { layers: this.stack.slice(1) };
    const dialect = connection.dialect;
    for (const node of nodes) {
      const compiled = compileNode(dialect, schema, node);
      this.nodeTables.set(node, compiled);
      this.touching.set(compiled, []);
    }
    for (const type of relationships) {
      const relationship = compileRelationship(
        dialect,
        schema,
        type,
        this.node(type.source),
        this.node(type.target),
      );
      this.relationshipTables.set(type, relationship);
      this.touching
        .get(relationship.source)!
        .push({ relationship, endpoint: relationship.sourceColumn });
      this.touching
        .get(relationship.target)!
        .push({ relationship, endpoint: relationship.targetColumn });
    }
  }

  snapshot(): Record<string, unknown> {
    return { layer: this.layer };
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

  private async rows(
    sql: SqlFragments,
    zone: ZoneEntry | undefined,
    ctx: InvokeContext | undefined,
  ): Promise<Row[]> {
    const result = await this.connection.executeTemplate<Row>(
      sql.fragments,
      sql.boundValues,
      zone,
      ctx,
    );
    return result.rows;
  }

  /** A read of one statement: it joins the caller's transaction when one is open. */
  private read(ctx: InvokeContext | undefined): Run {
    return (sql) => this.rows(sql, undefined, ctx);
  }

  /**
   * Runs an operation of several statements as one: inside the caller's
   * transaction when one is open on this connection, otherwise inside one of
   * its own that never outlives the call.
   */
  private atomic<T>(ctx: InvokeContext | undefined, body: (run: Run) => Promise<T>): Promise<T> {
    if (this.connection.hasOpenTransaction(ctx)) return body(this.read(ctx));
    const zone: ZoneEntry = { kind: this.ctx.self.ref.kind, provider: this.ctx.self };
    return this.connection.runInTransaction((bind) => {
      bind(zone);
      return body((sql) => this.rows(sql, zone, ctx));
    }, ctx);
  }

  private assignments(
    type: object,
    table: CompiledTable,
    properties: Record<string, unknown>,
  ): Assignment[] {
    return namedColumns(this.describe, nameOf(type), table.properties, properties);
  }

  private async winner(
    run: Run,
    table: CompiledTable,
    identity: readonly unknown[],
    view: StackView,
  ): Promise<Winner | undefined> {
    if (view.layers.length === 0) return undefined;
    const [row] = await run(selectWinner(table, identity, view));
    if (!row) return undefined;
    return {
      row,
      layer: String(row[table.layer.name]),
      stated: row[table.effect.name] === STATED,
    };
  }

  /** The stated winner for an identity in this store's view, if any. */
  private async visible(
    run: Run,
    table: CompiledTable,
    identity: readonly unknown[],
  ): Promise<Winner | undefined> {
    const top = await this.winner(run, table, identity, this.view);
    return top?.stated ? top : undefined;
  }

  /**
   * States the given values for an identity and answers with the row the layer
   * then holds: onto what the view shows, or — when that statement returns no
   * row, the view showing nothing — as a new value, every column not given
   * taking its declared default.
   */
  private async merge(
    run: Run,
    table: CompiledTable,
    identity: readonly unknown[],
    assignments: readonly Assignment[],
  ): Promise<Row> {
    const [shown] = await run(mergeShown(table, this.layer, identity, assignments, this.view));
    if (shown) return shown;
    const [stated] = await run(stateNew(table, this.layer, identity, assignments));
    if (!stated) throw new Error(`${this.describe}: stating '${table.name}' returned no row.`);
    return stated;
  }

  /**
   * Applies a change to a visible value: in place when this layer states it,
   * otherwise by stating the value from beneath here with the change. No row —
   * the layer removed the identity, or nothing states it any more — is absent.
   */
  private async change(
    run: Run,
    table: CompiledTable,
    identity: readonly unknown[],
    assignments: readonly Assignment[],
    top: Winner,
  ): Promise<Row | undefined> {
    const [row] = await run(
      top.layer === this.layer
        ? updateStated(table, this.layer, identity, assignments)
        : changeBeneath(table, this.layer, identity, assignments, this.beneath),
    );
    return row;
  }

  /**
   * Makes an identity absent: this layer's own statement is withdrawn, and
   * whatever the layers beneath still state for it is hidden. True once a
   * statement that makes it absent has returned its row.
   */
  private async hide(run: Run, table: CompiledTable, identity: readonly unknown[]): Promise<boolean> {
    const [withdrawn] = await run(deleteOwn(table, this.layer, identity, STATED));
    if (this.beneath.layers.length === 0) return withdrawn !== undefined;
    const [removal] = await run(removeBeneath(table, this.layer, identity, this.beneath));
    return withdrawn !== undefined || removal !== undefined;
  }

  /** Withdraws this layer's own row — exactly that one statement — and reads
   *  what the view now holds for the identity. */
  private async retract(
    ctx: InvokeContext | undefined,
    table: CompiledTable,
    identity: readonly unknown[],
    resolved: (run: Run) => Promise<Winner | undefined>,
  ): Promise<Row | "absent" | "notStated"> {
    return this.atomic(ctx, async (run) => {
      const [own] = await run(deleteOwn(table, this.layer, identity));
      if (!own) return "notStated";
      return (await resolved(run))?.row ?? "absent";
    });
  }

  async createNode(
    type: GraphNodeType,
    key: unknown,
    properties: Record<string, unknown>,
    ctx?: InvokeContext,
  ): Promise<Found<GraphNodeValue> | Exists> {
    const node = this.node(type);
    const set = this.assignments(type, node, properties);
    return this.atomic(ctx, async (run) => {
      if (await this.visible(run, node, [key])) return { status: "exists" };
      const [row] = await run(insertStated(node, this.layer, [key], set));
      return row ? { status: "found", value: nodeValue(node, row) } : { status: "exists" };
    });
  }

  async mergeNode(
    type: GraphNodeType,
    key: unknown,
    properties: Record<string, unknown>,
    ctx?: InvokeContext,
  ): Promise<Found<GraphNodeValue>> {
    const node = this.node(type);
    const set = this.assignments(type, node, properties);
    return this.atomic(ctx, async (run) => ({
      status: "found",
      value: nodeValue(node, await this.merge(run, node, [key], set)),
    }));
  }

  async updateNode(
    type: GraphNodeType,
    key: unknown,
    properties: Record<string, unknown>,
    ctx?: InvokeContext,
  ): Promise<Found<GraphNodeValue> | Absent> {
    const node = this.node(type);
    const set = this.assignments(type, node, properties);
    if (set.length === 0) {
      throw new Error(`${this.describe}: updating '${nameOf(type)}' needs at least one property.`);
    }
    return this.atomic(ctx, async (run) => {
      const top = await this.visible(run, node, [key]);
      if (!top) return { status: "absent" };
      const row = await this.change(run, node, [key], set, top);
      return row ? { status: "found", value: nodeValue(node, row) } : { status: "absent" };
    });
  }

  async deleteNode(
    type: GraphNodeType,
    key: unknown,
    ctx?: InvokeContext,
  ): Promise<Found<GraphNodeValue> | Absent> {
    const node = this.node(type);
    return this.atomic(ctx, async (run) => {
      const top = await this.visible(run, node, [key]);
      if (!top || !(await this.hide(run, node, [key]))) return { status: "absent" };
      // This layer's own relationships touching the node are withdrawn. Those
      // beneath are out of the view because the node is; nothing is stated
      // about them.
      for (const { relationship, endpoint } of this.touching.get(node) ?? []) {
        await run(deleteStatedTouching(relationship, this.layer, endpoint, key));
      }
      return { status: "found", value: nodeValue(node, top.row) };
    });
  }

  async getNode(
    type: GraphNodeType,
    key: unknown,
    ctx?: InvokeContext,
  ): Promise<Found<GraphNodeValue> | Absent> {
    const node = this.node(type);
    const top = await this.visible(this.read(ctx), node, [key]);
    return top ? { status: "found", value: nodeValue(node, top.row) } : { status: "absent" };
  }

  async retractNode(
    type: GraphNodeType,
    key: unknown,
    ctx?: InvokeContext,
  ): Promise<Found<GraphNodeValue> | Absent | NotStated> {
    const node = this.node(type);
    const outcome = await this.retract(ctx, node, [key], (run) => this.visible(run, node, [key]));
    return typeof outcome === "string"
      ? { status: outcome }
      : { status: "found", value: nodeValue(node, outcome) };
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
    const after = page.after === undefined ? undefined : decodeKeyTail(page.after, 1);
    if (page.after !== undefined && !after) return { status: "cursorInvalid" };
    const sql = selectPage(
      node,
      this.view,
      {
        seek: (qualifier) =>
          after ? [new SqlFragments().text(`${qualifier}${node.key.sql} > `).value(after[0])] : [],
        filter: (qualifier) =>
          filterConditions(this.describe, nameOf(type), where, node.properties, qualifier),
      },
      [node.key],
      page.limit + 1,
    );
    return this.page(
      await this.read(ctx)(sql),
      page.limit,
      (row) => nodeValue(node, row),
      (row) => [row[node.key.name]],
    );
  }

  /** `endpointAbsent` for the first endpoint this store's view does not hold. */
  private async missingEndpoint(
    run: Run,
    relationship: CompiledRelationship,
    source: unknown,
    target: unknown,
  ): Promise<"source" | "target" | undefined> {
    if (!(await this.visible(run, relationship.source, [source]))) return "source";
    if (!(await this.visible(run, relationship.target, [target]))) return "target";
    return undefined;
  }

  /** The relationship as this store's view holds it: the stated winner for the
   *  pair, while both its endpoints resolve. */
  private async visibleRelationship(
    run: Run,
    relationship: CompiledRelationship,
    source: unknown,
    target: unknown,
  ): Promise<Winner | undefined> {
    const top = await this.visible(run, relationship, [source, target]);
    if (!top || (await this.missingEndpoint(run, relationship, source, target))) return undefined;
    return top;
  }

  async createRelationship(
    type: GraphRelationshipType,
    source: unknown,
    target: unknown,
    properties: Record<string, unknown>,
    ctx?: InvokeContext,
  ): Promise<Found<GraphRelationshipValue> | Exists | EndpointAbsent> {
    const relationship = this.relationship(type);
    const set = this.assignments(type, relationship, properties);
    return this.atomic(ctx, async (run) => {
      const endpoint = await this.missingEndpoint(run, relationship, source, target);
      if (endpoint) return { status: "endpointAbsent", endpoint };
      if (await this.visible(run, relationship, [source, target])) return { status: "exists" };
      const [row] = await run(insertStated(relationship, this.layer, [source, target], set));
      return row
        ? { status: "found", value: relationshipValue(relationship, row) }
        : { status: "exists" };
    });
  }

  async mergeRelationship(
    type: GraphRelationshipType,
    source: unknown,
    target: unknown,
    properties: Record<string, unknown>,
    ctx?: InvokeContext,
  ): Promise<Found<GraphRelationshipValue> | Absent> {
    const relationship = this.relationship(type);
    const set = this.assignments(type, relationship, properties);
    return this.atomic(ctx, async (run) => {
      if (await this.missingEndpoint(run, relationship, source, target)) {
        return { status: "absent" };
      }
      const row = await this.merge(run, relationship, [source, target], set);
      return { status: "found", value: relationshipValue(relationship, row) };
    });
  }

  async updateRelationship(
    type: GraphRelationshipType,
    source: unknown,
    target: unknown,
    properties: Record<string, unknown>,
    ctx?: InvokeContext,
  ): Promise<Found<GraphRelationshipValue> | Absent> {
    const relationship = this.relationship(type);
    const set = this.assignments(type, relationship, properties);
    if (set.length === 0) {
      throw new Error(`${this.describe}: updating '${nameOf(type)}' needs at least one property.`);
    }
    return this.atomic(ctx, async (run) => {
      const top = await this.visibleRelationship(run, relationship, source, target);
      if (!top) return { status: "absent" };
      const row = await this.change(run, relationship, [source, target], set, top);
      return row
        ? { status: "found", value: relationshipValue(relationship, row) }
        : { status: "absent" };
    });
  }

  async deleteRelationship(
    type: GraphRelationshipType,
    source: unknown,
    target: unknown,
    ctx?: InvokeContext,
  ): Promise<Found<GraphRelationshipValue> | Absent> {
    const relationship = this.relationship(type);
    return this.atomic(ctx, async (run) => {
      const top = await this.visibleRelationship(run, relationship, source, target);
      if (!top || !(await this.hide(run, relationship, [source, target]))) {
        return { status: "absent" };
      }
      return { status: "found", value: relationshipValue(relationship, top.row) };
    });
  }

  async retractRelationship(
    type: GraphRelationshipType,
    source: unknown,
    target: unknown,
    ctx?: InvokeContext,
  ): Promise<Found<GraphRelationshipValue> | Absent | NotStated> {
    const relationship = this.relationship(type);
    const outcome = await this.retract(ctx, relationship, [source, target], (run) =>
      this.visibleRelationship(run, relationship, source, target),
    );
    return typeof outcome === "string"
      ? { status: outcome }
      : { status: "found", value: relationshipValue(relationship, outcome) };
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
    const after = page.after === undefined ? undefined : decodeKeyTail(page.after, 2);
    if (page.after !== undefined && !after) return { status: "cursorInvalid" };
    const sourceOnly = endpoints.source !== undefined && endpoints.target === undefined;
    const targetOnly = endpoints.target !== undefined && endpoints.source === undefined;
    const sql = selectPage(
      relationship,
      this.view,
      {
        seek: (qualifier) => {
          const conditions: SqlFragments[] = [];
          if (endpoints.source !== undefined) {
            conditions.push(
              new SqlFragments().text(`${qualifier}${s.sql} = `).value(endpoints.source),
            );
          }
          if (endpoints.target !== undefined) {
            conditions.push(
              new SqlFragments().text(`${qualifier}${t.sql} = `).value(endpoints.target),
            );
          }
          // The seek names only the columns still free, so it continues along
          // the index that already satisfied the endpoint filter.
          if (after && sourceOnly) {
            conditions.push(new SqlFragments().text(`${qualifier}${t.sql} > `).value(after[1]));
          } else if (after && targetOnly) {
            conditions.push(new SqlFragments().text(`${qualifier}${s.sql} > `).value(after[0]));
          } else if (after) {
            conditions.push(
              new SqlFragments()
                .text(`(${qualifier}${s.sql}, ${qualifier}${t.sql}) > (`)
                .value(after[0])
                .text(", ")
                .value(after[1])
                .text(")"),
            );
          }
          return conditions;
        },
        filter: (qualifier) => [
          ...filterConditions(
            this.describe,
            nameOf(type),
            where,
            relationship.properties,
            qualifier,
          ),
          resolvesAmong(relationship.source, `${qualifier}${s.sql}`, this.view, "m"),
          resolvesAmong(relationship.target, `${qualifier}${t.sql}`, this.view, "m"),
        ],
      },
      // A target-only listing reads the target-leading index in source order.
      targetOnly ? [s] : sourceOnly ? [t] : [s, t],
      page.limit + 1,
    );
    return this.page(
      await this.read(ctx)(sql),
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
    const compiled = prepared as LayeredPreparedTraversal;
    const after = page.after === undefined ? undefined : decodeKeyTail(page.after, 1);
    if (page.after !== undefined && !after) return { status: "cursorInvalid" };
    const rows = await this.read(ctx)(
      traversalStatement(
        this.describe,
        nameOf(prepared.spec.to),
        compiled,
        this.view,
        key,
        where,
        page.limit,
        after?.[0],
      ),
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

export function isCurrentLayerStore(value: unknown): value is CurrentLayerStore {
  return value instanceof CurrentLayerStore;
}

/** The store's schema instance, which addresses every table a statement names. */
export function resolveSchema(value: unknown, ctx: ResourceContext, describe: string): SqlSchema {
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
export function assertTablesDistinct(
  describe: string,
  nodes: readonly LayeredNodeType[],
  relationships: readonly LayeredRelationshipType[],
  bookkeeping: readonly (readonly [table: object, field: string])[] = [],
): void {
  const owner = new Map<object, { type: object; field: string }>();
  const types: [object, object, string][] = [
    ...bookkeeping.map(([table, field]): [object, object, string] => [table, table, field]),
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

/**
 * `GRAPH_BASE_STORE_MISMATCH` and `GRAPH_BASE_LAYER_DUPLICATE`. A layer two
 * bases share deeper down is legal and takes its lowest place; what is refused
 * is one layer named twice among the direct bases, and this store's own layer
 * anywhere beneath it — the second of which no `telo check` rule can see, since
 * a rule reads one level.
 */
export function assertBasesStack(
  describe: string,
  connection: SqlConnection,
  schema: SqlSchema,
  layer: string,
  bases: readonly {
    readonly connection: SqlConnection;
    readonly schema: SqlSchema;
    readonly layer: string;
    readonly stack: LayerStack;
  }[],
): void {
  bases.forEach((base, index) => {
    if (base.connection !== connection || base.schema !== schema) {
      refuse(
        "GRAPH_BASE_STORE_MISMATCH",
        `${describe} lists base '${nameOf(base)}' at 'bases[${index}]', which is on another ` +
          `connection or another schema. A layer and its bases are read in one statement, so ` +
          `they must share both.`,
      );
    }
  });
  const direct = new Set<string>();
  bases.forEach((base, index) => {
    if (base.layer === layer) {
      refuse(
        "GRAPH_BASE_LAYER_DUPLICATE",
        `${describe} lists base '${nameOf(base)}' at 'bases[${index}]', which names this ` +
          `store's own layer '${layer}'. A layer cannot be built on itself.`,
      );
    }
    if (direct.has(base.layer)) {
      refuse(
        "GRAPH_BASE_LAYER_DUPLICATE",
        `${describe} names layer '${base.layer}' twice among 'bases:', again at ` +
          `'bases[${index}]' ('${nameOf(base)}'). A base is listed once.`,
      );
    }
    direct.add(base.layer);
  });
  bases.forEach((base, index) => {
    if (base.stack.includes(layer)) {
      refuse(
        "GRAPH_BASE_LAYER_DUPLICATE",
        `${describe}: its own layer '${layer}' is reached again beneath 'bases[${index}]' ` +
          `('${nameOf(base)}'). A layer cannot be built on itself.`,
      );
    }
  });
}

export function register(): void {}

export async function create(
  resource: StoreManifest,
  ctx: ResourceContext,
): Promise<CurrentLayerStore> {
  const describe = `${resource.kind} "${resource.metadata.name}"`;
  const connection = resolveSqlConnection(
    resource.connection as SqlConnection | undefined,
    ctx,
    () => `${describe}: 'connection'`,
  );
  if (!connection) throw new Error(`${describe}: 'connection' is required.`);
  const layer = resource.layer;
  if (typeof layer !== "string" || layer === "") {
    throw new Error(`${describe}: 'layer' must be a non-empty string.`);
  }
  const nodes = (resource.nodes ?? []).map((value, index) =>
    ctx.resolveRef(
      value,
      isLayeredNodeType,
      () => `${describe}: 'nodes[${index}]'`,
      "GraphLayersSql.Node",
    ),
  );
  const relationships = (resource.relationships ?? []).map((value, index) =>
    ctx.resolveRef(
      value,
      isLayeredRelationshipType,
      () => `${describe}: 'relationships[${index}]'`,
      "GraphLayersSql.Relationship",
    ),
  );
  const bases = (resource.bases ?? []).map((value, index) =>
    ctx.resolveRef(
      value,
      isCurrentLayerStore,
      () => `${describe}: 'bases[${index}]'`,
      "GraphLayersSql.CurrentStore",
    ),
  );

  assertSchemaHoldsTables(ctx, resource.metadata.name, describe);
  assertTablesDistinct(describe, nodes, relationships);
  assertEndpointsListed(describe, nodes, relationships, nameOf);
  const schema = resolveSchema(resource.schema, ctx, describe);
  assertBasesStack(describe, connection, schema, layer, bases);
  return new CurrentLayerStore(
    describe,
    ctx,
    connection,
    schema,
    layer,
    bases,
    nodes,
    relationships,
  );
}
