import { RuntimeError, type ResourceContext, type RuntimeResource } from "@telorun/sdk";
import type { AcceptedQuery, JsonSchema, RelationTarget } from "./collection-types.js";

/** A collection as its resource declares it, its references read. */
export interface CollectionDeclaration {
  model: JsonSchema;
  key: string;
  query: AcceptedQuery;
  relations: Record<string, RelationTarget>;
}

type CollectionResource = RuntimeResource & {
  model?: unknown;
  key?: string;
  query?: Partial<AcceptedQuery>;
  relations?: Record<string, { collection?: unknown }>;
};

export const DEFAULT_KEY = "id";

/** The JSON Schema a shape slot names — a live shape, a reference the registry
 *  holds, or a schema written in place. */
function modelSchema(model: unknown, ctx: ResourceContext, owner: string, slot: string): JsonSchema {
  if (model && typeof model === "object") {
    const value = model as Record<string, any>;
    if (value.schema && typeof value.schema === "object") return value.schema;
    const key = typeof value.$ref === "string" ? value.$ref : value.name;
    if (typeof key === "string") {
      const found = ctx.lookupSchema(key);
      if (found) return found as JsonSchema;
    } else if (value.type || value.properties) {
      return value;
    }
  }
  throw new RuntimeError("ERR_REF_UNRESOLVED", `${owner}: '${slot}' does not name a data shape.`);
}

function target(entry: { collection?: unknown }, ctx: ResourceContext, owner: string, property: string): RelationTarget {
  const slot = `relations.${property}.collection`;
  const ref = entry.collection as { name?: unknown; alias?: unknown } | undefined;
  if (!ctx.resolveDeclaredManifest) {
    throw new RuntimeError(
      "ERR_CONTROLLER_HOST_INCOMPATIBLE",
      `${owner}: this host cannot read declarations, which reading '${slot}' needs.`,
    );
  }
  const declared =
    ref && typeof ref.name === "string"
      ? (ctx.resolveDeclaredManifest(ref.name, typeof ref.alias === "string" ? ref.alias : undefined) as
          | CollectionResource
          | undefined)
      : undefined;
  if (!declared) throw new RuntimeError("ERR_REF_UNRESOLVED", `${owner}: '${slot}' does not name a collection declaration.`);
  return {
    model: modelSchema(declared.model, ctx, owner, `${slot} model`),
    key: declared.key ?? DEFAULT_KEY,
    query: { filters: declared.query?.filters ?? [] },
  };
}

/** Reads a collection's own model and query and every relation's target
 *  declaration — the inputs of `collectionProblems`. */
export function readCollection(resource: CollectionResource, ctx: ResourceContext, owner: string): CollectionDeclaration {
  return {
    model: modelSchema(resource.model, ctx, owner, "model"),
    key: resource.key ?? DEFAULT_KEY,
    query: {
      filters: resource.query?.filters ?? [],
      sort: resource.query?.sort ?? [],
      facets: resource.query?.facets ?? [],
    },
    relations: Object.fromEntries(
      Object.entries(resource.relations ?? {}).map(([property, entry]) => [property, target(entry, ctx, owner, property)]),
    ),
  };
}
