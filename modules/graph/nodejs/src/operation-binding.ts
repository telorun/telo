import { getRefIdentity, integerInput, type ResourceContext } from "@telorun/sdk";
import {
  isGraphNodeType,
  isGraphRelationshipType,
  isGraphStore,
  type GraphFilter,
  type GraphNodeType,
  type GraphPage,
  type GraphRelationshipType,
  type GraphStore,
} from "./graph-store.js";

/** The name a type or store was declared under, for a message. */
export function declaredName(instance: object): string {
  return getRefIdentity(instance)?.name ?? "(inline)";
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

/** The paging inputs, as the contract admits them (an integer, possibly an
 *  int64 from CEL). */
export function pageOf(inputs: { limit?: unknown; offset?: unknown }, describe: string): GraphPage {
  return { limit: optionalInteger(inputs.limit, "limit", describe), offset: optionalInteger(inputs.offset, "offset", describe) };
}

function optionalInteger(value: unknown, field: string, describe: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  const integer = integerInput(value);
  if (integer === undefined) {
    throw new Error(`${describe}: '${field}' must be a safe integer, got ${String(value)}.`);
  }
  return integer;
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
