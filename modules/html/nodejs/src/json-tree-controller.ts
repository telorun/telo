import { effectiveBaseUrl } from "./base-url.js";
import { decodeHtmlBytes } from "./html-bytes-decoding.js";
import type { Parsed } from "./html-node.js";
import { parseHtml } from "./parse5-tree.js";

interface JsonTreeInputs {
  html: string | { bytes: Uint8Array; charset?: string };
  fragment?: boolean;
  baseUrl?: string;
}

export async function create() {
  return {
    async invoke(inputs: JsonTreeInputs): Promise<Parsed> {
      const text =
        typeof inputs.html === "string"
          ? inputs.html
          : decodeHtmlBytes(inputs.html.bytes, inputs.html.charset);
      const nodes = parseHtml(text, inputs.fragment === true);
      const baseUrl = effectiveBaseUrl(nodes, inputs.baseUrl);
      return baseUrl === undefined ? { nodes } : { nodes, baseUrl };
    },
  };
}
