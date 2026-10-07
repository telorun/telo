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

/** A `Ui.Node` as its author wrote it, references already live. */
export interface AuthoredNode {
  type: string;
  when?: boolean;
  style?: Style;
  children?: AuthoredNode[];
  ref?: unknown;
  [key: string]: unknown;
}

/**
 * Turn an authored node into the node a renderer receives: a node whose
 * `when:` is false is left out, a composite is replaced by what it provides,
 * and containers resolve their children in order. `undefined` means the node
 * is omitted — switched off, or a composite that provided none.
 */
export async function resolveNode(
  node: AuthoredNode,
  ctx: ResourceContext,
  where: string,
): Promise<Provided | undefined> {
  if (node.when === false) return undefined;
  const { when, ...rest } = node;
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
    const style = mergeStyles(provided.node.style as Style | undefined, node.style);
    return {
      node: style === undefined ? provided.node : { ...provided.node, style },
      assets: provided.assets,
    };
  }
  if (!Array.isArray(node.children)) return { node: rest as SpecNode, assets: [] };
  const children: SpecNode[] = [];
  const assets: AssetFile[][] = [];
  for (const [index, child] of node.children.entries()) {
    const resolved = await resolveNode(child, ctx, `${where}.children[${index}]`);
    if (!resolved?.node) continue;
    children.push(resolved.node);
    assets.push(resolved.assets);
  }
  return { node: { ...rest, children } as SpecNode, assets: mergeAssets(...assets) };
}
