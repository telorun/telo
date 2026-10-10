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
import {
  BASE_STACK_LIMIT,
  storeActor,
  type Actor,
  type BaseCycle,
  type BaseLimit,
  type BaseNotPinned,
  type BasePinRequest,
  type BaseRevisionConflict,
  type BasesMoved,
  type ConflictClass,
  type ConflictDecision,
  type ConflictNotFound,
  type DraftClosed,
  type DraftConflicted,
  type DraftForeign,
  type DraftHandle,
  type DraftNotFound,
  type DraftStale,
  type DraftSummary,
  type LayerNotFound,
  type NodeConflict,
  type NotStated,
  type PinnedBase,
  type PublishedRevision,
  type RelationshipConflict,
  type ResolutionInvalid,
  type RevisionedGraphStore,
  type RevisionLabelExists,
  type RevisionLabelled,
  type RevisionNotFound,
  type RevisionOrder,
  type RevisionSummary,
  type SessionOpened,
} from "@telorun/graph-layers";
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
import { assertTablesDistinct, resolveSchema } from "./current-store.js";
import { assertSchemaHoldsTables } from "./declared-references.js";
import { DRAFT, REMOVED, RETRACTED, STATED } from "./declared-table.js";
import { newDraftPublicId, newInternalId } from "./draft-identity.js";
import type { RowEffect } from "./drafted-statements.js";
import { compileLayersTable, type LayersTable } from "./drafted-tables.js";
import {
  resolvesAmong,
  selectPage,
  selectWinner,
  viewBeneath,
  type LayerStack,
  type StackView,
} from "./layer-overlay.js";
import { isLayeredNodeType, type LayeredNodeType } from "./node-type.js";
import { changesNothing } from "./same-value.js";
import {
  baseListDigest,
  decodePinnedTail,
  encodePinnedTail,
  type TailPin,
} from "./page-tail.js";
import {
  composeStack,
  mergeBaseLists,
  placePins,
  sameBaseList,
  type Pin,
  type PinMove,
} from "./pinned-stack.js";
import { filterConditions } from "./compiled-types.js";
import {
  isLayeredRelationshipType,
  type LayeredRelationshipType,
} from "./relationship-type.js";
import { conflictToken, merge, sameProperties, type Merge } from "./revision-merge.js";
import {
  anyDraftVersion,
  anyWithdrawnNode,
  CANDIDATE_ALIASES,
  closeCurrentTouching,
  closeVersion,
  copyVersion,
  countEndpointMissing,
  countMoved,
  deleteDraftVersion,
  discardVersions,
  insertVersion,
  publishVersions,
  restandDraftVersion,
  selectCandidates,
  selectStanding,
  selectUncoveredTouching,
  selectVersions,
  selectVersionsById,
  updateDraftVersion,
  withdrawDraftTouching,
  type AsOf,
  type CandidateNarrowing,
  type DraftScope,
  type NewVersion,
  type StoodOn,
  type VersionStamp,
  type WithdrawnSides,
} from "./revisioned-statements.js";
import {
  compileChangesetBasesTable,
  compileChangesetsTable,
  compileRevisionedNode,
  compileRevisionedRelationship,
  type ChangesetBasesTable,
  type ChangesetsTable,
  type RevisionedNode,
  type RevisionedRelationship,
  type RevisionedTable,
} from "./revisioned-tables.js";
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
  nodes?: unknown[];
  relationships?: unknown[];
  layers?: unknown;
  changesets?: unknown;
  changesetBases?: unknown;
}

type Row = Record<string, unknown>;
type Run = (sql: SqlFragments) => Promise<Row[]>;

/**
 * A layer's resolved stack: the layer at one of its revisions, then every layer
 * beneath it at the revision it is pinned to, highest precedence first.
 */
interface Stack {
  /** The layer's own id, then each layer beneath. */
  readonly layers: readonly string[];
  /** The revision each layer is read at, in the order of `layers`. */
  readonly asOf: readonly bigint[];
  /** The direct pins, in position order. */
  readonly direct: readonly Pin[];
  /** The changeset whose rows in the bases table are `direct`; null for none. */
  readonly pointer: string | null;
  readonly nameOf: (id: string) => string;
}

/** What the store knows about one open session. */
interface Session {
  readonly changeset: string;
  readonly publicId: string;
  readonly cancellation: CancellationSource;
  closed?: DraftClosed;
}

/** One row of the layer for an identity, with its bookkeeping. */
interface Version {
  readonly row: Row;
  readonly id: string;
  readonly effect: RowEffect;
  readonly over: string | null;
  readonly beneath: string | null;
  readonly resolution: VersionStamp["resolution"];
  readonly resolvedBy: Actor | null;
}

/** The winning statement for an identity among the layers beneath. */
interface Beneath {
  readonly row: Row;
  readonly id: string;
  readonly effect: RowEffect;
}

/** Everything a view says about one identity: the changeset's row, the layer's
 *  statement at the revision the view reads it at, and the winner beneath. */
interface Standing {
  readonly draft?: Version;
  readonly published?: Version;
  readonly beneath?: Beneath;
}

/** The value a view shows for an identity, and where it is stated. */
interface Shown {
  readonly row: Row;
  readonly id: string;
  readonly from: "draft" | "published" | "beneath";
}

/** One write in progress. In a session its rows are the draft's changeset's;
 *  outside one they are a changeset of their own, published as `revision`. */
interface Writing {
  readonly run: Run;
  readonly own: string;
  readonly stack: Stack;
  readonly view: StackView;
  /** The layers beneath, as the view reads them; absent with none. */
  readonly beneath?: StackView;
  readonly at: AsOf;
  readonly changeset: string;
  readonly draft: boolean;
  /** The revision a write outside a session is published as. */
  readonly revision: bigint | null;
  changed: boolean;
}

interface Reading {
  readonly run: Run;
  readonly own: string;
  readonly stack: Stack;
  readonly view: StackView;
  /** What a tail issued now is pinned to. */
  readonly pin: TailPin;
}

/** A changeset's row as an operation holds it. */
interface Draft {
  readonly id: string;
  readonly parent: bigint;
  /** The changeset whose rows are this one's base list; null for none. */
  readonly pointer: string | null;
}

/** A statement the layer makes, with the rows it is judged from. */
interface Candidate {
  readonly row: Row;
  readonly id: string;
  /** The changeset's own row, or one the layer states and the changeset
   *  leaves standing. */
  readonly draft: boolean;
  readonly effect: RowEffect;
  readonly over: string | null;
  readonly theirsId: string | null;
  /** The layer's row as it now stands, when it states a value. */
  readonly theirs?: Row;
  /** The layer's row the draft's was written over, when it stated a value. */
  readonly base?: Row;
  /** The row beneath the statement was written over, and the one beneath now. */
  readonly beneath: string | null;
  readonly beneathNowId: string | null;
  readonly beneathBase?: Row;
  readonly beneathNow?: Row;
  /** A relationship with an endpoint that does not resolve in the draft's view. */
  readonly missing: boolean;
  readonly endpointRows: readonly (string | null)[];
}

interface Judged {
  readonly class: ConflictClass;
  readonly properties?: string[];
  readonly token: string;
  /** Which comparison the conflict comes from: the layer's own row having
   *  moved, or what lies beneath. Absent for `endpoint-missing`. */
  readonly against?: "layer" | "beneath";
  /** Set for every class but `endpoint-missing`. */
  readonly merge?: Extract<Merge, { outcome: "conflict" }>;
}

/** What a reconciliation runs in. */
interface Reconciling {
  readonly run: Run;
  readonly own: string;
  readonly scope: DraftScope;
}

type MoveRefusal = LayerNotFound | RevisionNotFound | BaseCycle | BaseRevisionConflict | BaseLimit;

const REBASE_BATCH = 500;
/** How many immutable stacks, base lists and layer names a store remembers. */
const REMEMBERED = 4096;

function remember<K, V>(cache: Map<K, V>, key: K, value: V): V {
  if (cache.size >= REMEMBERED) cache.clear();
  cache.set(key, value);
  return value;
}

function isRefusal<T extends { status: string }>(value: unknown): value is T {
  return typeof (value as { status?: unknown } | undefined)?.status === "string";
}

function nameOf(type: object): string {
  return getRefIdentity(type)?.name ?? "(inline)";
}

function textOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

/**
 * One layer of a graph kept in revisioned tables: every row is one version of
 * the layer's statement about one identity, written by exactly one changeset.
 * A changeset is a draft while open and a numbered, immutable revision of the
 * layer once published; a superseded row is kept, with the revision it stopped
 * being current at.
 *
 * Outside a draft session a read sees the layer at one revision — its head,
 * or the revision the listing's first page was read at — and a write is a
 * revision of its own, allocated by an atomic increment on the layer's row in
 * the same atomic operation. Inside a session — recognised by the zones
 * correlated on this store in the call's context — a read sees the draft's
 * rows over the layer AT THE DRAFT'S PARENT REVISION, whatever was published
 * since, and a write makes a row of the draft's changeset, taken together with
 * the changeset's own row so that the database serialises it against that
 * draft being published or discarded.
 *
 * The layers beneath are PINNED. A changeset names — through `bases_changeset`
 * — the changeset whose rows in the bases table are its base list, so the list
 * is stored once per change and a published revision's stack never changes. A
 * read resolves the layer's stack at the revision it reads; a row records the
 * winning row beneath it when it was written, and a base list that moves is
 * reconciled against those records: {@link reconcile}.
 *
 * Every identifier comes from a declaration; every value, id and revision is
 * bound; every instant is the engine schema's own expression.
 */
export class RevisionedLayerStore implements RevisionedGraphStore, ResourceInstance {
  /** This layer's name. What it is built on is data — its pins — not a
   *  declaration, so no other layer is named here. */
  readonly stack: LayerStack;
  private readonly nodeTables = new Map<GraphNodeType, RevisionedNode>();
  private readonly relationshipTables = new Map<GraphRelationshipType, RevisionedRelationship>();
  private readonly tables: RevisionedTable[] = [];
  private readonly touching = new Map<
    RevisionedNode,
    { relationship: RevisionedRelationship; endpoint: CompiledColumn }[]
  >();
  private readonly sessions = new WeakMap<ZoneEntry, Session>();
  private readonly now: string;
  /** Set once the layer's row is known to be committed. */
  private ownId?: string;
  /** What never changes once committed, so is read once: the base-list pointer
   *  of a published revision, a published base list, the stack beneath a layer
   *  at a revision, and a layer's name. */
  private readonly pointers = new Map<string, string | null>();
  private readonly baseLists = new Map<string, readonly Pin[]>();
  private readonly stacks = new Map<string, readonly Pin[]>();
  private readonly names = new Map<string, string>();

  constructor(
    private readonly describe: string,
    private readonly ctx: ResourceContext,
    /** The actor recorded when a caller names none: the store resource. */
    private readonly self: Actor,
    readonly connection: SqlConnection,
    readonly schema: SqlInstantSchema,
    readonly layer: string,
    readonly nodes: readonly LayeredNodeType[],
    readonly relationships: readonly LayeredRelationshipType[],
    readonly layersTable: LayersTable,
    readonly changesetsTable: ChangesetsTable,
    readonly basesTable: ChangesetBasesTable,
  ) {
    this.stack = [layer];
    this.now = schema.currentInstant();
    const dialect = connection.dialect;
    for (const node of nodes) {
      const compiled = compileRevisionedNode(describe, dialect, schema, node);
      this.nodeTables.set(node, compiled);
      this.tables.push(compiled);
      this.touching.set(compiled, []);
    }
    for (const type of relationships) {
      const relationship = compileRevisionedRelationship(
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

  private node(type: GraphNodeType): RevisionedNode {
    const compiled = this.nodeTables.get(type);
    if (!compiled) {
      throw new Error(`${this.describe} does not list node type '${nameOf(type)}' in 'nodes:'.`);
    }
    return compiled;
  }

  private relationship(type: GraphRelationshipType): RevisionedRelationship {
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

  // ── the layer ────────────────────────────────────────────────────────────

  /** The layer's internal id while it has a row. It is kept only when the row
   *  was found already committed — never from inside a caller's transaction,
   *  which may still roll back what it shows. */
  private async registeredId(run: Run, joined: boolean): Promise<string | undefined> {
    if (this.ownId) return this.ownId;
    const known = await this.layerNamed(run, this.layer);
    if (known && !joined) this.ownId = known.id;
    return known?.id;
  }

  /**
   * The layer's internal id. A read registers nothing: a layer with no row yet
   * holds nothing at revision 0, so it is read under an id no row carries. A
   * call that changes the layer (`register`) creates the row first, inside its
   * own atomic operation — a refused call and one that changes nothing never
   * do.
   */
  private async layerId(run: Run, joined: boolean, register: boolean): Promise<string> {
    const known = await this.registeredId(run, joined);
    if (known) return known;
    if (!register) return newInternalId();
    const l = this.layersTable;
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
    const registered = await this.layerNamed(run, this.layer);
    if (!registered) {
      throw new Error(`${this.describe}: layer '${this.layer}' could not be registered.`);
    }
    return registered.id;
  }

  /** The layer's id as a read sees it. */
  private ownLayer(ctx: InvokeContext | undefined): Promise<string> {
    return this.layerId(this.read(ctx), this.connection.hasOpenTransaction(ctx), false);
  }

  /** Whether what a call reads of published bookkeeping may be remembered: not
   *  inside a caller's transaction, which may yet roll back what it shows. */
  private settled(ctx: InvokeContext | undefined): boolean {
    return !this.connection.hasOpenTransaction(ctx);
  }

  /** A registered layer by name, with its head revision. */
  private async layerNamed(
    run: Run,
    name: string,
  ): Promise<{ id: string; head: bigint } | undefined> {
    const l = this.layersTable;
    const [row] = await run(
      new SqlFragments()
        .text(`SELECT ${l.id}, ${l.head_revision} FROM ${l.table} WHERE ${l.name} = `)
        .value(name),
    );
    return row ? { id: String(row.id), head: readInt64Column(row.head_revision) } : undefined;
  }

  /** The names of layers by id, for `origin` and for a base list. */
  private async namesOf(
    run: Run,
    settled: boolean,
    ids: readonly string[],
  ): Promise<(id: string) => string> {
    const known = new Map<string, string>();
    const unknown: string[] = [];
    for (const id of new Set(ids)) {
      const name = this.names.get(id);
      if (name === undefined) unknown.push(id);
      else known.set(id, name);
    }
    if (unknown.length > 0) {
      const l = this.layersTable;
      const rows = await run(
        new SqlFragments()
          .text(`SELECT ${l.id}, ${l.name} FROM ${l.table} WHERE ${l.id} IN (`)
          .valueList(unknown, ", ")
          .text(")"),
      );
      for (const row of rows) {
        known.set(String(row.id), String(row.name));
        if (settled) remember(this.names, String(row.id), String(row.name));
      }
    }
    return (id) => {
      const name = known.get(id);
      if (name === undefined) {
        throw new Error(`${this.describe}: layer '${id}' is not registered in its layers table.`);
      }
      return name;
    };
  }

  private async head(run: Run, layer: string): Promise<bigint> {
    const l = this.layersTable;
    const [row] = await run(
      new SqlFragments()
        .text(`SELECT ${l.head_revision} FROM ${l.table} WHERE ${l.id} = `)
        .value(layer),
    );
    // A layer no write has registered yet holds nothing, at revision 0.
    return row ? readInt64Column(row.head_revision) : 0n;
  }

  /** Takes the layer's row for the rest of the transaction — published writes
   *  to one layer apply one at a time — and reads its head revision. */
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

  /** The next revision, by an increment the database applies to the row this
   *  transaction holds. */
  private async advanceLayer(run: Run, layer: string): Promise<bigint> {
    const l = this.layersTable;
    const [row] = await run(
      new SqlFragments()
        .text(`UPDATE ${l.table} SET ${l.head_revision} = ${l.head_revision} + 1 WHERE ${l.id} = `)
        .value(layer)
        .text(` RETURNING ${l.head_revision}`),
    );
    return readInt64Column(row.head_revision);
  }

  // ── the stack ────────────────────────────────────────────────────────────

  /** The changeset whose rows are the base list of a layer's revision. Null
   *  for a layer built on none — as every layer is before its first revision. */
  private async pointerAt(
    run: Run,
    settled: boolean,
    layer: string,
    revision: bigint,
  ): Promise<string | null> {
    if (revision === 0n) return null;
    const key = `${layer}@${revision}`;
    const known = this.pointers.get(key);
    if (known !== undefined) return known;
    const c = this.changesetsTable;
    const [row] = await run(
      new SqlFragments()
        .text(`SELECT ${c.bases_changeset} FROM ${c.table} WHERE ${c.layer_id} = `)
        .value(layer)
        .text(` AND ${c.revision} = `)
        .value(revision),
    );
    if (!row) {
      throw new Error(
        `${this.describe}: revision ${revision} of layer '${layer}' is in no changeset, though ` +
          `a stack reads it.`,
      );
    }
    const pointer = textOrNull(row.bases_changeset);
    return settled ? remember(this.pointers, key, pointer) : pointer;
  }

  /** A base list by the changeset it is stored under. `settled` false for one
   *  that may still change: an open draft's own. */
  private async baseList(
    run: Run,
    settled: boolean,
    pointer: string | null,
  ): Promise<readonly Pin[]> {
    if (pointer === null) return [];
    const known = this.baseLists.get(pointer);
    if (known && settled) return known;
    const b = this.basesTable;
    const rows = await run(
      new SqlFragments()
        .text(
          `SELECT ${b.base_layer_id}, ${b.base_revision} FROM ${b.table} ` +
            `WHERE ${b.changeset_id} = `,
        )
        .value(pointer)
        .text(` ORDER BY ${b.position}`),
    );
    const list = rows.map((row) => ({
      layer: String(row.base_layer_id),
      revision: readInt64Column(row.base_revision),
    }));
    return settled ? remember(this.baseLists, pointer, list) : list;
  }

  /** The stack beneath one layer at one of its revisions. A published
   *  revision's is immutable, so it is resolved once. */
  private async beneathOf(run: Run, settled: boolean, pin: Pin): Promise<readonly Pin[]> {
    const key = `${pin.layer}@${pin.revision}`;
    const known = this.stacks.get(key);
    if (known) return known;
    const pointer = await this.pointerAt(run, settled, pin.layer, pin.revision);
    const composed = await this.compose(run, settled, await this.baseList(run, settled, pointer));
    if ("conflict" in composed) {
      throw new Error(
        `${this.describe}: revision ${pin.revision} of layer '${pin.layer}' holds layer ` +
          `'${composed.conflict.layer}' at two revisions, which no publish allows.`,
      );
    }
    return settled ? remember(this.stacks, key, composed.stack) : composed.stack;
  }

  private async compose(run: Run, settled: boolean, direct: readonly Pin[]) {
    const parts: Pin[][] = [];
    for (const pin of direct) parts.push([pin, ...(await this.beneathOf(run, settled, pin))]);
    return composeStack(parts);
  }

  /** The layer's stack over a base list already known to be legal. */
  private async stackOver(
    run: Run,
    settled: boolean,
    own: string,
    revision: bigint,
    direct: readonly Pin[],
    pointer: string | null,
  ): Promise<Stack> {
    const composed = await this.compose(run, settled, direct);
    if ("conflict" in composed) {
      throw new Error(
        `${this.describe}: the stack of layer '${this.layer}' holds layer ` +
          `'${composed.conflict.layer}' at two revisions.`,
      );
    }
    const beneath = composed.stack;
    const named = await this.namesOf(
      run,
      settled,
      beneath.map((pin) => pin.layer),
    );
    return {
      layers: [own, ...beneath.map((pin) => pin.layer)],
      asOf: [revision, ...beneath.map((pin) => pin.revision)],
      direct,
      pointer,
      nameOf: (id) => (id === own ? this.layer : named(id)),
    };
  }

  /** The layer's stack at one of its published revisions. */
  private async stackAt(run: Run, settled: boolean, own: string, revision: bigint): Promise<Stack> {
    const pointer = await this.pointerAt(run, settled, own, revision);
    const direct = await this.baseList(run, settled, pointer);
    return this.stackOver(run, settled, own, revision, direct, pointer);
  }

  /** A draft's stack: the layer at the draft's parent revision over the
   *  draft's base list, which is its own once it moved a pin. */
  private async stackOfDraft(run: Run, settled: boolean, own: string, draft: Draft): Promise<Stack> {
    const direct = await this.baseList(run, settled && draft.pointer !== draft.id, draft.pointer);
    return this.stackOver(run, settled, own, draft.parent, direct, draft.pointer);
  }

  private publishedView(stack: Stack): StackView {
    return { layers: stack.layers, asOf: stack.asOf };
  }

  private draftView(stack: Stack, changeset: string): StackView {
    return { layers: stack.layers, asOf: stack.asOf, draft: true, changeset };
  }

  private scopeOf(stack: Stack, changeset: string): DraftScope {
    return {
      view: this.draftView(stack, changeset),
      at: { layer: stack.layers[0], revision: stack.asOf[0] },
      beneath: stack.layers.slice(1).map((layer, index) => ({
        layer,
        revision: stack.asOf[index + 1],
      })),
      changeset,
    };
  }

  /** A base list as it is returned: names, revisions and their labels. */
  private async pinned(run: Run, settled: boolean, direct: readonly Pin[]): Promise<PinnedBase[]> {
    if (direct.length === 0) return [];
    const nameOf = await this.namesOf(
      run,
      settled,
      direct.map((pin) => pin.layer),
    );
    const c = this.changesetsTable;
    const sql = new SqlFragments().text(
      `SELECT ${c.layer_id}, ${c.revision}, ${c.label} FROM ${c.table} WHERE ${c.label} IS NOT NULL AND (`,
    );
    direct.forEach((pin, index) => {
      sql
        .text(`${index === 0 ? "" : " OR "}(${c.layer_id} = `)
        .value(pin.layer)
        .text(` AND ${c.revision} = `)
        .value(pin.revision)
        .text(")");
    });
    const labels = new Map<string, string>();
    for (const row of await run(sql.text(")"))) {
      labels.set(`${String(row.layer_id)}@${readInt64Column(row.revision)}`, String(row.label));
    }
    return direct.map((pin, position) => {
      const label = labels.get(`${pin.layer}@${pin.revision}`);
      return {
        layer: nameOf(pin.layer),
        revision: pin.revision,
        ...(label === undefined ? {} : { label }),
        position,
      };
    });
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

  private changesetColumns(): string {
    const c = this.changesetsTable;
    return [
      c.id,
      c.public_id,
      c.layer_id,
      c.parent_revision,
      c.created_at,
      c.published_at,
      c.discarded_at,
      c.revision,
      c.bases_changeset,
    ].join(", ");
  }

  private closedAs(row: Row | undefined): DraftClosed | undefined {
    if (!row) return { status: "draftClosed", closedAs: "discarded" };
    if (row.published_at !== null && row.published_at !== undefined) {
      const revision = row.revision === null || row.revision === undefined ? null : readInt64Column(row.revision);
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

  private draftOf(row: Row): Draft {
    return {
      id: String(row.id),
      parent: readInt64Column(row.parent_revision),
      pointer: textOrNull(row.bases_changeset),
    };
  }

  private async changesetRow(run: Run, id: string): Promise<Row | undefined> {
    const c = this.changesetsTable;
    const [row] = await run(
      new SqlFragments()
        .text(`SELECT ${this.changesetColumns()} FROM ${c.table} WHERE ${c.id} = `)
        .value(id),
    );
    return row;
  }

  /**
   * The draft-open check of a session WRITE: a conditional update of the
   * changeset's own row, in the transaction of the write. It matches only
   * while the draft is open, and holds the row until the write commits, so the
   * database — not a claim or a lease — decides between this write and the
   * draft being published or discarded. Answers the draft as it stands.
   */
  private async holdDraft(run: Run, session: Session): Promise<Draft> {
    const c = this.changesetsTable;
    const [held] = await run(
      new SqlFragments()
        .text(`UPDATE ${c.table} SET ${c.parent_revision} = ${c.parent_revision} WHERE ${c.id} = `)
        .value(session.changeset)
        .text(
          ` AND ${c.published_at} IS NULL AND ${c.discarded_at} IS NULL ` +
            `RETURNING ${c.id}, ${c.parent_revision}, ${c.bases_changeset}`,
        ),
    );
    if (held) return this.draftOf(held);
    return this.endSession(session, this.closedAs(await this.changesetRow(run, session.changeset))!);
  }

  /** The draft-open check of a session READ, and the draft as it stands. */
  private async openDraftOf(run: Run, session: Session): Promise<Draft> {
    const row = await this.changesetRow(run, session.changeset);
    const closed = this.closedAs(row);
    if (closed) this.endSession(session, closed);
    return this.draftOf(row!);
  }

  async openSession(
    entry: ZoneEntry,
    draft: string,
    cancellation: CancellationSource,
    ctx?: InvokeContext,
  ): Promise<SessionOpened | DraftNotFound | DraftClosed | DraftForeign> {
    const own = await this.ownLayer(ctx);
    const c = this.changesetsTable;
    const [row] = await this.read(ctx)(
      new SqlFragments()
        .text(`SELECT ${this.changesetColumns()} FROM ${c.table} WHERE ${c.public_id} = `)
        .value(draft),
    );
    if (!row) return { status: "draftNotFound" };
    if (String(row.layer_id) !== own) return { status: "draftForeign" };
    const closed = this.closedAs(row);
    if (closed) return closed;
    this.sessions.set(entry, { changeset: String(row.id), publicId: draft, cancellation });
    return { status: "opened" };
  }

  closeSession(entry: ZoneEntry): DraftClosed | undefined {
    const session = this.sessions.get(entry);
    this.sessions.delete(entry);
    return session?.closed;
  }

  // ── views ────────────────────────────────────────────────────────────────

  /**
   * What a read sees, checked against the tail it follows. In a session: the
   * draft over the layer at the draft's parent revision, over the draft's
   * pinned bases. Outside one: the layer at its head — or, following a tail,
   * at the revision that tail's first page was read at, which must be one the
   * layer has published — over the bases that revision pinned. Every field of
   * a tail is judged here, before any statement over a typed table.
   */
  private reading(ctx: InvokeContext | undefined): Promise<Reading>;
  private reading(
    ctx: InvokeContext | undefined,
    tail: { readonly pin?: TailPin },
  ): Promise<Reading | "cursorInvalid">;
  private async reading(
    ctx: InvokeContext | undefined,
    tail: { readonly pin?: TailPin } = {},
  ): Promise<Reading | "cursorInvalid"> {
    const session = this.session(ctx);
    const own = await this.ownLayer(ctx);
    const run = this.read(ctx);
    const settled = this.settled(ctx);
    if (session) {
      const draft = await this.openDraftOf(run, session);
      const stack = await this.stackOfDraft(run, settled, own, draft);
      const pin = {
        draft: session.publicId,
        parent: draft.parent.toString(),
        bases: baseListDigest(
          stack.direct.map((base) => ({ layer: stack.nameOf(base.layer), revision: base.revision })),
        ),
      };
      if (
        tail.pin &&
        (!("draft" in tail.pin) || tail.pin.parent !== pin.parent || tail.pin.bases !== pin.bases)
      ) {
        return "cursorInvalid";
      }
      return { run, own, stack, view: this.draftView(stack, session.changeset), pin };
    }
    const head = await this.head(run, own);
    let revision = head;
    if (tail.pin) {
      if ("draft" in tail.pin) return "cursorInvalid";
      revision = BigInt(tail.pin.revision);
      if (revision > head) return "cursorInvalid";
    }
    const stack = await this.stackAt(run, settled, own, revision);
    return { run, own, stack, view: this.publishedView(stack), pin: { revision: revision.toString() } };
  }

  /** A tail as this call may follow it: one this store wrote, for the same
   *  draft — or for none — as the call itself reads. Checked before any
   *  statement names a value of it. */
  private tailOf(
    after: string | undefined,
    arity: number,
    session: Session | undefined,
  ): { keys?: unknown[]; pin?: TailPin } | "cursorInvalid" {
    if (after === undefined) return {};
    const tail = decodePinnedTail(after, arity);
    if (!tail) return "cursorInvalid";
    const draft = "draft" in tail.pin ? tail.pin.draft : undefined;
    if (draft !== session?.publicId) return "cursorInvalid";
    return tail;
  }

  // ── reading and writing one identity ─────────────────────────────────────

  private writing(
    run: Run,
    stack: Stack,
    changeset: string,
    revision: bigint | null,
  ): Writing {
    const draft = revision === null;
    const view = draft ? this.draftView(stack, changeset) : this.publishedView(stack);
    return {
      run,
      own: stack.layers[0],
      stack,
      view,
      ...(stack.layers.length > 1 ? { beneath: viewBeneath(this.publishedView(stack)) } : {}),
      at: { layer: stack.layers[0], revision: stack.asOf[0] },
      changeset,
      draft,
      revision,
      changed: false,
    };
  }

  /**
   * One write. Inside a session it makes rows of the draft's changeset, holding
   * the draft. Outside one it holds the layer, makes rows of a changeset of
   * its own, and — when it changed anything — publishes that changeset as the
   * layer's next revision before it commits.
   */
  private async write<T>(
    ctx: InvokeContext | undefined,
    body: (writing: Writing) => Promise<T>,
  ): Promise<T> {
    const session = this.session(ctx);
    const settled = this.settled(ctx);
    return this.atomic(ctx, async (run) => {
      const own = await this.layerId(run, !settled, !session);
      if (session) {
        const draft = await this.holdDraft(run, session);
        const stack = await this.stackOfDraft(run, settled, own, draft);
        return body(this.writing(run, stack, session.changeset, null));
      }
      const head = await this.holdLayer(run, own);
      const stack = await this.stackAt(run, settled, own, head);
      const writing = this.writing(run, stack, newInternalId(), head + 1n);
      const result = await body(writing);
      if (writing.changed) {
        await this.advanceLayer(run, own);
        await this.recordRevision(run, own, writing.changeset, head, head + 1n, stack.pointer);
      }
      return result;
    });
  }

  /** The changeset of a change made outside a session: opened and published at
   *  once, by the store itself. It inherits the layer's base list unless the
   *  change is to that list. */
  private async recordRevision(
    run: Run,
    own: string,
    changeset: string,
    parent: bigint,
    revision: bigint,
    pointer: string | null,
  ): Promise<void> {
    const c = this.changesetsTable;
    const sql = new SqlFragments()
      .text(
        `INSERT INTO ${c.table} (${c.id}, ${c.public_id}, ${c.layer_id}, ${c.parent_revision}, ` +
          `${c.revision}, ${c.bases_changeset}, ${c.created_at}, ${c.created_by_type}, ` +
          `${c.created_by_id}, ${c.published_at}, ${c.published_by_type}, ${c.published_by_id}) VALUES (`,
      )
      .valueList([changeset, newDraftPublicId(), own, parent, revision], ", ")
      .text(", ");
    if (pointer === null) sql.text("NULL");
    else sql.value(pointer);
    await run(
      sql
        .text(`, ${this.now}, `)
        .valueList([this.self.type, this.self.id], ", ")
        .text(`, ${this.now}, `)
        .valueList([this.self.type, this.self.id], ", ")
        .text(")"),
    );
  }

  private version(table: RevisionedTable, row: Row): Version {
    const type = row[table.resolvedByType.name];
    const id = row[table.resolvedById.name];
    return {
      row,
      id: String(row[table.row.name]),
      effect: row[table.effect.name] as RowEffect,
      over: textOrNull(row[table.over.name]),
      beneath: textOrNull(row[table.beneath.name]),
      resolution: (row[table.resolution.name] ?? null) as VersionStamp["resolution"],
      resolvedBy: typeof type === "string" && typeof id === "string" ? { type, id } : null,
    };
  }

  private async standing(
    writing: Writing,
    table: RevisionedTable,
    identity: readonly unknown[],
  ): Promise<Standing> {
    const rows = await writing.run(
      selectVersions(table, writing.at, writing.draft ? writing.changeset : undefined, identity),
    );
    const draft = rows.find((row) => row[table.state.name] === DRAFT);
    const published = rows.find((row) => row[table.state.name] !== DRAFT);
    // What wins among the layers beneath, read only when there are any.
    const [beneath] = writing.beneath
      ? await writing.run(selectWinner(table, identity, writing.beneath))
      : [];
    return {
      ...(draft ? { draft: this.version(table, draft) } : {}),
      ...(published ? { published: this.version(table, published) } : {}),
      ...(beneath
        ? {
            beneath: {
              row: beneath,
              id: String(beneath[table.row.name]),
              effect: beneath[table.effect.name] as RowEffect,
            },
          }
        : {}),
    };
  }

  /**
   * What the write's view shows for the identity: the draft's statement, else
   * the layer's, else the winner beneath. A removal shows nothing; a draft's
   * retraction withdraws the layer's own statement, so what lies beneath shows.
   */
  private shown(standing: Standing): Shown | undefined {
    const { draft, published, beneath } = standing;
    const fromBeneath = (): Shown | undefined =>
      beneath?.effect === STATED ? { row: beneath.row, id: beneath.id, from: "beneath" } : undefined;
    if (draft) {
      if (draft.effect === STATED) return { row: draft.row, id: draft.id, from: "draft" };
      return draft.effect === RETRACTED ? fromBeneath() : undefined;
    }
    if (published) {
      return published.effect === STATED
        ? { row: published.row, id: published.id, from: "published" }
        : undefined;
    }
    return fromBeneath();
  }

  /** The draft's row for the identity no longer stands on what it was written
   *  over: the layer's own row, or the statement winning beneath, has moved. */
  private movedUnder(standing: Standing): boolean {
    const draft = standing.draft;
    if (!draft) return false;
    const over = standing.published?.id ?? null;
    const beneath = standing.beneath?.id ?? null;
    return draft.over !== over || (draft.effect !== RETRACTED && draft.beneath !== beneath);
  }

  /**
   * The bookkeeping an ordinary write leaves: the row beneath it, and — on a
   * draft row — the layer's row as the draft reads it. Standing on both as
   * they now are is also what settles a conflict on the identity: the caller's
   * version is kept, and recorded as taken by the store.
   */
  private stamp(writing: Writing, standing: Standing, effect: RowEffect): VersionStamp {
    const beneath = standing.beneath?.id ?? null;
    if (!writing.draft) return { effect, over: null, beneath, resolution: null, resolvedBy: null };
    const over = standing.published?.id ?? null;
    const draft = standing.draft;
    const settles = this.movedUnder(standing);
    return {
      effect,
      over,
      beneath,
      resolution: settles ? "mine" : (draft?.resolution ?? null),
      resolvedBy: settles ? this.self : (draft?.resolvedBy ?? null),
    };
  }

  private newVersion(writing: Writing, stamp: VersionStamp): NewVersion {
    return {
      ...stamp,
      id: newInternalId(),
      layer: writing.own,
      changeset: writing.changeset,
      from: writing.revision,
    };
  }

  /** Makes way for a new row of the write's own: a draft's row for the
   *  identity is replaced, and outside a draft the layer's current row is
   *  ended at the write's revision. */
  private async supersede(
    writing: Writing,
    table: RevisionedTable,
    identity: readonly unknown[],
    standing: Standing,
  ): Promise<void> {
    if (writing.draft) {
      if (standing.draft) await writing.run(deleteDraftVersion(table, writing.changeset, identity));
    } else if (standing.published) {
      await writing.run(closeVersion(table, standing.published.id, writing.revision!));
    }
  }

  /** States a value for an identity the view does not show — one never stated,
   *  or hidden: a hidden key is absent, so the new statement replaces the
   *  removal. */
  private async stateNew(
    writing: Writing,
    table: RevisionedTable,
    identity: readonly unknown[],
    standing: Standing,
    assignments: readonly Assignment[],
  ): Promise<Row | undefined> {
    writing.changed = true;
    await this.supersede(writing, table, identity, standing);
    const [row] = await writing.run(
      insertVersion(
        table,
        this.newVersion(writing, this.stamp(writing, standing, STATED)),
        identity,
        assignments,
      ),
    );
    return row;
  }

  /** Whose row a write holds for as long as it runs. */
  private held(writing: Writing): string {
    return writing.draft ? "draft's" : "layer's";
  }

  /**
   * Applies a change to a shown value. A draft's own row is changed in place;
   * no published row is ever changed — a row of the write's own is made as a
   * copy of the one shown, the layer's or one from beneath, with the change.
   */
  private async change(
    writing: Writing,
    table: RevisionedTable,
    identity: readonly unknown[],
    standing: Standing,
    shown: Shown,
    assignments: readonly Assignment[],
  ): Promise<Row> {
    // Given values that all equal the layer's own statement change nothing:
    // no row is written, so no revision is made and no draft row. A value
    // from beneath is not the layer's own, and a draft row the layer or a
    // base moved under is settled by being written again.
    const settles = writing.draft && this.movedUnder(standing);
    if (shown.from !== "beneath" && !settles && changesNothing(shown.row, assignments)) {
      return shown.row;
    }
    writing.changed = true;
    const stamp = this.stamp(writing, standing, STATED);
    let row: Row | undefined;
    if (shown.from === "draft") {
      [row] = await writing.run(
        updateDraftVersion(table, writing.changeset, identity, stamp, assignments),
      );
    } else {
      await this.supersede(writing, table, identity, standing);
      [row] = await writing.run(
        copyVersion(table, this.newVersion(writing, stamp), shown.id, assignments),
      );
    }
    if (!row) {
      throw new Error(
        `${this.describe}: changing the '${table.name}' statement returned no row while the ` +
          `${this.held(writing)} row is held, though a version is copied by row id and none is ` +
          `ever deleted.`,
      );
    }
    return row;
  }

  /** In a draft: the changeset withdraws the layer's statement for the
   *  identity, by a `retracted` row over it. */
  private async retractInDraft(
    writing: Writing,
    table: RevisionedTable,
    identity: readonly unknown[],
    standing: Standing,
    published: Version,
  ): Promise<void> {
    const stamp = this.stamp(writing, standing, RETRACTED);
    await writing.run(
      standing.draft
        ? updateDraftVersion(table, writing.changeset, identity, stamp, [])
        : copyVersion(table, this.newVersion(writing, stamp), published.id, []),
    );
  }

  /** Withdraws the layer's own statement as the write sees it. */
  private async withdrawOwn(
    writing: Writing,
    table: RevisionedTable,
    identity: readonly unknown[],
    standing: Standing,
  ): Promise<void> {
    if (!writing.draft) {
      if (standing.published) {
        await writing.run(closeVersion(table, standing.published.id, writing.revision!));
      }
      return;
    }
    if (standing.published) {
      await this.retractInDraft(writing, table, identity, standing, standing.published);
    } else {
      await writing.run(deleteDraftVersion(table, writing.changeset, identity));
    }
  }

  /**
   * Makes a shown identity absent. Where a layer beneath states it — whether
   * or not this layer restates it — the layer hides it: a `removed` row of the
   * write's own, a full row carrying the values it hides and naming the hidden
   * row. Where only this layer states it, the statement is withdrawn and no
   * row is left.
   */
  private async hide(
    writing: Writing,
    table: RevisionedTable,
    identity: readonly unknown[],
    standing: Standing,
  ): Promise<void> {
    writing.changed = true;
    const beneath = standing.beneath;
    if (beneath?.effect !== STATED) {
      await this.withdrawOwn(writing, table, identity, standing);
      return;
    }
    const stamp = this.stamp(writing, standing, REMOVED);
    await this.supersede(writing, table, identity, standing);
    await writing.run(copyVersion(table, this.newVersion(writing, stamp), beneath.id, []));
  }

  /** Withdraws the layer's own statement for an identity — exactly that one, a
   *  removal included — and says whether it stated anything. */
  private async withdraw(
    writing: Writing,
    table: RevisionedTable,
    identity: readonly unknown[],
    standing: Standing,
  ): Promise<boolean> {
    const { draft, published } = standing;
    if (writing.draft ? (draft ? draft.effect === RETRACTED : !published) : !published) return false;
    writing.changed = true;
    await this.withdrawOwn(writing, table, identity, standing);
    return true;
  }

  private assignments(
    type: object,
    table: RevisionedTable,
    properties: Record<string, unknown>,
  ): Assignment[] {
    return namedColumns(this.describe, nameOf(type), table.properties, properties);
  }

  /** The row a view shows for an identity, read in one statement. */
  private async seen(
    run: Run,
    view: StackView,
    table: RevisionedTable,
    identity: readonly unknown[],
  ): Promise<Row | undefined> {
    const [row] = await run(selectWinner(table, identity, view));
    return row?.[table.effect.name] === STATED ? row : undefined;
  }

  private async missingEndpoint(
    run: Run,
    view: StackView,
    relationship: RevisionedRelationship,
    source: unknown,
    target: unknown,
  ): Promise<"source" | "target" | undefined> {
    if (!(await this.seen(run, view, relationship.source, [source]))) return "source";
    if (!(await this.seen(run, view, relationship.target, [target]))) return "target";
    return undefined;
  }

  private async seenRelationship(
    run: Run,
    view: StackView,
    relationship: RevisionedRelationship,
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
      if (this.shown(standing)) return { status: "exists" };
      const row = await this.stateNew(writing, node, [key], standing, set);
      return row
        ? { status: "found", value: nodeValue(node, row, writing.stack.nameOf) }
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
      const shown = this.shown(standing);
      const row = shown
        ? await this.change(writing, node, [key], standing, shown, set)
        : await this.stateNew(writing, node, [key], standing, set);
      if (!row) {
        throw new Error(
          `${this.describe}: merging '${nameOf(type)}' returned no row while the ` +
            `${this.held(writing)} row is held.`,
        );
      }
      return { status: "found", value: nodeValue(node, row, writing.stack.nameOf) };
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
      const shown = this.shown(standing);
      if (!shown) return { status: "absent" };
      const row = await this.change(writing, node, [key], standing, shown, set);
      return { status: "found", value: nodeValue(node, row, writing.stack.nameOf) };
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
      const shown = this.shown(standing);
      if (!shown) return { status: "absent" };
      await this.hide(writing, node, [key], standing);
      // The layer's own relationships touching the node are withdrawn: the
      // node's row is written, and one statement per relationship the layer
      // itself states there — never a row for anything else.
      for (const { relationship, endpoint } of this.touching.get(node) ?? []) {
        await this.withdrawTouching(writing, relationship, endpoint, key);
      }
      return { status: "found", value: nodeValue(node, shown.row, writing.stack.nameOf) };
    });
  }

  private async withdrawTouching(
    writing: Writing,
    relationship: RevisionedRelationship,
    endpoint: CompiledColumn,
    key: unknown,
  ): Promise<void> {
    const { run, at, changeset } = writing;
    if (!writing.draft) {
      await run(closeCurrentTouching(relationship, at.layer, endpoint, key, writing.revision!));
      return;
    }
    for (const statement of withdrawDraftTouching(relationship, at, changeset, endpoint, key)) {
      await run(statement);
    }
    // A row's id is the store's to mint, so each retraction is a statement.
    const uncovered = await run(selectUncoveredTouching(relationship, at, changeset, endpoint, key));
    for (const row of uncovered) {
      const over = String(row[relationship.row.name]);
      await run(
        copyVersion(
          relationship,
          this.newVersion(writing, {
            effect: RETRACTED,
            over,
            beneath: null,
            resolution: null,
            resolvedBy: null,
          }),
          over,
          [],
        ),
      );
    }
  }

  async getNode(
    type: GraphNodeType,
    key: unknown,
    ctx?: InvokeContext,
  ): Promise<Found<GraphNodeValue> | Absent> {
    const node = this.node(type);
    const reading = await this.reading(ctx);
    const row = await this.seen(reading.run, reading.view, node, [key]);
    return row
      ? { status: "found", value: nodeValue(node, row, reading.stack.nameOf) }
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
      const beneath = standing.beneath;
      return beneath?.effect === STATED
        ? { status: "found", value: nodeValue(node, beneath.row, writing.stack.nameOf) }
        : { status: "absent" };
    });
  }

  // ── listings ─────────────────────────────────────────────────────────────

  private page<T>(
    rows: readonly Row[],
    limit: number,
    pin: TailPin,
    value: (row: Row) => T,
    keys: (row: Row) => unknown[],
  ): Found<GraphPageResult<T>> {
    const kept = rows.slice(0, limit);
    const items = kept.map(value);
    return rows.length > limit
      ? {
          status: "found",
          value: { items, next: encodePinnedTail(keys(kept[kept.length - 1]), pin) },
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
    const reading = await this.reading(ctx, tail);
    if (reading === "cursorInvalid") return { status: "cursorInvalid" };
    const { run, view, stack, pin } = reading;
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
      pin,
      (row) => nodeValue(node, row, stack.nameOf),
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
      if (this.shown(standing)) return { status: "exists" };
      const row = await this.stateNew(writing, relationship, identity, standing, set);
      return row
        ? { status: "found", value: relationshipValue(relationship, row, writing.stack.nameOf) }
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
      const shown = this.shown(standing);
      const row = shown
        ? await this.change(writing, relationship, identity, standing, shown, set)
        : await this.stateNew(writing, relationship, identity, standing, set);
      if (!row) {
        throw new Error(
          `${this.describe}: merging '${nameOf(type)}' returned no row while the ` +
            `${this.held(writing)} row is held.`,
        );
      }
      return {
        status: "found",
        value: relationshipValue(relationship, row, writing.stack.nameOf),
      };
    });
  }

  /** The relationship as the write's view holds it: shown, while both its
   *  endpoints resolve. */
  private async shownRelationship(
    writing: Writing,
    relationship: RevisionedRelationship,
    source: unknown,
    target: unknown,
    standing: Standing,
  ): Promise<Shown | undefined> {
    const shown = this.shown(standing);
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
      return {
        status: "found",
        value: relationshipValue(relationship, row, writing.stack.nameOf),
      };
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
      await this.hide(writing, relationship, identity, standing);
      return {
        status: "found",
        value: relationshipValue(relationship, shown.row, writing.stack.nameOf),
      };
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
      // What lies beneath shows again, while both its endpoints resolve.
      const beneath = standing.beneath;
      if (
        beneath?.effect !== STATED ||
        (await this.missingEndpoint(writing.run, writing.view, relationship, source, target))
      ) {
        return { status: "absent" };
      }
      return {
        status: "found",
        value: relationshipValue(relationship, beneath.row, writing.stack.nameOf),
      };
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
    const reading = await this.reading(ctx, tail);
    if (reading === "cursorInvalid") return { status: "cursorInvalid" };
    const { run, view, stack, pin } = reading;
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
        filter: (qualifier) =>
          filterConditions(this.describe, nameOf(type), where, relationship.properties, qualifier),
        // In the view only while both endpoints resolve.
        probes: (qualifier) => [
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
      pin,
      (row) => relationshipValue(relationship, row, stack.nameOf),
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
    const reading = await this.reading(ctx, tail);
    if (reading === "cursorInvalid") return { status: "cursorInvalid" };
    const { run, view, stack, pin } = reading;
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
      pin,
      (row) => nodeValue(end, row, stack.nameOf),
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

  /** Opens a draft at the layer's head, on the head's base list. Any number
   *  are open on a layer at once, so this always opens one. */
  async openDraft(
    request: { readonly message?: string; readonly actor?: Actor },
    ctx?: InvokeContext,
  ): Promise<Found<{ readonly draft: DraftHandle; readonly opened: boolean }>> {
    const settled = this.settled(ctx);
    const c = this.changesetsTable;
    const l = this.layersTable;
    const actor = request.actor ?? this.self;
    const insert = new SqlFragments()
      .text(
        `INSERT INTO ${c.table} (${c.id}, ${c.public_id}, ${c.layer_id}, ${c.parent_revision}, ` +
          `${c.bases_changeset}, ${c.message}, ${c.created_at}, ${c.created_by_type}, ` +
          `${c.created_by_id}) SELECT `,
      )
      .value(newInternalId())
      .text(", ")
      .value(newDraftPublicId())
      .text(
        `, l.${l.id}, l.${l.head_revision}, (SELECT h.${c.bases_changeset} FROM ${c.table} h ` +
          `WHERE h.${c.layer_id} = l.${l.id} AND h.${c.revision} = l.${l.head_revision}), `,
      );
    if (request.message === undefined) insert.text("NULL");
    else insert.value(request.message);
    insert
      .text(`, ${this.now}, `)
      .value(actor.type)
      .text(", ")
      .value(actor.id);
    // Opening is the layer's first write when nothing wrote it before, so the
    // layer's row is created in the same atomic operation as the draft.
    return this.atomic(ctx, async (run) => {
      const own = await this.layerId(run, !settled, true);
      const [created] = await run(
        insert
          .text(` FROM ${l.table} l WHERE l.${l.id} = `)
          .value(own)
          .text(` RETURNING ${c.public_id}, ${c.parent_revision}, ${c.created_at}`),
      );
      return { status: "found", value: { draft: this.handle(created), opened: true } };
    });
  }

  /** Takes a changeset of this layer by its public id, whatever its state, for
   *  the rest of the transaction. */
  private async holdDraftById(run: Run, own: string, draft: string): Promise<Row | undefined> {
    const c = this.changesetsTable;
    const [row] = await run(
      new SqlFragments()
        .text(`UPDATE ${c.table} SET ${c.parent_revision} = ${c.parent_revision} WHERE ${c.public_id} = `)
        .value(draft)
        .text(` AND ${c.layer_id} = `)
        .value(own)
        .text(` RETURNING ${this.changesetColumns()}`),
    );
    return row;
  }

  /** Rows of the changeset the layer has moved under or that no longer stand
   *  on what lies beneath them, and relationships the draft's view states with
   *  an endpoint that does not resolve. After a reconciliation every such row
   *  left is a conflict. */
  private async undecided(run: Run, scope: DraftScope): Promise<number> {
    let count = 0;
    for (const table of this.tables) {
      const [moved] = await run(countMoved(table, scope));
      count += Number(moved?.moved ?? 0);
    }
    const withdrawn = this.withdrawnSides(run, scope.changeset);
    for (const relationship of this.relationshipTables.values()) {
      const [missing] = await run(
        countEndpointMissing(relationship, scope, await withdrawn(relationship)),
      );
      count += Number(missing?.missing ?? 0);
    }
    return count;
  }

  /** Per relationship type, the sides the changeset withdraws a node of — each
   *  node type asked once, from the changeset's own range. */
  private withdrawnSides(
    run: Run,
    changeset: string,
  ): (relationship: RevisionedRelationship) => Promise<WithdrawnSides> {
    const asked = new Map<RevisionedNode, Promise<boolean>>();
    const withdraws = (node: RevisionedNode): Promise<boolean> => {
      let answer = asked.get(node);
      if (!answer) {
        answer = run(anyWithdrawnNode(node, changeset)).then((rows) => rows.length > 0);
        asked.set(node, answer);
      }
      return answer;
    };
    return async (relationship) => ({
      source: await withdraws(relationship.source),
      target: await withdraws(relationship.target),
    });
  }

  /** The tables a changeset holds rows of. Only those are published: a table
   *  it never touched is not read at all. */
  private async touched(run: Run, changeset: string): Promise<RevisionedTable[]> {
    const touched: RevisionedTable[] = [];
    for (const table of this.tables) {
      if ((await run(anyDraftVersion(table, changeset))).length > 0) touched.push(table);
    }
    return touched;
  }

  /** Makes a changeset's rows the layer's statements from `revision`. */
  private async promote(
    run: Run,
    own: string,
    changeset: string,
    revision: bigint,
    tables: readonly RevisionedTable[],
  ): Promise<void> {
    for (const table of tables) {
      for (const statement of publishVersions(table, own, changeset, revision)) {
        await run(statement);
      }
    }
  }

  /** Replaces the base list stored under a changeset. */
  private async storeBaseList(run: Run, changeset: string, list: readonly Pin[]): Promise<void> {
    const b = this.basesTable;
    await run(
      new SqlFragments().text(`DELETE FROM ${b.table} WHERE ${b.changeset_id} = `).value(changeset),
    );
    for (const [position, pin] of list.entries()) {
      await run(
        new SqlFragments()
          .text(
            `INSERT INTO ${b.table} (${b.id}, ${b.changeset_id}, ${b.position}, ` +
              `${b.base_layer_id}, ${b.base_revision}) VALUES (`,
          )
          .valueList([newInternalId(), changeset, position, pin.layer, pin.revision], ", ")
          .text(")"),
      );
    }
  }

  private async pointDraftAt(
    run: Run,
    changeset: string,
    pointer: string | null,
    parent?: bigint,
  ): Promise<void> {
    const c = this.changesetsTable;
    const sql = new SqlFragments().text(`UPDATE ${c.table} SET ${c.bases_changeset} = `);
    if (pointer === null) sql.text("NULL");
    else sql.value(pointer);
    if (parent !== undefined) sql.text(`, ${c.parent_revision} = `).value(parent);
    await run(sql.text(` WHERE ${c.id} = `).value(changeset));
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
    const own = await this.ownLayer(ctx);
    const settled = this.settled(ctx);
    return this.atomic(ctx, async (run) => {
      const row = await this.holdDraftById(run, own, draft);
      if (!row) return { status: "draftNotFound" };
      const held = this.draftOf(row);
      const closed = this.closedAs(row);
      if (closed?.closedAs === "discarded") return closed;
      if (closed) {
        // A draft with no change became no revision: the layer stayed where it was.
        return {
          status: "found",
          value: {
            revision: {
              number: closed.revision ?? held.parent,
              publishedAt: readTimestampColumn(row.published_at),
            },
            changed: closed.revision !== undefined,
          },
        };
      }
      const head = await this.holdLayer(run, own);
      if (head !== held.parent) {
        return { status: "draftStale", parentRevision: held.parent, headRevision: head };
      }
      const stack = await this.stackOfDraft(run, settled, own, held);
      if ((await this.undecided(run, this.scopeOf(stack, held.id))) > 0) {
        return { status: "draftConflicted" };
      }

      // A draft whose only change is its base list is a revision too.
      const touched = await this.touched(run, held.id);
      const changed =
        touched.length > 0 || held.pointer !== (await this.pointerAt(run, settled, own, head));
      let number = head;
      if (changed) {
        number = await this.advanceLayer(run, own);
        await this.promote(run, own, held.id, number, touched);
      }
      const c = this.changesetsTable;
      const actor = request.actor ?? this.self;
      const close = new SqlFragments()
        .text(`UPDATE ${c.table} SET ${c.published_at} = ${this.now}, ${c.published_by_type} = `)
        .value(actor.type)
        .text(`, ${c.published_by_id} = `)
        .value(actor.id);
      if (changed) close.text(`, ${c.revision} = `).value(number);
      if (request.message !== undefined) close.text(`, ${c.message} = `).value(request.message);
      const [published] = await run(
        close.text(` WHERE ${c.id} = `).value(held.id).text(` RETURNING ${c.published_at}`),
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
    const own = await this.ownLayer(ctx);
    return this.atomic(ctx, async (run) => {
      const row = await this.holdDraftById(run, own, draft);
      if (!row) return { status: "draftNotFound" };
      const closed = this.closedAs(row);
      if (closed?.closedAs === "published") return closed;
      if (closed) return { status: "found", value: {} };
      const changeset = String(row.id);
      for (const table of this.tables) await run(discardVersions(table, changeset));
      // A base list of the draft's own goes with it.
      await this.storeBaseList(run, changeset, []);
      const c = this.changesetsTable;
      const actor = request.actor ?? this.self;
      await run(
        new SqlFragments()
          .text(`UPDATE ${c.table} SET ${c.discarded_at} = ${this.now}, ${c.discarded_by_type} = `)
          .value(actor.type)
          .text(`, ${c.discarded_by_id} = `)
          .value(actor.id)
          .text(` WHERE ${c.id} = `)
          .value(changeset),
      );
      return { status: "found", value: {} };
    });
  }

  /**
   * Moves the draft onto the layer's head. The draft's own pin changes are
   * re-applied onto the head's base list — refused, with nothing changed, when
   * the result is no legal stack — and then every statement that no longer
   * stands on what it was written over is reconciled: {@link reconcile}.
   */
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
    | BaseRevisionConflict
    | BaseLimit
  > {
    const own = await this.ownLayer(ctx);
    const settled = this.settled(ctx);
    return this.atomic(ctx, async (run) => {
      const row = await this.holdDraftById(run, own, draft);
      if (!row) return { status: "draftNotFound" };
      const closed = this.closedAs(row);
      if (closed) return closed;
      const held = this.draftOf(row);
      const head = await this.holdLayer(run, own);
      const headPointer = await this.pointerAt(run, settled, own, head);
      let direct = await this.baseList(run, settled, headPointer);
      let pointer = headPointer;
      if (held.pointer === held.id) {
        // The draft moved pins of its own: they are re-applied onto the head's.
        const drafted = await this.baseList(run, false, held.id);
        const parentList = await this.baseList(
          run,
          settled,
          await this.pointerAt(run, settled, own, held.parent),
        );
        const merged = mergeBaseLists(parentList, drafted, direct);
        if (sameBaseList(merged, direct)) {
          await this.storeBaseList(run, held.id, []);
        } else {
          const legal = await this.legalStack(run, settled, own, merged);
          if (isRefusal<MoveRefusal>(legal)) {
            if (legal.status === "baseRevisionConflict" || legal.status === "baseLimit") return legal;
            throw new Error(
              `${this.describe}: rebasing draft '${draft}' would put layer '${this.layer}' ` +
                `beneath itself, which no pin it holds allows.`,
            );
          }
          if (!sameBaseList(merged, drafted)) await this.storeBaseList(run, held.id, merged);
          direct = merged;
          pointer = held.id;
        }
      }
      const stack = await this.stackOver(run, settled, own, head, direct, pointer);
      const scope = this.scopeOf(stack, held.id);
      // The layer's published statements stand on the head's base list; they
      // are walked only when the draft's differs from it.
      const merged = await this.reconcile({ run, own, scope }, pointer !== headPointer);
      const conflicts = await this.undecided(run, scope);
      await this.pointDraftAt(run, held.id, pointer, head);
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
    const own = await this.ownLayer(ctx);
    const c = this.changesetsTable;
    const l = this.layersTable;
    const sql = new SqlFragments()
      .text(
        `SELECT d.${c.public_id}, d.${c.parent_revision}, d.${c.message}, d.${c.created_at}, ` +
          `d.${c.created_by_type}, d.${c.created_by_id}, l.${l.head_revision} ` +
          `FROM ${c.table} d JOIN ${l.table} l ON l.${l.id} = d.${c.layer_id} WHERE d.${c.layer_id} = `,
      )
      .value(own)
      .text(` AND d.${c.published_at} IS NULL AND d.${c.discarded_at} IS NULL`);
    if (after) sql.text(` AND d.${c.public_id} > `).value(after[0]);
    sql.text(` ORDER BY d.${c.public_id} LIMIT `).value(page.limit + 1);
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

  // ── history ──────────────────────────────────────────────────────────────

  async listRevisions(
    request: { readonly order: RevisionOrder; readonly after?: bigint; readonly layer?: string },
    page: GraphPage,
    ctx?: InvokeContext,
  ): Promise<Found<GraphPageResult<RevisionSummary>> | CursorInvalid | LayerNotFound> {
    const tail = page.after === undefined ? undefined : decodeKeyTail(page.after, 1);
    if (page.after !== undefined && (!tail || typeof tail[0] !== "bigint" || tail[0] < 0n)) {
      return { status: "cursorInvalid" };
    }
    const run = this.read(ctx);
    let layer = await this.ownLayer(ctx);
    if (request.layer !== undefined && request.layer !== this.layer) {
      const named = await this.layerNamed(run, request.layer);
      if (!named) return { status: "layerNotFound", layer: request.layer };
      layer = named.id;
    }
    const c = this.changesetsTable;
    const ascending = request.order === "ascending";
    const sql = new SqlFragments()
      .text(
        `SELECT ${c.revision}, ${c.label}, ${c.message}, ${c.published_at}, ` +
          `${c.published_by_type}, ${c.published_by_id}, ${c.bases_changeset} ` +
          `FROM ${c.table} WHERE ${c.layer_id} = `,
      )
      .value(layer)
      .text(` AND ${c.revision} IS NOT NULL`);
    if (request.after !== undefined) sql.text(` AND ${c.revision} > `).value(request.after);
    if (tail) sql.text(` AND ${c.revision} ${ascending ? ">" : "<"} `).value(tail[0]);
    sql.text(` ORDER BY ${c.revision} ${ascending ? "ASC" : "DESC"} LIMIT `).value(page.limit + 1);
    const rows = await run(sql);
    const kept = rows.slice(0, page.limit);
    const settled = this.settled(ctx);
    // A base list is stored once per change, so a page shares few of them.
    const lists = new Map<string | null, readonly PinnedBase[]>();
    const items: RevisionSummary[] = [];
    for (const row of kept) {
      const pointer = textOrNull(row.bases_changeset);
      if (!lists.has(pointer)) {
        const direct = await this.baseList(run, settled, pointer);
        lists.set(pointer, await this.pinned(run, settled, direct));
      }
      items.push({
        number: readInt64Column(row.revision),
        ...(typeof row.label === "string" ? { label: row.label } : {}),
        ...(typeof row.message === "string" ? { message: row.message } : {}),
        publishedAt: readTimestampColumn(row.published_at),
        publishedBy: { type: String(row.published_by_type), id: String(row.published_by_id) },
        bases: lists.get(pointer)!,
      });
    }
    return rows.length > page.limit
      ? { status: "found", value: { items, next: encodeKeyTail([items[items.length - 1].number]) } }
      : { status: "found", value: { items } };
  }

  /**
   * Names a published revision of the layer, for good. One conditional write
   * under the layer's own row, so two labellers are answered by outcomes; the
   * unique index over labelled rows stays the database's guarantee.
   */
  async labelRevision(
    request: { readonly revision: bigint; readonly label: string; readonly actor?: Actor },
    ctx?: InvokeContext,
  ): Promise<
    | Found<{ readonly number: bigint; readonly label: string }>
    | RevisionNotFound
    | RevisionLabelExists
    | RevisionLabelled
  > {
    const settled = this.settled(ctx);
    const { revision, label } = request;
    const actor = request.actor ?? this.self;
    const c = this.changesetsTable;
    return this.atomic(ctx, async (run) => {
      // A layer with no row has no revision to label, and labelling makes none.
      const own = await this.registeredId(run, !settled);
      if (!own) return { status: "revisionNotFound", layer: this.layer, revision };
      await this.holdLayer(run, own);
      const rows = await run(
        new SqlFragments()
          .text(`SELECT ${c.revision}, ${c.label} FROM ${c.table} WHERE ${c.layer_id} = `)
          .value(own)
          .text(` AND (${c.revision} = `)
          .value(revision)
          .text(` OR ${c.label} = `)
          .value(label)
          .text(")"),
      );
      const numbered = rows.find((row) => readInt64Column(row.revision) === revision);
      if (!numbered) return { status: "revisionNotFound", layer: this.layer, revision };
      if (numbered.label === label) return { status: "found", value: { number: revision, label } };
      if (typeof numbered.label === "string") {
        return { status: "revisionLabelled", revision, label: numbered.label };
      }
      const labelled = rows.find((row) => row.label === label);
      if (labelled) {
        return { status: "revisionLabelExists", label, revision: readInt64Column(labelled.revision) };
      }
      await run(
        new SqlFragments()
          .text(`UPDATE ${c.table} SET ${c.label} = `)
          .value(label)
          .text(`, ${c.labelled_at} = ${this.now}, ${c.labelled_by_type} = `)
          .value(actor.type)
          .text(`, ${c.labelled_by_id} = `)
          .value(actor.id)
          .text(` WHERE ${c.layer_id} = `)
          .value(own)
          .text(` AND ${c.revision} = `)
          .value(revision)
          .text(` AND ${c.label} IS NULL`),
      );
      return { status: "found", value: { number: revision, label } };
    });
  }

  // ── bases ────────────────────────────────────────────────────────────────

  /**
   * The stack beneath the layer over a base list, when it is a legal one: no
   * layer at two revisions, the layer itself nowhere beneath, and no more
   * layers than a stack holds. Judged at the pinned revisions, never at heads.
   */
  private async legalStack(
    run: Run,
    settled: boolean,
    own: string,
    direct: readonly Pin[],
  ): Promise<readonly Pin[] | BaseCycle | BaseRevisionConflict | BaseLimit> {
    const parts: Pin[][] = [];
    for (const pin of direct) parts.push([pin, ...(await this.beneathOf(run, settled, pin))]);
    const nameOf = await this.namesOf(
      run,
      settled,
      parts.flat().map((pin) => pin.layer),
    );
    for (const part of parts) {
      if (part.some((pin) => pin.layer === own)) {
        return { status: "baseCycle", layer: nameOf(part[0].layer) };
      }
    }
    const composed = composeStack(parts);
    if ("conflict" in composed) {
      return {
        status: "baseRevisionConflict",
        layer: nameOf(composed.conflict.layer),
        revisions: composed.conflict.revisions,
      };
    }
    if (composed.stack.length + 1 > BASE_STACK_LIMIT) {
      return { status: "baseLimit", limit: BASE_STACK_LIMIT };
    }
    return composed.stack;
  }

  /** The pins a call names, each resolved to a layer and a revision number. */
  private async resolvePins(
    run: Run,
    requests: readonly BasePinRequest[],
  ): Promise<PinMove[] | LayerNotFound | RevisionNotFound | BaseCycle | BaseRevisionConflict> {
    const c = this.changesetsTable;
    const moves: PinMove[] = [];
    const named = new Map<string, bigint>();
    for (const request of requests) {
      // By name, so the answer is the same before the layer has a row.
      if (request.layer === this.layer) return { status: "baseCycle", layer: request.layer };
      const layer = await this.layerNamed(run, request.layer);
      if (!layer) return { status: "layerNotFound", layer: request.layer };
      let revision: bigint;
      if (request.revision === undefined) {
        revision = layer.head;
      } else if (typeof request.revision === "bigint") {
        if (request.revision > layer.head) {
          return { status: "revisionNotFound", layer: request.layer, revision: request.revision };
        }
        revision = request.revision;
      } else {
        const [labelled] = await run(
          new SqlFragments()
            .text(`SELECT ${c.revision} FROM ${c.table} WHERE ${c.layer_id} = `)
            .value(layer.id)
            .text(` AND ${c.label} = `)
            .value(request.revision),
        );
        if (!labelled) {
          return { status: "revisionNotFound", layer: request.layer, revision: request.revision };
        }
        revision = readInt64Column(labelled.revision);
      }
      const before = named.get(request.layer);
      if (before !== undefined) {
        // One layer named twice in one move: it cannot hold both pins.
        return {
          status: "baseRevisionConflict",
          layer: request.layer,
          revisions: before <= revision ? [before, revision] : [revision, before],
        };
      }
      named.set(request.layer, revision);
      moves.push({
        layer: layer.id,
        revision,
        ...(request.position === undefined ? {} : { position: request.position }),
      });
    }
    return moves;
  }

  /**
   * Changes the layer's base list as one move. `next` answers the list wanted
   * from the one in force, or why there is none.
   *
   * Inside a session the list becomes the draft's own and every statement the
   * layer makes — the draft's rows, and the layer's rows the draft does not
   * cover — is reconciled with what now lies beneath it; what clashes stays as
   * conflicts of the draft. Outside one the same runs in a changeset of the
   * store's own, holding the layer, which is published as the next revision —
   * or, when anything is left undecided, is taken back whole, so that nothing
   * was changed.
   */
  private async moveBases<Refusal extends { readonly status: string }>(
    ctx: InvokeContext | undefined,
    next: (run: Run, current: readonly Pin[]) => Promise<readonly Pin[] | Refusal>,
  ): Promise<BasesMoved | Refusal | BaseCycle | BaseRevisionConflict | BaseLimit | DraftConflicted> {
    const session = this.session(ctx);
    const settled = this.settled(ctx);
    return this.atomic(ctx, async (run) => {
      const answer = async (
        list: readonly Pin[],
        merged: number,
        conflicts: number,
      ): Promise<BasesMoved> => ({
        status: "found",
        value: { bases: await this.pinned(run, settled, list), merged, conflicts },
      });

      if (session) {
        const own = await this.layerId(run, !settled, false);
        const draft = await this.holdDraft(run, session);
        const current = await this.baseList(run, settled && draft.pointer !== draft.id, draft.pointer);
        const wanted = await next(run, current);
        if (isRefusal<Refusal>(wanted)) return wanted;
        if (sameBaseList(wanted, current)) return answer(current, 0, 0);
        const legal = await this.legalStack(run, settled, own, wanted);
        if (isRefusal<BaseCycle | BaseRevisionConflict | BaseLimit>(legal)) return legal;
        // A list moved back to the one the draft began from is no change.
        const parentPointer = await this.pointerAt(run, settled, own, draft.parent);
        const back = sameBaseList(wanted, await this.baseList(run, settled, parentPointer));
        await this.storeBaseList(run, draft.id, back ? [] : wanted);
        const pointer = back ? parentPointer : draft.id;
        await this.pointDraftAt(run, draft.id, pointer);
        const stack = await this.stackOver(run, settled, own, draft.parent, wanted, pointer);
        const scope = this.scopeOf(stack, draft.id);
        const merged = await this.reconcile({ run, own, scope }, true);
        return answer(wanted, merged, await this.undecided(run, scope));
      }

      // A layer with no row holds nothing — no bases, revision 0 — and the
      // request is judged against that first: a refusal or a move that changes
      // nothing is answered from there, and only a change registers the layer.
      // The move is then judged again under the layer's row, so a first write
      // that raced this one is seen.
      if (!(await this.registeredId(run, !settled))) {
        const unregistered = newInternalId();
        const wanted = await next(run, []);
        if (isRefusal<Refusal>(wanted)) return wanted;
        if (wanted.length === 0) return answer([], 0, 0);
        const legal = await this.legalStack(run, settled, unregistered, wanted);
        if (isRefusal<BaseCycle | BaseRevisionConflict | BaseLimit>(legal)) return legal;
      }
      const own = await this.layerId(run, !settled, true);
      const head = await this.holdLayer(run, own);
      const headPointer = await this.pointerAt(run, settled, own, head);
      const current = await this.baseList(run, settled, headPointer);
      const wanted = await next(run, current);
      if (isRefusal<Refusal>(wanted)) return wanted;
      if (sameBaseList(wanted, current)) return answer(current, 0, 0);
      const legal = await this.legalStack(run, settled, own, wanted);
      if (isRefusal<BaseCycle | BaseRevisionConflict | BaseLimit>(legal)) return legal;
      const changeset = newInternalId();
      const pointer = wanted.length === 0 ? null : changeset;
      const stack = await this.stackOver(run, settled, own, head, wanted, pointer);
      const scope = this.scopeOf(stack, changeset);
      const merged = await this.reconcile({ run, own, scope }, true);
      if ((await this.undecided(run, scope)) > 0) {
        // Only rows of this changeset were written: taking them back leaves
        // the base list, the head and every read as they were.
        for (const table of this.tables) await run(discardVersions(table, changeset));
        return { status: "draftConflicted" };
      }
      const revision = await this.advanceLayer(run, own);
      await this.promote(run, own, changeset, revision, await this.touched(run, changeset));
      if (pointer !== null) await this.storeBaseList(run, changeset, wanted);
      await this.recordRevision(run, own, changeset, head, revision, pointer);
      return answer(wanted, merged, 0);
    });
  }

  pinBases(
    bases: readonly BasePinRequest[],
    ctx?: InvokeContext,
  ): Promise<
    | BasesMoved
    | LayerNotFound
    | RevisionNotFound
    | BaseCycle
    | BaseRevisionConflict
    | BaseLimit
    | DraftConflicted
  > {
    return this.moveBases<LayerNotFound | RevisionNotFound | BaseCycle | BaseRevisionConflict>(
      ctx,
      async (run, current) => {
        const moves = await this.resolvePins(run, bases);
        return Array.isArray(moves) ? placePins(current, moves) : moves;
      },
    );
  }

  async unpinBase(
    layer: string,
    ctx?: InvokeContext,
  ): Promise<BasesMoved | BaseNotPinned | DraftConflicted> {
    const outcome = await this.moveBases<BaseNotPinned>(ctx, async (run, current) => {
      const named = await this.layerNamed(run, layer);
      if (!named || !current.some((pin) => pin.layer === named.id)) {
        return { status: "baseNotPinned", layer };
      }
      return current.filter((pin) => pin.layer !== named.id);
    });
    if (
      outcome.status === "baseCycle" ||
      outcome.status === "baseRevisionConflict" ||
      outcome.status === "baseLimit"
    ) {
      throw new Error(
        `${this.describe}: removing the pin on '${layer}' left no legal stack, which removing ` +
          `a layer cannot do.`,
      );
    }
    return outcome;
  }

  async listBases(ctx?: InvokeContext): Promise<Found<readonly PinnedBase[]>> {
    const { run, stack } = await this.reading(ctx);
    return { status: "found", value: await this.pinned(run, this.settled(ctx), stack.direct) };
  }

  // ── reconciling ──────────────────────────────────────────────────────────

  private seekPast(table: RevisionedTable, keys: readonly unknown[]): () => SqlFragments {
    return () =>
      new SqlFragments()
        .text(`(${table.identity.map((c) => `r.${c.sql}`).join(", ")}) > (`)
        .valueList(keys, ", ")
        .text(")");
  }

  private valueAssignments(table: RevisionedTable, values: Row): Assignment[] {
    return [...table.properties.values()]
      .filter((column) => column.name in values)
      .map((column) => ({ column, value: values[column.name] ?? null }));
  }

  /** Statements read by one of the two listings, each with the rows it is
   *  judged from: the layer's row as it stands and the one the draft's row was
   *  written over, the row beneath as it stands and the one recorded. A row
   *  that states no value — a removal — is no side of a merge. */
  private async withRows(run: Run, table: RevisionedTable, rows: readonly Row[]): Promise<Candidate[]> {
    const read = rows.map((row) => ({
      row,
      id: String(row[CANDIDATE_ALIASES.row]),
      draft: row[CANDIDATE_ALIASES.state] === DRAFT,
      effect: row[CANDIDATE_ALIASES.effect] as RowEffect,
      over: textOrNull(row[CANDIDATE_ALIASES.over]),
      theirsId: textOrNull(row[CANDIDATE_ALIASES.theirs]),
      beneath: textOrNull(row[CANDIDATE_ALIASES.beneath]),
      beneathNowId: textOrNull(row[CANDIDATE_ALIASES.beneathNow]),
      missing: Number(row[CANDIDATE_ALIASES.missing]) === 1,
      endpointRows: [
        textOrNull(row[CANDIDATE_ALIASES.sourceRow]),
        textOrNull(row[CANDIDATE_ALIASES.targetRow]),
      ],
    }));
    const ids = [
      ...new Set(
        read
          .flatMap((c) => [c.over, c.theirsId, c.beneath, c.beneathNowId])
          .filter((id): id is string => id !== null),
      ),
    ];
    const byId = new Map<string, Row>();
    if (ids.length > 0) {
      for (const row of await run(selectVersionsById(table, ids))) {
        if (row[table.effect.name] === STATED) byId.set(String(row[table.row.name]), row);
      }
    }
    const valued = (id: string | null) => (id === null ? undefined : byId.get(id));
    return read.map((candidate): Candidate => {
      const [theirs, base] = [valued(candidate.theirsId), valued(candidate.over)];
      const [beneathNow, beneathBase] = [valued(candidate.beneathNowId), valued(candidate.beneath)];
      return {
        ...candidate,
        ...(theirs ? { theirs } : {}),
        ...(base ? { base } : {}),
        ...(beneathNow ? { beneathNow } : {}),
        ...(beneathBase ? { beneathBase } : {}),
      };
    });
  }

  /** A draft's conflict candidates. */
  private async candidates(
    run: Run,
    table: RevisionedTable,
    scope: DraftScope,
    narrowing: CandidateNarrowing,
  ): Promise<Candidate[]> {
    const quote = (name: string) => this.connection.dialect.quoteIdentifier(name);
    return this.withRows(run, table, await run(selectCandidates(table, scope, quote, narrowing)));
  }

  /** The layer's statements the changeset leaves standing that no longer stand
   *  on what lies beneath them, or state a relationship with a missing endpoint. */
  private async standingStatements(
    run: Run,
    table: RevisionedTable,
    scope: DraftScope,
    narrowing: Pick<CandidateNarrowing, "identity" | "seek" | "limit">,
  ): Promise<Candidate[]> {
    const quote = (name: string) => this.connection.dialect.quoteIdentifier(name);
    return this.withRows(run, table, await run(selectStanding(table, scope, quote, narrowing)));
  }

  /** The draft's row against the layer's own row, three ways. */
  private merged(table: RevisionedTable, candidate: Candidate): Merge {
    return merge(table.properties, {
      mine: { effect: candidate.effect, row: candidate.row },
      ...(candidate.theirs ? { theirs: candidate.theirs } : {}),
      ...(candidate.base ? { base: candidate.base } : {}),
    });
  }

  /** A statement against what lies beneath it, three ways: the row it recorded
   *  as beneath is the ancestor, the row beneath now the other side. */
  private mergedBeneath(
    table: RevisionedTable,
    mine: { readonly effect: RowEffect; readonly row: Row },
    candidate: Candidate,
  ): Merge {
    return merge(table.properties, {
      mine,
      ...(candidate.beneathNow ? { theirs: candidate.beneathNow } : {}),
      ...(candidate.beneathBase ? { base: candidate.beneathBase } : {}),
    });
  }

  private beneathMoved(candidate: Candidate): boolean {
    return candidate.effect !== RETRACTED && candidate.beneath !== candidate.beneathNowId;
  }

  /**
   * Reconciles one row of the changeset: first with the layer's own row when
   * the layer moved under it, then with what now lies beneath it. What merges
   * is written back — or the row is dropped, or turned into a withdrawal, when
   * nothing is left for it to say — and what clashes is left as it is, a
   * conflict. Answers whether anything was merged.
   */
  private async reconcileDraftRow(
    { run, scope }: Reconciling,
    table: RevisionedTable,
    candidate: Candidate,
  ): Promise<boolean> {
    const identity = table.identity.map((c) => candidate.row[c.name]);
    let mine = { effect: candidate.effect, row: candidate.row };
    let merged = false;
    if (candidate.over !== candidate.theirsId) {
      const outcome = this.merged(table, candidate);
      if (outcome.outcome === "conflict") return false;
      if (outcome.outcome === "drop") {
        await run(deleteDraftVersion(table, scope.changeset, identity));
        return true;
      }
      await run(
        restandDraftVersion(
          table,
          scope.changeset,
          identity,
          { over: candidate.theirsId },
          this.valueAssignments(table, outcome.values ?? {}),
        ),
      );
      if (outcome.values) mine = { effect: mine.effect, row: { ...mine.row, ...outcome.values } };
      merged = true;
    }
    if (!this.beneathMoved(candidate)) return merged;
    const outcome = this.mergedBeneath(table, mine, candidate);
    if (outcome.outcome === "conflict") return merged;
    if (outcome.outcome === "keep") {
      await run(
        restandDraftVersion(
          table,
          scope.changeset,
          identity,
          { beneath: candidate.beneathNowId },
          this.valueAssignments(table, outcome.values ?? {}),
        ),
      );
      return true;
    }
    // Nothing is left to say: the layer's own statement is withdrawn, so the
    // one beneath shows.
    await run(
      candidate.theirsId === null
        ? deleteDraftVersion(table, scope.changeset, identity)
        : updateDraftVersion(
            table,
            scope.changeset,
            identity,
            {
              effect: RETRACTED,
              over: candidate.theirsId,
              beneath: null,
              resolution: null,
              resolvedBy: null,
            },
            [],
          ),
    );
    return true;
  }

  /**
   * Reconciles one statement the layer published and the changeset leaves
   * standing, by a row of the changeset over it: the merged values on the row
   * now beneath, a withdrawal when nothing is left to say, or — for a clash —
   * a copy still recording the old row beneath, so the conflict is one of the
   * changeset's rows. A relationship whose endpoint does not resolve is copied
   * the same way. Answers whether anything was merged.
   */
  private async reconcileStanding(
    { run, own, scope }: Reconciling,
    table: RevisionedTable,
    candidate: Candidate,
  ): Promise<boolean> {
    const copy = (effect: RowEffect, beneath: string | null, values: Row = {}) =>
      run(
        copyVersion(
          table,
          {
            id: newInternalId(),
            layer: own,
            changeset: scope.changeset,
            from: null,
            effect,
            over: candidate.id,
            beneath,
            resolution: null,
            resolvedBy: null,
          },
          candidate.id,
          this.valueAssignments(table, values),
        ),
      );
    if (!this.beneathMoved(candidate)) {
      await copy(candidate.effect, candidate.beneath);
      return false;
    }
    const outcome = this.mergedBeneath(
      table,
      { effect: candidate.effect, row: candidate.row },
      candidate,
    );
    if (outcome.outcome === "conflict") {
      await copy(candidate.effect, candidate.beneath);
      return false;
    }
    if (outcome.outcome === "drop") await copy(RETRACTED, null);
    else await copy(candidate.effect, candidate.beneathNowId, outcome.values);
    return true;
  }

  /**
   * Brings every statement the layer makes in a scope onto what it now stands
   * on, in identity order, in batches. The changeset's rows always; the
   * layer's published statements the changeset does not cover when
   * `walkPublished` — that is, when the scope's base list is not the one those
   * statements were published on.
   *
   * It costs the statements the layer itself makes, one probe of each layer of
   * the stack for each: it never reads what a base holds beyond those probes.
   * Node tables come first, so a relationship is judged against the nodes as
   * they are left. Answers how many statements merged.
   */
  private async reconcile(reconciling: Reconciling, walkPublished: boolean): Promise<number> {
    const { run, scope } = reconciling;
    let merged = 0;
    const drain = async (
      table: RevisionedTable,
      read: (seek?: () => SqlFragments) => Promise<Candidate[]>,
      each: (candidate: Candidate) => Promise<boolean>,
    ) => {
      let after: unknown[] | undefined;
      for (;;) {
        const batch = await read(after ? this.seekPast(table, after) : undefined);
        for (const candidate of batch) if (await each(candidate)) merged += 1;
        if (batch.length < REBASE_BATCH) return;
        after = table.identity.map((c) => batch[batch.length - 1].row[c.name]);
      }
    };
    for (const table of this.tables) {
      await drain(
        table,
        (seek) =>
          this.candidates(run, table, scope, {
            ...(seek ? { seek } : {}),
            limit: REBASE_BATCH,
            movedOnly: true,
          }),
        (candidate) => this.reconcileDraftRow(reconciling, table, candidate),
      );
      if (!walkPublished) continue;
      await drain(
        table,
        (seek) =>
          this.standingStatements(run, table, scope, {
            ...(seek ? { seek } : {}),
            limit: REBASE_BATCH,
          }),
        (candidate) => this.reconcileStanding(reconciling, table, candidate),
      );
    }
    return merged;
  }

  /** After a decision on one identity: brings what the layer now states for it
   *  onto what lies beneath, as {@link reconcile} does for every identity. */
  private async reconcileOne(
    reconciling: Reconciling,
    table: RevisionedTable,
    identity: readonly unknown[],
    walkPublished: boolean,
  ): Promise<void> {
    const { run, scope } = reconciling;
    const [drafted] = await this.candidates(run, table, scope, { identity, movedOnly: true });
    if (drafted) {
      if (drafted.over === drafted.theirsId) await this.reconcileDraftRow(reconciling, table, drafted);
      return;
    }
    if (!walkPublished) return;
    const [standing] = await this.standingStatements(run, table, scope, { identity });
    if (standing) await this.reconcileStanding(reconciling, table, standing);
  }

  // ── conflicts ────────────────────────────────────────────────────────────

  /**
   * What a candidate is. Undefined when it is no conflict. A key has one
   * conflict at a time: the layer's own row having moved is settled before
   * what lies beneath, and a missing endpoint last. The token is drawn from
   * every row either comparison reads, so it stops matching when any moves.
   */
  private judge(table: RevisionedTable, candidate: Candidate): Judged | undefined {
    const endpointMissing = (): Judged | undefined =>
      candidate.missing && candidate.effect === STATED
        ? {
            class: "endpoint-missing",
            token: conflictToken(["e", candidate.id, candidate.over, ...candidate.endpointRows]),
          }
        : undefined;
    if (!candidate.draft) return endpointMissing();
    const rows = [
      candidate.id,
      candidate.over,
      candidate.theirsId,
      candidate.beneath,
      candidate.beneathNowId,
    ];
    if (candidate.over !== candidate.theirsId) {
      const outcome = this.merged(table, candidate);
      if (outcome.outcome !== "conflict") return undefined;
      return {
        class: outcome.class,
        ...(outcome.properties ? { properties: outcome.properties } : {}),
        token: conflictToken(["m", ...rows]),
        against: "layer",
        merge: outcome,
      };
    }
    if (this.beneathMoved(candidate)) {
      const outcome = this.mergedBeneath(
        table,
        { effect: candidate.effect, row: candidate.row },
        candidate,
      );
      if (outcome.outcome === "conflict") {
        return {
          class: outcome.class,
          ...(outcome.properties ? { properties: outcome.properties } : {}),
          token: conflictToken(["b", ...rows]),
          against: "beneath",
          merge: outcome,
        };
      }
    }
    return endpointMissing();
  }

  private async conflicts<T>(
    table: RevisionedTable,
    page: GraphPage,
    ctx: InvokeContext | undefined,
    value: (candidate: Candidate, conflict: Record<string, unknown>) => T,
  ): Promise<Found<GraphPageResult<T>> | CursorInvalid> {
    const session = this.requireSession(ctx, "a conflict listing");
    const tail = this.tailOf(page.after, table.identity.length, session);
    if (tail === "cursorInvalid") return { status: "cursorInvalid" };
    const reading = await this.reading(ctx, tail);
    if (reading === "cursorInvalid") return { status: "cursorInvalid" };
    const { run, stack, pin } = reading;
    const scope = this.scopeOf(stack, session.changeset);
    const rows = await this.candidates(run, table, scope, {
      ...(tail.keys ? { seek: this.seekPast(table, tail.keys) } : {}),
      limit: page.limit + 1,
      ...("sourceColumn" in table
        ? { withdrawn: await this.withdrawnSides(run, session.changeset)(table) }
        : {}),
    });
    const kept = rows.slice(0, page.limit);
    const items: T[] = [];
    for (const candidate of kept) {
      const conflict = this.judge(table, candidate);
      if (!conflict) continue;
      // The other side and the ancestor: the layer's rows, or those beneath.
      const [theirs, base] =
        conflict.against === "beneath"
          ? [candidate.beneathNow, candidate.beneathBase]
          : [candidate.theirs, conflict.against === "layer" ? candidate.base : undefined];
      items.push(
        value(candidate, {
          class: conflict.class,
          ...(conflict.properties ? { properties: conflict.properties } : {}),
          ...(candidate.effect === STATED
            ? { mine: propertiesOf(candidate.row, table.properties) }
            : {}),
          ...(theirs ? { theirs: propertiesOf(theirs, table.properties) } : {}),
          ...(base ? { base: propertiesOf(base, table.properties) } : {}),
          token: conflict.token,
        }),
      );
    }
    return rows.length > page.limit
      ? {
          status: "found",
          value: {
            items,
            next: encodePinnedTail(
              table.identity.map((c) => kept[kept.length - 1].row[c.name]),
              pin,
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
    return this.conflicts(
      node,
      page,
      ctx,
      (candidate, conflict) =>
        ({ key: candidate.row[node.key.name], ...conflict }) as unknown as NodeConflict,
    );
  }

  relationshipConflicts(
    type: GraphRelationshipType,
    page: GraphPage,
    ctx?: InvokeContext,
  ): Promise<Found<GraphPageResult<RelationshipConflict>> | CursorInvalid> {
    const relationship = this.relationship(type);
    return this.conflicts(
      relationship,
      page,
      ctx,
      (candidate, conflict) =>
        ({
          source: candidate.row[relationship.sourceColumn.name],
          target: candidate.row[relationship.targetColumn.name],
          ...conflict,
        }) as unknown as RelationshipConflict,
    );
  }

  /**
   * Decides one conflict. The decision's write names the rows the draft's row
   * stood on when the conflict was read, so it applies only while the conflict
   * is still that one.
   */
  private resolve(
    table: RevisionedTable,
    typeName: string,
    identity: readonly unknown[],
    decision: ConflictDecision,
    ctx: InvokeContext | undefined,
  ): Promise<"applied" | ConflictNotFound | ResolutionInvalid> {
    this.requireSession(ctx, "a conflict resolution");
    const set = namedColumns(this.describe, typeName, table.properties, decision.set ?? {});
    return this.write(ctx, async (writing) => {
      const { run, changeset, stack } = writing;
      const scope = this.scopeOf(stack, changeset);
      const [candidate] = await this.candidates(run, table, scope, { identity });
      const conflict = candidate ? this.judge(table, candidate) : undefined;
      if (!candidate || !conflict) return { status: "conflictNotFound" };
      if (decision.token !== undefined && decision.token !== conflict.token) {
        return { status: "conflictNotFound" };
      }
      const invalid = (reason: string): ResolutionInvalid => ({ status: "resolutionInvalid", reason });
      const resolvedBy = decision.resolvedBy ?? this.self;
      const applied = (rows: readonly Row[]): "applied" | ConflictNotFound => {
        if (rows.length === 0) return { status: "conflictNotFound" };
        writing.changed = true;
        return "applied";
      };
      const whileOn: StoodOn = { over: candidate.over, beneath: candidate.beneath };
      /** The layer's own statement withdrawn in the draft: what it stood over
       *  shows through a retraction, and a row over nothing is dropped. */
      const withdrawn = (over: string | null): SqlFragments =>
        over === null
          ? deleteDraftVersion(table, changeset, identity, whileOn)
          : updateDraftVersion(
              table,
              changeset,
              identity,
              { effect: RETRACTED, over, beneath: candidate.beneath, resolution: "theirs", resolvedBy },
              [],
              whileOn,
            );

      if (!conflict.merge) {
        // An endpoint is missing: the relationship is removed from the draft.
        if (decision.take === "mine") {
          return invalid(
            "'mine' would keep a relationship whose endpoint does not resolve. Restore the " +
              "endpoint node instead, which clears the conflict.",
          );
        }
        if (set.length > 0) {
          return invalid("'set' has no value to apply to: taking 'theirs' removes the relationship.");
        }
        if (!candidate.draft) {
          return applied(
            await run(
              copyVersion(
                table,
                this.newVersion(writing, {
                  effect: RETRACTED,
                  over: candidate.id,
                  beneath: null,
                  resolution: "theirs",
                  resolvedBy,
                }),
                candidate.id,
                [],
              ),
            ),
          );
        }
        return applied(await run(withdrawn(candidate.over)));
      }

      const beneath = conflict.against === "beneath";
      // What a decision leaves stands on the rows the conflict was judged
      // against: the layer's row for a clash with the layer, the row beneath
      // for a clash with what lies beneath.
      const onto = beneath
        ? { over: candidate.over, beneath: candidate.beneathNowId }
        : { over: candidate.theirsId, beneath: candidate.beneath };
      const other = beneath ? candidate.beneathNow : candidate.theirs;
      const taken =
        decision.take === "mine" ? conflict.merge.takingMine : conflict.merge.takingTheirs;
      let outcome: "applied" | ConflictNotFound;
      if (!taken) {
        if (set.length > 0) {
          return invalid(
            `'set' has no value to apply to: ${decision.take === "mine" ? "the draft's" : "the other"} ` +
              `side states none.`,
          );
        }
        // `mine` keeps the draft's removal or withdrawal, now over the other
        // side as it stands; `theirs` accepts that the other side states
        // nothing.
        outcome = applied(
          await run(
            decision.take === "mine"
              ? updateDraftVersion(
                  table,
                  changeset,
                  identity,
                  { effect: candidate.effect, ...onto, resolution: "mine", resolvedBy },
                  [],
                  whileOn,
                )
              : beneath
                ? withdrawn(candidate.over)
                : deleteDraftVersion(table, changeset, identity, whileOn),
          ),
        );
      } else {
        const values: Row = { ...taken };
        for (const assignment of set) values[assignment.column.name] = assignment.value;
        if (decision.take === "theirs" && other && sameProperties(table.properties, values, other)) {
          // Nothing is left for the draft to say about the identity.
          outcome = applied(
            await run(
              beneath
                ? withdrawn(candidate.over)
                : deleteDraftVersion(table, changeset, identity, whileOn),
            ),
          );
        } else {
          outcome = applied(
            await run(
              updateDraftVersion(
                table,
                changeset,
                identity,
                {
                  effect: STATED,
                  ...onto,
                  resolution: set.length > 0 ? "merged" : decision.take,
                  resolvedBy,
                },
                this.valueAssignments(table, values),
                whileOn,
              ),
            ),
          );
        }
      }
      // A clash with the layer is settled first; what the key now states is
      // then brought onto what lies beneath, which may list it again.
      if (outcome === "applied" && !beneath) {
        await this.reconcileOne(
          { run, own: writing.own, scope },
          table,
          identity,
          stack.pointer === changeset,
        );
      }
      return outcome;
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
    const reading = await this.reading(ctx);
    const row = await this.seenRelationship(reading.run, reading.view, relationship, source, target);
    return row
      ? { status: "found", value: relationshipValue(relationship, row, reading.stack.nameOf) }
      : { status: "absent" };
  }
}

export function isRevisionedLayerStore(value: unknown): value is RevisionedLayerStore {
  return value instanceof RevisionedLayerStore;
}

export function register(): void {}

export async function create(
  resource: StoreManifest,
  ctx: ResourceContext,
): Promise<RevisionedLayerStore> {
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

  assertSchemaHoldsTables(ctx, resource.metadata.name, describe, [
    "layers",
    "changesets",
    "changesetBases",
  ]);
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
  const changesets = compileChangesetsTable(describe, resource.changesets, ctx, dialect, schema);
  const bases = compileChangesetBasesTable(describe, resource.changesetBases, ctx, dialect, schema);
  assertTablesDistinct(describe, nodes, relationships, [
    [layers.resource, "layers"],
    [changesets.resource, "changesets"],
    [bases.resource, "changesetBases"],
  ]);
  assertEndpointsListed(describe, nodes, relationships, nameOf);
  return new RevisionedLayerStore(
    describe,
    ctx,
    storeActor(resource.metadata.name),
    connection,
    schema,
    layer,
    nodes,
    relationships,
    layers.compiled,
    changesets.compiled,
    bases.compiled,
  );
}
