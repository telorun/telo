import type { InvokeContext } from "@telorun/sdk";

/**
 * A node type as a backend's node kind exposes it. `key` is the NAME of the
 * identifying property; everything else about the type is the backend's.
 */
export interface GraphNodeType {
  readonly key: string;
}

/** A relationship type as a backend's relationship kind exposes it: the node
 *  types it joins, as the same instances the store lists. */
export interface GraphRelationshipType {
  readonly source: GraphNodeType;
  readonly target: GraphNodeType;
}

/** A node as every operation returns it: its key, and every other property it
 *  holds. A property with no value is absent rather than null. `origin` is the
 *  layer the value was resolved from, set only by a layered store. */
export interface GraphNodeValue {
  readonly key: unknown;
  readonly properties: Record<string, unknown>;
  readonly origin?: string;
}

/** A relationship as every operation returns it: its endpoints' keys, and every
 *  property of its own. `origin` as on a node. */
export interface GraphRelationshipValue {
  readonly source: unknown;
  readonly target: unknown;
  readonly properties: Record<string, unknown>;
  readonly origin?: string;
}

export const COMPARISON_OPERATORS = ["eq", "ne", "lt", "lte", "gt", "gte"] as const;
export type ComparisonOperator = (typeof COMPARISON_OPERATORS)[number];

/**
 * Operator-first property filter: each operator holds a partial property map,
 * and every comparison is ANDed. `eq` of null matches an absent property, `ne`
 * of null a present one, and no other comparison ever matches an absent one.
 */
export type GraphFilter = Partial<Record<ComparisonOperator, Record<string, unknown>>>;

/**
 * One page of a listing. `after` is the backend's own tail — the `next` of the
 * page before, handed back verbatim; `graph` never reads it.
 */
export interface GraphPage {
  readonly limit: number;
  readonly after?: string;
}

/** The items of one page, in the listing's order, and — only when more exist —
 *  the tail to resume from. */
export interface GraphPageResult<T> {
  readonly items: T[];
  readonly next?: string;
}

export type TraversalDirection = "out" | "in" | "both";

export interface TraversalHop {
  readonly relationship: GraphRelationshipType;
  readonly direction: TraversalDirection;
  readonly minHops: number;
  readonly maxHops: number;
}

/** A traversal as declared: validated by `graph` before a backend sees it, so
 *  its hops chain from `from` to `to` and a repeated hop joins one node type. */
export interface TraversalSpec {
  readonly from: GraphNodeType;
  readonly to: GraphNodeType;
  readonly hops: readonly TraversalHop[];
}

/** A backend's compiled form of one traversal — opaque to `graph`, prepared once
 *  when the operation is created and handed back on every call. */
export interface PreparedTraversal {
  readonly spec: TraversalSpec;
}

export type Found<T> = { readonly status: "found"; readonly value: T };
export type Absent = { readonly status: "absent" };
export type Exists = { readonly status: "exists" };
/** The backend does not accept the tail it was handed. */
export type CursorInvalid = { readonly status: "cursorInvalid" };
export type EndpointAbsent = {
  readonly status: "endpointAbsent";
  readonly endpoint: "source" | "target";
};

/**
 * The contract every graph backend's store implements. Each operation receives
 * the backend's own type instances (the ones its store lists) plus plain values,
 * and returns a value or an OUTCOME — absent, exists, an absent endpoint —
 * never an error code: which code an outcome earns is `graph`'s decision, made
 * once for every backend. A failure that is not an outcome (a lost connection, a
 * constraint the model does not describe) is thrown as it arrives.
 *
 * Every operation is atomic. It joins the caller's transaction when one is open,
 * and otherwise commits on its own, opening a transaction that never outlives
 * the call.
 *
 * A listing — `findNodes`, `findRelationships`, `traverse` — returns at most
 * `page.limit` items in its stated order, resuming strictly after `page.after`,
 * and sets `next` only when more exist. A tail it does not accept is the
 * outcome `cursorInvalid`.
 */
export interface GraphStore {
  readonly nodes: readonly GraphNodeType[];
  readonly relationships: readonly GraphRelationshipType[];

  createNode(
    type: GraphNodeType,
    key: unknown,
    properties: Record<string, unknown>,
    ctx?: InvokeContext,
  ): Promise<Found<GraphNodeValue> | Exists>;
  mergeNode(
    type: GraphNodeType,
    key: unknown,
    properties: Record<string, unknown>,
    ctx?: InvokeContext,
  ): Promise<Found<GraphNodeValue>>;
  updateNode(
    type: GraphNodeType,
    key: unknown,
    properties: Record<string, unknown>,
    ctx?: InvokeContext,
  ): Promise<Found<GraphNodeValue> | Absent>;
  deleteNode(
    type: GraphNodeType,
    key: unknown,
    ctx?: InvokeContext,
  ): Promise<Found<GraphNodeValue> | Absent>;
  getNode(
    type: GraphNodeType,
    key: unknown,
    ctx?: InvokeContext,
  ): Promise<Found<GraphNodeValue> | Absent>;
  findNodes(
    type: GraphNodeType,
    where: GraphFilter,
    page: GraphPage,
    ctx?: InvokeContext,
  ): Promise<Found<GraphPageResult<GraphNodeValue>> | CursorInvalid>;

  createRelationship(
    type: GraphRelationshipType,
    source: unknown,
    target: unknown,
    properties: Record<string, unknown>,
    ctx?: InvokeContext,
  ): Promise<Found<GraphRelationshipValue> | Exists | EndpointAbsent>;
  /** Absent when an endpoint does not exist; which one is not reported. */
  mergeRelationship(
    type: GraphRelationshipType,
    source: unknown,
    target: unknown,
    properties: Record<string, unknown>,
    ctx?: InvokeContext,
  ): Promise<Found<GraphRelationshipValue> | Absent>;
  updateRelationship(
    type: GraphRelationshipType,
    source: unknown,
    target: unknown,
    properties: Record<string, unknown>,
    ctx?: InvokeContext,
  ): Promise<Found<GraphRelationshipValue> | Absent>;
  deleteRelationship(
    type: GraphRelationshipType,
    source: unknown,
    target: unknown,
    ctx?: InvokeContext,
  ): Promise<Found<GraphRelationshipValue> | Absent>;
  findRelationships(
    type: GraphRelationshipType,
    endpoints: { readonly source?: unknown; readonly target?: unknown },
    where: GraphFilter,
    page: GraphPage,
    ctx?: InvokeContext,
  ): Promise<Found<GraphPageResult<GraphRelationshipValue>> | CursorInvalid>;

  /** Compile one traversal. Called once, when the operation is created, and
   *  never performs I/O. */
  prepareTraversal(spec: TraversalSpec): PreparedTraversal;
  /** Absent when the start node does not exist. */
  traverse(
    prepared: PreparedTraversal,
    key: unknown,
    where: GraphFilter,
    page: GraphPage,
    ctx?: InvokeContext,
  ): Promise<Found<GraphPageResult<GraphNodeValue>> | Absent | CursorInvalid>;
}

export function isGraphStore(value: unknown): value is GraphStore {
  const store = value as GraphStore | undefined;
  return (
    !!store &&
    Array.isArray(store.nodes) &&
    Array.isArray(store.relationships) &&
    typeof store.createNode === "function" &&
    typeof store.traverse === "function" &&
    typeof store.prepareTraversal === "function"
  );
}

export function isGraphNodeType(value: unknown): value is GraphNodeType {
  return !!value && typeof (value as GraphNodeType).key === "string";
}

export function isGraphRelationshipType(value: unknown): value is GraphRelationshipType {
  const type = value as GraphRelationshipType | undefined;
  return !!type && isGraphNodeType(type.source) && isGraphNodeType(type.target);
}
