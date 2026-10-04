/**
 * The tree back to CEL source.
 *
 * The contract is round-trip: serializing any tree the parser produced yields text
 * that parses to an **equal** tree (`tree-equality.ts`), and a `qcall` writes back
 * as the `Alias.fn(x)` it was read from. That is what makes a tree, rather than the
 * author's text, something a tool may hold and hand back — a rewrite, a quick fix,
 * a stored expression.
 *
 * Parentheses are placed from precedence alone, never kept from the source: the
 * tree records structure, and the source's own parentheses are not structure.
 *
 * It refuses rather than guesses. A tree that cannot be written as CEL — an
 * `unparsed` hole left by error recovery, a `NaN` double, an integer outside its
 * type's range, a name that is not a name — throws, because text that does not
 * parse back would make every later answer about it wrong.
 */

import { MAX_INT, MAX_UINT, MIN_INT } from "./lexer.js";
import { isIdentifierSpelling, isReservedWord } from "./reserved-words.js";
import type { CelLiteral, CelNode } from "./syntax-tree.js";

export class CelSerializeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CelSerializeError";
  }
}

/** Binding strength, loosest first; a child is wrapped when it binds more loosely than its slot needs. */
const PRECEDENCE = {
  conditional: 0,
  or: 1,
  and: 2,
  relation: 3,
  additive: 4,
  multiplicative: 5,
  unary: 6,
  postfix: 7,
  primary: 8,
} as const;

const BINARY_PRECEDENCE: Record<string, number> = {
  "||": PRECEDENCE.or,
  "&&": PRECEDENCE.and,
  "==": PRECEDENCE.relation,
  "!=": PRECEDENCE.relation,
  "<": PRECEDENCE.relation,
  "<=": PRECEDENCE.relation,
  ">": PRECEDENCE.relation,
  ">=": PRECEDENCE.relation,
  in: PRECEDENCE.relation,
  "+": PRECEDENCE.additive,
  "-": PRECEDENCE.additive,
  "*": PRECEDENCE.multiplicative,
  "/": PRECEDENCE.multiplicative,
  "%": PRECEDENCE.multiplicative,
};

function isNegativeNumber(literal: CelLiteral): boolean {
  if (literal.type === "int") return literal.value < 0n;
  if (literal.type === "double") return literal.value < 0 || Object.is(literal.value, -0);
  return false;
}

/** A literal written with a leading `-` binds as loosely as a negation does. */
function precedenceOf(node: CelNode): number {
  switch (node.kind) {
    case "literal":
      return isNegativeNumber(node.literal) ? PRECEDENCE.unary : PRECEDENCE.primary;
    case "ident":
    case "list":
    case "map":
      return PRECEDENCE.primary;
    case "select":
    case "index":
    case "call":
    case "receiverCall":
    case "qcall":
      return PRECEDENCE.postfix;
    case "unary":
      return PRECEDENCE.unary;
    case "binary":
      return BINARY_PRECEDENCE[node.operator]!;
    case "conditional":
      return PRECEDENCE.conditional;
    case "unparsed":
      throw new CelSerializeError("an unparsed expression has no source to write");
  }
}

function name(text: string, what: string): string {
  if (!isIdentifierSpelling(text) || isReservedWord(text)) {
    throw new CelSerializeError(`${JSON.stringify(text)} is not a name, so it cannot be written as a ${what}`);
  }
  return text;
}

/** A member or a called function may be named by any word, reserved or not. */
function memberName(text: string, what: string): string {
  if (!isIdentifierSpelling(text)) {
    throw new CelSerializeError(`${JSON.stringify(text)} is not a name, so it cannot be written as a ${what}`);
  }
  return text;
}

/**
 * A member name, between backticks where it needs them. A name that is not spelled as an
 * identifier is quoted whether or not it was written that way, because that is the only
 * spelling it has; a backtick inside one has none at all, so it is refused.
 */
function fieldName(text: string, quoted: boolean): string {
  if (!quoted && isIdentifierSpelling(text)) return text;
  if (text.includes("`") || text.includes("\n") || text === "") {
    throw new CelSerializeError(`${JSON.stringify(text)} cannot be written as a member name`);
  }
  return `\`${text}\``;
}

function writeDouble(value: number): string {
  if (Number.isNaN(value)) {
    throw new CelSerializeError("a double that is not a number cannot be written as a literal");
  }
  if (value === Number.POSITIVE_INFINITY) return "1e999";
  if (value === Number.NEGATIVE_INFINITY) return "-1e999";
  const sign = value < 0 || Object.is(value, -0) ? "-" : "";
  const text = String(Math.abs(value));
  return `${sign}${/[.e]/.test(text) ? text : `${text}.0`}`;
}

/**
 * A string literal, always in double quotes.
 *
 * **One spelling, chosen rather than remembered.** The tree records a string's VALUE and not
 * the quote the author typed — the source's own formatting is not structure, which is the
 * same rule that makes the serializer drop redundant parentheses — so a round trip
 * normalizes `'x'` to `"x"`. Both are CEL and the parser reads either.
 *
 * The cost lands on a quick fix, which is written by rewriting the tree and serializing it
 * back **into a YAML scalar**: a double-quoted CEL literal inside a double-quoted scalar has
 * to be escaped, so a repair reads `!cel "a.startsWith(\"x\")"` where the author wrote
 * `'x'`. Choosing the quote here cannot fix that — a single-quoted YAML scalar wants the
 * opposite choice, and this engine does not know which scalar the text will land in. Picking
 * the YAML quoting that needs no escaping is the EDITOR's, which has both halves in hand.
 */
function writeString(value: string): string {
  const quote = '"';
  let text = quote;
  for (const unit of value) {
    const code = unit.codePointAt(0)!;
    if (unit === "\\") text += "\\\\";
    else if (unit === quote) text += `\\${quote}`;
    else if (unit === "\n") text += "\\n";
    else if (unit === "\r") text += "\\r";
    else if (unit === "\t") text += "\\t";
    else if (code < 0x20 || code === 0x7f) text += `\\x${code.toString(16).padStart(2, "0")}`;
    else text += unit;
  }
  return `${text}${quote}`;
}

function writeBytes(value: Uint8Array): string {
  let text = 'b"';
  for (const byte of value) {
    if (byte === 0x5c) text += "\\\\";
    else if (byte === 0x22) text += '\\"';
    else if (byte >= 0x20 && byte <= 0x7e) text += String.fromCharCode(byte);
    else text += `\\x${byte.toString(16).padStart(2, "0")}`;
  }
  return `${text}"`;
}

function writeLiteral(literal: CelLiteral): string {
  switch (literal.type) {
    case "int":
      if (literal.value < MIN_INT || literal.value > MAX_INT) {
        throw new CelSerializeError(`${literal.value} is outside the range of a 64-bit integer`);
      }
      return `${literal.value}`;
    case "uint":
      if (literal.value < 0n || literal.value > MAX_UINT) {
        throw new CelSerializeError(`${literal.value} is outside the range of an unsigned 64-bit integer`);
      }
      return `${literal.value}u`;
    case "double":
      return writeDouble(literal.value);
    case "string":
      return writeString(literal.value);
    case "bytes":
      return writeBytes(literal.value);
    case "bool":
      return literal.value ? "true" : "false";
    case "null":
      return "null";
  }
}

/** Writes `node` for a slot that binds at least as tightly as `needs`. */
function write(node: CelNode, needs: number): string {
  const text = writeNode(node);
  return precedenceOf(node) < needs ? `(${text})` : text;
}

function writeNode(node: CelNode): string {
  switch (node.kind) {
    case "literal":
      return writeLiteral(node.literal);
    case "ident":
      return `${node.absolute ? "." : ""}${name(node.name, "name")}`;
    case "list":
      return `[${node.elements
        .map((element) => `${element.optional ? "?" : ""}${write(element.value, PRECEDENCE.conditional)}`)
        .join(", ")}]`;
    case "map":
      return `{${node.entries
        .map(
          (entry) =>
            `${entry.optional ? "?" : ""}${write(entry.key, PRECEDENCE.conditional)}: ${write(entry.value, PRECEDENCE.conditional)}`,
        )
        .join(", ")}}`;
    case "select":
      return `${write(node.operand, PRECEDENCE.postfix)}.${node.optional ? "?" : ""}${fieldName(node.field, node.quoted)}`;
    case "index":
      return `${write(node.operand, PRECEDENCE.postfix)}[${node.optional ? "?" : ""}${write(node.index, PRECEDENCE.conditional)}]`;
    case "call":
      return `${name(node.name, "function name")}(${writeArguments(node.args)})`;
    case "receiverCall":
      return `${write(node.receiver, PRECEDENCE.postfix)}.${memberName(node.name, "function name")}(${writeArguments(node.args)})`;
    case "qcall":
      return `${name(node.namespace, "namespace")}.${memberName(node.name, "function name")}(${writeArguments(node.args)})`;
    case "unary":
      return `${node.operator}${writeUnaryOperand(node.operator, node.operand)}`;
    case "binary":
      return `${write(node.left, BINARY_PRECEDENCE[node.operator]!)} ${node.operator} ${write(node.right, BINARY_PRECEDENCE[node.operator]! + 1)}`;
    case "conditional":
      return `${write(node.condition, PRECEDENCE.or)} ? ${write(node.whenTrue, PRECEDENCE.conditional)} : ${write(node.whenFalse, PRECEDENCE.conditional)}`;
    case "unparsed":
      throw new CelSerializeError("an unparsed expression has no source to write");
  }
}

/**
 * A minus directly on a non-negative numeric literal would read back as part of the
 * literal, so it is parenthesized: `-(1)` stays a negation of one.
 */
function writeUnaryOperand(operator: string, operand: CelNode): string {
  if (operator === "-" && operand.kind === "literal" && !isNegativeNumber(operand.literal)) {
    if (operand.literal.type === "int" || operand.literal.type === "double") {
      return `(${writeLiteral(operand.literal)})`;
    }
  }
  return write(operand, PRECEDENCE.unary);
}

function writeArguments(args: readonly CelNode[]): string {
  return args.map((argument) => write(argument, PRECEDENCE.conditional)).join(", ");
}

/** The CEL source of a tree. Throws on a tree that has none. */
export function serializeTree(root: CelNode): string {
  return write(root, PRECEDENCE.conditional);
}
