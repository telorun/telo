import type { ResourceContext, ResourceInstance, RuntimeResource } from "@telorun/sdk";
import type { AddressSpec } from "./address-expansion.js";
import { addressSpec, type AddressConfig } from "./address-spec.js";
import { modelSchema, type JsonSchema } from "./model-schema.js";
import { reloadEveryOf } from "./timed-reload.js";

type Reload = "focus" | "unauthorized";

/** What an accessor-template field arrives as: a chain, a fixed value, or a map
 *  or list of them. */
export type BodyBinding =
  | { root: string; path: string[] }
  | { value: unknown }
  | { map: Record<string, BodyBinding> }
  | { list: BodyBinding[] };

/** One query as a renderer receives it, every member present. */
export interface QuerySpec {
  /** The declaration's identity: nodes drawing the same query share one read. */
  id: string;
  schema: JsonSchema;
  method: "GET" | "QUERY" | "POST";
  url: AddressSpec;
  input: { body: BodyBinding } | null;
  query: Record<string, JsonSchema>;
  reloadOn: Reload[];
  /** Milliseconds; absent when the read is not repeated. */
  reloadEvery?: number;
}

export interface QueryInstance {
  provide(): Promise<QuerySpec>;
  /** The same spec, known once the query is created. */
  spec(): QuerySpec;
}

export function isQuery(candidate: unknown): candidate is QueryInstance {
  const query = candidate as Partial<QueryInstance> | null;
  return typeof query?.provide === "function" && typeof query.spec === "function";
}

type QueryResource = RuntimeResource & {
  model: unknown;
  url: AddressConfig;
  input?: { method?: "QUERY" | "POST" | null; model: unknown; body: BodyBinding } | null;
  query?: Record<string, JsonSchema> | null;
  reloadOn?: Reload[] | null;
  /** A `Telo.Duration`, decoded by the kernel. */
  reloadEvery?: unknown;
};

/** Where an inline declaration was written, as the loader stamps it. */
interface Origin {
  parentName?: unknown;
  pathFromParent?: unknown;
}

/**
 * A query's identity, qualified by its module: a named one's `<module>/<name>`,
 * an inline one's `<module>/<holder>/<path>` (`Web/web/pages/0/children/1/query`).
 */
export function queryId(metadata: { name: string; module?: unknown; xTeloOrigin?: Origin }): string {
  const origin = metadata.xTeloOrigin;
  const local = typeof origin?.parentName !== "string" || typeof origin.pathFromParent !== "string"
    ? metadata.name
    : [origin.parentName, ...origin.pathFromParent.replace(/\[(\d+)\]/g, ".$1").split(".").filter((segment) => segment !== "")].join("/");
  return typeof metadata.module === "string" ? `${metadata.module}/${local}` : local;
}

/** A read declared once and drawn by any number of nodes. */
class Query implements ResourceInstance, QueryInstance {
  private readonly reading: QuerySpec;

  constructor(resource: QueryResource, ctx: ResourceContext) {
    const owner = `Ui.Query '${resource.metadata.name}'`;
    const input = resource.input;
    this.reading = {
      id: queryId(resource.metadata as { name: string; module?: unknown; xTeloOrigin?: Origin }),
      schema: modelSchema(resource.model, ctx, owner),
      method: input == null ? "GET" : (input.method ?? "QUERY"),
      url: addressSpec(resource.url, ctx, `${owner} url`),
      input: input == null ? null : { body: input.body },
      query: resource.query ?? {},
      reloadOn: resource.reloadOn ?? [],
      ...reloadEveryOf(resource.reloadEvery),
    };
  }

  spec(): QuerySpec {
    return this.reading;
  }

  async provide(): Promise<QuerySpec> {
    return this.reading;
  }
}

export async function create(resource: QueryResource, ctx: ResourceContext): Promise<ResourceInstance> {
  return new Query(resource, ctx);
}
