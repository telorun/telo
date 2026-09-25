import type { ResourceManifest } from "@telorun/sdk";
import type { Parsed } from "./html-node.js";
import { selectAll } from "./selector-matcher.js";
import { indexTree } from "./tree-index.js";

interface SelectionResource extends ResourceManifest {
  selector: string;
}

export async function create(resource: SelectionResource) {
  return {
    async invoke({ document }: { document: Parsed }): Promise<Parsed> {
      const nodes = selectAll(resource.selector, indexTree(document.nodes), "root");
      return document.baseUrl === undefined ? { nodes } : { nodes, baseUrl: document.baseUrl };
    },
  };
}
