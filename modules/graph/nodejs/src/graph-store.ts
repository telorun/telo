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
 *  holds. A property with no value is absent rather than null. */
export interface GraphNodeValue {
  readonly key: unknown;
  readonly properties: Record<string, unknown>;
}

/** A relationship as every operation returns it: its endpoints' keys, and every
 *  property of its own. */
export interface GraphRelationshipValue {
  readonly source: unknown;
  readonly target: unknown;
  readonly properties: Record<string, unknown>;
}

export const COMPARISON_OPERATORS = ["eq", "ne", "lt", "lte", "gt", "gte"] as const;
export type ComparisonOperator = (typeof COMPARISON_OPERATORS)[number];

/**
 * Operator-first property filter: each operator holds a partial property map,
 * and every comparison is ANDed. `eq` of null matches an absent property, `ne`
 * of null a present one, and no other comparison ever matches an absent one.
 */
export type GraphFilter = Partial<Record<ComparisonOperator, Record<string, unknown>>>;

export interface GraphPage {
  readonly limit?: number;
  readonly offset?: number;
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
 * Every write joins whatever transaction is ambient on the caller's context and
 * opens none of its own.
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
  ): Promise<GraphNodeValue[]>;

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
  ): Promise<GraphRelationshipValue[]>;

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
  ): Promise<Found<GraphNodeValue[]> | Absent>;
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
