import { getRefIdentity, integerInput, type ResourceContext } from "@telorun/sdk";
import { canonicalWhere, cursorInvalid, decodeCursor, encodeCursor, type CursorBinding } from "./graph-cursor.js";
import {
  isGraphNodeType,
  isGraphRelationshipType,
  isGraphStore,
  type GraphFilter,
  type GraphNodeType,
  type CursorInvalid,
  type Found,
  type GraphPage,
  type GraphPageResult,
  type GraphRelationshipType,
  type GraphStore,
} from "./graph-store.js";

/** The name a type or store was declared under, for a message. */
export function declaredName(instance: object): string {
  return getRefIdentity(instance)?.name ?? "(inline)";
}

/**
 * The name a store or type was declared under, as a cursor is bound to it:
 * read from the identity the kernel stamps, and required — a binding never
 * holds a stand-in word.
 */
export function boundName(instance: object, describe: string, slot: string): string {
  const name = getRefIdentity(instance)?.name;
  if (!name) {
    throw new Error(
      `${describe}: '${slot}' holds an instance with no declared name, so a cursor cannot be ` +
        `bound to it. Declare the resource and reference it.`,
    );
  }
  return name;
}

export interface OperationManifest {
  metadata: { name: string; module?: string };
  store?: unknown;
}

export function describeOperation(kind: string, resource: OperationManifest): string {
  return `Graph.${kind} "${resource.metadata.name}"`;
}

export function resolveStore(
  resource: OperationManifest,
  ctx: ResourceContext,
  describe: string,
): GraphStore {
  return ctx.resolveRef(resource.store, isGraphStore, () => `${describe}: 'store'`, "Graph.Store");
}

export function resolveNodeType(
  value: unknown,
  ctx: ResourceContext,
  describe: string,
  field: string,
): GraphNodeType {
  return ctx.resolveRef(value, isGraphNodeType, () => `${describe}: '${field}'`, "Graph.Node");
}

export function resolveRelationshipType(
  value: unknown,
  ctx: ResourceContext,
  describe: string,
  field: string,
): GraphRelationshipType {
  return ctx.resolveRef(
    value,
    isGraphRelationshipType,
    () => `${describe}: '${field}'`,
    "Graph.Relationship",
  );
}

/** The page size a listing takes when its caller names none. */
export const DEFAULT_PAGE_LIMIT = 100;

export interface PagingInputs {
  limit?: unknown;
  cursor?: unknown;
  where?: unknown;
}

/**
 * One listing call: what its cursor is bound to, the page the store is asked
 * for, and how the store's answer becomes the operation's `next`. The subject
 * names the operation kind, the store and the types by declared name only, so
 * one binding holds on every replica of an application.
 */
export class Listing {
  private readonly binding: CursorBinding;
  readonly where: GraphFilter;
  readonly page: GraphPage;

  constructor(
    private readonly describe: string,
    inputs: PagingInputs,
    subject: Readonly<Record<string, unknown>>,
  ) {
    this.where = filterOf(inputs.where);
    this.binding = { ...subject, where: canonicalWhere(this.where) };
    const limit = integerInput(inputs.limit ?? DEFAULT_PAGE_LIMIT);
    if (limit === undefined) {
      throw new Error(`${describe}: 'limit' must be a safe integer, got ${String(inputs.limit)}.`);
    }
    this.page =
      inputs.cursor === undefined || inputs.cursor === null
        ? { limit }
        : { limit, after: decodeCursor(describe, this.binding, inputs.cursor) };
  }

  /** The page as the operation returns it; a refused tail is the caller's
   *  cursor being wrong, whatever the envelope said. */
  result<T>(outcome: Found<GraphPageResult<T>> | CursorInvalid): { items: T[]; next?: string } {
    if (outcome.status === "cursorInvalid") {
      cursorInvalid(this.describe, "is not one this store issued for this listing");
    }
    const { items, next } = outcome.value;
    return next === undefined ? { items } : { items, next: encodeCursor(this.binding, next) };
  }
}

export function filterOf(where: unknown): GraphFilter {
  return (where ?? {}) as GraphFilter;
}

export function propertiesOf(properties: unknown): Record<string, unknown> {
  return (properties ?? {}) as Record<string, unknown>;
}

/** A key as a message quotes it; an int64 from CEL is not JSON. */
export function quoteKey(key: unknown): string {
  return typeof key === "bigint" ? key.toString() : JSON.stringify(key) ?? String(key);
}
