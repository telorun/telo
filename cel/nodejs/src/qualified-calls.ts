/**
 * Every call an expression makes on a namespace.
 *
 * Only a resolved tree holds one (`namespace-resolution.ts`), so the answer is
 * always relative to the namespace set the tree was resolved under. A consumer uses
 * it to say which functions of which other modules an expression reaches, which
 * cannot be re-derived from the expression alone — the name set is not in the text.
 *
 * The order is source order: a call before any call written inside it.
 */

import type { CelNode, SourceRange } from "./syntax-tree.js";
import { walkTree } from "./syntax-tree.js";

export interface QualifiedCall {
  readonly namespace: string;
  readonly name: string;
  /** `<namespace>.<name>`, the spelling the call was written with. */
  readonly qualifiedName: string;
  readonly arity: number;
  readonly range: SourceRange;
  readonly nameRange: SourceRange;
}

export function qualifiedCalls(root: CelNode): readonly QualifiedCall[] {
  const calls: QualifiedCall[] = [];
  for (const node of walkTree(root)) {
    if (node.kind !== "qcall") continue;
    calls.push({
      namespace: node.namespace,
      name: node.name,
      qualifiedName: `${node.namespace}.${node.name}`,
      arity: node.args.length,
      range: node.range,
      nameRange: node.nameRange,
    });
  }
  return calls;
}
