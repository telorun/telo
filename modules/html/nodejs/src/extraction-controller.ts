import { InvokeError, type ResourceManifest } from "@telorun/sdk";
import { toText } from "hast-util-to-text";
import { toHast, type HastTree } from "./hast-tree.js";
import type { ElementNode, HtmlNode, Parsed } from "./html-node.js";
import { findUnserializableIn, serializeNode } from "./html-serialization.js";
import { selectAll, type Scope } from "./selector-matcher.js";
import { indexTree, type TreeIndex } from "./tree-index.js";

type FieldType = "text" | "html" | "attr" | "number" | "integer";

interface Field {
  selector: string;
  type?: FieldType;
  attr?: string;
  many?: boolean;
  nullable?: boolean;
  fields?: Record<string, Field>;
}

interface ExtractionResource extends ResourceManifest {
  fields: Record<string, Field>;
}

/** The page indexed for matching, as hast for the text rendering, and the
 *  path of each node from the document for a refusal to name. */
interface Tree {
  readonly index: TreeIndex;
  readonly hast: HastTree;
  readonly nodes: readonly HtmlNode[];
  paths?: Map<HtmlNode, string>;
}

function pathOf(tree: Tree, node: HtmlNode): string {
  if (!tree.paths) {
    const paths = new Map<HtmlNode, string>();
    const visit = (nodes: readonly HtmlNode[], at: string) =>
      nodes.forEach((child, i) => {
        const path = `${at}[${i}]`;
        paths.set(child, path);
        if (child.type === "element") visit(child.children, `${path}.children`);
      });
    visit(tree.nodes, "nodes");
    tree.paths = paths;
  }
  return tree.paths.get(node)!;
}

const NUMBER = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;
const INTEGER = /^[+-]?\d+$/;

export async function create(resource: ExtractionResource) {
  const label = `${resource.kind} '${resource.metadata.name}'`;

  /** A match's value, or undefined when the match does not carry it. */
  function valueOf(field: Field, path: string, node: ElementNode, tree: Tree): unknown {
    const match = tree.hast.hastOf.get(node)!;
    switch (field.type) {
      case "html": {
        const problem = findUnserializableIn(node, pathOf(tree, node));
        if (problem) {
          throw new InvokeError(
            "ERR_HTML_NOT_SERIALIZABLE",
            `${label}: field '${path}' reads markup, but ${problem.path} cannot be written as markup that reads back unchanged — ${problem.reason}.`,
            { field: path, path: problem.path },
          );
        }
        return serializeNode(node, undefined);
      }
      case "attr":
        return Object.hasOwn(node.attrs, field.attr!) ? node.attrs[field.attr!] : undefined;
      case "number":
      case "integer": {
        const text = toText(match).trim();
        if (field.type === "number" ? NUMBER.test(text) : INTEGER.test(text)) {
          if (field.type === "number") return Number(text);
          const whole = BigInt(text);
          return whole >= BigInt(Number.MIN_SAFE_INTEGER) && whole <= BigInt(Number.MAX_SAFE_INTEGER)
            ? Number(whole)
            : whole;
        }
        throw new InvokeError(
          "ERR_HTML_FIELD_CONVERSION",
          `${label}: field '${path}' matched ${JSON.stringify(text)}, which is not ${
            field.type === "number" ? "a number" : "an integer"
          }.`,
          { field: path, text },
        );
      }
      default:
        return toText(match);
    }
  }

  function extractField(field: Field, path: string, scope: Scope, tree: Tree): unknown {
    const matches = selectAll(field.selector, tree.index, scope);
    const one = (match: ElementNode): unknown =>
      field.fields ? extractFields(field.fields, path, match, tree) : valueOf(field, path, match, tree);
    if (field.many) {
      return matches.map(one).filter((value) => value !== undefined);
    }
    const value = matches.length > 0 ? one(matches[0]!) : undefined;
    if (value !== undefined) return value;
    if (field.nullable) return null;
    throw new InvokeError(
      "ERR_HTML_FIELD_MISSING",
      `${label}: field '${path}' (selector ${JSON.stringify(field.selector)}) matched ${
        field.type === "attr" && matches.length > 0
          ? `an element without '${field.attr}'`
          : "nothing"
      }. Declare it 'nullable: true' when it may be absent.`,
      { field: path },
    );
  }

  function extractFields(
    fields: Record<string, Field>,
    prefix: string,
    scope: Scope,
    tree: Tree,
  ): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [name, field] of Object.entries(fields)) {
      const path = prefix ? `${prefix}.${name}` : name;
      out[name] = extractField(field, path, scope, tree);
    }
    return out;
  }

  return {
    async invoke({ document }: { document: Parsed }): Promise<{ fields: Record<string, unknown> }> {
      const tree: Tree = { index: indexTree(document.nodes), hast: toHast(document.nodes), nodes: document.nodes };
      return { fields: extractFields(resource.fields, "", "root", tree) };
    },
  };
}

