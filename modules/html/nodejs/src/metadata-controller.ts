import { resolveUrl } from "./base-url.js";
import { isHtmlElement, walkElements, type ElementNode, type HtmlNode, type Parsed } from "./html-node.js";

interface LinkEntry {
  rel: string[];
  href: string;
  type?: string;
  hreflang?: string;
  sizes?: string;
  media?: string;
  title?: string;
}

type JsonLdEntry = { value: unknown } | { error: string };

interface MetadataOutputs {
  title?: string;
  lang?: string;
  baseUrl?: string;
  meta: Record<string, string[]>;
  links: LinkEntry[];
  jsonLd: JsonLdEntry[];
}

const ASCII_WHITESPACE = /[\t\n\f\r ]+/;

function textContent(nodes: readonly HtmlNode[]): string {
  let out = "";
  for (const node of nodes) {
    if (node.type === "text") out += node.text;
    else if (node.type === "element") out += textContent(node.children);
  }
  return out;
}

function stripAndCollapse(text: string): string {
  return text.split(ASCII_WHITESPACE).filter(Boolean).join(" ");
}

function jsonLdEntry(script: ElementNode): JsonLdEntry {
  const text = textContent(script.children);
  try {
    return { value: JSON.parse(text) };
  } catch (err) {
    // A malformed block is reported in the output, never dropped.
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

export async function create() {
  return {
    async invoke({ document }: { document: Parsed }): Promise<MetadataOutputs> {
      const base = document.baseUrl;
      const out: MetadataOutputs = { meta: {}, links: [], jsonLd: [] };
      if (base !== undefined) out.baseUrl = base;
      for (const node of document.nodes) {
        if (isHtmlElement(node, "html") && node.attrs.lang !== undefined) out.lang = node.attrs.lang;
      }
      for (const element of walkElements(document.nodes)) {
        if (element.namespace !== undefined) continue;
        const attrs = element.attrs;
        switch (element.tag) {
          case "title":
            out.title ??= stripAndCollapse(textContent(element.children));
            break;
          case "meta":
            if (attrs.content === undefined) break;
            for (const key of new Set([attrs.name, attrs.property])) {
              if (key !== undefined) (out.meta[key] ??= []).push(attrs.content);
            }
            break;
          case "link": {
            if (attrs.href === undefined) break;
            const link: LinkEntry = {
              rel: (attrs.rel ?? "").toLowerCase().split(ASCII_WHITESPACE).filter(Boolean),
              href: resolveUrl(attrs.href, base),
            };
            for (const key of ["type", "hreflang", "sizes", "media", "title"] as const) {
              if (attrs[key] !== undefined) link[key] = attrs[key];
            }
            out.links.push(link);
            break;
          }
          case "script":
            if ((attrs.type ?? "").trim().toLowerCase() === "application/ld+json") {
              out.jsonLd.push(jsonLdEntry(element));
            }
            break;
        }
      }
      return out;
    },
  };
}
