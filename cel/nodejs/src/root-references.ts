/**
 * What an expression reads from its environment.
 *
 * The answer is the first identifier of every access chain — `request` in
 * `request.query.limit`, `xs` in `xs[0].id` — with three exclusions, each of which
 * would otherwise invent a dependency the expression does not have:
 *
 * - a name a comprehension or `cel.bind` binds, which the expression supplies itself;
 * - the namespace of a qualified call, which names a module rather than a value;
 * - the receiver of a call on a reserved namespace (`cel.bind(…)`, `optional.of(…)`),
 *   for the same reason.
 *
 * A function name is not an identifier node at all, so no call name can be mistaken
 * for a read. Field names are not nodes either, which is why only the root of a
 * chain is answered.
 *
 * The result is sorted and deduplicated: it is a set of names, and a consumer that
 * compares two expressions' reads must not see an ordering difference.
 */

import { namespaceMacroBinding, receiverMacroBinding } from "./comprehension-bindings.js";
import { RESERVED_NAMESPACES } from "./namespace-resolution.js";
import type { CelNode } from "./syntax-tree.js";

class BoundNames {
  private readonly depth = new Map<string, number>();

  bind(name: string): void {
    this.depth.set(name, (this.depth.get(name) ?? 0) + 1);
  }

  unbind(name: string): void {
    const held = this.depth.get(name)!;
    if (held === 1) this.depth.delete(name);
    else this.depth.set(name, held - 1);
  }

  has(name: string): boolean {
    return this.depth.has(name);
  }
}

/** Every name the expression reads from its environment, sorted. */
export function rootReferences(root: CelNode): readonly string[] {
  const found = new Set<string>();
  collect(root, new BoundNames(), found);
  return [...found].sort();
}

function collect(node: CelNode, bound: BoundNames, found: Set<string>): void {
  switch (node.kind) {
    case "ident":
      // An absolute name reads past every binding by construction, so a binding of the
      // same name says nothing about it.
      if (node.absolute || !bound.has(node.name)) found.add(node.name);
      return;
    case "literal":
    case "unparsed":
      return;
    case "receiverCall":
      collectCall(node, bound, found);
      return;
    case "list":
      for (const element of node.elements) collect(element.value, bound, found);
      return;
    case "map":
      for (const entry of node.entries) {
        collect(entry.key, bound, found);
        collect(entry.value, bound, found);
      }
      return;
    case "select":
      collect(node.operand, bound, found);
      return;
    case "index":
      collect(node.operand, bound, found);
      collect(node.index, bound, found);
      return;
    case "call":
    case "qcall":
      for (const argument of node.args) collect(argument, bound, found);
      return;
    case "unary":
      collect(node.operand, bound, found);
      return;
    case "binary":
      collect(node.left, bound, found);
      collect(node.right, bound, found);
      return;
    case "conditional":
      collect(node.condition, bound, found);
      collect(node.whenTrue, bound, found);
      collect(node.whenFalse, bound, found);
      return;
  }
}

function collectCall(
  node: Extract<CelNode, { kind: "receiverCall" }>,
  bound: BoundNames,
  found: Set<string>,
): void {
  const receiver = node.receiver;
  const onNamespace = receiver.kind === "ident" && RESERVED_NAMESPACES.includes(receiver.name);
  const binding = onNamespace
    ? namespaceMacroBinding((receiver as { name: string }).name, node.name, node.args.length)
    : receiverMacroBinding(node.name, node.args.length);
  if (!onNamespace) collect(receiver, bound, found);

  const variable = binding ? node.args[binding.variableArgument] : undefined;
  if (!binding || variable?.kind !== "ident") {
    for (const argument of node.args) collect(argument, bound, found);
    return;
  }

  for (const [at, argument] of node.args.entries()) {
    if (at === binding.variableArgument || binding.scopedArguments.includes(at)) continue;
    collect(argument, bound, found);
  }
  bound.bind(variable.name);
  for (const at of binding.scopedArguments) {
    const argument = node.args[at];
    if (argument) collect(argument, bound, found);
  }
  bound.unbind(variable.name);
}
