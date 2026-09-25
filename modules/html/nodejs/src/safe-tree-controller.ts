import { InvokeError, type ResourceManifest } from "@telorun/sdk";
import type { HtmlNode, Parsed } from "./html-node.js";
import { checkReadback } from "./html-serialization.js";
import { policyProblems, sanitizeNodes, type SanitizePolicy } from "./sanitize-policy.js";

type SafeTreeResource = ResourceManifest & SanitizePolicy;

/** How many times sanitized output is replaced by its readback before a tree
 *  that still does not read back as itself is refused. */
const READBACK_ROUNDS = 3;

export async function create(resource: SafeTreeResource) {
  const label = `${resource.kind} '${resource.metadata.name}'`;
  const problems = policyProblems(resource);
  if (problems.length > 0) {
    throw new InvokeError(
      "ERR_HTML_SANITIZE_POLICY_INVALID",
      `${label}: the policy is refused — ${problems.join("; ")}.`,
      { problems },
    );
  }
  return {
    async invoke({ document }: { document: Parsed }): Promise<Parsed> {
      const nodes = settled(sanitizeNodes(document.nodes, resource), label);
      return document.baseUrl === undefined ? { nodes } : { nodes, baseUrl: document.baseUrl };
    },
  };
}

/** The sanitized tree, or what it reads back as when markup cannot carry it —
 *  so the output always serializes. */
function settled(nodes: HtmlNode[], label: string): HtmlNode[] {
  let current = nodes;
  for (let round = 0; ; round++) {
    const { readback, problem } = checkReadback(current);
    if (!problem) return current;
    if (round === READBACK_ROUNDS) {
      throw new InvokeError(
        "ERR_HTML_NOT_SERIALIZABLE",
        `${label}: the sanitized tree still does not read back as itself after ${READBACK_ROUNDS} readbacks — ${problem.path}: ${problem.reason}.`,
        { path: problem.path },
      );
    }
    current = readback;
  }
}
