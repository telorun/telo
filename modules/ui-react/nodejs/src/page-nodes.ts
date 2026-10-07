import type { DataValidator } from "@telorun/sdk";
import { errorNode, type SpecNode } from "./component-abi.js";

/** A page node as written, after its expressions were evaluated for a request. */
export interface EvaluatedNode {
  type: string;
  when?: unknown;
  style?: unknown;
  children?: EvaluatedNode[];
  ref?: unknown;
  [key: string]: unknown;
}

const mergeStyles = (own: unknown, added: unknown) =>
  added === undefined ? own : own === undefined ? added : [...new Set([own, added].flat())];

/** Stands where a node already judged sits, so judging what holds it does not
 *  judge it again. */
const JUDGED: SpecNode = { type: "text", text: "" };

type Invalid = (node: SpecNode, reason: string) => void;

/**
 * Produce one page node for a request: a node whose `when` is false is left
 * out, a composite stands as the node it provided at start — or is left out
 * when it provided none — and every node that is not a valid `Ui.SpecNode` once
 * evaluated is replaced — itself, not its container — by an error node.
 * `invalid` is told about each replacement.
 *
 * Each node is judged once: a container on its own fields, its children
 * standing as already judged; a composite's node was judged at start
 * ({@link judgedComposite}), so only the style its placement adds is judged
 * here.
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
    if (node.style === undefined) return composite;
    const style = mergeStyles(composite.style, node.style);
    const reason = refusalOf({ ...JUDGED, style }, validator);
    return reason === undefined ? { ...composite, style } : refuse(rest as SpecNode, reason, invalid);
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
