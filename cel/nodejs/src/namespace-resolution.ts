/**
 * Turning `Alias.fn(x)` into a qualified call.
 *
 * `Alias.fn(x)` and `obj.method(x)` are **the same syntax** — a call written on a
 * receiver — so no parser can tell them apart, and only a set of names that denote
 * namespaces rather than values can. That set comes from the host, which is why
 * this is a separate total tree-to-tree pass rather than a parser rule: the parser
 * has one input and this has two.
 *
 * The pass is total — it visits every node and rewrites every receiver call whose
 * receiver is a bare identifier in the set, wherever it sits. It is also the only
 * producer of `qcall`, and `cel` and `optional` can never be in the set, because
 * the standard macros are written on them (`cel.bind(…)`, `optional.of(…)`) and a
 * namespace would capture those calls instead.
 *
 * A resolved tree records the set it was resolved under, so a consumer given a tree
 * can tell whether it was resolved under the set it is about to check it against —
 * the alternative is a tree that looks resolved and silently is not.
 */

import { isIdentifierSpelling, isReservedWord } from "./reserved-words.js";
import type { CelMapEntry, CelNode } from "./syntax-tree.js";

/** Names that can never be registered as a namespace. */
export const RESERVED_NAMESPACES: readonly string[] = ["cel", "optional"];

/** A namespace set a host cannot have: the name is not a name, or is reserved. */
export class CelNamespaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CelNamespaceError";
  }
}

/**
 * Validates a namespace set and puts it in a canonical order, so that two sets with
 * the same names compare equal however the host listed them.
 */
export function normalizeNamespaces(names: Iterable<string>): readonly string[] {
  const normalized: string[] = [];
  for (const name of names) {
    if (!isIdentifierSpelling(name)) {
      throw new CelNamespaceError(`${JSON.stringify(name)} is not spelled as a name, so it names no namespace`);
    }
    if (isReservedWord(name)) {
      throw new CelNamespaceError(`${JSON.stringify(name)} is a reserved word, so it names no namespace`);
    }
    if (RESERVED_NAMESPACES.includes(name)) {
      throw new CelNamespaceError(
        `${JSON.stringify(name)} is reserved: the standard macros are written on it, and a namespace would capture them`,
      );
    }
    if (!normalized.includes(name)) normalized.push(name);
  }
  return normalized.sort();
}

export function namespaceSetsEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((name, at) => name === right[at]);
}

/** Rewrites every call on a name of the set into a `qcall`. Total; shares what it does not change. */
export function resolveNamespaces(root: CelNode, namespaces: readonly string[]): CelNode {
  // With no namespaces the pass is the identity — nothing can match an empty set — so it
  // answers without walking. Every site with no module names takes this path, which is why
  // it is worth stating rather than leaving to the structural sharing below.
  if (namespaces.length === 0) return root;
  const resolved = mapChildren(root, (child) => resolveNamespaces(child, namespaces));
  if (resolved.kind !== "receiverCall") return resolved;
  const receiver = resolved.receiver;
  // An absolute name denotes a value the environment declares, never a namespace: a
  // namespaced call has exactly one spelling, and `.Alias.fn(x)` is not it.
  if (receiver.kind !== "ident" || receiver.absolute || !namespaces.includes(receiver.name)) {
    return resolved;
  }
  return {
    kind: "qcall",
    namespace: receiver.name,
    namespaceRange: receiver.range,
    name: resolved.name,
    nameRange: resolved.nameRange,
    args: resolved.args,
    range: resolved.range,
  };
}

/** Rebuilds a node from its mapped children, returning the original when none moved. */
function mapChildren(node: CelNode, map: (child: CelNode) => CelNode): CelNode {
  switch (node.kind) {
    case "literal":
    case "ident":
    case "unparsed":
      return node;
    case "list": {
      let moved = false;
      const elements = node.elements.map((element) => {
        const value = map(element.value);
        if (value === element.value) return element;
        moved = true;
        return { ...element, value };
      });
      return moved ? { ...node, elements } : node;
    }
    case "map": {
      let moved = false;
      const entries: CelMapEntry[] = node.entries.map((entry) => {
        const key = map(entry.key);
        const value = map(entry.value);
        if (key === entry.key && value === entry.value) return entry;
        moved = true;
        return { ...entry, key, value };
      });
      return moved ? { ...node, entries } : node;
    }
    case "select": {
      const operand = map(node.operand);
      return operand === node.operand ? node : { ...node, operand };
    }
    case "index": {
      const operand = map(node.operand);
      const index = map(node.index);
      return operand === node.operand && index === node.index ? node : { ...node, operand, index };
    }
    case "call":
    case "qcall": {
      const args = mapList(node.args, map);
      return args ? { ...node, args } : node;
    }
    case "receiverCall": {
      const receiver = map(node.receiver);
      const args = mapList(node.args, map);
      if (receiver === node.receiver && !args) return node;
      return { ...node, receiver, args: args ?? node.args };
    }
    case "unary": {
      const operand = map(node.operand);
      return operand === node.operand ? node : { ...node, operand };
    }
    case "binary": {
      const left = map(node.left);
      const right = map(node.right);
      return left === node.left && right === node.right ? node : { ...node, left, right };
    }
    case "conditional": {
      const condition = map(node.condition);
      const whenTrue = map(node.whenTrue);
      const whenFalse = map(node.whenFalse);
      return condition === node.condition && whenTrue === node.whenTrue && whenFalse === node.whenFalse
        ? node
        : { ...node, condition, whenTrue, whenFalse };
    }
  }
}

/** The mapped list, or nothing when every element is the one it started as. */
function mapList(
  nodes: readonly CelNode[],
  map: (child: CelNode) => CelNode,
): readonly CelNode[] | undefined {
  let moved = false;
  const mapped = nodes.map((node) => {
    const next = map(node);
    if (next !== node) moved = true;
    return next;
  });
  return moved ? mapped : undefined;
}
