/**
 * Whether two trees are the same expression.
 *
 * Ranges are **not** compared: two trees of the same expression written with
 * different spacing or parentheses hold different offsets, and the round-trip
 * contract (`serializer.ts`) is exactly that serializing and re-parsing gives back
 * the same expression — not the same text.
 *
 * Numbers compare by identity rather than by `==`, so `-0.0` is not `0.0` and a
 * `NaN` equals itself: both are distinct literals a round-trip must preserve.
 */

import type { CelLiteral, CelNode } from "./syntax-tree.js";

function literalsEqual(left: CelLiteral, right: CelLiteral): boolean {
  if (left.type !== right.type) return false;
  switch (left.type) {
    case "null":
      return true;
    case "int":
    case "uint":
      return left.value === (right as typeof left).value;
    case "double":
      return Object.is(left.value, (right as typeof left).value);
    case "bool":
    case "string":
      return left.value === (right as typeof left).value;
    case "bytes": {
      const other = (right as typeof left).value;
      return left.value.length === other.length && left.value.every((byte, at) => byte === other[at]);
    }
  }
}

function listsEqual(left: readonly CelNode[], right: readonly CelNode[]): boolean {
  return left.length === right.length && left.every((node, at) => treesEqual(node, right[at]!));
}

/** Whether the two trees are the same expression, their ranges aside. */
export function treesEqual(left: CelNode, right: CelNode): boolean {
  if (left.kind !== right.kind) return false;
  switch (left.kind) {
    case "literal":
      return literalsEqual(left.literal, (right as typeof left).literal);
    case "ident": {
      const other = right as typeof left;
      // Absolute changes what the name resolves against, so it is part of the expression;
      // whether a member was written between backticks is not.
      return left.name === other.name && left.absolute === other.absolute;
    }
    case "unparsed":
      return true;
    case "list": {
      const other = (right as typeof left).elements;
      return (
        left.elements.length === other.length &&
        left.elements.every(
          (element, at) =>
            element.optional === other[at]!.optional && treesEqual(element.value, other[at]!.value),
        )
      );
    }
    case "map": {
      const other = (right as typeof left).entries;
      return (
        left.entries.length === other.length &&
        left.entries.every(
          (entry, at) =>
            entry.optional === other[at]!.optional &&
            treesEqual(entry.key, other[at]!.key) &&
            treesEqual(entry.value, other[at]!.value),
        )
      );
    }
    case "select": {
      const other = right as typeof left;
      return (
        left.field === other.field &&
        left.optional === other.optional &&
        treesEqual(left.operand, other.operand)
      );
    }
    case "index": {
      const other = right as typeof left;
      return (
        left.optional === other.optional &&
        treesEqual(left.operand, other.operand) &&
        treesEqual(left.index, other.index)
      );
    }
    case "call": {
      const other = right as typeof left;
      return left.name === other.name && listsEqual(left.args, other.args);
    }
    case "receiverCall": {
      const other = right as typeof left;
      return (
        left.name === other.name &&
        treesEqual(left.receiver, other.receiver) &&
        listsEqual(left.args, other.args)
      );
    }
    case "qcall": {
      const other = right as typeof left;
      return (
        left.namespace === other.namespace && left.name === other.name && listsEqual(left.args, other.args)
      );
    }
    case "unary": {
      const other = right as typeof left;
      return left.operator === other.operator && treesEqual(left.operand, other.operand);
    }
    case "binary": {
      const other = right as typeof left;
      return (
        left.operator === other.operator &&
        treesEqual(left.left, other.left) &&
        treesEqual(left.right, other.right)
      );
    }
    case "conditional": {
      const other = right as typeof left;
      return (
        treesEqual(left.condition, other.condition) &&
        treesEqual(left.whenTrue, other.whenTrue) &&
        treesEqual(left.whenFalse, other.whenFalse)
      );
    }
  }
}
