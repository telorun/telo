/**
 * What a module call's argument is when it is WRITTEN AS LITERALS ALONE — read off
 * the tree, never evaluated.
 *
 * A host asks because some parameters accept only a value fixed where the call is
 * written: a `Text` parameter is a text a catalog can look up, which an
 * expression's result never is (`TEXT_ARGUMENT_COMPUTED`). The same reading gives
 * the keys of a map literal and what each holds, which is how a message's values
 * are judged where they are written.
 */
import { qualifiedCalls, type CelNode } from "@telorun/cel";
import { moduleCallNodes } from "./module-call.js";

/** A literal argument's value: a string, a bigint (an `int` or `uint`), a number
 *  (a `double`), a boolean, null, bytes, or a list or string-keyed map of them. */
export interface LiteralValue {
  readonly value: unknown;
}

/** The value `node` is written as, when it is literals alone. */
export function literalValueOf(node: CelNode): LiteralValue | undefined {
  switch (node.kind) {
    case "literal": {
      const literal = node.literal;
      return { value: literal.type === "null" ? null : literal.value };
    }
    case "unary": {
      if (node.operator !== "-" || node.operand.kind !== "literal") return undefined;
      const literal = node.operand.literal;
      if (literal.type === "int") return { value: -literal.value };
      if (literal.type === "double") return { value: -literal.value };
      return undefined;
    }
    case "list": {
      const out: unknown[] = [];
      for (const element of node.elements) {
        if (element.optional) return undefined;
        const value = literalValueOf(element.value);
        if (!value) return undefined;
        out.push(value.value);
      }
      return { value: out };
    }
    case "map": {
      const out: Record<string, unknown> = {};
      for (const entry of node.entries) {
        if (entry.optional || entry.key.kind !== "literal" || entry.key.literal.type !== "string") return undefined;
        const value = literalValueOf(entry.value);
        if (!value) return undefined;
        out[entry.key.literal.value] = value.value;
      }
      return { value: out };
    }
    default:
      return undefined;
  }
}

/** The CEL type a literal node is written as, or undefined for anything else. */
export function literalTypeOf(node: CelNode): string | undefined {
  if (node.kind === "literal") return node.literal.type === "null" ? "null_type" : node.literal.type;
  if (node.kind === "unary" && node.operator === "-" && node.operand.kind === "literal") {
    return node.operand.literal.type;
  }
  return undefined;
}

/** One entry of a map literal whose key is a string literal. */
export interface MapLiteralEntry {
  readonly key: string;
  readonly value: CelNode;
}

/** The entries of a map literal keyed by string literals, or undefined for any
 *  other node. */
export function mapLiteralEntries(node: CelNode): readonly MapLiteralEntry[] | undefined {
  if (node.kind !== "map") return undefined;
  const out: MapLiteralEntry[] = [];
  for (const entry of node.entries) {
    if (entry.optional || entry.key.kind !== "literal" || entry.key.literal.type !== "string") return undefined;
    out.push({ key: entry.key.literal.value, value: entry.value });
  }
  return out;
}

/** One argument of a module call as written: its value when it is literals alone. */
export type WrittenArgument = { readonly literal: true; readonly value: unknown } | { readonly literal: false };

/** The arguments every qualified call in a tree is written with, per call. */
export interface WrittenCall {
  readonly qualified: string;
  readonly arguments: readonly WrittenArgument[];
}

/** Every qualified call in `root` with how each argument is written. */
export function writtenCalls(root: CelNode): WrittenCall[] {
  if (qualifiedCalls(root).length === 0) return [];
  return moduleCallNodes(root).map(({ call }) => ({
    qualified: call.qualified,
    arguments: call.args.map((arg): WrittenArgument => {
      const literal = literalValueOf(arg);
      return literal ? { literal: true, value: literal.value } : { literal: false };
    }),
  }));
}
