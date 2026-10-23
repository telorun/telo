import { canonicalTypeSchemaId, type DataValidator, type ResourceContext } from "@telorun/sdk";
import { mergeAssets, type AssetFile, type SpecNode } from "./composite.js";
import { deliveredMenu, deliveredTabs, placed, presented, type AuthoredNode, type AuthoredTab, type RootShapes } from "./node-resolution.js";
import { headerReads, type HeaderReads } from "./request-header-reads.js";
import { placedRowAction } from "./row-actions.js";

/** The node standing where one could not be produced. */
export function errorNode(code: string, message: string): SpecNode {
  return { type: "error", code, message };
}

/** A node as written, after its expressions were evaluated for a request. */
export interface EvaluatedNode {
  type: string;
  when?: unknown;
  shown?: unknown;
  style?: unknown;
  children?: EvaluatedNode[];
  ref?: unknown;
  [key: string]: unknown;
}

/** Stands where a node already judged sits, so judging what holds it does not
 *  judge it again. */
const JUDGED: SpecNode = { type: "text", text: { word: "loading" } };

/** Stands where an action already judged sits inside a row action. */
const JUDGED_ACTION: SpecNode = {
  type: "action",
  schema: {},
  path: "/",
  label: { word: "save" },
  fields: [],
  groups: [],
  state: { address: false, store: { type: "memory" }, fields: [] },
  failure: JUDGED,
  onSuccess: { refreshes: [] },
  concurrency: "parallel",
  clearAnswerOn: [],
};

type Invalid = (node: SpecNode, reason: string) => void;

/**
 * Produce one node for a request: a node whose `when` is false is left
 * out, a menu keeps the items whose own `when` holds — left out when none
 * does, and replaced whole when an item is not valid — a `tabs` node keeps the
 * tabs whose own `when` holds, each tab's children produced as a container's
 * are, and is left out when none does, a composite stands as the node it
 * provided at start — placed as `ui`
 * places it, the placement's style and `shown` over it — or is left out when
 * it provided none, a list's row action carries the node its action provided
 * at start, and every node that is not a valid `Ui.SpecNode` once
 * evaluated is replaced — itself, not its container — by an error node.
 * `invalid` is told about each replacement.
 *
 * Each node is judged once: a container on its own fields, its children
 * standing as already judged; a composite's node was judged at start
 * ({@link judgedComposite}), so only what its placement adds is judged here.
 */
export function producedNode(
  node: EvaluatedNode,
  provided: (ref: unknown) => SpecNode | null | undefined,
  validator: DataValidator,
  invalid: Invalid,
): SpecNode | undefined {
  if (node.when === false) return undefined;
  const { when, ...rest } = node;
  if (node.type === "composite") {
    const composite = provided(node.ref);
    // A composite with nothing to show is left out, like a node switched off.
    if (composite === null) return undefined;
    if (!composite) return refuse(rest as SpecNode, "its 'ref' names nothing this application resolved", invalid);
    if (node.style == null && node.shown == null) return composite;
    const shell = placed(
      { ...JUDGED, ...(composite.style === undefined ? {} : { style: composite.style }), ...(composite.shown === undefined ? {} : { shown: composite.shown }) },
      node,
    );
    const reason = refusalOf(shell.type === "box" ? { ...shell, children: [JUDGED] } : shell, validator);
    return reason === undefined ? placed(composite, node) : refuse(rest as SpecNode, reason, invalid);
  }
  if (node.type === "menu") {
    // Its items are delivered by their own `when`, and judged with it.
    const menu = Array.isArray(node.items) ? deliveredMenu(rest) : rest;
    if (menu === undefined) return undefined;
    const reason = refusalOf(menu as SpecNode, validator);
    return reason === undefined ? (menu as SpecNode) : refuse(menu as SpecNode, reason, invalid);
  }
  if (node.type === "tabs" && Array.isArray(node.tabs)) {
    const tabs = deliveredTabs(node.tabs as AuthoredTab[])?.map((tab) =>
      Array.isArray(tab.children)
        ? {
            ...tab,
            children: (tab.children as EvaluatedNode[])
              .map((child) => producedNode(child, provided, validator, invalid))
              .filter((child): child is SpecNode => child !== undefined),
          }
        : tab,
    );
    if (tabs === undefined) return undefined;
    const produced = { ...rest, tabs } as SpecNode;
    const judged = tabs.map((tab) => (Array.isArray(tab.children) ? { ...tab, children: tab.children.map(() => JUDGED) } : tab));
    const reason = refusalOf({ ...rest, tabs: judged } as SpecNode, validator);
    return reason === undefined ? produced : refuse(produced, reason, invalid);
  }
  if (Array.isArray(node.rowActions)) {
    // A row action's action stands as the node it provided at start, judged
    // there; the list is judged around it.
    const entries = node.rowActions as Record<string, unknown>[];
    const actions = entries.map((entry) => provided(entry.action));
    if (actions.some((action) => !action)) {
      return refuse(rest as SpecNode, "a row action's 'action' names nothing this application resolved", invalid);
    }
    const reason = refusalOf({ ...rest, rowActions: entries.map((entry) => placedRowAction(entry as never, JUDGED_ACTION)) } as SpecNode, validator);
    if (reason !== undefined) return refuse(rest as SpecNode, reason, invalid);
    return { ...rest, rowActions: entries.map((entry, index) => placedRowAction(entry as never, actions[index]!)) } as SpecNode;
  }
  if (!Array.isArray(node.children)) {
    const reason = refusalOf(rest as SpecNode, validator);
    return reason === undefined ? (rest as SpecNode) : refuse(rest as SpecNode, reason, invalid);
  }
  const children = node.children
    .map((child) => producedNode(child, provided, validator, invalid))
    .filter((child): child is SpecNode => child !== undefined);
  const produced = { ...rest, children } as SpecNode;
  const reason = refusalOf({ ...rest, children: children.map(() => JUDGED) } as SpecNode, validator);
  return reason === undefined ? produced : refuse(produced, reason, invalid);
}

/** What a composite provided, judged once: itself when it is a valid
 *  `Ui.SpecNode`, the error node otherwise. */
export function judgedComposite(node: SpecNode, validator: DataValidator, invalid: Invalid): SpecNode {
  const reason = refusalOf(node, validator);
  if (reason === undefined) return node;
  invalid(node, reason);
  return errorNode("ERR_UI_NODE_INVALID", `A '${String(node.type)}' node a composite provides is not valid: ${reason}`);
}

/** Why a node is no valid `Ui.SpecNode`; nothing when it is one. */
function refusalOf(node: SpecNode, validator: DataValidator): string | undefined {
  try {
    validator.validate(node);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return undefined;
}

function refuse(node: SpecNode, reason: string, invalid: Invalid): SpecNode {
  invalid(node, reason);
  return errorNode(
    "ERR_UI_NODE_INVALID",
    `A '${String(node.type)}' node is not valid for this request: ${reason}`,
  );
}

interface Providing {
  provide(): Promise<{ node?: SpecNode; assets: AssetFile[] }>;
}

const provides = (candidate: unknown): candidate is Providing =>
  typeof (candidate as Providing | null)?.provide === "function";

/**
 * Nodes with each composite's `ref`, and each list row action's `action`,
 * replaced by its index in `placed`, where the instance is appended. A tree's
 * structure and references are literal — only leaf values are evaluated per
 * request — so the numbering made once holds for every request, and no
 * instance passes through evaluation. `composite` resolves a composite node's
 * reference to its instance.
 */
function withCompositesNumbered(node: unknown, placed: unknown[], composite: (ref: unknown, where: string) => Providing, where: string): unknown {
  if (Array.isArray(node)) return node.map((child, at) => withCompositesNumbered(child, placed, composite, `${where}[${at}]`));
  if (node === null || typeof node !== "object") return node;
  const { type, ref, children, rowActions, tabs } = node as EvaluatedNode;
  if (type === "composite") return { ...node, ref: placed.push(composite(ref, where)) - 1 };
  if (type === "tabs" && Array.isArray(tabs)) {
    return {
      ...node,
      tabs: (tabs as AuthoredTab[]).map((tab, at) =>
        Array.isArray(tab.children) ? { ...tab, children: withCompositesNumbered(tab.children, placed, composite, `${where}.tabs[${at}].children`) } : tab,
      ),
    };
  }
  if (Array.isArray(children)) return { ...node, children: withCompositesNumbered(children, placed, composite, `${where}.children`) };
  if (type === "list" && Array.isArray(rowActions)) {
    return {
      ...node,
      rowActions: (rowActions as Record<string, unknown>[]).map((entry) =>
        provides(entry.action) ? { ...entry, action: placed.push(entry.action) - 1 } : entry,
      ),
    };
  }
  return node;
}

/**
 * Nodes written for a place delivered per request — a page's children, an
 * application's header: prepared once, with what the roots in scope say about
 * the values they name and every composite they place resolved and judged, then
 * evaluated and produced for each request ({@link producedNode}).
 */
export class RequestNodes {
  private constructor(
    private readonly ctx: ResourceContext,
    private readonly where: string,
    /** The nodes, every composite numbered. */
    private readonly tree: unknown,
    /** What each numbered composite provided — `null` for nothing. */
    private readonly composites: (SpecNode | null)[],
    private readonly validator: DataValidator,
    /** Every file the composites need, each once. */
    readonly assets: AssetFile[],
    /** The request headers the nodes' expressions read. */
    readonly headerReads: HeaderReads,
  ) {}

  /** `where` names the nodes in what is logged and refused. */
  static async prepare(nodes: unknown, roots: RootShapes, ctx: ResourceContext, where: string): Promise<RequestNodes> {
    const reader = { ctx, owner: where };
    const authored = (nodes as AuthoredNode[]).map((child, at) => presented(child, roots, reader, `${where}[${at}]`));
    const placed: unknown[] = [];
    const composite = (ref: unknown, at: string) =>
      ctx.resolveRef(ref, provides, () => `'ref' of the composite node at ${where}${at}`, "Ui.Composite");
    const tree = withCompositesNumbered(authored, placed, composite, "");
    const validator = ctx.createTypeValidator(canonicalTypeSchemaId("Ui", "SpecNode"));
    const composites: (SpecNode | null)[] = [];
    const assets: AssetFile[][] = [];
    for (const instance of placed) {
      const provided = await (instance as Providing).provide();
      assets.push(provided.assets);
      composites.push(
        provided.node === undefined
          ? null
          : // Judged here, once: a request places it as it stands.
            judgedComposite(provided.node, validator, (invalid, reason) =>
              ctx.log.error("A composite provides a node that is not valid and is shown as an error", {
                code: "ERR_UI_NODE_INVALID",
                where,
                type: String(invalid.type),
                reason,
              }),
            ),
      );
    }
    return new RequestNodes(ctx, where, tree, composites, validator, mergeAssets(...assets), headerReads(tree));
  }

  /** The nodes for one request: evaluated over it, a node switched off left
   *  out, one not valid replaced by an error node and logged. */
  deliver(request: Record<string, unknown>): SpecNode[] {
    const evaluated = this.ctx.expandValue(this.tree, { request }) as EvaluatedNode[];
    return evaluated
      .map((node) =>
        producedNode(
          node,
          (ref) => this.composites[ref as number],
          this.validator,
          (invalid, reason) =>
            this.ctx.log.error("A node is not valid for this request and is shown as an error", {
              code: "ERR_UI_NODE_INVALID",
              where: this.where,
              type: String(invalid.type),
              reason,
            }),
        ),
      )
      .filter((node): node is SpecNode => node !== undefined);
  }
}
