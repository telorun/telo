import { canonicalTypeSchemaId, RuntimeError, type ResourceContext } from "@telorun/sdk";
import { addressSpec, type AddressConfig } from "./address-spec.js";
import { buttonSpec, providedButton } from "./button-display.js";
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

/** The lists of child nodes a node holds, by member: a container's
 *  `children`, a bar's three regions. */
export function nodeLists(node: { type: string; [key: string]: unknown }): string[] {
  if (node.type === "bar") return ["start", "center", "end"];
  return Array.isArray(node.children) ? ["children"] : [];
}

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
    return { node: { ...own, tabs: delivered, fill: node.fill === true } as SpecNode, assets: mergeAssets(...assets) };
  }
  const lists = nodeLists(node);
  if (lists.length === 0) {
    const drawn = await withLinkButtons(node, ctx, where);
    const { when, ...leaf } = presented(drawn.node, roots, reader, where);
    if (leaf.type === "menu") {
      const menu = deliveredMenu(leaf);
      return menu && { node: menu as SpecNode, assets: [] };
    }
    if (!Array.isArray(leaf.rowActions)) return { node: leaf as SpecNode, assets: drawn.assets };
    const { rowActions, assets } = await providedRowActions(leaf.rowActions as PendingRowAction[]);
    return { node: { ...leaf, rowActions } as SpecNode, assets: mergeAssets(...assets) };
  }
  const assets: AssetFile[][] = [];
  const { when, ...container } = withoutAbsent(node);
  for (const list of lists) {
    const children: SpecNode[] = [];
    for (const [index, child] of ((node[list] as AuthoredNode[] | undefined) ?? []).entries()) {
      const resolved = await resolveNode(child, ctx, `${where}.${list}[${index}]`, roots);
      if (!resolved?.node) continue;
      children.push(resolved.node);
      assets.push(resolved.assets);
    }
    container[list] = children;
  }
  return { node: { ...container, fill: node.fill === true } as SpecNode, assets: mergeAssets(...assets) };
}

/**
 * What a composite provided, where a node places it: the placement's style
 * joins the provided one, its `fill` fills it, and the placement's `shown`
 * governs it — around it when the provided node has a condition of its own, so
 * both must hold.
 */
export function placed(provided: SpecNode, placement: { style?: unknown; shown?: unknown; fill?: unknown }): SpecNode {
  const style = mergeStyles(provided.style as Style | undefined, placement.style as Style | undefined);
  const fill = provided.fill === true || placement.fill === true;
  const styled: SpecNode = { ...provided, ...(style === undefined ? {} : { style }), fill };
  if (placement.shown == null) return styled;
  if (styled.shown === undefined) return { ...styled, shown: placement.shown };
  return { type: "box", children: [styled], shown: placement.shown, fill };
}

/**
 * `node` with the display of every `link` and `command` it holds, at any depth,
 * turned into what a renderer receives and the icon file it is drawn from
 * served; a link written without one stays inline, a command is drawn by its text.
 */
export async function withLinkButtons(node: AuthoredNode, ctx: ResourceContext, where: string): Promise<{ node: AuthoredNode; assets: AssetFile[] }> {
  if (node.type === "command" && node.button == null) return { node: { ...node, button: { type: "text" } }, assets: [] };
  if ((node.type === "link" || node.type === "command") && node.button != null) {
    const owner = `the ${node.type} node at ${where}`;
    const drawn = await buttonSpec(await providedButton(node.button, ctx, () => `'button' of ${owner}`), owner, "button.icon");
    return { node: { ...node, button: drawn.spec }, assets: drawn.assets };
  }
  const assets: AssetFile[] = [];
  const each = async (nodes: AuthoredNode[], at: string) => {
    const drawn: AuthoredNode[] = [];
    for (const [index, child] of nodes.entries()) {
      const next = await withLinkButtons(child, ctx, `${at}[${index}]`);
      assets.push(...next.assets);
      drawn.push(next.node);
    }
    return drawn;
  };
  const lists = nodeLists(node);
  if (lists.length > 0) {
    const drawn: AuthoredNode = { ...node };
    for (const list of lists) if (Array.isArray(node[list])) drawn[list] = await each(node[list] as AuthoredNode[], `${where}.${list}`);
    return { node: drawn, assets };
  }
  if (node.type === "tabs" && Array.isArray(node.tabs)) {
    const tabs: AuthoredTab[] = [];
    for (const [index, tab] of (node.tabs as AuthoredTab[]).entries()) {
      tabs.push(Array.isArray(tab.children) ? { ...tab, children: await each(tab.children, `${where}.tabs[${index}].children`) } : tab);
    }
    return { node: { ...node, tabs }, assets };
  }
  return { node, assets };
}

/**
 * A node with what its roots say about the values it names, through every
 * container: a `value` node's `present`, a `list` node's column headers and
 * each column's `present`, and each of its row actions held to its action
 * ({@link pendingRowAction}), the action still the instance for whoever places
 * the node to provide; a `command` node is held to a command one of its roots
 * offers. A member holding nothing is one left out, a bar's region `[]`, and
 * `fill` is the one written; `when` is kept, for whoever decides delivery.
 */
export function presented(node: AuthoredNode, roots: RootShapes, reader: ShapeReader, where: string): AuthoredNode {
  const own: AuthoredNode = { ...withoutAbsent(node), fill: node.fill === true };
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
  if (own.type === "bar") for (const list of nodeLists(own)) own[list] ??= [];
  const lists = nodeLists(own);
  if (lists.length > 0) {
    const shown: AuthoredNode = { ...own };
    for (const list of lists) {
      shown[list] = (own[list] as AuthoredNode[]).map((child, index) => presented(child, roots, reader, `${where}.${list}[${index}]`));
    }
    return shown;
  }
  if (own.type === "command") {
    commandAt(own.command as Binding, roots, reader, `${where}.command`);
    return own;
  }
  if (own.type === "link") return { ...own, href: addressSpec(own.href as AddressConfig, reader.ctx, `${where}.href`), button: own.button ?? null };
  if (own.type === "menu" && Array.isArray(own.items)) {
    return {
      ...own,
      items: (own.items as AuthoredNode[]).map((item, index) => presented(item, roots, reader, `${where}.items[${index}]`)),
    };
  }
  if (own.type === "value") {
    const target = shapeOf(own.value as Binding, roots, reader, `${where}.value`);
    const present = presentation(target);
    return {
      ...own,
      ...(present ? { present } : {}),
      ...(own.href == null ? {} : { href: addressSpec(own.href as AddressConfig, reader.ctx, `${where}.href`) }),
      labels: shapeLabels(target),
    };
  }
  if (own.type === "list") {
    const rows = shapeOf(own.rows as Binding, roots, reader, `${where}.rows`);
    const row = rows && itemsOf(rows, reader, `${where}.rows`);
    const rowRoots: RootShapes = { ...roots, row };
    const columns = (own.columns as { header?: unknown; value: Binding; href?: AddressConfig | null; shown?: Condition | null }[]).map(
      ({ header, value, href, shown }, index) => {
        const target = shapeOf(value, rowRoots, reader, `${where}.columns[${index}].value`);
        const last = isChain(value) ? value.path[value.path.length - 1] : undefined;
        const present = presentation(target);
        return {
          header: header ?? headerOf(last ?? "", target),
          value,
          ...(present ? { present } : {}),
          labels: shapeLabels(target),
          ...(href != null ? { href: addressSpec(href, reader.ctx, `${where}.columns[${index}].href`) } : {}),
          ...(shown != null ? { shown } : {}),
        };
      },
    );
    const rowActions = (own.rowActions as RowActionConfig[] | undefined)?.map((entry, index) =>
      pendingRowAction(entry, reader.ctx, where, `rowActions[${index}]`),
    );
    return { ...own, columns, rowActionsDisplay: own.rowActionsDisplay ?? "auto", ...(rowActions ? { rowActions } : {}) };
  }
  return own;
}

/**
 * A `menu` node as delivered: the items whose `when` is not false, each without
 * its `when`, without a member holding nothing and drawn inline (`button` is
 * null). Nothing when no item is delivered — a menu with nothing to choose is
 * left out, like a node switched off.
 */
export function deliveredMenu<T extends Record<string, unknown>>(menu: T): T | undefined {
  const items = (menu.items as AuthoredNode[])
    .filter((item) => item.when !== false)
    .map((item) => {
      const { when, ...kept } = withoutAbsent(item);
      return { ...kept, button: null };
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

/**
 * Refuses a command node whose binding is not a chain to a command a root in
 * scope offers (a `Ui.Command` member of it): the runtime twin of the type the
 * analyzer gives each root a region binds.
 */
function commandAt(binding: Binding, roots: RootShapes, reader: ShapeReader, where: string): void {
  const id = canonicalTypeSchemaId("Ui", "Command");
  const command = reader.ctx.lookupSchema(id);
  const target = shapeOf(binding, roots, reader, where);
  const offered = target?.some(({ root }) => root === command || root.$id === id) === true;
  if (offered) return;
  const written = isChain(binding) ? `'${[binding.root, ...binding.path].join(".")}'` : "a fixed value";
  throw new RuntimeError(
    "ERR_UI_COMMAND_UNRESOLVED",
    `${where}: the command node names ${written}, which is no command a root in scope offers. Name a command of a root the place binds, such as 'chat.exportTranscript' in a chat's header.`,
  );
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
