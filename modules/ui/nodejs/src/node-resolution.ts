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
import { sourceKeys } from "./source-keys.js";

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

/** One tab of a `tabs` node as written, or as evaluated for a request. */
export interface AuthoredTab {
  text?: unknown;
  children?: AuthoredNode[];
  when?: unknown;
  [key: string]: unknown;
}

/** What each root a tree may read is declared as, by name — what presents the
 *  values its `value` and `list` nodes name. */
export type RootShapes = Readonly<Record<string, Shape | undefined>>;

export const NO_ROOTS: RootShapes = {};

/**
 * Turn an authored node into the node a renderer receives: a node whose
 * `when:` is false is left out, a menu keeps only the items delivered (see
 * {@link deliveredMenu}) and a `tabs` node only the tabs (see
 * {@link deliveredTabs}), a composite is replaced by what it provides,
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
  if (node.type === "tabs" && Array.isArray(node.tabs)) {
    const tabs: AuthoredTab[] = [];
    const assets: AssetFile[][] = [];
    for (const [index, tab] of keyedTabs(node.tabs as AuthoredTab[]).entries()) {
      if (tab.when === false) continue;
      const children: SpecNode[] = [];
      for (const [at, child] of (tab.children ?? []).entries()) {
        const resolved = await resolveNode(child, ctx, `${where}.tabs[${index}].children[${at}]`, roots);
        if (!resolved?.node) continue;
        children.push(resolved.node);
        assets.push(resolved.assets);
      }
      tabs.push({ ...tab, children: children as AuthoredNode[] });
    }
    const delivered = deliveredTabs(tabs);
    if (delivered === undefined) return undefined;
    const { when, ...own } = withoutAbsent(node);
    return { node: { ...own, tabs: delivered } as SpecNode, assets: mergeAssets(...assets) };
  }
  if (!Array.isArray(node.children)) {
    const { when, ...leaf } = presented(node, roots, reader, where);
    if (leaf.type === "menu") {
      const menu = deliveredMenu(leaf);
      return menu && { node: menu as SpecNode, assets: [] };
    }
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
  if (own.type === "tabs" && Array.isArray(own.tabs)) {
    return {
      ...own,
      tabs: (own.tabs as AuthoredTab[]).map((tab, index) =>
        Array.isArray(tab.children)
          ? { ...tab, children: tab.children.map((child, at) => presented(child, roots, reader, `${where}.tabs[${index}].children[${at}]`)) }
          : tab,
      ),
    };
  }
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

/**
 * A `menu` node as delivered: the items whose `when` is not false, each without
 * its `when` and without a member holding nothing. Nothing when no item is
 * delivered — a menu with nothing to choose is left out, like a node switched
 * off.
 */
export function deliveredMenu<T extends Record<string, unknown>>(menu: T): T | undefined {
  const items = (menu.items as AuthoredNode[])
    .filter((item) => item.when !== false)
    .map((item) => {
      const { when, ...kept } = withoutAbsent(item);
      return kept;
    });
  return items.length === 0 ? undefined : { ...menu, items };
}

/** Every tab keyed by the slug of the source text it was written with
 *  (see {@link sourceKeys}), over every tab whatever its `when`; a tab keyed
 *  already keeps its key. */
function keyedTabs(tabs: AuthoredTab[]): AuthoredTab[] {
  const keys = sourceKeys(tabs.map((tab) => tab.text), "tab");
  return tabs.map((tab, index) => (typeof tab.key === "string" ? tab : { ...tab, key: keys[index] }));
}

/**
 * The tabs of a `tabs` node as delivered: every tab keyed, then the tabs
 * whose `when` is not false, each without its `when` and without a member
 * holding nothing. Nothing when no tab is delivered — a `tabs` node with
 * nothing to show is left out, like a node switched off.
 */
export function deliveredTabs(tabs: AuthoredTab[]): AuthoredTab[] | undefined {
  const delivered = keyedTabs(tabs)
    .filter((tab) => tab.when !== false)
    .map((tab) => {
      const kept: AuthoredTab = {};
      for (const [key, value] of Object.entries(tab)) if (key !== "when" && value !== null && value !== undefined) kept[key] = value;
      return kept;
    });
  return delivered.length === 0 ? undefined : delivered;
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
