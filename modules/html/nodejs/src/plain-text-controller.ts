import { toText } from "hast-util-to-text";
import { toHast } from "./hast-tree.js";
import type { Parsed } from "./html-node.js";

/** The `innerText` rendering with the default UA stylesheet and no author CSS,
 *  which is what hast-util-to-text implements. */
export async function create() {
  return {
    async invoke({ document }: { document: Parsed }): Promise<{ text: string }> {
      return { text: toText(toHast(document.nodes).root) };
    },
  };
}
