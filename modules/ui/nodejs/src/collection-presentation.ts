import { RuntimeError, type ResourceContext, type ResourceInstance, type RuntimeResource } from "@telorun/sdk";
import { isCollectionSource, sameCollection, type CollectionFacts, type Operator } from "./collection-source.js";
import type { OptionSourceSpec } from "./option-source.js";
import type { Binding } from "./row-binding.js";

/** One relation entry as written. A member holding nothing is one left out. */
interface RelationConfig {
  source: unknown;
  label: Binding;
  hint?: Binding | null;
  href?: Binding | null;
  search?: { property: string; operator: Operator } | null;
  pageSize?: number | bigint | null;
}

type CollectionPresentationResource = RuntimeResource & {
  source: unknown;
  relations?: Record<string, RelationConfig> | null;
};

/** A collection as one set of screens shows it: where it is read from, what it
 *  is, and where each related record is read and labelled from, by property. */
export interface Presentation {
  basePath: string;
  collection: CollectionFacts;
  relations: Record<string, OptionSourceSpec>;
}

export interface PresentationInstance {
  presentation(): Presentation;
}

export function isPresentation(candidate: unknown): candidate is PresentationInstance {
  return typeof (candidate as PresentationInstance | null)?.presentation === "function";
}

/** Reads the presentation a `presentation` slot names. */
export function presentationAt(value: unknown, ctx: ResourceContext, owner: string): Presentation {
  return ctx
    .resolveRef(value, isPresentation, () => `'presentation' of ${owner}`, "Ui.CollectionPresentation")
    .presentation();
}

class CollectionPresentation implements ResourceInstance, PresentationInstance {
  private read?: Presentation;

  constructor(
    private readonly resource: CollectionPresentationResource,
    private readonly ctx: ResourceContext,
  ) {}

  presentation(): Presentation {
    if (this.read) return this.read;
    const owner = `Ui.CollectionPresentation '${this.resource.metadata.name}'`;
    const sourceOf = (value: unknown, slot: string) =>
      this.ctx.resolveRef(value, isCollectionSource, () => `'${slot}' of ${owner}`, "Ui.CollectionSource");
    const source = sourceOf(this.resource.source, "source");
    const collection = source.collection();
    const relations: Record<string, OptionSourceSpec> = {};
    for (const [property, entry] of Object.entries(this.resource.relations ?? {})) {
      const at = `${owner}: 'relations.${property}'`;
      const declared = collection.relations[property];
      if (!declared) {
        throw new RuntimeError(
          "ERR_UI_RELATION_UNDECLARED",
          `${at} presents a relation the collection does not declare. Declare it under the collection's 'relations', or remove this entry.`,
        );
      }
      const related = sourceOf(entry.source, `relations.${property}.source`);
      const target = related.collection();
      if (declared.target && target.identity && !sameCollection(declared.target, target.identity)) {
        throw new RuntimeError(
          "ERR_UI_RELATION_TARGET_MISMATCH",
          `${at} reads related records from a source whose collection ('${target.identity.name}') is not the relation's target ('${declared.target.name}'). Point 'source' at a source of the collection the relation names.`,
        );
      }
      const search = entry.search ?? undefined;
      if (search && !target.query.filters.some((f) => f.property === search.property && f.operator === search.operator)) {
        throw new RuntimeError(
          "ERR_UI_RELATION_SEARCH_NOT_ACCEPTED",
          `${at} searches related records with a property and operator their collection does not accept ('${search.operator}' on '${search.property}'). Declare the pair under that collection's 'query.filters', or change 'search'.`,
        );
      }
      relations[property] = {
        type: "collection",
        schema: target.model,
        value: { root: "row", path: [target.key] },
        label: entry.label,
        ...(entry.hint != null ? { hint: entry.hint } : {}),
        ...(entry.href != null ? { href: entry.href } : {}),
        basePath: related.basePath,
        filters: {},
        pageSize: Number(entry.pageSize ?? 25),
        ...(search ? { search } : {}),
      };
    }
    return (this.read = { basePath: source.basePath, collection, relations });
  }

  init(): void {
    this.presentation();
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

export async function create(resource: CollectionPresentationResource, ctx: ResourceContext): Promise<ResourceInstance> {
  return new CollectionPresentation(resource, ctx);
}
