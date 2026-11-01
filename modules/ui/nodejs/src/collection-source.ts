import {
  getRefIdentity,
  refSentinelTarget,
  RuntimeError,
  type ResourceContext,
  type ResourceInstance,
  type RuntimeResource,
} from "@telorun/sdk";
import type { JsonSchema } from "./model-schema.js";

export type Operator = "eq" | "contains" | "gt" | "gte" | "lt" | "lte" | "in" | "absent";

/** What a collection's list request accepts. */
export interface AcceptedQuery {
  filters: { property: string; operator: Operator }[];
  sort: { property: string }[];
  facets: { property: string }[];
}

/** Which declaration a collection is: its name in the module declaring it. */
export interface CollectionIdentity {
  name: string;
  module?: string;
}

/** A collection as a screen reads it: its record shape, key and accepted query
 *  as it publishes them, and the target of each relation it declares — unknown
 *  where the relation names it through an import the reader cannot follow. */
export interface CollectionFacts {
  identity?: CollectionIdentity;
  model: JsonSchema;
  key: string;
  query: AcceptedQuery;
  relations: Record<string, { target?: CollectionIdentity }>;
}

export interface CollectionSourceInstance {
  readonly basePath: string;
  collection(): CollectionFacts;
}

export function isCollectionSource(candidate: unknown): candidate is CollectionSourceInstance {
  const source = candidate as CollectionSourceInstance | null;
  return typeof source?.basePath === "string" && typeof source.collection === "function";
}

export const sameCollection = (a: CollectionIdentity, b: CollectionIdentity): boolean => a.name === b.name && a.module === b.module;

type Reference = { name: string; alias?: string };

/** The name a reference value carries: a resolved reference or a `!ref` sentinel. */
function referenceOf(value: unknown): Reference | undefined {
  const written = value as { __ref?: unknown; name?: unknown; alias?: unknown } | null;
  if (written && typeof written === "object" && written.__ref === true && typeof written.name === "string") {
    return { name: written.name, ...(typeof written.alias === "string" ? { alias: written.alias } : {}) };
  }
  return refSentinelTarget(value);
}

type Declaration = RuntimeResource & { relations?: Record<string, { collection?: unknown }> };

/** What a collection publishes: `model`, `key` and `query`. */
interface CollectionReading {
  model: { schema: JsonSchema };
  key: string;
  query: Partial<AcceptedQuery>;
}

interface PublishingInstance {
  snapshot(): unknown;
}

const isPublishing = (candidate: unknown): candidate is PublishingInstance =>
  typeof (candidate as PublishingInstance | null)?.snapshot === "function";

function isReading(value: unknown): value is CollectionReading {
  const reading = value as CollectionReading | null;
  return (
    typeof reading?.key === "string" &&
    reading.model !== null &&
    typeof reading.model?.schema === "object" &&
    Array.isArray(reading.query?.filters)
  );
}

type CollectionSourceResource = RuntimeResource & { collection: unknown; basePath: string };

class CollectionSource implements ResourceInstance, CollectionSourceInstance {
  readonly basePath: string;
  private facts?: CollectionFacts;

  constructor(
    private readonly resource: CollectionSourceResource,
    private readonly ctx: ResourceContext,
    /** The reference as written, read before injection replaces it. */
    private readonly written: Reference | undefined,
  ) {
    this.basePath = resource.basePath;
  }

  /** The declarations lookup, which the relation checks a source feeds need. */
  private lookup(owner: string): NonNullable<ResourceContext["resolveDeclaredManifest"]> {
    const lookup = this.ctx.resolveDeclaredManifest?.bind(this.ctx);
    if (!lookup) {
      throw new RuntimeError(
        "ERR_CONTROLLER_HOST_INCOMPATIBLE",
        `${owner}: this host cannot read declarations, which reading the collection's relations needs.`,
      );
    }
    return lookup;
  }

  private declaration(instance: object, owner: string): Declaration | undefined {
    const reference = this.written ?? (getRefIdentity(instance) ? { name: getRefIdentity(instance)!.name } : undefined);
    if (!reference) return undefined;
    return this.lookup(owner)(reference.name, reference.alias) as Declaration | undefined;
  }

  collection(): CollectionFacts {
    if (this.facts) return this.facts;
    const owner = `Ui.CollectionSource '${this.resource.metadata.name}'`;
    const instance = this.ctx.resolveRef(
      this.resource.collection,
      isPublishing,
      () => `'collection' of ${owner}`,
      "DataModel.Collection",
    );
    const reading = instance.snapshot();
    if (!isReading(reading)) {
      throw new RuntimeError(
        "ERR_REF_UNRESOLVED",
        `${owner}: 'collection' publishes no record model, key and accepted query. Point it at a collection.`,
      );
    }
    const declared = this.declaration(instance as object, owner);
    const module = declared?.metadata?.module as string | undefined;
    // A relation's reference is written in the collection's module, so an alias
    // is that module's import, resolved where the collection was declared.
    const targetOf = (value: unknown): CollectionIdentity | undefined => {
      const reference = referenceOf(value);
      if (!reference) return undefined;
      if (reference.alias === undefined || reference.alias === "Self") return { name: reference.name, module };
      const target = this.lookup(owner)(reference.name, reference.alias, declared);
      return target ? { name: target.metadata.name, module: target.metadata.module as string | undefined } : undefined;
    };
    return (this.facts = {
      ...(declared ? { identity: { name: declared.metadata.name, module } } : {}),
      model: reading.model.schema,
      key: reading.key,
      query: { filters: reading.query.filters ?? [], sort: reading.query.sort ?? [], facets: reading.query.facets ?? [] },
      relations: Object.fromEntries(
        Object.entries(declared?.relations ?? {}).map(([property, entry]) => {
          const target = targetOf(entry?.collection);
          return [property, target ? { target } : {}];
        }),
      ),
    });
  }

  init(): void {
    this.collection();
  }

  snapshot(): Record<string, unknown> {
    return { basePath: this.basePath };
  }
}

export async function create(resource: CollectionSourceResource, ctx: ResourceContext): Promise<ResourceInstance> {
  return new CollectionSource(resource, ctx, referenceOf(resource.collection));
}
