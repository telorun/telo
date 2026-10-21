import type { ResourceContext } from "@telorun/sdk";
import {
  isComposite,
  mergeAssets,
  mergeStyles,
  type AssetFile,
  type Provided,
  type SpecNode,
  type Style,
} from "./composite.js";
import { headerOf, itemsOf, presentation, schemaAt, shapeLabels, type Shape, type ShapeReader } from "./model-schema.js";
import { isChain, type Binding, type Condition } from "./row-binding.js";
import { pendingRowAction, providedRowActions, type PendingRowAction, type RowActionConfig } from "./row-actions.js";

/** A `Ui.Node` as its author wrote it, references already live. */
export interface AuthoredNode {
  type: string;
  when?: boolean;
  shown?: Condition | null;
  style?: Style;
  children?: AuthoredNode[];
  ref?: unknown;
  [key: string]: unknown;
}

/** What each root a tree may read is declared as, by name — what presents the
 *  values its `value` and `list` nodes name. */
export type RootShapes = Readonly<Record<string, Shape | undefined>>;

export const NO_ROOTS: RootShapes = {};

/**
 * Turn an authored node into the node a renderer receives: a node whose
 * `when:` is false is left out, a composite is replaced by what it provides,
 * containers resolve their children in order, and a `value` or `list` node
 * carries what its roots say about the values it names. `undefined` means the
 * node is omitted — switched off, or a composite that provided none.
 */
export async function resolveNode(
  node: AuthoredNode,
  ctx: ResourceContext,
  where: string,
  roots: RootShapes = NO_ROOTS,
): Promise<Provided | undefined> {
  if (node.when === false) return undefined;
  const reader: ShapeReader = { ctx, owner: where };
  if (node.type === "composite") {
    const composite = ctx.resolveRef(
      node.ref,
      isComposite,
      () => `'ref' of the composite node at ${where}`,
      "Ui.Composite",
    );
    const provided = await composite.provide();
    // A composite with nothing to show is left out, like a node switched off.
    if (!provided.node) return undefined;
    return { node: placed(provided.node, node), assets: provided.assets };
  }
  if (!Array.isArray(node.children)) {
    const { when, ...leaf } = presented(node, roots, reader, where);
    if (!Array.isArray(leaf.rowActions)) return { node: leaf as SpecNode, assets: [] };
    const { rowActions, assets } = await providedRowActions(leaf.rowActions as PendingRowAction[]);
    return { node: { ...leaf, rowActions } as SpecNode, assets: mergeAssets(...assets) };
  }
  const children: SpecNode[] = [];
  const assets: AssetFile[][] = [];
  for (const [index, child] of node.children.entries()) {
    const resolved = await resolveNode(child, ctx, `${where}.children[${index}]`, roots);
    if (!resolved?.node) continue;
    children.push(resolved.node);
    assets.push(resolved.assets);
  }
  const { when, ...container } = withoutAbsent(node);
  return { node: { ...container, children } as SpecNode, assets: mergeAssets(...assets) };
}

/**
 * What a composite provided, where a node places it: the placement's style
 * joins the provided one, and the placement's `shown` governs it — around it
 * when the provided node has a condition of its own, so both must hold.
 */
export function placed(provided: SpecNode, placement: { style?: unknown; shown?: unknown }): SpecNode {
  const style = mergeStyles(provided.style as Style | undefined, placement.style as Style | undefined);
  const styled = style === undefined ? provided : { ...provided, style };
  if (placement.shown == null) return styled;
  if (styled.shown === undefined) return { ...styled, shown: placement.shown };
  return { type: "box", children: [styled], shown: placement.shown };
}

/**
 * A node with what its roots say about the values it names, through every
 * container: a `value` node's `present`, a `list` node's column headers and
 * each column's `present`, and each of its row actions held to its action
 * ({@link pendingRowAction}), the action still the instance for whoever places
 * the node to provide. A member holding nothing is one left out; `when` is
 * kept, for whoever decides delivery.
 */
export function presented(node: AuthoredNode, roots: RootShapes, reader: ShapeReader, where: string): AuthoredNode {
  const own = withoutAbsent(node);
  if (Array.isArray(own.children)) {
    return {
      ...own,
      children: own.children.map((child, index) => presented(child, roots, reader, `${where}.children[${index}]`)),
    };
  }
  if (own.type === "value") {
    const target = shapeOf(own.value as Binding, roots, reader, `${where}.value`);
    const present = presentation(target);
    return { ...own, ...(present ? { present } : {}), labels: shapeLabels(target) };
  }
  if (own.type === "list") {
    const rows = shapeOf(own.rows as Binding, roots, reader, `${where}.rows`);
    const row = rows && itemsOf(rows, reader, `${where}.rows`);
    const rowRoots: RootShapes = { ...roots, row };
    const columns = (own.columns as { header?: unknown; value: Binding; shown?: Condition | null }[]).map(
      ({ header, value, shown }, index) => {
        const target = shapeOf(value, rowRoots, reader, `${where}.columns[${index}].value`);
        const last = isChain(value) ? value.path[value.path.length - 1] : undefined;
        const present = presentation(target);
        return {
          header: header ?? headerOf(last ?? "", target),
          value,
          ...(present ? { present } : {}),
          labels: shapeLabels(target),
          ...(shown != null ? { shown } : {}),
        };
      },
    );
    const rowActions = (own.rowActions as RowActionConfig[] | undefined)?.map((entry, index) =>
      pendingRowAction(entry, reader.ctx, where, `rowActions[${index}]`),
    );
    return { ...own, columns, ...(rowActions ? { rowActions } : {}) };
  }
  return own;
}

/** The shape the value a binding names is declared as, where its root says. */
function shapeOf(binding: Binding, roots: RootShapes, reader: ShapeReader, where: string): Shape | undefined {
  if (!isChain(binding)) return undefined;
  const root = roots[binding.root];
  return root && schemaAt(root, binding.path, reader, where);
}

/** `node` with every member holding nothing left out. */
function withoutAbsent(node: AuthoredNode): AuthoredNode {
  const kept: AuthoredNode = { type: node.type };
  for (const [key, value] of Object.entries(node)) {
    if (value === null || value === undefined) continue;
    kept[key] = value;
  }
  return kept;
}
