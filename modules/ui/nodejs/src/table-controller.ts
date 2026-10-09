import { RuntimeError, type ResourceContext, type ResourceInstance, type RuntimeResource } from "@telorun/sdk";
import { isCollection, type CollectionQuery } from "./collection-controller.js";
import { isComposite, mergeAssets, type AssetFile, type Provided, type SpecNode } from "./composite.js";
import { isAction } from "./action-controller.js";
import {
  headerOf,
  modelSchema,
  modelShape,
  presentation,
  propertiesOf,
  schemaAt,
  type JsonSchema,
  type Shape,
  type ShapeReader,
} from "./model-schema.js";
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
  rowActions?: RowActionConfig[];
};

/** An operation a row offers. A member holding nothing is one left out. */
interface RowActionConfig {
  action: unknown;
  inputs: Record<string, Binding>;
  confirm?: string;
}

/** Why a row's inputs cannot make a record of the action's input model: a key
 *  a closed model does not declare, a required input left unbound, a fixed
 *  value its property refuses. A path into the row is typed by `telo check`
 *  alone. */
function rowActionInputProblems(schema: JsonSchema, inputs: Record<string, Binding>, ctx: ResourceContext): string[] {
  const properties = (schema.properties ?? {}) as Record<string, JsonSchema>;
  const problems: string[] = [];
  for (const [name, binding] of Object.entries(inputs)) {
    if (!Object.hasOwn(properties, name)) {
      if (schema.additionalProperties === false) problems.push(`'${name}' is not a property of the action's input model`);
      continue;
    }
    if (isChain(binding)) continue;
    // Beside the model's own definitions, which the property may reference.
    const validator = ctx.createSchemaValidator({
      allOf: [properties[name]],
      $defs: schema.$defs,
      definitions: schema.definitions,
    });
    try {
      validator.validate(binding.value);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      problems.push(`'${name}' holds a value its property refuses (${error.message})`);
    }
  }
  for (const required of (Array.isArray(schema.required) ? schema.required : []) as string[]) {
    if (!Object.hasOwn(inputs, required)) problems.push(`required input '${required}' is not bound`);
  }
  return problems;
}

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

/**
 * A column showing a value. Its header and how its cells are shown come from
 * the model property the value names, and it sorts where the collection lists
 * that property, so a column written by hand and one derived from the model
 * are the same column.
 */
export function valueColumn(
  model: Shape,
  reader: ShapeReader,
  sortable: CollectionQuery["sort"],
  column: { header?: string; value: Binding; style?: StyleRule },
): ValueColumn {
  const { value, style } = column;
  if (!isChain(value)) {
    return { header: column.header ?? "", value, ...(style ? { style } : {}) };
  }
  const target = schemaAt(model, value.path, reader, "model");
  const last = value.path[value.path.length - 1];
  const present = presentation(target);
  return {
    header: column.header ?? (last === undefined ? "" : headerOf(last, target)),
    value,
    ...(value.path.length === 1 && sortable.some((sort) => sort.property === last) ? { sort: last } : {}),
    ...(present ? { present } : {}),
    ...(style ? { style } : {}),
  };
}

/** One column per model property, in declaration order. The row key names a
 *  row and is not shown. */
export function derivedColumns(
  schema: JsonSchema,
  reader: ShapeReader,
  sortable: CollectionQuery["sort"],
  rowKey: string,
): ValueColumn[] {
  const model = modelShape(schema, reader, "model");
  return propertiesOf(schema)
    .filter(([name]) => name !== rowKey)
    .map(([name]) => valueColumn(model, reader, sortable, { value: { root: "row", path: [name] } }));
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
    const reader = { ctx: this.ctx, owner };
    const model = modelShape(schema, reader, "model");
    const columns: Record<string, unknown>[] = [];
    for (const [index, column] of (resource.columns ?? []).entries()) {
      if (column.value !== undefined) {
        columns.push({ ...valueColumn(model, reader, query.sort, { ...column, value: column.value }) });
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
    const rowActions: Record<string, unknown>[] = [];
    for (const [index, entry] of (resource.rowActions ?? []).entries()) {
      const where = `rowActions[${index}]`;
      const operation = this.ctx
        .resolveRef(entry.action, isAction, () => `'${where}.action' of ${owner}`, "Ui.Action")
        .operation();
      if (operation.drawsLists) {
        throw new RuntimeError(
          "ERR_UI_ROW_ACTION_DRAWS_LISTS",
          `${owner}: '${where}' offers in a row an action that draws lists from its answer, and a row has nowhere to draw them. Declare an action without 'lists' for the row.`,
        );
      }
      const problems = rowActionInputProblems(operation.schema, entry.inputs, this.ctx);
      if (problems.length > 0) {
        throw new RuntimeError(
          "ERR_UI_ROW_ACTION_INPUTS_INVALID",
          `${owner}: '${where}.inputs' cannot make a record of the action's input model: ${problems.join("; ")}.`,
        );
      }
      rowActions.push({
        path: operation.path,
        label: operation.label,
        inputs: entry.inputs,
        ...(entry.confirm != null ? { confirm: entry.confirm } : {}),
      });
    }
    const create = await opener(resource.create, "create");
    const edit = await opener(resource.edit, "edit");
    const node: SpecNode = {
      type: "table",
      schema,
      basePath: resource.source.basePath,
      ...(resource.source.filters ? { filters: resource.source.filters } : {}),
      rowKey,
      pageSize: Number(resource.pageSize ?? 25),
      columns: resource.columns ? columns : derivedColumns(schema, reader, query.sort, rowKey),
      ...(resource.rowStyle ? { rowStyle: resource.rowStyle } : {}),
      ...(create ? { create } : {}),
      ...(edit ? { edit } : {}),
      rowActions,
      delete: resource.delete === true,
    };
    return { node, assets: mergeAssets(...assets) };
  }
}

export async function create(resource: TableResource, ctx: ResourceContext): Promise<ResourceInstance> {
  return new Table(resource, ctx);
}
