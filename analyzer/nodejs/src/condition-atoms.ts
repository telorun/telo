/**
 * A condition read as boolean structure over ATOMS — the one canonicalizer a
 * template definition's check uses to tell which of its choices move together.
 *
 * A condition splits on `!`, `&&` and `||`; what is left is a leaf. `a != b` is
 * read as `!(a == b)` and the operands of `==` are ordered by their canonical
 * text, so `self.adminPort != self.port` and `self.port == self.adminPort` name
 * one atom, the first negated. A leaf's canonical text is its tree printed one
 * way — no layout, one quoting — so two spellings of one expression are one
 * atom. Which leaves are atoms (an open read) and which are evaluated (closed
 * reads only) is the caller's to say.
 *
 * Browser-safe.
 */
import { parseExpression } from "@telorun/cel";
import { wrapCelAst, type CelNode } from "./cel-ast.js";

/** A condition's boolean structure. */
export type BooleanShape =
  | { readonly kind: "not"; readonly operand: BooleanShape }
  | { readonly kind: "and" | "or"; readonly left: BooleanShape; readonly right: BooleanShape }
  /** A leaf: its canonical text, its source text, and whether it was written
   *  negated (`a != b`, read as `!(a == b)`). */
  | { readonly kind: "leaf"; readonly canonical: string; readonly source: string; readonly negated: boolean };

/** A condition's shape, or the engine's syntax refusal. */
export function conditionShape(source: string): { shape: BooleanShape } | { parseError: string } {
  const parsed = parseExpression(source);
  const diagnostic = parsed.diagnostics[0];
  if (diagnostic) return { parseError: diagnostic.message };
  return { shape: shapeOf(wrapCelAst(parsed.root, 0), source) };
}

function shapeOf(node: CelNode, source: string): BooleanShape {
  if (node.kind === "unary" && node.op === "!") return { kind: "not", operand: shapeOf(node.operand, source) };
  if (node.kind === "binary" && (node.op === "&&" || node.op === "||")) {
    return {
      kind: node.op === "&&" ? "and" : "or",
      left: shapeOf(node.left, source),
      right: shapeOf(node.right, source),
    };
  }
  const text = source.slice(node.range[0], node.range[1]);
  if (node.kind === "binary" && node.op === "!=") {
    return { kind: "leaf", canonical: canonicalEquality(node.left, node.right), source: text, negated: true };
  }
  return { kind: "leaf", canonical: canonicalText(node), source: text, negated: false };
}

function canonicalEquality(left: CelNode, right: CelNode): string {
  const [a, b] = [canonicalText(left), canonicalText(right)].sort();
  return `${a} == ${b}`;
}

/** Every leaf of a shape, in written order. */
export function leavesOf(shape: BooleanShape): Extract<BooleanShape, { kind: "leaf" }>[] {
  if (shape.kind === "leaf") return [shape];
  if (shape.kind === "not") return leavesOf(shape.operand);
  return [...leavesOf(shape.left), ...leavesOf(shape.right)];
}

/** The value of a shape, each leaf's value given by `leaf`. */
export function evaluateShape(
  shape: BooleanShape,
  leaf: (leaf: Extract<BooleanShape, { kind: "leaf" }>) => boolean,
): boolean {
  switch (shape.kind) {
    case "leaf": {
      const value = leaf(shape);
      return shape.negated ? !value : value;
    }
    case "not":
      return !evaluateShape(shape.operand, leaf);
    case "and":
      return evaluateShape(shape.left, leaf) && evaluateShape(shape.right, leaf);
    case "or":
      return evaluateShape(shape.left, leaf) || evaluateShape(shape.right, leaf);
  }
}

/** The canonical text of an expression: one spelling for every layout. */
export function canonicalSource(source: string): string | undefined {
  const parsed = parseExpression(source);
  if (parsed.diagnostics.length > 0) return undefined;
  return canonicalText(wrapCelAst(parsed.root, 0));
}

/** The canonical text of a leaf, for a leaf whose `==` is the atom itself:
 *  `a == b` with its operands ordered. */
export function canonicalText(node: CelNode): string {
  switch (node.kind) {
    case "literal":
      return literalText(node.value);
    case "ident":
      return node.name;
    case "member":
      return `${canonicalText(node.target)}${node.optional ? ".?" : "."}${node.property}`;
    case "index":
      return `${canonicalText(node.target)}[${node.optional ? "?" : ""}${canonicalText(node.index)}]`;
    case "call":
      return `${node.name}(${node.args.map(canonicalText).join(", ")})`;
    case "methodCall":
      return `${canonicalText(node.receiver)}.${node.name}(${node.args.map(canonicalText).join(", ")})`;
    case "list":
      return `[${node.items.map(canonicalText).join(", ")}]`;
    case "map":
      return `{${node.entries.map((e) => `${canonicalText(e.key)}: ${canonicalText(e.value)}`).join(", ")}}`;
    case "ternary":
      return `(${canonicalText(node.cond)} ? ${canonicalText(node.then)} : ${canonicalText(node.else)})`;
    case "unary":
      return `${node.op}${wrapped(node.operand)}`;
    case "binary":
      if (node.op === "==") return canonicalEquality(node.left, node.right);
      return `${wrapped(node.left)} ${node.op} ${wrapped(node.right)}`;
  }
}

function wrapped(node: CelNode): string {
  const text = canonicalText(node);
  return node.kind === "binary" || node.kind === "ternary" ? `(${text})` : text;
}

function literalText(value: unknown): string {
  if (typeof value === "string") return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Uint8Array) return `b'${[...value].map((b) => `\\x${b.toString(16).padStart(2, "0")}`).join("")}'`;
  if (value === null || value === undefined) return "null";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
