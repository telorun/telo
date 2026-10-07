import { RuntimeError, type ResourceContext, type ResourceInstance, type RuntimeResource } from "@telorun/sdk";
import { isComposite, mergeAssets, type AssetFile, type Provided, type SpecNode } from "./composite.js";
import { isScalar, labelOf, modelSchema, propertiesOf, schemaAt, type JsonSchema } from "./model-schema.js";
import { isChain, type Binding, type StyleRule } from "./row-binding.js";

interface ColumnConfig {
  header?: string;
  value?: Binding;
  cell?: unknown;
  style?: StyleRule;
}

type TableResource = RuntimeResource & {
  model: unknown;
  source: { basePath: string; filters?: Record<string, string | number | boolean> };
  rowKey?: string;
  columns?: ColumnConfig[];
  pageSize?: number;
  rowStyle?: StyleRule;
  create?: unknown;
  edit?: unknown;
  delete?: boolean;
};

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
 * A column showing a value. Its header, how its cells are shown and whether it
 * sorts all come from the model property the value names, so a column written
 * by hand and one derived from the model are the same column.
 */
export function valueColumn(schema: JsonSchema, column: { header?: string; value: Binding; style?: StyleRule }): ValueColumn {
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
    ...(value.path.length === 1 && target && isScalar(target) ? { sort: last } : {}),
    ...(present ? { present } : {}),
    ...(style ? { style } : {}),
  };
}

/** One column per model property, in declaration order. */
export function derivedColumns(schema: JsonSchema): ValueColumn[] {
  return propertiesOf(schema).map(([name]) => valueColumn(schema, { value: { root: "row", path: [name] } }));
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
    for (const property of Object.keys(resource.source.filters ?? {})) {
      if (!(property in (schema.properties ?? {}))) {
        throw new RuntimeError(
          "ERR_UI_SOURCE_FILTER_UNKNOWN_PROPERTY",
          `${owner}: 'source.filters.${property}' filters its source by a property the row model does not declare. Use a property of 'model', or add this one to it.`,
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
        columns.push({ ...valueColumn(schema, { ...column, value: column.value }) });
        continue;
      }
      const cell = await part(column.cell, `columns[${index}].cell`);
      if (!cell) continue;
      columns.push({ header: column.header ?? "", cell, ...(column.style ? { style: column.style } : {}) });
    }
    const create = resource.create === undefined ? undefined : await part(resource.create, "create");
    const edit = resource.edit === undefined ? undefined : await part(resource.edit, "edit");
    const node: SpecNode = {
      type: "table",
      schema,
      basePath: resource.source.basePath,
      ...(resource.source.filters ? { filters: resource.source.filters } : {}),
      rowKey: resource.rowKey ?? "id",
      pageSize: Number(resource.pageSize ?? 25),
      columns: resource.columns ? columns : derivedColumns(schema),
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
