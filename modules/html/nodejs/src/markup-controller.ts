import { InvokeError, type ResourceManifest } from "@telorun/sdk";
import type { Parsed } from "./html-node.js";
import { findUnserializable, serializeNodes } from "./html-serialization.js";

export async function create(resource: ResourceManifest) {
  const label = `${resource.kind} '${resource.metadata.name}'`;
  return {
    async invoke({ document }: { document: Parsed }): Promise<{ html: string }> {
      const problem = findUnserializable(document.nodes, "nodes");
      if (problem) {
        throw new InvokeError(
          "ERR_HTML_NOT_SERIALIZABLE",
          `${label}: ${problem.path} cannot be written as markup that reads back unchanged — ${problem.reason}.`,
          { path: problem.path },
        );
      }
      return { html: serializeNodes(document.nodes) };
    },
  };
}
