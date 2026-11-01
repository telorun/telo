import { errorNode } from "@telorun/ui";

/** A node of a produced page. */
export type SpecNode = { type: string } & Record<string, any>;

export interface Hosted {
  /** The component ABIs this renderer implements. */
  abis: string[];
  /** The listing layout contracts it hosts a layout component of. */
  layoutAbis: string[];
  /** The bare specifiers the page's import map supplies. */
  specifiers: string[];
}

/**
 * Replace every component this renderer cannot host with an error node, in
 * place: one written against another ABI, or importing a specifier the page
 * does not supply — and a listing whose layout, or compact layout, is such a
 * component of the layout contract. Everything around it is kept, so the rest
 * of the page renders. `report` is told about each one.
 */
export function withUnhostedComponentsReplaced(
  node: SpecNode,
  hosted: Hosted,
  report: (error: SpecNode, node: SpecNode) => void,
  /** How a node below `node` is visited; this walk, unless a caller remembers. */
  child?: (node: SpecNode) => SpecNode,
): SpecNode {
  const down = (below: SpecNode): SpecNode => (child ?? visit)(below);
  const visit = (current: SpecNode): SpecNode => {
    if (current.type === "component") {
      const refused = refusal(current, hosted.abis, hosted.specifiers);
      if (!refused) return current;
      report(refused, current);
      return refused;
    }
    const next: SpecNode = { ...current };
    if (Array.isArray(current.children)) next.children = current.children.map(down);
    if (current.type === "tabs") {
      next.tabs = current.tabs.map((tab: Record<string, any>) => ({ ...tab, children: tab.children.map(down) }));
    }
    if (current.type === "filters") next.content = down(current.content);
    if (current.type === "data") {
      next.content = down(current.content);
      next.loading = down(current.loading);
      next.failure = down(current.failure);
    }
    if (current.type === "action") {
      if (current.result !== undefined) next.result = down(current.result);
      next.failure = down(current.failure);
    }
    if (current.type === "listing") {
      for (const spec of [current.layout, current.compact]) {
        if (spec?.type !== "component") continue;
        const refused = refusal(spec, hosted.layoutAbis, hosted.specifiers, true);
        if (!refused) continue;
        report(refused, current);
        return refused;
      }
      next.empty = down(current.empty);
      // A layout's per-record content, and each component a table column draws in place of a value.
      const layout = (spec: Record<string, any>) => ({
        ...spec,
        ...(spec.content !== undefined ? { content: down(spec.content) } : {}),
        ...(Array.isArray(spec.columns)
          ? { columns: spec.columns.map((column: Record<string, any>) => (column.cell ? { ...column, cell: down(column.cell) } : column)) }
          : {}),
      });
      next.layout = layout(current.layout);
      if (current.compact !== undefined) next.compact = layout(current.compact);
    }
    if (Array.isArray(current.rowActions)) {
      next.rowActions = current.rowActions.map((entry: Record<string, any>) => ({ ...entry, action: down(entry.action) }));
    }
    return next;
  };
  return visit(node);
}

/**
 * Nodes as this renderer hosts them, every component it cannot host replaced
 * ({@link withUnhostedComponentsReplaced}). A composite's node is delivered as
 * the same object to every request, so each node is judged once and what it
 * became is remembered; `report` hears of each replacement once.
 */
export class HostedNodes {
  private readonly held = new WeakMap<SpecNode, SpecNode>();

  constructor(
    private readonly hosted: Hosted,
    private readonly report: (error: SpecNode, node: SpecNode) => void,
  ) {}

  node(node: SpecNode): SpecNode {
    const known = this.held.get(node);
    if (known) return known;
    const hosted = withUnhostedComponentsReplaced(node, this.hosted, this.report, (child) => this.node(child));
    this.held.set(node, hosted);
    return hosted;
  }
}

/** Why a component — a node, or a listing's layout — cannot be hosted under `abis` with `specifiers` supplied. */
function refusal(component: SpecNode, abis: string[], specifiers: string[], layout = false): SpecNode | undefined {
  if (!abis.includes(component.abi)) {
    return errorNode(
      "ERR_UI_COMPONENT_ABI_UNSUPPORTED",
      `The component '${component.export}' is built for ${component.abi === undefined ? "no declared ABI" : `ABI '${component.abi}'`}; this application hosts ${abis.map((abi) => `'${abi}'`).join(", ")}${layout ? " for a listing layout" : ""}.`,
    );
  }
  const unsupplied = (component.external as string[]).filter((name) => !specifiers.includes(name));
  if (unsupplied.length > 0) {
    return errorNode(
      "ERR_UI_COMPONENT_IMPORT_UNSUPPLIED",
      `The component '${component.export}' imports ${unsupplied.map((name) => `'${name}'`).join(", ")}, which this application does not supply. It supplies ${specifiers.map((name) => `'${name}'`).join(", ")}; anything else must be bundled into the component.`,
    );
  }
  return undefined;
}
