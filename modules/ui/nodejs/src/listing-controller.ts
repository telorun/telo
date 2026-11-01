import { RuntimeError, type ResourceContext, type ResourceInstance, type RuntimeResource } from "@telorun/sdk";
import { isComposite, mergeAssets, type AssetFile, type Provided, type SpecNode } from "./composite.js";
import { presentationAt } from "./collection-presentation.js";
import { modelSchema, type JsonSchema } from "./model-schema.js";
import { resolveNode, type AuthoredNode } from "./node-resolution.js";
import type { Binding, StyleRule } from "./row-binding.js";
import { pendingRowAction, providedRowActions, type RowActionConfig } from "./row-actions.js";
import { word } from "./spec-texts.js";
import { dialogSpec, isSurface } from "./surface-spec.js";
import { isLayout, type LayoutAnswer, type LayoutInputs } from "./listing-layout.js";
import { tableLayout } from "./table-layout.js";

/** How a form is opened. A member holding nothing is one left out. */
interface OpenerConfig {
  form: unknown;
  surface?: unknown;
  afterSubmit?: string | null;
  unsaved?: string | null;
}

type ListingResource = RuntimeResource & {
  presentation: unknown;
  model: unknown;
  filters?: Record<string, Binding> | null;
  query?: Record<string, JsonSchema> | null;
  pageSize?: number | bigint | null;
  paging?: string | null;
  rowStyle?: StyleRule | null;
  create?: OpenerConfig | null;
  edit?: OpenerConfig | null;
  delete?: boolean | null;
  rowActions?: RowActionConfig[] | null;
  empty?: AuthoredNode | null;
  layout?: unknown;
  compact?: unknown;
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
    const { basePath, collection, relations } = presentationAt(resource.presentation, this.ctx, owner);
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
    const part = async (value: unknown, slot: string): Promise<SpecNode | undefined> => {
      const provided = await this.ctx.resolveRef(value, isComposite, () => `'${slot}' of ${owner}`, "Ui.Composite").provide();
      assets.push(provided.assets);
      return provided.node;
    };
    const opener = async (config: OpenerConfig | null | undefined, slot: string) => {
      if (config == null) return undefined;
      const form = await part(config.form, `${slot}.form`);
      if (!form) return undefined;
      const surface =
        config.surface == null
          ? dialogSpec()
          : await this.ctx.resolveRef(config.surface, isSurface, () => `'${slot}.surface' of ${owner}`, "Ui.Surface").provide();
      return { form, surface, afterSubmit: config.afterSubmit ?? "close", unsaved: config.unsaved ?? "confirm" };
    };
    const pending = (resource.rowActions ?? []).map((entry, index) => pendingRowAction(entry, this.ctx, owner, `rowActions[${index}]`));
    const { rowActions, assets: actionAssets } = await providedRowActions(pending);
    assets.push(...actionAssets);
    const create = await opener(resource.create, "create");
    const edit = await opener(resource.edit, "edit");
    const written = resource.empty == null ? undefined : await resolveNode(resource.empty, this.ctx, `${owner} empty`);
    if (written) assets.push(written.assets);
    const node: SpecNode = {
      type: "listing",
      schema,
      basePath,
      key: collection.key,
      query: resource.query ?? {},
      ...(resource.filters ? { filters: resource.filters } : {}),
      pageSize: Number(resource.pageSize ?? 25),
      paging: resource.paging ?? "pages",
      sort: collection.query.sort.map((sort) => sort.property),
      ...(resource.rowStyle ? { rowStyle: resource.rowStyle } : {}),
      ...(create ? { create } : {}),
      ...(edit ? { edit } : {}),
      delete: resource.delete === true,
      rowActions,
      relations,
      empty: written?.node ?? { type: "text", text: word("noRows") },
      layout: layout.spec!,
      ...(compact ? { compact: compact.spec! } : {}),
    };
    return { node, assets: mergeAssets(...assets) };
  }
}

export async function create(resource: ListingResource, ctx: ResourceContext): Promise<ResourceInstance> {
  return new Listing(resource, ctx);
}
