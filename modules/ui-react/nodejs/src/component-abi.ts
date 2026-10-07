/** A node of a produced page. */
export type SpecNode = { type: string } & Record<string, any>;

export function errorNode(code: string, message: string): SpecNode {
  return { type: "error", code, message };
}

export interface Hosted {
  /** The component ABIs this renderer implements. */
  abis: string[];
  /** The bare specifiers the page's import map supplies. */
  specifiers: string[];
}

/**
 * Replace every component this renderer cannot host with an error node, in
 * place: one written against another ABI, or importing a specifier the page
 * does not supply. Everything around it is kept, so the rest of the page
 * renders. `report` is told about each one.
 */
export function withUnhostedComponentsReplaced(
  node: SpecNode,
  hosted: Hosted,
  report: (error: SpecNode, node: SpecNode) => void,
): SpecNode {
  const visit = (current: SpecNode): SpecNode => {
    if (current.type === "component") {
      const refused = refusal(current, hosted);
      if (!refused) return current;
      report(refused, current);
      return refused;
    }
    const next: SpecNode = { ...current };
    if (Array.isArray(current.children)) next.children = current.children.map(visit);
    if (current.type === "filters") next.content = visit(current.content);
    if (current.type === "table") {
      next.columns = current.columns.map((column: Record<string, any>) =>
        column.cell ? { ...column, cell: visit(column.cell) } : column,
      );
    }
    return next;
  };
  return visit(node);
}

function refusal(component: SpecNode, hosted: Hosted): SpecNode | undefined {
  if (!hosted.abis.includes(component.abi)) {
    return errorNode(
      "ERR_UI_COMPONENT_ABI_UNSUPPORTED",
      `The component '${component.export}' is built for ${component.abi === undefined ? "no declared ABI" : `ABI '${component.abi}'`}; this application hosts ${hosted.abis.map((abi) => `'${abi}'`).join(", ")}.`,
    );
  }
  const unsupplied = (component.external as string[]).filter((name) => !hosted.specifiers.includes(name));
  if (unsupplied.length > 0) {
    return errorNode(
      "ERR_UI_COMPONENT_IMPORT_UNSUPPLIED",
      `The component '${component.export}' imports ${unsupplied.map((name) => `'${name}'`).join(", ")}, which this application does not supply. It supplies ${hosted.specifiers.map((name) => `'${name}'`).join(", ")}; anything else must be bundled into the component.`,
    );
  }
  return undefined;
}
