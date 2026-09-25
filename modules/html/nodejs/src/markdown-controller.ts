import type { ResourceManifest } from "@telorun/sdk";
import type { Nodes as MdastNodes } from "mdast";
import { toMdast } from "hast-util-to-mdast";
import { gfmToMarkdown } from "mdast-util-gfm";
import { toMarkdown, type Options } from "mdast-util-to-markdown";
import { resolveUrl } from "./base-url.js";
import { toHast } from "./hast-tree.js";
import type { Parsed } from "./html-node.js";

interface MarkdownResource extends ResourceManifest {
  gfm?: boolean;
  headingStyle?: "atx" | "setext";
  bullet?: "-" | "*" | "+";
  fence?: "`" | "~";
  emphasis?: "*" | "_";
  strong?: "*" | "_";
  ruleStyle?: "-" | "*" | "_";
}

function absolutize(node: MdastNodes, base: string): void {
  if (node.type === "link" || node.type === "image" || node.type === "definition") {
    node.url = resolveUrl(node.url, base);
  }
  if ("children" in node) for (const child of node.children) absolutize(child, base);
}

type Parent = Extract<MdastNodes, { children: unknown }>;

/**
 * CommonMark without the GFM extensions has no syntax for a strikethrough, a
 * task-list checkbox or a table, so those are lowered to what it does have: a
 * strikethrough to its text, a checkbox to nothing, and a table to one paragraph
 * per row with its cells separated by a space.
 */
function lowerGfm(node: MdastNodes): MdastNodes[] {
  if (node.type === "delete") return node.children.flatMap(lowerGfm);
  if (node.type === "table") {
    return node.children.map((row) => ({
      type: "paragraph" as const,
      children: row.children.flatMap((cell, index) => [
        ...(index > 0 ? [{ type: "text" as const, value: " " }] : []),
        ...(cell.children.flatMap(lowerGfm) as never[]),
      ]),
    }));
  }
  if (node.type === "listItem") node.checked = null;
  if ("children" in node) {
    (node as Parent).children = (node as Parent).children.flatMap(lowerGfm) as never;
  }
  return [node];
}

export async function create(resource: MarkdownResource) {
  const options: Options = {
    setext: resource.headingStyle === "setext",
    ...(resource.bullet ? { bullet: resource.bullet } : {}),
    ...(resource.fence ? { fence: resource.fence } : {}),
    ...(resource.emphasis ? { emphasis: resource.emphasis } : {}),
    ...(resource.strong ? { strong: resource.strong } : {}),
    ...(resource.ruleStyle ? { rule: resource.ruleStyle } : {}),
    extensions: resource.gfm === false ? [] : [gfmToMarkdown()],
  };
  return {
    async invoke({ document }: { document: Parsed }): Promise<{ markdown: string }> {
      const mdast = toMdast(toHast(document.nodes).root);
      if (document.baseUrl !== undefined) absolutize(mdast, document.baseUrl);
      if (resource.gfm === false) lowerGfm(mdast);
      return { markdown: toMarkdown(mdast, options) };
    },
  };
}
