import { RuntimeError, type ResourceContext, type ResourceInstance, type RuntimeResource } from "@telorun/sdk";
import type { AddressSpec } from "./address-expansion.js";
import { addressSpec, referenceOf, type AddressConfig } from "./address-spec.js";
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
  /** The id of the form whose settled record the url and body read as `form`; null when none. */
  form: string | null;
  reloadOn: Reload[];
  /** Milliseconds; absent when the read is not repeated. */
  reloadEvery?: number;
}

export interface QueryInstance {
  provide(): Promise<QuerySpec>;
  /** The same spec, known once the query is created. */
  spec(): QuerySpec;
  /** The shape of the form it names, which `form` reads in the trees drawing it. */
  formShape(): JsonSchema | undefined;
}

export function isQuery(candidate: unknown): candidate is QueryInstance {
  const query = candidate as Partial<QueryInstance> | null;
  return typeof query?.provide === "function" && typeof query.spec === "function";
}

type QueryResource = RuntimeResource & {
  model: unknown;
  form?: unknown;
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

/** What a declaration naming a form holds: its identity and its model. */
export interface NamedForm {
  id: string;
  schema: JsonSchema;
}

/**
 * The form a `form` slot names, read from its declaration — a form is named,
 * never held, so a query and the form it follows may sit anywhere; null where
 * none is named.
 */
export function namedForm(value: unknown, ctx: ResourceContext, owner: string): NamedForm | null {
  if (value == null) return null;
  const reference = referenceOf(value);
  const lookup = ctx.resolveDeclaredManifest?.bind(ctx);
  if (!lookup) {
    throw new RuntimeError(
      "ERR_CONTROLLER_HOST_INCOMPATIBLE",
      `${owner}: this host cannot read declarations, which resolving the form a 'form' names needs.`,
    );
  }
  const declared = reference && (lookup(reference.name, reference.alias) as { metadata?: unknown; model?: unknown } | undefined);
  if (!declared?.metadata || declared.model === undefined) {
    throw new RuntimeError("ERR_REF_UNRESOLVED", `${owner}: 'form' names no form. Point it at a Ui.Form.`);
  }
  return {
    id: queryId(declared.metadata as Parameters<typeof queryId>[0]),
    schema: modelSchema(declared.model, ctx, owner),
  };
}

/** A read declared once and drawn by any number of nodes. */
class Query implements ResourceInstance, QueryInstance {
  private readonly reading: QuerySpec;
  private readonly followed: NamedForm | null;

  constructor(resource: QueryResource, ctx: ResourceContext) {
    const owner = `Ui.Query '${resource.metadata.name}'`;
    const input = resource.input;
    this.followed = namedForm(resource.form, ctx, owner);
    this.reading = {
      id: queryId(resource.metadata as { name: string; module?: unknown; xTeloOrigin?: Origin }),
      schema: modelSchema(resource.model, ctx, owner),
      method: input == null ? "GET" : (input.method ?? "QUERY"),
      url: addressSpec(resource.url, ctx, `${owner} url`),
      input: input == null ? null : { body: input.body },
      query: resource.query ?? {},
      form: this.followed?.id ?? null,
      reloadOn: resource.reloadOn ?? [],
      ...reloadEveryOf(resource.reloadEvery),
    };
  }

  spec(): QuerySpec {
    return this.reading;
  }

  formShape(): JsonSchema | undefined {
    return this.followed?.schema;
  }

  async provide(): Promise<QuerySpec> {
    return this.reading;
  }
}

export async function create(resource: QueryResource, ctx: ResourceContext): Promise<ResourceInstance> {
  return new Query(resource, ctx);
}
