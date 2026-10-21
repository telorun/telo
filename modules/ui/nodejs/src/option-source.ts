import { RuntimeError, type ResourceContext, type ResourceInstance, type RuntimeResource } from "@telorun/sdk";
import { isCollection, type Operator } from "./collection-controller.js";
import { modelSchema, type JsonSchema } from "./model-schema.js";
import { isChain, type Binding } from "./row-binding.js";

/** Where a field's options come from, as a renderer receives it. */
export interface OptionSourceSpec {
  type: string;
  schema: JsonSchema;
  value: Binding;
  label: Binding;
  hint?: Binding;
  href?: Binding;
  [key: string]: unknown;
}

export interface OptionSourceInstance {
  provide(): Promise<OptionSourceSpec>;
}

export function isOptionSource(candidate: unknown): candidate is OptionSourceInstance {
  return typeof (candidate as OptionSourceInstance | null)?.provide === "function";
}

type CollectionOptionsResource = RuntimeResource & {
  model: unknown;
  value: Binding;
  label: Binding;
  hint?: Binding | null;
  href?: Binding | null;
  collection: unknown;
  source: { basePath: string; filters?: Record<string, Binding> | null };
  search?: { property: string; operator: Operator } | null;
  pageSize?: number | bigint | null;
};

class CollectionOptions implements ResourceInstance, OptionSourceInstance {
  constructor(
    private readonly resource: CollectionOptionsResource,
    private readonly ctx: ResourceContext,
  ) {}

  async provide(): Promise<OptionSourceSpec> {
    const resource = this.resource;
    const owner = `Ui.CollectionOptions '${resource.metadata.name}'`;
    const schema = modelSchema(resource.model, this.ctx, owner);
    const { query } = this.ctx.resolveRef(resource.collection, isCollection, () => `'collection' of ${owner}`, "Ui.Collection");
    const accepts = (property: string, operator: Operator) =>
      query.filters.some((filter) => filter.property === property && filter.operator === operator);
    const filters = resource.source.filters ?? {};
    for (const property of Object.keys(filters)) {
      if (!Object.hasOwn(schema.properties ?? {}, property)) {
        throw new RuntimeError(
          "ERR_UI_SOURCE_FILTER_UNKNOWN_PROPERTY",
          `${owner}: 'source.filters.${property}' filters its source by a property the option model does not declare. Use a property of 'model', or add this one to it.`,
        );
      }
      if (!accepts(property, "eq")) {
        throw new RuntimeError(
          "ERR_UI_SOURCE_FILTER_NOT_ACCEPTED",
          `${owner}: 'source.filters.${property}' filters its source by a property the collection does not accept an equality on. Declare it with operator 'eq' under the collection's 'query.filters', or remove this filter.`,
        );
      }
    }
    const search = resource.search ?? undefined;
    if (search && !accepts(search.property, search.operator)) {
      throw new RuntimeError(
        "ERR_UI_OPTION_SEARCH_NOT_ACCEPTED",
        `${owner}: 'search' searches with a property and operator the collection does not accept ('${search.operator}' on '${search.property}'). Declare the pair under the collection's 'query.filters', or change 'search'.`,
      );
    }
    const value = resource.value;
    if (!isChain(value) || value.root !== "row" || value.path.length !== 1 || !accepts(value.path[0], "in")) {
      throw new RuntimeError(
        "ERR_UI_OPTION_VALUE_NOT_FILTERABLE",
        `${owner}: 'value' yields a value no request can look options up by: 'value' must be a property of the record, read as 'row.<property>', that the collection accepts with operator 'in', so a chosen value is labelled by one request.`,
      );
    }
    return {
      type: "collection",
      schema,
      value,
      label: resource.label,
      ...(resource.hint != null ? { hint: resource.hint } : {}),
      ...(resource.href != null ? { href: resource.href } : {}),
      basePath: resource.source.basePath,
      filters,
      pageSize: Number(resource.pageSize ?? 25),
      ...(search ? { search } : {}),
    };
  }
}

export async function create(resource: CollectionOptionsResource, ctx: ResourceContext): Promise<ResourceInstance> {
  return new CollectionOptions(resource, ctx);
}
