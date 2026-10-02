/**
 * The canonical CEL syntax tree.
 *
 * Every node carries `range`, the half-open `[start, end)` span of UTF-16 code
 * units it covers in the source it was parsed from, so a diagnostic, a hover or a
 * rename can point at the text the author wrote. A tree built by hand carries
 * ranges too — the serializer and the queries read them, and a node with none
 * would make either answer silently wrong.
 *
 * Literals hold their decoded value in a tagged form rather than as a bare
 * JavaScript value: CEL's `int` and `uint` are both arbitrary-magnitude integers,
 * `1` and `1u` are different expressions, and a backend must be able to tell them
 * apart without consulting a runtime value class.
 *
 * `qcall` is the one node the parser never produces — see `namespace-resolution.ts`.
 */

/** Half-open span of UTF-16 code units: `[start, end)`. */
export type SourceRange = readonly [start: number, end: number];

export type CelLiteral =
  | { readonly type: "int"; readonly value: bigint }
  | { readonly type: "uint"; readonly value: bigint }
  | { readonly type: "double"; readonly value: number }
  | { readonly type: "string"; readonly value: string }
  | { readonly type: "bytes"; readonly value: Uint8Array }
  | { readonly type: "bool"; readonly value: boolean }
  | { readonly type: "null" };

export type CelUnaryOperator = "!" | "-";

export type CelBinaryOperator =
  | "||"
  | "&&"
  | "=="
  | "!="
  | "<"
  | "<="
  | ">"
  | ">="
  | "in"
  | "+"
  | "-"
  | "*"
  | "/"
  | "%";

interface Ranged {
  readonly range: SourceRange;
}

export interface CelLiteralNode extends Ranged {
  readonly kind: "literal";
  readonly literal: CelLiteral;
}

export interface CelIdentNode extends Ranged {
  readonly kind: "ident";
  readonly name: string;
  /**
   * `.y` — the name is resolved against the environment's own declarations, never
   * against a name something inside the expression bound. It is the only spelling for
   * the outer `request` where a comprehension variable is also called `request`.
   */
  readonly absolute: boolean;
}

/**
 * One element of a list literal. `optional` marks `[?x]`: the element holds an
 * `optional<T>` and contributes a `T`, and an absent one leaves no element behind.
 */
export interface CelListElement {
  readonly value: CelNode;
  readonly optional: boolean;
}

export interface CelListNode extends Ranged {
  readonly kind: "list";
  readonly elements: readonly CelListElement[];
}

/** One entry of a map literal. `optional` marks `{?k: v}`, as for a list element. */
export interface CelMapEntry {
  readonly key: CelNode;
  readonly value: CelNode;
  readonly optional: boolean;
}

export interface CelMapNode extends Ranged {
  readonly kind: "map";
  readonly entries: readonly CelMapEntry[];
}

/** `operand.field`, `operand.?field` when `optional`, `` operand.`field` `` when `quoted`. */
export interface CelSelectNode extends Ranged {
  readonly kind: "select";
  readonly operand: CelNode;
  /** The member's name, decoded: the text between the backticks for a quoted one. */
  readonly field: string;
  readonly fieldRange: SourceRange;
  readonly optional: boolean;
  /**
   * Written between backticks, which is how a member whose name is not spelled as an
   * identifier is read — `content-type`, `foo.txt`, `/api/v1`. It changes nothing about
   * what is read: the name is looked up exactly as a plain member's is.
   */
  readonly quoted: boolean;
}

/** `operand[index]`, and `operand[?index]` when `optional`. */
export interface CelIndexNode extends Ranged {
  readonly kind: "index";
  readonly operand: CelNode;
  readonly index: CelNode;
  readonly optional: boolean;
}

/** `name(args)`. */
export interface CelCallNode extends Ranged {
  readonly kind: "call";
  readonly name: string;
  readonly nameRange: SourceRange;
  readonly args: readonly CelNode[];
}

/** `receiver.name(args)`, including every macro call — nothing expands one here. */
export interface CelReceiverCallNode extends Ranged {
  readonly kind: "receiverCall";
  readonly receiver: CelNode;
  readonly name: string;
  readonly nameRange: SourceRange;
  readonly args: readonly CelNode[];
}

/** `namespace.name(args)`, where `namespace` names a module rather than a value. */
export interface CelQualifiedCallNode extends Ranged {
  readonly kind: "qcall";
  readonly namespace: string;
  readonly namespaceRange: SourceRange;
  readonly name: string;
  readonly nameRange: SourceRange;
  readonly args: readonly CelNode[];
}

export interface CelUnaryNode extends Ranged {
  readonly kind: "unary";
  readonly operator: CelUnaryOperator;
  readonly operand: CelNode;
}

export interface CelBinaryNode extends Ranged {
  readonly kind: "binary";
  readonly operator: CelBinaryOperator;
  readonly left: CelNode;
  readonly right: CelNode;
}

export interface CelConditionalNode extends Ranged {
  readonly kind: "conditional";
  readonly condition: CelNode;
  readonly whenTrue: CelNode;
  readonly whenFalse: CelNode;
}

/**
 * The hole error recovery leaves where an expression was expected and none could
 * be read. It stands for text the parser could not make sense of, so the tree
 * around it stays usable; it is never serializable and never evaluable.
 */
export interface CelUnparsedNode extends Ranged {
  readonly kind: "unparsed";
}

export type CelNode =
  | CelLiteralNode
  | CelIdentNode
  | CelListNode
  | CelMapNode
  | CelSelectNode
  | CelIndexNode
  | CelCallNode
  | CelReceiverCallNode
  | CelQualifiedCallNode
  | CelUnaryNode
  | CelBinaryNode
  | CelConditionalNode
  | CelUnparsedNode;

/** Every child node, in source order. The single reader of a node's shape for traversal. */
export function childNodes(node: CelNode): readonly CelNode[] {
  switch (node.kind) {
    case "literal":
    case "ident":
    case "unparsed":
      return [];
    case "list":
      return node.elements.map((element) => element.value);
    case "map":
      return node.entries.flatMap((entry) => [entry.key, entry.value]);
    case "select":
      return [node.operand];
    case "index":
      return [node.operand, node.index];
    case "call":
      return node.args;
    case "receiverCall":
      return [node.receiver, ...node.args];
    case "qcall":
      return node.args;
    case "unary":
      return [node.operand];
    case "binary":
      return [node.left, node.right];
    case "conditional":
      return [node.condition, node.whenTrue, node.whenFalse];
  }
}

/** Depth-first pre-order walk over the whole tree. */
export function* walkTree(root: CelNode): Generator<CelNode> {
  yield root;
  for (const child of childNodes(root)) yield* walkTree(child);
}

/** Whether any node of the tree is an unparsed hole. */
export function hasUnparsed(root: CelNode): boolean {
  for (const node of walkTree(root)) if (node.kind === "unparsed") return true;
  return false;
}
