import type { SpecNode } from "./composite.js";

/** The node lists whose filling node fills the node holding them. */
const PASSING_LISTS = ["children", "start", "center", "end"] as const;

/** The single trees, by node type, whose filling node fills the node holding them. */
const PASSING_TREES: Readonly<Record<string, readonly string[]>> = {
  data: ["content", "loading", "failure"],
  filters: ["content"],
  split: ["content"],
};

const isNode = (value: unknown): value is SpecNode =>
  value !== null && typeof value === "object" && !Array.isArray(value) && typeof (value as SpecNode).type === "string";

type Mark = (node: SpecNode) => SpecNode;

/**
 * A tree with `fill` decided on every node: a node fills when it was written
 * with `fill: true` or holds a filling node in the room it passes down — its
 * children, a bar's regions, a tab's children, a split view's aside and content,
 * a reader's trees, a filter bar's content. A tree drawn in a box of its own — a
 * surface's form, a listing's empty tree, an action's answers, a row action's
 * action, a menu's items, a split view's actions, a chat's header — is decided
 * inside that box and fills nothing around it. Linear in the size of the tree.
 */
export function filledNode(node: SpecNode): SpecNode {
  let fills = node.fill === true;
  const passing: Mark = (child) => {
    const marked = filledNode(child);
    if (marked.fill === true) fills = true;
    return marked;
  };
  const own: Mark = (child) => filledNode(child);
  const out: Record<string, unknown> = { ...node };
  for (const key of PASSING_LISTS) {
    const list = node[key];
    if (Array.isArray(list)) out[key] = list.map((child) => (isNode(child) ? passing(child) : child));
  }
  for (const key of PASSING_TREES[node.type] ?? []) {
    if (isNode(node[key])) out[key] = passing(node[key]);
  }
  if (node.type === "tabs" && Array.isArray(node.tabs)) {
    out.tabs = (node.tabs as Record<string, unknown>[]).map((tab) =>
      Array.isArray(tab.children) ? { ...tab, children: tab.children.map((child) => (isNode(child) ? passing(child) : child)) } : tab,
    );
  }
  if (node.type === "split" && node.aside !== null && typeof node.aside === "object") {
    const aside = node.aside as { actions?: unknown[]; content?: unknown };
    out.aside = {
      ...aside,
      ...(Array.isArray(aside.actions) ? { actions: aside.actions.map((action) => (isNode(action) ? own(action) : action)) } : {}),
      ...(isNode(aside.content) ? { content: passing(aside.content) } : {}),
    };
  }
  for (const key of ["items", "header"]) {
    const list = node[key];
    if ((node.type === "menu" || node.type === "chat") && Array.isArray(list)) out[key] = list.map((child) => (isNode(child) ? own(child) : child));
  }
  for (const key of ["empty", "result", "failure"]) {
    if (!(PASSING_TREES[node.type] ?? []).includes(key) && isNode(node[key])) out[key] = own(node[key]);
  }
  for (const key of ["create", "edit"]) {
    const opener = node[key] as { form?: unknown } | null | undefined;
    if (node.type === "listing" && opener && isNode(opener.form)) out[key] = { ...opener, form: own(opener.form) };
  }
  if (Array.isArray(node.rowActions)) {
    out.rowActions = (node.rowActions as Record<string, unknown>[]).map((entry) => (isNode(entry.action) ? { ...entry, action: own(entry.action) } : entry));
  }
  out.fill = fills;
  return out as SpecNode;
}

/** What a composite provides, every node of it marked ({@link filledNode}). */
export function filledProvided<T extends { node?: SpecNode }>(provided: T): T {
  return provided.node === undefined ? provided : { ...provided, node: filledNode(provided.node) };
}
