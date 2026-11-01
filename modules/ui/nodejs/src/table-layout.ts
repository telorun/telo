import type { ResourceContext, ResourceInstance, RuntimeResource, TextRecord } from "@telorun/sdk";
import { isComposite, mergeAssets, type AssetFile } from "./composite.js";
import type { LayoutAnswer, LayoutInputs, LayoutInstance } from "./listing-layout.js";
import { headerOf, modelShape, presentation, propertiesOf, schemaAt, shapeLabels, type JsonSchema, type Shape, type ShapeReader } from "./model-schema.js";
import { isChain, type Binding, type StyleRule } from "./row-binding.js";
import { schemaText, type ValueLabel } from "./spec-texts.js";

export interface ColumnConfig {
  header?: TextRecord;
  value?: Binding;
  cell?: unknown;
  style?: StyleRule;
}

export interface ValueColumn {
  header: TextRecord;
  value: Binding;
  sort?: string;
  relation?: string;
  present?: JsonSchema;
  labels: ValueLabel[];
  style?: StyleRule;
}

/**
 * A column showing a value. Its header and how its cells are shown come from
 * the model property the value names; it sorts where the collection lists that
 * property, and is labelled through a relation where the listing presents one
 * for it — so a column written by hand and one derived from the model are the
 * same column.
 */
export function valueColumn(
  model: Shape,
  reader: ShapeReader,
  inputs: LayoutInputs,
  column: { header?: TextRecord; value: Binding; style?: StyleRule },
): ValueColumn {
  const { value, style } = column;
  if (!isChain(value)) {
    return { header: column.header ?? schemaText("", null), value, labels: [], ...(style ? { style } : {}) };
  }
  const target = schemaAt(model, value.path, reader, "model");
  const last = value.path[value.path.length - 1];
  const present = presentation(target);
  const own = value.path.length === 1 ? last : undefined;
  return {
    header: column.header ?? headerOf(last ?? "", target),
    value,
    ...(own !== undefined && inputs.collection.query.sort.some((sort) => sort.property === own) ? { sort: own } : {}),
    ...(own !== undefined && Object.hasOwn(inputs.relations, own) ? { relation: own } : {}),
    ...(present ? { present } : {}),
    labels: shapeLabels(target),
    ...(style ? { style } : {}),
  };
}

/**
 * The table a listing draws: the columns listed — a value, or a component in
 * its place — or one per model property but the collection's key, in
 * declaration order. A listing with no `layout` draws exactly this with no
 * columns listed.
 */
export async function tableLayout(
  columns: ColumnConfig[] | undefined | null,
  inputs: LayoutInputs,
  ctx: ResourceContext,
  owner: string,
): Promise<LayoutAnswer> {
  const reader = { ctx, owner };
  const model = modelShape(inputs.model, reader, "model");
  const assets: AssetFile[][] = [];
  const drawn: Record<string, unknown>[] = [];
  if (!columns) {
    for (const [name] of propertiesOf(inputs.model)) {
      if (name !== inputs.collection.key) drawn.push({ ...valueColumn(model, reader, inputs, { value: { root: "row", path: [name] } }) });
    }
  } else {
    for (const [index, column] of columns.entries()) {
      if (column.value != null) {
        drawn.push({ ...valueColumn(model, reader, inputs, { ...column, value: column.value }) });
        continue;
      }
      const provided = await ctx
        .resolveRef(column.cell, isComposite, () => `'columns[${index}].cell' of ${owner}`, "Ui.Composite")
        .provide();
      assets.push(provided.assets);
      if (!provided.node) continue;
      drawn.push({
        header: column.header ?? schemaText("", null),
        labels: [],
        cell: provided.node,
        ...(column.style ? { style: column.style } : {}),
      });
    }
  }
  return { problems: [], spec: { type: "table", columns: drawn, reads: {} }, assets: mergeAssets(...assets) };
}

type TableLayoutResource = RuntimeResource & { columns?: ColumnConfig[] | null };

export async function create(resource: TableLayoutResource, ctx: ResourceContext): Promise<ResourceInstance & LayoutInstance> {
  const owner = `Ui.TableLayout '${resource.metadata.name}'`;
  return { invoke: (inputs: LayoutInputs) => tableLayout(resource.columns, inputs, ctx, owner) };
}
