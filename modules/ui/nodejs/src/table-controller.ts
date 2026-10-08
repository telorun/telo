import { RuntimeError, type ResourceContext, type ResourceInstance, type RuntimeResource } from "@telorun/sdk";
import { isCollection, type CollectionQuery } from "./collection-controller.js";
import { isComposite, mergeAssets, type AssetFile, type Provided, type SpecNode } from "./composite.js";
import { labelOf, modelSchema, propertiesOf, schemaAt, type JsonSchema } from "./model-schema.js";
import { isChain, type Binding, type StyleRule } from "./row-binding.js";
import { dialogSpec, isSurface } from "./surface-spec.js";

interface ColumnConfig {
  header?: string;
  value?: Binding;
  cell?: unknown;
  style?: StyleRule;
}

type TableResource = RuntimeResource & {
  model: unknown;
  collection: unknown;
  source: { basePath: string; filters?: Record<string, string | number | boolean> };
  rowKey?: string;
  columns?: ColumnConfig[];
  pageSize?: number;
  rowStyle?: StyleRule;
  create?: OpenerConfig;
  edit?: OpenerConfig;
  delete?: boolean;
};

/** How a form is opened. A member holding nothing is one left out. */
interface OpenerConfig {
  form: unknown;
  surface?: unknown;
  afterSubmit?: string;
  unsaved?: string;
}

export interface ValueColumn {
  header: string;
  value: Binding;
  sort?: string;
  present?: JsonSchema;
  style?: StyleRule;
}

/** What the model says about a value, which decides how a cell shows it. */
function presentation(target: JsonSchema | undefined): JsonSchema | undefined {
  if (!target) return undefined;
  const present: JsonSchema = {};
  for (const key of ["type", "format"]) if (target[key] !== undefined) present[key] = target[key];
  return Object.keys(present).length > 0 ? present : undefined;
}

/**
 * A column showing a value. Its header and how its cells are shown come from
 * the model property the value names, and it sorts where the collection lists
 * that property, so a column written by hand and one derived from the model
 * are the same column.
 */
export function valueColumn(
  schema: JsonSchema,
  sortable: CollectionQuery["sort"],
  column: { header?: string; value: Binding; style?: StyleRule },
): ValueColumn {
  const { value, style } = column;
  if (!isChain(value)) {
    return { header: column.header ?? "", value, ...(style ? { style } : {}) };
  }
  const target = schemaAt(schema, value.path);
  const last = value.path[value.path.length - 1];
  const present = presentation(target);
  return {
    header: column.header ?? (last === undefined ? "" : labelOf(last, target)),
    value,
    ...(value.path.length === 1 && sortable.some((sort) => sort.property === last) ? { sort: last } : {}),
    ...(present ? { present } : {}),
    ...(style ? { style } : {}),
  };
}

/** One column per model property, in declaration order. The row key names a
 *  row and is not shown. */
export function derivedColumns(schema: JsonSchema, sortable: CollectionQuery["sort"], rowKey: string): ValueColumn[] {
  return propertiesOf(schema)
    .filter(([name]) => name !== rowKey)
    .map(([name]) => valueColumn(schema, sortable, { value: { root: "row", path: [name] } }));
}

class Table implements ResourceInstance {
  constructor(
    private readonly resource: TableResource,
    private readonly ctx: ResourceContext,
  ) {}

  async provide(): Promise<Provided> {
    const resource = this.resource;
    const owner = `Ui.Table '${resource.metadata.name}'`;
    const schema = modelSchema(resource.model, this.ctx, owner);
    const rowKey = resource.rowKey ?? "id";
    const { query } = this.ctx.resolveRef(resource.collection, isCollection, () => `'collection' of ${owner}`, "Ui.Collection");
    for (const property of Object.keys(resource.source.filters ?? {})) {
      if (!Object.hasOwn(schema.properties ?? {}, property)) {
        throw new RuntimeError(
          "ERR_UI_SOURCE_FILTER_UNKNOWN_PROPERTY",
          `${owner}: 'source.filters.${property}' filters its source by a property the row model does not declare. Use a property of 'model', or add this one to it.`,
        );
      }
      if (!query.filters.some((filter) => filter.property === property && filter.operator === "eq")) {
        throw new RuntimeError(
          "ERR_UI_SOURCE_FILTER_NOT_ACCEPTED",
          `${owner}: 'source.filters.${property}' filters its source by a property the collection does not accept an equality on. Declare it with operator 'eq' under the collection's 'query.filters', or remove this filter.`,
        );
      }
    }
    const assets: AssetFile[][] = [];
    const part = async (value: unknown, slot: string): Promise<SpecNode | undefined> => {
      const provided = await this.ctx
        .resolveRef(value, isComposite, () => `'${slot}' of ${owner}`, "Ui.Composite")
        .provide();
      assets.push(provided.assets);
      return provided.node;
    };
    const columns: Record<string, unknown>[] = [];
    for (const [index, column] of (resource.columns ?? []).entries()) {
      if (column.value !== undefined) {
        columns.push({ ...valueColumn(schema, query.sort, { ...column, value: column.value }) });
        continue;
      }
      const cell = await part(column.cell, `columns[${index}].cell`);
      if (!cell) continue;
      columns.push({ header: column.header ?? "", cell, ...(column.style ? { style: column.style } : {}) });
    }
    const opener = async (config: OpenerConfig | undefined, slot: string) => {
      if (config === undefined) return undefined;
      const form = await part(config.form, `${slot}.form`);
      if (!form) return undefined;
      const surface =
        config.surface === undefined
          ? dialogSpec()
          : await this.ctx
              .resolveRef(config.surface, isSurface, () => `'${slot}.surface' of ${owner}`, "Ui.Surface")
              .provide();
      return { form, surface, afterSubmit: config.afterSubmit ?? "close", unsaved: config.unsaved ?? "confirm" };
    };
    const create = await opener(resource.create, "create");
    const edit = await opener(resource.edit, "edit");
    const node: SpecNode = {
      type: "table",
      schema,
      basePath: resource.source.basePath,
      ...(resource.source.filters ? { filters: resource.source.filters } : {}),
      rowKey,
      pageSize: Number(resource.pageSize ?? 25),
      columns: resource.columns ? columns : derivedColumns(schema, query.sort, rowKey),
      ...(resource.rowStyle ? { rowStyle: resource.rowStyle } : {}),
      ...(create ? { create } : {}),
      ...(edit ? { edit } : {}),
      delete: resource.delete === true,
    };
    return { node, assets: mergeAssets(...assets) };
  }
}

export async function create(resource: TableResource, ctx: ResourceContext): Promise<ResourceInstance> {
  return new Table(resource, ctx);
}
