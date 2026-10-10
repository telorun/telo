import {
  getRefIdentity,
  type CancellationSource,
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
import type {
  Actor,
  ConflictDecision,
  ConflictNotFound,
  DraftClosed,
  DraftConflicted,
  DraftedGraphStore,
  DraftForeign,
  DraftHandle,
  DraftNotFound,
  DraftStale,
  DraftSummary,
  NodeConflict,
  NotStated,
  PublishedRevision,
  RelationshipConflict,
  ResolutionInvalid,
  SessionOpened,
} from "@telorun/graph-layers";
import { storeActor } from "@telorun/graph-layers";
import {
  readInt64Column,
  readTimestampColumn,
  rendersCurrentInstant,
  resolveSqlConnection,
  type SqlConnection,
  type SqlInstantSchema,
} from "@telorun/sql";
import {
  namedColumns,
  nodeValue,
  propertiesOf,
  relationshipValue,
  type Assignment,
  type CompiledColumn,
} from "./compiled-types.js";
import { assertBasesStack, assertTablesDistinct, resolveSchema } from "./current-store.js";
import { assertSchemaHoldsTables } from "./declared-references.js";
import { DRAFT, PUBLISHED, refuse, REMOVED, RETRACTED, STATED } from "./declared-table.js";
import { classify, readCandidate, type Candidate, type Classified } from "./draft-conflicts.js";
import { newDraftPublicId, newInternalId } from "./draft-identity.js";
import {
  anyDraftRow,
  copyOnto,
  copyRow,
  countEndpointMissing,
  countMoved,
  deletePublishedTouching,
  deleteRow,
  discardRows,
  insertRow,
  mergeConvergent,
  publishRows,
  selectConflictCandidates,
  selectOwn,
  updateRow,
  withdrawTouchingInDraft,
  type RowAt,
  type RowEffect,
  type RowState,
  type Stamp,
} from "./drafted-statements.js";
import {
  compileDraftedNode,
  compileDraftedRelationship,
  compileDraftsTable,
  compileLayersTable,
  type DraftedNode,
  type DraftedRelationship,
  type DraftedTable,
  type DraftsTable,
  type LayersTable,
} from "./drafted-tables.js";
import {
  resolvesAmong,
  selectPage,
  selectWinner,
  stackOver,
  type LayerStack,
  type StackView,
} from "./layer-overlay.js";
import { isLayeredNodeType, type LayeredNodeType } from "./node-type.js";
import { changesNothing } from "./same-value.js";
import {
  decodeSelectedTail,
  encodeSelectedTail,
  type TailSelector,
} from "./page-tail.js";
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
  layers?: unknown;
  drafts?: unknown;
}

type Row = Record<string, unknown>;
type Run = (sql: SqlFragments) => Promise<Row[]>;

/** The stack as the tables store it: each layer's internal id. */
interface Layers {
  readonly own: string;
  readonly stack: LayerStack;
  readonly beneath: LayerStack;
  readonly nameOf: (id: string) => string;
}

/** What the store knows about one open session. */
interface Session {
  readonly draft: string;
  readonly publicId: string;
  readonly cancellation: CancellationSource;
  closed?: DraftClosed;
}

/** One of the layer's two rows for an identity. */
interface OwnRow {
  readonly row: Row;
  readonly effect: RowEffect;
  readonly revision: bigint | null;
  readonly over: bigint | null;
  readonly resolution: Stamp["resolution"];
  readonly resolvedBy: Actor | null;
}

/** Everything said about one identity: by the layer's draft, by its published
 *  row, and by the first base that states it. */
interface Standing {
  readonly draft?: OwnRow;
  readonly published?: OwnRow;
  readonly beneath?: { readonly row: Row; readonly layer: string; readonly stated: boolean };
}

/** The value a view shows for an identity, and the row it comes from. */
interface Shown {
  readonly row: Row;
  readonly at: RowAt;
}

/** One write in progress: which of the layer's rows it makes, and under what. */
interface Writing {
  readonly run: Run;
  readonly layers: Layers;
  readonly view: StackView;
  readonly state: RowState;
  /** The revision a published write is stamped with; null inside a draft. */
  readonly revision: bigint | null;
  changed: boolean;
}

interface Reading {
  readonly run: Run;
  readonly layers: Layers;
  readonly view: StackView;
  /** Inside a session: what a tail issued now is bound to. */
  readonly selector?: TailSelector;
}

function nameOf(type: object): string {
  return getRefIdentity(type)?.name ?? "(inline)";
}

function int64OrNull(value: unknown): bigint | null {
  return value === null || value === undefined ? null : readInt64Column(value);
}

/**
 * One layer of a graph kept in drafted tables: the layer holds at most one
 * published row and one draft row per identity, and a single revision counter.
 *
 * Outside a draft session a read sees the published rows of the stack and a
 * write changes the layer's published row in place, advancing the counter in
 * the same atomic operation. Inside a session — recognised by the zones
 * correlated on this store in the call's context — a read sees the draft's
 * rows over the layer's published ones, and a write makes a draft row, taken
 * together with the draft's own row in the drafts table so that the database
 * serialises it against that draft being published or discarded.
 *
 * Every identifier comes from a declaration; every value, layer id and
 * revision is bound; every instant is the engine schema's own expression.
 */
export class DraftedLayerStore implements DraftedGraphStore, ResourceInstance {
  /** This layer's name, then every layer beneath it in precedence order. */
  readonly stack: LayerStack;
  private readonly nodeTables = new Map<GraphNodeType, DraftedNode>();
  private readonly relationshipTables = new Map<GraphRelationshipType, DraftedRelationship>();
  private readonly tables: DraftedTable[] = [];
  private readonly touching = new Map<
    DraftedNode,
    { relationship: DraftedRelationship; endpoint: CompiledColumn }[]
  >();
  private readonly sessions = new WeakMap<ZoneEntry, Session>();
  private readonly now: string;
  /** Set once the layer rows are known to be committed. */
  private resolvedLayers?: Layers;

  constructor(
    private readonly describe: string,
    private readonly ctx: ResourceContext,
    /** The actor recorded when a caller names none: the store resource. */
    private readonly self: Actor,
    readonly connection: SqlConnection,
    readonly schema: SqlInstantSchema,
    readonly layer: string,
    bases: readonly DraftedLayerStore[],
    readonly nodes: readonly LayeredNodeType[],
    readonly relationships: readonly LayeredRelationshipType[],
    readonly layersTable: LayersTable,
    readonly draftsTable: DraftsTable,
  ) {
    this.stack = stackOver(
      layer,
      bases.map((base) => base.stack),
    );
    this.now = schema.currentInstant();
    const dialect = connection.dialect;
    for (const node of nodes) {
      const compiled = compileDraftedNode(describe, dialect, schema, node);
      this.nodeTables.set(node, compiled);
      this.tables.push(compiled);
      this.touching.set(compiled, []);
    }
    for (const type of relationships) {
      const relationship = compileDraftedRelationship(
        describe,
        dialect,
        schema,
        type,
        this.node(type.source),
        this.node(type.target),
      );
      this.relationshipTables.set(type, relationship);
      this.tables.push(relationship);
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

  private node(type: GraphNodeType): DraftedNode {
    const compiled = this.nodeTables.get(type);
    if (!compiled) {
      throw new Error(`${this.describe} does not list node type '${nameOf(type)}' in 'nodes:'.`);
    }
    return compiled;
  }

  private relationship(type: GraphRelationshipType): DraftedRelationship {
    const compiled = this.relationshipTables.get(type);
    if (!compiled) {
      throw new Error(
        `${this.describe} does not list relationship type '${nameOf(type)}' in 'relationships:'.`,
      );
    }
    return compiled;
  }

  // ── statements and transactions ──────────────────────────────────────────

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

  private read(ctx: InvokeContext | undefined): Run {
    return (sql) => this.rows(sql, undefined, ctx);
  }

  /** Runs several statements as one: in the caller's transaction when one is
   *  open on this connection, otherwise in one of its own. */
  private atomic<T>(ctx: InvokeContext | undefined, body: (run: Run) => Promise<T>): Promise<T> {
    if (this.connection.hasOpenTransaction(ctx)) return body(this.read(ctx));
    const zone: ZoneEntry = { kind: this.ctx.self.ref.kind, provider: this.ctx.self };
    return this.connection.runInTransaction((bind) => {
      bind(zone);
      return body((sql) => this.rows(sql, zone, ctx));
    }, ctx);
  }

  // ── layers ───────────────────────────────────────────────────────────────

  /**
   * The internal id of every layer of the stack. A read registers nothing: a
   * layer with no row yet holds nothing, so it is read under an id no row
   * carries. A write (`register`) creates its own layer's row first, inside
   * its own atomic operation. The answer is kept only when every row was found
   * already committed — never from a partial resolution, and never from inside
   * a caller's transaction, which may still roll back what it shows.
   */
  private async layersOf(run: Run, joined: boolean, register: boolean): Promise<Layers> {
    if (this.resolvedLayers) return this.resolvedLayers;
    const l = this.layersTable;
    const select = () =>
      run(
        new SqlFragments()
          .text(`SELECT ${l.id}, ${l.name} FROM ${l.table} WHERE ${l.name} IN (`)
          .valueList(this.stack, ", ")
          .text(")"),
      );
    let known = await select();
    const committed = known.length === this.stack.length;
    if (register && !known.some((row) => String(row.name) === this.layer)) {
      await run(
        new SqlFragments()
          .text(
            `INSERT INTO ${l.table} (${l.id}, ${l.name}, ${l.head_revision}, ${l.created_at}, ` +
              `${l.created_by_type}, ${l.created_by_id}) VALUES (`,
          )
          .value(newInternalId())
          .text(", ")
          .value(this.layer)
          .text(`, 0, ${this.now}, `)
          .value(this.self.type)
          .text(", ")
          .value(this.self.id)
          .text(`) ON CONFLICT (${l.name}) DO NOTHING`),
      );
      known = await select();
      if (!known.some((row) => String(row.name) === this.layer)) {
        throw new Error(`${this.describe}: layer '${this.layer}' could not be registered.`);
      }
    }
    const ids = new Map(known.map((row) => [String(row.name), String(row.id)]));
    const stack = this.stack.map((name) => ids.get(name) ?? newInternalId());
    const names = new Map(stack.map((id, index) => [id, this.stack[index]]));
    const layers: Layers = {
      own: stack[0],
      stack,
      beneath: stack.slice(1),
      nameOf: (id) => names.get(id) ?? id,
    };
    if (committed && !joined) this.resolvedLayers = layers;
    return layers;
  }

  /** The stack as a read sees it. */
  private resolved(ctx: InvokeContext | undefined): Promise<Layers> {
    return this.layersOf(this.read(ctx), this.connection.hasOpenTransaction(ctx), false);
  }

  /** Takes the layer's row for the rest of the transaction — published writes
   *  to one layer apply one at a time — and reads its revision. */
  private async holdLayer(run: Run, layer: string): Promise<bigint> {
    const l = this.layersTable;
    const [row] = await run(
      new SqlFragments()
        .text(`UPDATE ${l.table} SET ${l.head_revision} = ${l.head_revision} WHERE ${l.id} = `)
        .value(layer)
        .text(` RETURNING ${l.head_revision}`),
    );
    if (!row) {
      throw new Error(
        `${this.describe}: layer '${this.layer}' is no longer registered in its layers table.`,
      );
    }
    return readInt64Column(row.head_revision);
  }

  private async advanceLayer(run: Run, layer: string): Promise<void> {
    const l = this.layersTable;
    await run(
      new SqlFragments()
        .text(`UPDATE ${l.table} SET ${l.head_revision} = ${l.head_revision} + 1 WHERE ${l.id} = `)
        .value(layer),
    );
  }

  // ── sessions ─────────────────────────────────────────────────────────────

  private session(ctx: InvokeContext | undefined): Session | undefined {
    for (const entry of this.ctx.zonesFor(this, ctx)) {
      const session = this.sessions.get(entry);
      if (session) return session;
    }
    return undefined;
  }

  private requireSession(ctx: InvokeContext | undefined, what: string): Session {
    const session = this.session(ctx);
    if (!session) {
      throw new Error(`${this.describe}: ${what} is reached only inside a draft session.`);
    }
    return session;
  }

  private draftColumns(): string {
    const d = this.draftsTable;
    return [d.id, d.public_id, d.layer_id, d.parent_revision, d.created_at, d.published_at, d.discarded_at, d.revision].join(", ");
  }

  private closedAs(row: Row | undefined): DraftClosed | undefined {
    if (!row) return { status: "draftClosed", closedAs: "discarded" };
    if (row.published_at !== null && row.published_at !== undefined) {
      const revision = int64OrNull(row.revision);
      return {
        status: "draftClosed",
        closedAs: "published",
        ...(revision === null ? {} : { revision }),
      };
    }
    if (row.discarded_at !== null && row.discarded_at !== undefined) {
      return { status: "draftClosed", closedAs: "discarded" };
    }
    return undefined;
  }

  /** The session's draft is no longer open: the session's own cancellation
   *  source is cancelled, and the operation stops as that cancellation. */
  private endSession(session: Session, closed: DraftClosed): never {
    session.closed ??= closed;
    session.cancellation.cancel(`draft '${session.publicId}' was ${closed.closedAs}`);
    session.cancellation.token.throwIfCancelled();
    throw new Error(`${this.describe}: the session's draft was ${closed.closedAs}.`);
  }

  /**
   * The draft-open check of a session WRITE: a conditional update of the
   * draft's own row, in the transaction of the write. It matches only while the
   * draft is open, and holds the row until the write commits, so the database
   * — not a claim or a lease — decides between this write and the draft being
   * published or discarded.
   */
  private async holdDraft(run: Run, session: Session): Promise<void> {
    const d = this.draftsTable;
    const [held] = await run(
      new SqlFragments()
        .text(`UPDATE ${d.table} SET ${d.parent_revision} = ${d.parent_revision} WHERE ${d.id} = `)
        .value(session.draft)
        .text(` AND ${d.published_at} IS NULL AND ${d.discarded_at} IS NULL RETURNING ${d.id}`),
    );
    if (held) return;
    const [row] = await run(
      new SqlFragments()
        .text(`SELECT ${this.draftColumns()} FROM ${d.table} WHERE ${d.id} = `)
        .value(session.draft),
    );
    this.endSession(session, this.closedAs(row)!);
  }

  /** The draft-open check of a session READ, and the revision the draft stands on. */
  private async draftParent(run: Run, session: Session): Promise<bigint> {
    const d = this.draftsTable;
    const [row] = await run(
      new SqlFragments()
        .text(`SELECT ${this.draftColumns()} FROM ${d.table} WHERE ${d.id} = `)
        .value(session.draft),
    );
    const closed = this.closedAs(row);
    if (closed) this.endSession(session, closed);
    return readInt64Column(row!.parent_revision);
  }

  async openSession(
    entry: ZoneEntry,
    draft: string,
    cancellation: CancellationSource,
    ctx?: InvokeContext,
  ): Promise<SessionOpened | DraftNotFound | DraftClosed | DraftForeign> {
    const layers = await this.resolved(ctx);
    const d = this.draftsTable;
    const [row] = await this.read(ctx)(
      new SqlFragments()
        .text(`SELECT ${this.draftColumns()} FROM ${d.table} WHERE ${d.public_id} = `)
        .value(draft),
    );
    if (!row) return { status: "draftNotFound" };
    if (String(row.layer_id) !== layers.own) return { status: "draftForeign" };
    const closed = this.closedAs(row);
    if (closed) return closed;
    this.sessions.set(entry, { draft: String(row.id), publicId: draft, cancellation });
    return { status: "opened" };
  }

  closeSession(entry: ZoneEntry): DraftClosed | undefined {
    const session = this.sessions.get(entry);
    this.sessions.delete(entry);
    return session?.closed;
  }

  // ── reading and writing one identity ─────────────────────────────────────

  private async reading(ctx: InvokeContext | undefined): Promise<Reading> {
    const session = this.session(ctx);
    const layers = await this.resolved(ctx);
    const run = this.read(ctx);
    if (!session) return { run, layers, view: { layers: layers.stack } };
    const parent = await this.draftParent(run, session);
    return {
      run,
      layers,
      view: { layers: layers.stack, draft: true },
      selector: { draft: session.publicId, parent: parent.toString() },
    };
  }

  /**
   * One write: inside a session it makes draft rows, holding the draft; outside
   * one it makes published rows, holding the layer, and advances the layer's
   * revision when it changed anything.
   */
  private async write<T>(
    ctx: InvokeContext | undefined,
    body: (writing: Writing) => Promise<T>,
  ): Promise<T> {
    const session = this.session(ctx);
    const joined = this.connection.hasOpenTransaction(ctx);
    return this.atomic(ctx, async (run) => {
      const layers = await this.layersOf(run, joined, !session);
      if (session) {
        await this.holdDraft(run, session);
        return body({
          run,
          layers,
          view: { layers: layers.stack, draft: true },
          state: DRAFT,
          revision: null,
          changed: false,
        });
      }
      const head = await this.holdLayer(run, layers.own);
      const writing: Writing = {
        run,
        layers,
        view: { layers: layers.stack },
        state: PUBLISHED,
        revision: head + 1n,
        changed: false,
      };
      const result = await body(writing);
      if (writing.changed) await this.advanceLayer(run, layers.own);
      return result;
    });
  }

  private ownRow(table: DraftedTable, row: Row): OwnRow {
    const type = row[table.resolvedByType.name];
    const id = row[table.resolvedById.name];
    return {
      row,
      effect: row[table.effect.name] as RowEffect,
      revision: int64OrNull(row[table.revision.name]),
      over: int64OrNull(row[table.over.name]),
      resolution: (row[table.resolution.name] ?? null) as Stamp["resolution"],
      resolvedBy: typeof type === "string" && typeof id === "string" ? { type, id } : null,
    };
  }

  private async standing(
    writing: Pick<Writing, "run" | "layers" | "state">,
    table: DraftedTable,
    identity: readonly unknown[],
  ): Promise<Standing> {
    const { run, layers } = writing;
    // A published write never reads the draft's row.
    const states: RowState[] = writing.state === DRAFT ? [DRAFT, PUBLISHED] : [PUBLISHED];
    const own = await run(selectOwn(table, layers.own, states, identity));
    const of = (state: RowState) => {
      const row = own.find((candidate) => candidate[table.state.name] === state);
      return row ? this.ownRow(table, row) : undefined;
    };
    let beneath: Standing["beneath"];
    if (layers.beneath.length > 0) {
      const [row] = await run(selectWinner(table, identity, { layers: layers.beneath }));
      if (row) {
        beneath = {
          row,
          layer: String(row[table.layer.name]),
          stated: row[table.effect.name] === STATED,
        };
      }
    }
    return { draft: of(DRAFT), published: of(PUBLISHED), beneath };
  }

  /** What the write's view shows for the identity. */
  private shown(writing: Writing, standing: Standing): Shown | undefined {
    const own = writing.layers.own;
    const beneath = (): Shown | undefined =>
      standing.beneath?.stated
        ? { row: standing.beneath.row, at: { layer: standing.beneath.layer, state: PUBLISHED } }
        : undefined;
    if (writing.state === DRAFT && standing.draft) {
      if (standing.draft.effect === RETRACTED) return beneath();
      return standing.draft.effect === STATED
        ? { row: standing.draft.row, at: { layer: own, state: DRAFT } }
        : undefined;
    }
    if (standing.published) {
      return standing.published.effect === STATED
        ? { row: standing.published.row, at: { layer: own, state: PUBLISHED } }
        : undefined;
    }
    return beneath();
  }

  /** The row the write makes or replaces, if the layer holds it. */
  private target(writing: Writing, standing: Standing): OwnRow | undefined {
    return writing.state === DRAFT ? standing.draft : standing.published;
  }

  /**
   * The bookkeeping an ordinary write leaves. A draft row stands over the
   * layer's published row as it is now, which is also what settles a conflict
   * on it: the caller's version is kept, and recorded as taken by the store.
   */
  private stamp(writing: Writing, standing: Standing, effect: RowEffect): Stamp {
    if (writing.state === PUBLISHED) {
      return { effect, revision: writing.revision, over: null, resolution: null, resolvedBy: null };
    }
    const over = standing.published?.revision ?? null;
    const draft = standing.draft;
    const settles = draft !== undefined && draft.over !== over;
    return {
      effect,
      revision: null,
      over,
      resolution: settles ? "mine" : (draft?.resolution ?? null),
      resolvedBy: settles ? this.self : (draft?.resolvedBy ?? null),
    };
  }

  /**
   * Makes the write's row: in place when `from` is that row, otherwise holding
   * what the row at `from` holds — or as a new row — in place of whatever the
   * layer held. No row is returned, and nothing is written, when nothing is at
   * `from` any more.
   */
  private async put(
    writing: Writing,
    table: DraftedTable,
    identity: readonly unknown[],
    stamp: Stamp,
    from: RowAt | undefined,
    assignments: readonly Assignment[],
    replaces: boolean,
  ): Promise<Row | undefined> {
    const at: RowAt = { layer: writing.layers.own, state: writing.state };
    const written = ([row]: Row[]): Row | undefined => {
      if (row) writing.changed = true;
      return row;
    };
    if (from && from.layer === at.layer && from.state === at.state) {
      return written(
        await writing.run(updateRow(table, at, stamp, this.now, identity, assignments)),
      );
    }
    if (from) {
      const copy = replaces ? copyOnto : copyRow;
      return written(
        await writing.run(copy(table, at, stamp, this.now, from, identity, assignments)),
      );
    }
    if (replaces) await this.drop(writing, table, identity);
    return written(
      await writing.run(insertRow(table, at, stamp, this.now, identity, assignments)),
    );
  }

  private async drop(
    writing: Writing,
    table: DraftedTable,
    identity: readonly unknown[],
  ): Promise<void> {
    writing.changed = true;
    await writing.run(deleteRow(table, { layer: writing.layers.own, state: writing.state }, identity));
  }

  /** States a value for an identity the view does not show. */
  private stateNew(
    writing: Writing,
    table: DraftedTable,
    identity: readonly unknown[],
    standing: Standing,
    assignments: readonly Assignment[],
  ): Promise<Row | undefined> {
    return this.put(
      writing,
      table,
      identity,
      this.stamp(writing, standing, STATED),
      undefined,
      assignments,
      this.target(writing, standing) !== undefined,
    );
  }

  /** Whose row a write holds for as long as it runs. */
  private held(writing: Writing): string {
    return writing.state === DRAFT ? "draft's" : "layer's";
  }

  /** What the write's read would have held had the shown row not been there. */
  private without(writing: Writing, standing: Standing, shown: Shown): Standing {
    return shown.at.layer === writing.layers.own
      ? { ...standing, published: undefined }
      : { ...standing, beneath: undefined };
  }

  /**
   * Applies a change to a shown value: in place when it is the write's own
   * row, otherwise by copying the row it comes from with the change. No row
   * means the copy's source is gone — a delete of it took effect after this
   * write read it, in another layer or outside this session — and nothing was
   * written: the write then answers as after that delete.
   */
  private async change(
    writing: Writing,
    table: DraftedTable,
    identity: readonly unknown[],
    standing: Standing,
    shown: Shown,
    assignments: readonly Assignment[],
  ): Promise<Row | undefined> {
    // Given values that all equal the layer's own statement change nothing:
    // no row is written, so nothing is published and no draft row is made. A
    // value from beneath is not the layer's own, and a draft row the layer
    // moved under is settled by being written again.
    const settles =
      writing.state === DRAFT &&
      standing.draft !== undefined &&
      standing.draft.over !== (standing.published?.revision ?? null);
    if (shown.at.layer === writing.layers.own && !settles && changesNothing(shown.row, assignments)) {
      return shown.row;
    }
    const row = await this.put(
      writing,
      table,
      identity,
      this.stamp(writing, standing, STATED),
      shown.at,
      assignments,
      this.target(writing, standing) !== undefined,
    );
    if (!row && shown.at.layer === writing.layers.own && shown.at.state === writing.state) {
      throw new Error(
        `${this.describe}: changing the '${table.name}' statement in place returned no row ` +
          `while the ${this.held(writing)} row is held.`,
      );
    }
    return row;
  }

  /** States the given values whatever the view shows: over the shown value,
   *  or as a new one — also when the shown value's source is gone. */
  private async merge(
    writing: Writing,
    table: DraftedTable,
    identity: readonly unknown[],
    standing: Standing,
    assignments: readonly Assignment[],
  ): Promise<Row> {
    const shown = this.shown(writing, standing);
    const changed = shown
      ? await this.change(writing, table, identity, standing, shown, assignments)
      : undefined;
    const row =
      changed ??
      (await this.stateNew(
        writing,
        table,
        identity,
        shown ? this.without(writing, standing, shown) : standing,
        assignments,
      ));
    if (!row) {
      throw new Error(
        `${this.describe}: stating a new '${table.name}' value returned no row while the ` +
          `${this.held(writing)} row is held.`,
      );
    }
    return row;
  }

  /**
   * Makes a shown identity absent, and answers with the value it hid — or with
   * nothing when no statement of this write made it absent. Whatever the
   * write's own row said is withdrawn; if the view would then still show a
   * value, the layer states against it — a removal when a base states it, and
   * inside a draft a retraction when only the layer's own published row does.
   *
   * A removal is a copy of the row it hides. When that row is gone — a delete
   * of it took effect after this write read it — nothing was written, and the
   * identity is read again: a layer further down may still show it, and the
   * removal is then stated over that value instead. Each further read is of a
   * lower winner, so there are at most as many as the stack has layers.
   */
  private async hide(
    writing: Writing,
    table: DraftedTable,
    identity: readonly unknown[],
    read: Standing,
    first: Shown,
  ): Promise<Shown | undefined> {
    const bound = writing.layers.stack.length;
    let standing = read;
    let shown: Shown | undefined = first;
    for (let reads = 0; shown; reads += 1) {
      if (reads >= bound) {
        throw new Error(
          `${this.describe}: hiding a '${table.name}' statement found its source gone more ` +
            `often than the stack has layers (${bound}).`,
        );
      }
      const beneath = standing.beneath?.stated === true;
      const target = this.target(writing, standing) !== undefined;
      const stillShown =
        writing.state === DRAFT && standing.published
          ? standing.published.effect === STATED
          : beneath;
      if (!stillShown) {
        if (target) await this.drop(writing, table, identity);
        return shown;
      }
      const row = await this.put(
        writing,
        table,
        identity,
        this.stamp(writing, standing, beneath ? REMOVED : RETRACTED),
        shown.at,
        [],
        target,
      );
      if (row) return shown;
      standing = await this.standing(writing, table, identity);
      shown = this.shown(writing, standing);
    }
    return undefined;
  }

  /** Withdraws the layer's own statement for an identity — exactly that one —
   *  and says whether it stated anything. */
  private async withdraw(
    writing: Writing,
    table: DraftedTable,
    identity: readonly unknown[],
    standing: Standing,
  ): Promise<boolean> {
    if (writing.state === PUBLISHED) {
      if (!standing.published) return false;
      await this.drop(writing, table, identity);
      return true;
    }
    const { draft, published } = standing;
    if (draft ? draft.effect === RETRACTED : !published) return false;
    if (!published) {
      await this.drop(writing, table, identity);
      return true;
    }
    const own = writing.layers.own;
    await this.put(
      writing,
      table,
      identity,
      this.stamp(writing, standing, RETRACTED),
      { layer: own, state: draft ? DRAFT : PUBLISHED },
      [],
      false,
    );
    return true;
  }

  private assignments(
    type: object,
    table: DraftedTable,
    properties: Record<string, unknown>,
  ): Assignment[] {
    return namedColumns(this.describe, nameOf(type), table.properties, properties);
  }

  private async resolves(
    run: Run,
    view: StackView,
    node: DraftedNode,
    key: unknown,
  ): Promise<boolean> {
    const [row] = await run(selectWinner(node, [key], view));
    return row?.[node.effect.name] === STATED;
  }

  private async missingEndpoint(
    run: Run,
    view: StackView,
    relationship: DraftedRelationship,
    source: unknown,
    target: unknown,
  ): Promise<"source" | "target" | undefined> {
    if (!(await this.resolves(run, view, relationship.source, source))) return "source";
    if (!(await this.resolves(run, view, relationship.target, target))) return "target";
    return undefined;
  }

  /** The row a view shows for an identity, read in one statement. */
  private async seen(
    run: Run,
    view: StackView,
    table: DraftedTable,
    identity: readonly unknown[],
  ): Promise<Row | undefined> {
    const [row] = await run(selectWinner(table, identity, view));
    return row?.[table.effect.name] === STATED ? row : undefined;
  }

  private async seenRelationship(
    run: Run,
    view: StackView,
    relationship: DraftedRelationship,
    source: unknown,
    target: unknown,
  ): Promise<Row | undefined> {
    const row = await this.seen(run, view, relationship, [source, target]);
    if (!row || (await this.missingEndpoint(run, view, relationship, source, target))) {
      return undefined;
    }
    return row;
  }

  // ── nodes ────────────────────────────────────────────────────────────────

  async createNode(
    type: GraphNodeType,
    key: unknown,
    properties: Record<string, unknown>,
    ctx?: InvokeContext,
  ): Promise<Found<GraphNodeValue> | Exists> {
    const node = this.node(type);
    const set = this.assignments(type, node, properties);
    return this.write(ctx, async (writing) => {
      const standing = await this.standing(writing, node, [key]);
      if (this.shown(writing, standing)) return { status: "exists" };
      const row = await this.stateNew(writing, node, [key], standing, set);
      return row
        ? { status: "found", value: nodeValue(node, row, writing.layers.nameOf) }
        : { status: "exists" };
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
    return this.write(ctx, async (writing) => {
      const standing = await this.standing(writing, node, [key]);
      const row = await this.merge(writing, node, [key], standing, set);
      return { status: "found", value: nodeValue(node, row, writing.layers.nameOf) };
    });
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
    return this.write(ctx, async (writing) => {
      const standing = await this.standing(writing, node, [key]);
      const shown = this.shown(writing, standing);
      if (!shown) return { status: "absent" };
      const row = await this.change(writing, node, [key], standing, shown, set);
      return row
        ? { status: "found", value: nodeValue(node, row, writing.layers.nameOf) }
        : { status: "absent" };
    });
  }

  async deleteNode(
    type: GraphNodeType,
    key: unknown,
    ctx?: InvokeContext,
  ): Promise<Found<GraphNodeValue> | Absent> {
    const node = this.node(type);
    return this.write(ctx, async (writing) => {
      const standing = await this.standing(writing, node, [key]);
      const shown = this.shown(writing, standing);
      if (!shown) return { status: "absent" };
      const hidden = await this.hide(writing, node, [key], standing, shown);
      if (!hidden) return { status: "absent" };
      // The layer's own relationships touching the node are withdrawn. Those a
      // base states are out of the view because the node is; nothing is stated
      // about them.
      const own = writing.layers.own;
      for (const { relationship, endpoint } of this.touching.get(node) ?? []) {
        const statements =
          writing.state === DRAFT
            ? withdrawTouchingInDraft(relationship, own, endpoint, key, this.now)
            : [deletePublishedTouching(relationship, own, endpoint, key)];
        for (const statement of statements) await writing.run(statement);
      }
      return { status: "found", value: nodeValue(node, hidden.row, writing.layers.nameOf) };
    });
  }

  async getNode(
    type: GraphNodeType,
    key: unknown,
    ctx?: InvokeContext,
  ): Promise<Found<GraphNodeValue> | Absent> {
    const node = this.node(type);
    const { run, view, layers } = await this.reading(ctx);
    const row = await this.seen(run, view, node, [key]);
    return row
      ? { status: "found", value: nodeValue(node, row, layers.nameOf) }
      : { status: "absent" };
  }

  async retractNode(
    type: GraphNodeType,
    key: unknown,
    ctx?: InvokeContext,
  ): Promise<Found<GraphNodeValue> | Absent | NotStated> {
    const node = this.node(type);
    return this.write(ctx, async (writing) => {
      const standing = await this.standing(writing, node, [key]);
      if (!(await this.withdraw(writing, node, [key], standing))) return { status: "notStated" };
      const row = await this.seen(writing.run, writing.view, node, [key]);
      return row
        ? { status: "found", value: nodeValue(node, row, writing.layers.nameOf) }
        : { status: "absent" };
    });
  }

  // ── listings ─────────────────────────────────────────────────────────────

  /** A tail as this call may follow it: one this store wrote, for the same
   *  draft — or for none — as the call itself reads. Checked before any
   *  statement names a value of it. */
  private tailOf(
    after: string | undefined,
    arity: number,
    session: Session | undefined,
  ): { keys?: unknown[]; parent?: string } | "cursorInvalid" {
    if (after === undefined) return {};
    const tail = decodeSelectedTail(after, arity);
    if (!tail || tail.selector?.draft !== session?.publicId) return "cursorInvalid";
    return { keys: tail.keys, parent: tail.selector?.parent };
  }

  private page<T>(
    rows: readonly Row[],
    limit: number,
    selector: TailSelector | undefined,
    value: (row: Row) => T,
    keys: (row: Row) => unknown[],
  ): Found<GraphPageResult<T>> {
    const kept = rows.slice(0, limit);
    const items = kept.map(value);
    return rows.length > limit
      ? {
          status: "found",
          value: { items, next: encodeSelectedTail(keys(kept[kept.length - 1]), selector) },
        }
      : { status: "found", value: { items } };
  }

  async findNodes(
    type: GraphNodeType,
    where: GraphFilter,
    page: GraphPage,
    ctx?: InvokeContext,
  ): Promise<Found<GraphPageResult<GraphNodeValue>> | CursorInvalid> {
    const node = this.node(type);
    const tail = this.tailOf(page.after, 1, this.session(ctx));
    if (tail === "cursorInvalid") return { status: "cursorInvalid" };
    const { run, view, layers, selector } = await this.reading(ctx);
    if (tail.parent !== undefined && tail.parent !== selector?.parent) {
      return { status: "cursorInvalid" };
    }
    const after = tail.keys;
    const sql = selectPage(
      node,
      view,
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
      await run(sql),
      page.limit,
      selector,
      (row) => nodeValue(node, row, layers.nameOf),
      (row) => [row[node.key.name]],
    );
  }

  // ── relationships ────────────────────────────────────────────────────────

  async createRelationship(
    type: GraphRelationshipType,
    source: unknown,
    target: unknown,
    properties: Record<string, unknown>,
    ctx?: InvokeContext,
  ): Promise<Found<GraphRelationshipValue> | Exists | EndpointAbsent> {
    const relationship = this.relationship(type);
    const set = this.assignments(type, relationship, properties);
    return this.write(ctx, async (writing) => {
      const endpoint = await this.missingEndpoint(
        writing.run,
        writing.view,
        relationship,
        source,
        target,
      );
      if (endpoint) return { status: "endpointAbsent", endpoint };
      const identity = [source, target];
      const standing = await this.standing(writing, relationship, identity);
      if (this.shown(writing, standing)) return { status: "exists" };
      const row = await this.stateNew(writing, relationship, identity, standing, set);
      return row
        ? { status: "found", value: relationshipValue(relationship, row, writing.layers.nameOf) }
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
    return this.write(ctx, async (writing) => {
      if (await this.missingEndpoint(writing.run, writing.view, relationship, source, target)) {
        return { status: "absent" };
      }
      const identity = [source, target];
      const standing = await this.standing(writing, relationship, identity);
      const row = await this.merge(writing, relationship, identity, standing, set);
      return {
        status: "found",
        value: relationshipValue(relationship, row, writing.layers.nameOf),
      };
    });
  }

  /** The relationship as the write's view holds it: shown, while both its
   *  endpoints resolve. */
  private async shownRelationship(
    writing: Writing,
    relationship: DraftedRelationship,
    source: unknown,
    target: unknown,
    standing: Standing,
  ): Promise<Shown | undefined> {
    const shown = this.shown(writing, standing);
    if (!shown) return undefined;
    const missing = await this.missingEndpoint(
      writing.run,
      writing.view,
      relationship,
      source,
      target,
    );
    return missing ? undefined : shown;
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
    return this.write(ctx, async (writing) => {
      const identity = [source, target];
      const standing = await this.standing(writing, relationship, identity);
      const shown = await this.shownRelationship(writing, relationship, source, target, standing);
      if (!shown) return { status: "absent" };
      const row = await this.change(writing, relationship, identity, standing, shown, set);
      return row
        ? { status: "found", value: relationshipValue(relationship, row, writing.layers.nameOf) }
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
    return this.write(ctx, async (writing) => {
      const identity = [source, target];
      const standing = await this.standing(writing, relationship, identity);
      const shown = await this.shownRelationship(writing, relationship, source, target, standing);
      if (!shown) return { status: "absent" };
      const hidden = await this.hide(writing, relationship, identity, standing, shown);
      return hidden
        ? { status: "found", value: relationshipValue(relationship, hidden.row, writing.layers.nameOf) }
        : { status: "absent" };
    });
  }

  async retractRelationship(
    type: GraphRelationshipType,
    source: unknown,
    target: unknown,
    ctx?: InvokeContext,
  ): Promise<Found<GraphRelationshipValue> | Absent | NotStated> {
    const relationship = this.relationship(type);
    return this.write(ctx, async (writing) => {
      const identity = [source, target];
      const standing = await this.standing(writing, relationship, identity);
      if (!(await this.withdraw(writing, relationship, identity, standing))) {
        return { status: "notStated" };
      }
      const row = await this.seenRelationship(
        writing.run,
        writing.view,
        relationship,
        source,
        target,
      );
      return row
        ? { status: "found", value: relationshipValue(relationship, row, writing.layers.nameOf) }
        : { status: "absent" };
    });
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
    const tail = this.tailOf(page.after, 2, this.session(ctx));
    if (tail === "cursorInvalid") return { status: "cursorInvalid" };
    const { run, view, layers, selector } = await this.reading(ctx);
    if (tail.parent !== undefined && tail.parent !== selector?.parent) {
      return { status: "cursorInvalid" };
    }
    const after = tail.keys;
    const sourceOnly = endpoints.source !== undefined && endpoints.target === undefined;
    const targetOnly = endpoints.target !== undefined && endpoints.source === undefined;
    const sql = selectPage(
      relationship,
      view,
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
          resolvesAmong(relationship.source, `${qualifier}${s.sql}`, view, "m"),
          resolvesAmong(relationship.target, `${qualifier}${t.sql}`, view, "m"),
        ],
      },
      targetOnly ? [s] : sourceOnly ? [t] : [s, t],
      page.limit + 1,
    );
    return this.page(
      await run(sql),
      page.limit,
      selector,
      (row) => relationshipValue(relationship, row, layers.nameOf),
      (row) => [row[s.name], row[t.name]],
    );
  }

  prepareTraversal(spec: TraversalSpec): PreparedTraversal {
    const tableNames = new Set(this.tables.map((table) => table.name));
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
    const tail = this.tailOf(page.after, 1, this.session(ctx));
    if (tail === "cursorInvalid") return { status: "cursorInvalid" };
    const { run, view, layers, selector } = await this.reading(ctx);
    if (tail.parent !== undefined && tail.parent !== selector?.parent) {
      return { status: "cursorInvalid" };
    }
    const rows = await run(
      traversalStatement(
        this.describe,
        nameOf(prepared.spec.to),
        compiled,
        view,
        key,
        where,
        page.limit,
        tail.keys?.[0],
      ),
    );
    if (Number(rows[0]?.[compiled.presentAlias] ?? 0) === 0) return { status: "absent" };
    const end = compiled.end;
    return this.page(
      rows.filter((row) => row[end.key.name] !== null && row[end.key.name] !== undefined),
      page.limit,
      selector,
      (row) => nodeValue(end, row, layers.nameOf),
      (row) => [row[end.key.name]],
    );
  }

  // ── drafts ───────────────────────────────────────────────────────────────

  private handle(row: Row): DraftHandle {
    return {
      id: String(row.public_id),
      parentRevision: readInt64Column(row.parent_revision),
      createdAt: readTimestampColumn(row.created_at),
    };
  }

  async openDraft(
    request: { readonly message?: string; readonly actor?: Actor },
    ctx?: InvokeContext,
  ): Promise<Found<{ readonly draft: DraftHandle; readonly opened: boolean }>> {
    const joined = this.connection.hasOpenTransaction(ctx);
    return this.atomic(ctx, async (run) => {
      const layers = await this.layersOf(run, joined, true);
      // The layer's row is taken first, as a publish and every published write
      // take it, so no draft of this layer opens or closes until this commits.
      const head = await this.holdLayer(run, layers.own);
      const d = this.draftsTable;
      const actor = request.actor ?? this.self;
      const returned = `${d.public_id}, ${d.parent_revision}, ${d.created_at}`;
      const [open] = await run(
        new SqlFragments()
          .text(`SELECT ${returned} FROM ${d.table} WHERE ${d.layer_id} = `)
          .value(layers.own)
          .text(` AND ${d.published_at} IS NULL AND ${d.discarded_at} IS NULL`),
      );
      if (open) return { status: "found", value: { draft: this.handle(open), opened: false } };
      const insert = new SqlFragments()
        .text(
          `INSERT INTO ${d.table} (${d.id}, ${d.public_id}, ${d.layer_id}, ${d.parent_revision}, ` +
            `${d.message}, ${d.created_at}, ${d.created_by_type}, ${d.created_by_id}) VALUES (`,
        )
        .value(newInternalId())
        .text(", ")
        .value(newDraftPublicId())
        .text(", ")
        .value(layers.own)
        .text(", ")
        .value(head)
        .text(", ");
      if (request.message === undefined) insert.text("NULL");
      else insert.value(request.message);
      const [created] = await run(
        insert
          .text(`, ${this.now}, `)
          .value(actor.type)
          .text(", ")
          .value(actor.id)
          .text(`) RETURNING ${returned}`),
      );
      return { status: "found", value: { draft: this.handle(created), opened: true } };
    });
  }

  /** Takes a draft of this layer by its public id, whatever its state, for the
   *  rest of the transaction. */
  private async holdDraftById(run: Run, layers: Layers, draft: string): Promise<Row | undefined> {
    const d = this.draftsTable;
    const [row] = await run(
      new SqlFragments()
        .text(`UPDATE ${d.table} SET ${d.parent_revision} = ${d.parent_revision} WHERE ${d.public_id} = `)
        .value(draft)
        .text(` AND ${d.layer_id} = `)
        .value(layers.own)
        .text(` RETURNING ${this.draftColumns()}`),
    );
    return row;
  }

  private async conflictCount(run: Run, view: StackView): Promise<number> {
    let conflicts = 0;
    for (const table of this.tables) {
      const [moved] = await run(countMoved(table, view.layers[0]));
      conflicts += Number(moved?.moved ?? 0);
    }
    for (const relationship of this.relationshipTables.values()) {
      const [missing] = await run(countEndpointMissing(relationship, view));
      conflicts += Number(missing?.missing ?? 0);
    }
    return conflicts;
  }

  async publish(
    draft: string,
    request: { readonly message?: string; readonly actor?: Actor },
    ctx?: InvokeContext,
  ): Promise<
    | Found<{ readonly revision: PublishedRevision; readonly changed: boolean }>
    | DraftNotFound
    | DraftClosed
    | DraftStale
    | DraftConflicted
  > {
    const layers = await this.resolved(ctx);
    return this.atomic(ctx, async (run) => {
      const row = await this.holdDraftById(run, layers, draft);
      if (!row) return { status: "draftNotFound" };
      const parent = readInt64Column(row.parent_revision);
      const closed = this.closedAs(row);
      if (closed?.closedAs === "discarded") return closed;
      if (closed) {
        const number = readInt64Column(row.revision);
        return {
          status: "found",
          value: {
            revision: { number, publishedAt: readTimestampColumn(row.published_at) },
            changed: number !== parent,
          },
        };
      }
      const head = await this.holdLayer(run, layers.own);
      if (head !== parent) {
        return { status: "draftStale", parentRevision: parent, headRevision: head };
      }
      const view: StackView = { layers: layers.stack, draft: true };
      if ((await this.conflictCount(run, view)) > 0) return { status: "draftConflicted" };

      let changed = false;
      for (const table of this.tables) {
        if ((await run(anyDraftRow(table, layers.own))).length > 0) {
          changed = true;
          break;
        }
      }
      const number = changed ? head + 1n : head;
      if (changed) {
        for (const table of this.tables) {
          for (const statement of publishRows(table, layers.own, number)) await run(statement);
        }
        await this.advanceLayer(run, layers.own);
      }
      const d = this.draftsTable;
      const actor = request.actor ?? this.self;
      const close = new SqlFragments()
        .text(`UPDATE ${d.table} SET ${d.published_at} = ${this.now}, ${d.published_by_type} = `)
        .value(actor.type)
        .text(`, ${d.published_by_id} = `)
        .value(actor.id)
        .text(`, ${d.revision} = `)
        .value(number);
      if (request.message !== undefined) close.text(`, ${d.message} = `).value(request.message);
      const [published] = await run(
        close.text(` WHERE ${d.id} = `).value(String(row.id)).text(` RETURNING ${d.published_at}`),
      );
      return {
        status: "found",
        value: {
          revision: { number, publishedAt: readTimestampColumn(published.published_at) },
          changed,
        },
      };
    });
  }

  async discardDraft(
    draft: string,
    request: { readonly actor?: Actor },
    ctx?: InvokeContext,
  ): Promise<Found<Record<string, never>> | DraftNotFound | DraftClosed> {
    const layers = await this.resolved(ctx);
    return this.atomic(ctx, async (run) => {
      const row = await this.holdDraftById(run, layers, draft);
      if (!row) return { status: "draftNotFound" };
      const closed = this.closedAs(row);
      if (closed?.closedAs === "published") return closed;
      if (closed) return { status: "found", value: {} };
      for (const table of this.tables) await run(discardRows(table, layers.own));
      const d = this.draftsTable;
      const actor = request.actor ?? this.self;
      await run(
        new SqlFragments()
          .text(`UPDATE ${d.table} SET ${d.discarded_at} = ${this.now}, ${d.discarded_by_type} = `)
          .value(actor.type)
          .text(`, ${d.discarded_by_id} = `)
          .value(actor.id)
          .text(` WHERE ${d.id} = `)
          .value(String(row.id)),
      );
      return { status: "found", value: {} };
    });
  }

  async rebaseDraft(
    draft: string,
    ctx?: InvokeContext,
  ): Promise<
    | Found<{
        readonly parentRevision: bigint;
        readonly merged: number;
        readonly conflicts: number;
      }>
    | DraftNotFound
    | DraftClosed
  > {
    const layers = await this.resolved(ctx);
    return this.atomic(ctx, async (run) => {
      const row = await this.holdDraftById(run, layers, draft);
      if (!row) return { status: "draftNotFound" };
      const closed = this.closedAs(row);
      if (closed) return closed;
      const head = await this.holdLayer(run, layers.own);
      let merged = 0;
      for (const table of this.tables) {
        for (const statement of mergeConvergent(table, layers.own)) {
          merged += (await run(statement)).length;
        }
      }
      const conflicts = await this.conflictCount(run, { layers: layers.stack, draft: true });
      const d = this.draftsTable;
      await run(
        new SqlFragments()
          .text(`UPDATE ${d.table} SET ${d.parent_revision} = `)
          .value(head)
          .text(` WHERE ${d.id} = `)
          .value(String(row.id)),
      );
      return { status: "found", value: { parentRevision: head, merged, conflicts } };
    });
  }

  async listDrafts(
    page: GraphPage,
    ctx?: InvokeContext,
  ): Promise<Found<GraphPageResult<DraftSummary>> | CursorInvalid> {
    const after = page.after === undefined ? undefined : decodeKeyTail(page.after, 1);
    if (page.after !== undefined && (!after || typeof after[0] !== "string")) {
      return { status: "cursorInvalid" };
    }
    const layers = await this.resolved(ctx);
    const d = this.draftsTable;
    const l = this.layersTable;
    const sql = new SqlFragments()
      .text(
        `SELECT d.${d.public_id}, d.${d.parent_revision}, d.${d.message}, d.${d.created_at}, ` +
          `d.${d.created_by_type}, d.${d.created_by_id}, l.${l.head_revision} ` +
          `FROM ${d.table} d JOIN ${l.table} l ON l.${l.id} = d.${d.layer_id} WHERE d.${d.layer_id} = `,
      )
      .value(layers.own)
      .text(` AND d.${d.published_at} IS NULL AND d.${d.discarded_at} IS NULL`);
    if (after) sql.text(` AND d.${d.public_id} > `).value(after[0]);
    sql.text(` ORDER BY d.${d.public_id} LIMIT `).value(page.limit + 1);
    const rows = await this.read(ctx)(sql);
    const kept = rows.slice(0, page.limit);
    const items = kept.map((row): DraftSummary => {
      const handle = this.handle(row);
      return {
        ...handle,
        stale: readInt64Column(row.head_revision) !== handle.parentRevision,
        ...(typeof row.message === "string" ? { message: row.message } : {}),
        createdBy: { type: String(row.created_by_type), id: String(row.created_by_id) },
      };
    });
    return rows.length > page.limit
      ? { status: "found", value: { items, next: encodeKeyTail([kept[kept.length - 1].public_id]) } }
      : { status: "found", value: { items } };
  }

  // ── conflicts ────────────────────────────────────────────────────────────

  private conflictValues(
    table: DraftedTable,
    candidate: Candidate,
    conflict: Classified,
  ): {
    class: Classified["class"];
    properties?: string[];
    mine?: Record<string, unknown>;
    theirs?: Record<string, unknown>;
    token: string;
  } {
    return {
      class: conflict.class,
      ...(conflict.properties ? { properties: conflict.properties } : {}),
      ...(candidate.effect === STATED
        ? { mine: propertiesOf(candidate.row, table.properties) }
        : {}),
      ...(candidate.theirs?.effect === STATED
        ? { theirs: propertiesOf(candidate.theirs.row, table.properties) }
        : {}),
      token: conflict.token,
    };
  }

  private async conflicts<T>(
    table: DraftedTable,
    page: GraphPage,
    ctx: InvokeContext | undefined,
    what: string,
    value: (candidate: Candidate, conflict: Classified) => T,
  ): Promise<Found<GraphPageResult<T>> | CursorInvalid> {
    const session = this.requireSession(ctx, what);
    const arity = table.identity.length;
    const tail = this.tailOf(page.after, arity, session);
    if (tail === "cursorInvalid") return { status: "cursorInvalid" };
    const { run, view, selector } = await this.reading(ctx);
    if (tail.parent !== undefined && tail.parent !== selector?.parent) {
      return { status: "cursorInvalid" };
    }
    const keys = tail.keys;
    const seek = keys
      ? () =>
          new SqlFragments()
            .text(`(${table.identity.map((c) => `r.${c.sql}`).join(", ")}) > (`)
            .valueList(keys, ", ")
            .text(")")
      : undefined;
    const quote = (name: string) => this.connection.dialect.quoteIdentifier(name);
    const rows = await run(
      selectConflictCandidates(table, view, quote, { seek, limit: page.limit + 1 }),
    );
    const kept = rows.slice(0, page.limit);
    const items: T[] = [];
    for (const row of kept) {
      const candidate = readCandidate(table, row);
      const conflict = classify(table, candidate);
      if (conflict) items.push(value(candidate, conflict));
    }
    return rows.length > page.limit
      ? {
          status: "found",
          value: {
            items,
            next: encodeSelectedTail(
              table.identity.map((c) => kept[kept.length - 1][c.name]),
              selector,
            ),
          },
        }
      : { status: "found", value: { items } };
  }

  nodeConflicts(
    type: GraphNodeType,
    page: GraphPage,
    ctx?: InvokeContext,
  ): Promise<Found<GraphPageResult<NodeConflict>> | CursorInvalid> {
    const node = this.node(type);
    return this.conflicts(node, page, ctx, "a conflict listing", (candidate, conflict) => ({
      key: candidate.row[node.key.name],
      ...this.conflictValues(node, candidate, conflict),
    }));
  }

  relationshipConflicts(
    type: GraphRelationshipType,
    page: GraphPage,
    ctx?: InvokeContext,
  ): Promise<Found<GraphPageResult<RelationshipConflict>> | CursorInvalid> {
    const relationship = this.relationship(type);
    return this.conflicts(relationship, page, ctx, "a conflict listing", (candidate, conflict) => ({
      source: candidate.row[relationship.sourceColumn.name],
      target: candidate.row[relationship.targetColumn.name],
      ...this.conflictValues(relationship, candidate, conflict),
    }));
  }

  /**
   * Decides one conflict. The decision's write names the revision the draft row
   * stood over when the conflict was read, so it applies only while the
   * conflict is still that one.
   */
  private resolve(
    table: DraftedTable,
    typeName: string,
    identity: readonly unknown[],
    decision: ConflictDecision,
    ctx: InvokeContext | undefined,
  ): Promise<"applied" | ConflictNotFound | ResolutionInvalid> {
    this.requireSession(ctx, "a conflict resolution");
    const set = namedColumns(this.describe, typeName, table.properties, decision.set ?? {});
    return this.write(ctx, async (writing) => {
      const { run, view } = writing;
      const quote = (name: string) => this.connection.dialect.quoteIdentifier(name);
      const [found] = await run(selectConflictCandidates(table, view, quote, { identity }));
      const candidate = found ? readCandidate(table, found) : undefined;
      const conflict = candidate ? classify(table, candidate) : undefined;
      if (!candidate || !conflict) return { status: "conflictNotFound" };
      if (decision.token !== undefined && decision.token !== conflict.token) {
        return { status: "conflictNotFound" };
      }
      const invalid = (reason: string): ResolutionInvalid => ({ status: "resolutionInvalid", reason });
      const resolvedBy = decision.resolvedBy ?? this.self;
      const own = writing.layers.own;
      const draft: RowAt = { layer: own, state: DRAFT };

      if (conflict.class === "endpoint-missing") {
        if (decision.take === "mine") {
          return invalid(
            "'mine' would keep a relationship whose endpoint does not resolve. Restore the " +
              "endpoint node instead, which clears the conflict.",
          );
        }
        if (set.length > 0) {
          return invalid("'set' has no value to apply to: taking 'theirs' removes the relationship.");
        }
        const standing = await this.standing(writing, table, identity);
        const stamp = (effect: RowEffect): Stamp => ({
          effect,
          revision: null,
          over: standing.published?.revision ?? null,
          resolution: "theirs",
          resolvedBy,
        });
        const from: RowAt = { layer: own, state: candidate.state };
        if (standing.beneath?.stated) {
          await this.put(writing, table, identity, stamp(REMOVED), from, [], false);
        } else if (standing.published?.effect === STATED) {
          await this.put(writing, table, identity, stamp(RETRACTED), from, [], false);
        } else {
          await this.drop(writing, table, identity);
        }
        return "applied";
      }

      const whileOver = { over: candidate.over };
      const theirs = candidate.theirs;
      const over = theirs?.revision ?? null;
      if (decision.take === "mine") {
        if (set.length > 0 && candidate.effect !== STATED) {
          return invalid("'set' has no value to apply to: the draft's side states none.");
        }
        const [row] = await run(
          updateRow(
            table,
            draft,
            {
              effect: candidate.effect,
              revision: null,
              over,
              resolution: set.length > 0 ? "merged" : "mine",
              resolvedBy,
            },
            this.now,
            identity,
            set,
            whileOver,
          ),
        );
        return row ? "applied" : { status: "conflictNotFound" };
      }
      if (set.length === 0) {
        const [row] = await run(deleteRow(table, draft, identity, whileOver));
        return row ? "applied" : { status: "conflictNotFound" };
      }
      if (theirs?.effect !== STATED) {
        return invalid("'set' has no value to apply to: the published side states none.");
      }
      const named = new Set(set.map((assignment) => assignment.column.name));
      const taken: Assignment[] = [...table.properties.values()]
        .filter((column) => !named.has(column.name))
        .map((column) => ({ column, value: theirs.row[column.name] ?? null }));
      const [row] = await run(
        updateRow(
          table,
          draft,
          { effect: STATED, revision: null, over, resolution: "merged", resolvedBy },
          this.now,
          identity,
          [...taken, ...set],
          whileOver,
        ),
      );
      return row ? "applied" : { status: "conflictNotFound" };
    });
  }

  async resolveNodeConflict(
    type: GraphNodeType,
    key: unknown,
    decision: ConflictDecision,
    ctx?: InvokeContext,
  ): Promise<Found<GraphNodeValue> | Absent | ConflictNotFound | ResolutionInvalid> {
    const node = this.node(type);
    const outcome = await this.resolve(node, nameOf(type), [key], decision, ctx);
    return outcome === "applied" ? this.getNode(type, key, ctx) : outcome;
  }

  async resolveRelationshipConflict(
    type: GraphRelationshipType,
    source: unknown,
    target: unknown,
    decision: ConflictDecision,
    ctx?: InvokeContext,
  ): Promise<Found<GraphRelationshipValue> | Absent | ConflictNotFound | ResolutionInvalid> {
    const relationship = this.relationship(type);
    const outcome = await this.resolve(
      relationship,
      nameOf(type),
      [source, target],
      decision,
      ctx,
    );
    if (outcome !== "applied") return outcome;
    const { run, view, layers } = await this.reading(ctx);
    const row = await this.seenRelationship(run, view, relationship, source, target);
    return row
      ? { status: "found", value: relationshipValue(relationship, row, layers.nameOf) }
      : { status: "absent" };
  }
}

export function isDraftedLayerStore(value: unknown): value is DraftedLayerStore {
  return value instanceof DraftedLayerStore;
}

export function register(): void {}

export async function create(
  resource: StoreManifest,
  ctx: ResourceContext,
): Promise<DraftedLayerStore> {
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
      isDraftedLayerStore,
      () => `${describe}: 'bases[${index}]'`,
      "GraphLayersSql.DraftedStore",
    ),
  );

  assertSchemaHoldsTables(ctx, resource.metadata.name, describe, ["layers", "drafts"]);
  const schema = resolveSchema(resource.schema, ctx, describe);
  if (!rendersCurrentInstant(schema)) {
    const identity = getRefIdentity(schema);
    throw new Error(
      `${describe}: 'schema' references '${identity?.name ?? "(inline)"}' of kind ` +
        `'${identity?.kind ?? "(unknown)"}', whose engine module predates instant rendering — ` +
        `its schema instance cannot say how the current instant is written in its timestamp ` +
        `columns. Upgrade the module that declares that kind.`,
    );
  }
  const dialect = connection.dialect;
  const layers = compileLayersTable(describe, resource.layers, ctx, dialect, schema);
  const drafts = compileDraftsTable(describe, resource.drafts, ctx, dialect, schema);
  assertTablesDistinct(describe, nodes, relationships, [
    [layers.resource, "layers"],
    [drafts.resource, "drafts"],
  ]);
  assertEndpointsListed(describe, nodes, relationships, nameOf);
  assertBasesStack(describe, connection, schema, layer, bases);
  bases.forEach((base, index) => {
    if (base.layersTable.table !== layers.compiled.table || base.draftsTable.table !== drafts.compiled.table) {
      refuse(
        "GRAPH_BASE_STORE_MISMATCH",
        `${describe} lists base '${nameOf(base)}' at 'bases[${index}]', which keeps its layers ` +
          `or drafts in another table. A layer and its bases are registered in one layers ` +
          `table, so they must share both bookkeeping tables.`,
      );
    }
  });
  return new DraftedLayerStore(
    describe,
    ctx,
    storeActor(resource.metadata.name),
    connection,
    schema,
    layer,
    bases,
    nodes,
    relationships,
    layers.compiled,
    drafts.compiled,
  );
}
