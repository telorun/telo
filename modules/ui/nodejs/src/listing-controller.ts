import { RuntimeError, type ResourceContext, type ResourceInstance, type RuntimeResource } from "@telorun/sdk";
import { mergeAssets, type AssetFile, type Provided, type SpecNode } from "./composite.js";
import { namedForm } from "./query-controller.js";
import { presentationAt } from "./collection-presentation.js";
import { modelSchema, type JsonSchema } from "./model-schema.js";
import { resolveNode, type AuthoredNode } from "./node-resolution.js";
import type { Binding, StyleRule } from "./row-binding.js";
import { pendingMutationCall, providedMutationCalls, type MutationCallConfig } from "./mutation-calls.js";
import { uiText } from "./spec-texts.js";
import { isLayout, type LayoutAnswer, type LayoutInputs } from "./listing-layout.js";
import { tableLayout } from "./table-layout.js";
import { filledProvided } from "./fill-marking.js";
import { reloadEveryOf } from "./timed-reload.js";
import { defaultedPressSpec, pressSpec, type PressConfig } from "./press.js";

type ListingResource = RuntimeResource & {
  presentation: unknown;
  model: unknown;
  form?: unknown;
  filters?: Record<string, Binding> | null;
  query?: Record<string, JsonSchema> | null;
  pageSize?: number | bigint | null;
  paging?: string | null;
  sort?: { by?: { property: string; direction?: string | null } | null; choosable?: boolean | null } | null;
  show?: { count?: boolean | null } | null;
  rowActionsDisplay?: string | null;
  rowStyle?: StyleRule | null;
  create?: { to: unknown; label?: unknown } | null;
  edit?: { to: unknown; label?: unknown } | null;
  delete?: boolean | null;
  rowActions?: MutationCallConfig[] | null;
  press?: PressConfig | null;
  empty?: AuthoredNode | null;
  layout?: unknown;
  compact?: unknown;
  /** A `Telo.Duration`, decoded by the kernel. */
  reloadEvery?: unknown;
};

class Listing implements ResourceInstance {
  constructor(
    private readonly resource: ListingResource,
    private readonly ctx: ResourceContext,
  ) {}

  /** The layout at a slot, called with the listing's inputs; an omitted
   *  `layout` is the table with every default, as `{ kind: Ui.TableLayout }`. */
  private async layout(slot: "layout" | "compact", inputs: LayoutInputs, owner: string): Promise<LayoutAnswer | undefined> {
    const value = this.resource[slot];
    if (value == null) return slot === "layout" ? tableLayout(undefined, inputs, this.ctx, owner) : undefined;
    const answer = await this.ctx.resolveRef(value, isLayout, () => `'${slot}' of ${owner}`, "Ui.ListingLayout").invoke(inputs);
    const [problem] = answer.problems;
    if (problem) throw new RuntimeError(`ERR_${problem.code}`, `${owner}: '${slot}' ${problem.message}`);
    if (!answer.spec) {
      throw new RuntimeError(
        "ERR_OUTPUT_INVALID",
        `${owner}: '${slot}' answered no layout and named no problem. A layout answers a spec whenever it can draw the listing.`,
      );
    }
    return answer;
  }

  async provide(): Promise<Provided> {
    const resource = this.resource;
    const owner = `Ui.Listing '${resource.metadata.name}'`;
    const schema = modelSchema(resource.model, this.ctx, owner);
    const { basePath, collection, relations } = await presentationAt(resource.presentation, this.ctx, owner);
    for (const property of Object.keys(resource.filters ?? {})) {
      if (!Object.hasOwn(schema.properties ?? {}, property)) {
        throw new RuntimeError(
          "ERR_UI_SOURCE_FILTER_UNKNOWN_PROPERTY",
          `${owner}: 'filters.${property}' filters its source by a property the row model does not declare. Use a property of 'model', or add this one to it.`,
        );
      }
      if (!collection.query.filters.some((filter) => filter.property === property && filter.operator === "eq")) {
        throw new RuntimeError(
          "ERR_UI_SOURCE_FILTER_NOT_ACCEPTED",
          `${owner}: 'filters.${property}' filters its source by a property the collection does not accept an equality on. Declare it with operator 'eq' under the collection's 'query.filters', or remove this filter.`,
        );
      }
    }
    const by = resource.sort?.by;
    if (by && !collection.query.sort.some((sort) => sort.property === by.property)) {
      throw new RuntimeError(
        "ERR_UI_LISTING_SORT_NOT_ACCEPTED",
        `${owner}: 'sort.by' starts sorted by '${by.property}', which the collection does not accept a sort on. Declare it under the collection's 'query.sort', or change 'sort.by'.`,
      );
    }
    const choosable = resource.sort?.choosable !== false;
    const inputs: LayoutInputs = {
      model: schema,
      collection: {
        model: collection.model,
        key: collection.key,
        query: collection.query,
        ...(collection.identity ? { identity: collection.identity } : {}),
        relations: collection.relations,
      },
      relations,
    };
    const assets: AssetFile[][] = [];
    const layout = (await this.layout("layout", inputs, owner))!;
    const compact = await this.layout("compact", inputs, owner);
    assets.push(layout.assets, compact?.assets ?? []);
    const pending = (resource.rowActions ?? []).map((entry, index) => pendingMutationCall(entry, this.ctx, owner, `rowActions[${index}]`, "call"));
    const { entries: rowActions, assets: actionAssets } = await providedMutationCalls(pending);
    assets.push(...actionAssets);
    const create = await defaultedPressSpec(resource.create, "create", this.ctx, owner, "create");
    const edit = await defaultedPressSpec(resource.edit, "edit", this.ctx, owner, "edit");
    const press = (await pressSpec(resource.press, this.ctx, owner)) ?? edit;
    const written = resource.empty == null ? undefined : await resolveNode(resource.empty, this.ctx, `${owner} empty`);
    if (written) assets.push(written.assets);
    const node: SpecNode = {
      type: "listing",
      schema,
      basePath,
      key: collection.key,
      query: resource.query ?? {},
      form: namedForm(resource.form, this.ctx, owner)?.id ?? null,
      ...(resource.filters ? { filters: resource.filters } : {}),
      pageSize: Number(resource.pageSize ?? 25),
      paging: resource.paging ?? "pages",
      sort: {
        sortable: choosable ? collection.query.sort.map((sort) => sort.property) : [],
        initial: by ? `${by.direction === "descending" ? "-" : ""}${by.property}` : null,
      },
      show: { count: resource.show?.count !== false },
      ...(resource.rowStyle ? { rowStyle: resource.rowStyle } : {}),
      create,
      edit,
      delete: resource.delete === true,
      rowActions,
      rowActionsDisplay: resource.rowActionsDisplay ?? "auto",
      relations,
      empty: written?.node ?? { type: "text", text: uiText("noRows") },
      layout: layout.spec!,
      ...(compact ? { compact: compact.spec! } : {}),
      press,
      ...reloadEveryOf(resource.reloadEvery),
    };
    return filledProvided({ node, assets: mergeAssets(...assets) });
  }
}

export async function create(resource: ListingResource, ctx: ResourceContext): Promise<ResourceInstance> {
  return new Listing(resource, ctx);
}
