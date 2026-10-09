/**
 * CEL's grammar, read by recursive descent into the canonical tree.
 *
 * **Error recovery is the point.** Parsing never throws and never discards what it
 * read: the first thing it cannot read, in source order, becomes one ranged
 * diagnostic, the reader stops there, and the tree holds the longest prefix it
 * understood with an `unparsed` node where the rest would have been. Text the lexer
 * cannot read ends the token stream where it begins, so the tree is the tree of the
 * source cut there. That is what lets completion and hover work on an expression
 * mid-token, and nothing downstream has to re-parse a shortened prefix to get an
 * answer. A member left unnamed (`request.`, and a pair of backticks holding nothing)
 * is a select with an **empty field name**, which is the shape completion after a dot
 * reads; an aggregate or a call left open keeps the elements it read. Neither can be
 * serialized, and the diagnostic is what says the tree is incomplete.
 *
 * **Nothing is expanded.** A macro call (`has(x)`, `xs.map(i, i)`, `cel.bind(…)`) is
 * an ordinary call node: expanding it here would make the serializer unable to
 * write the source back, and lowering it to a comprehension is the checker's and a
 * backend's business. A qualified call is not produced here either — see
 * `namespace-resolution.ts`.
 *
 * **A unary minus directly on a numeric literal folds into the literal.** That is
 * how the int64 minimum is written at all, and it keeps `-0.0` a value rather than
 * a negation of zero. The fold is on tokens, so whitespace and comments between the
 * minus and the number change nothing: `- 1` is the literal `-1`, ranged from the
 * minus. A minus on a parenthesized literal does not fold, so the serializer can
 * write a hand-built negation back without changing its shape.
 *
 * **`maxDepth` bounds the tree as well as the grammar.** The descent counts its own
 * nesting, and every node built is measured: a node with no child is 1 high, any
 * other one more than its tallest child. A chain (`1 + 1 + …`, `a.b.b…`) nests no
 * grammar and still builds a tree as tall as it is long, which every walker
 * downstream recurses over — so it is refused here, once, with a diagnostic.
 */

import { type Token, tokenize } from "./lexer.js";
import { type CelParseLimits, resolveParseLimits } from "./parse-limits.js";
import type { CelSyntaxDiagnostic } from "./syntax-diagnostic.js";
import { FirstSyntaxDiagnostic, firstInSourceOrder } from "./syntax-diagnostic.js";
import { wordReading } from "./reserved-words.js";
import { childNodes } from "./syntax-tree.js";
import type {
  CelBinaryOperator,
  CelListElement,
  CelMapEntry,
  CelNode,
  CelUnaryOperator,
  SourceRange,
} from "./syntax-tree.js";

export interface ParseOptions {
  readonly limits?: Partial<CelParseLimits>;
  /**
   * Whether the optional library's own syntax is read: `[?x]` and `{?k: v}`, whose entry
   * holds an optional and contributes its value type. It follows the environment's
   * `enableOptionalTypes`, because a syntax for a type that does not exist would parse to
   * a tree nothing can check.
   */
  readonly optionalSyntax?: boolean;
}

export interface ParseResult {
  readonly source: string;
  readonly root: CelNode;
  readonly diagnostics: readonly CelSyntaxDiagnostic[];
}

const RELATIONS: readonly string[] = ["==", "!=", "<", "<=", ">", ">="];
const ADDITIVE: readonly string[] = ["+", "-"];
const MULTIPLICATIVE: readonly string[] = ["*", "/", "%"];

class Parser {
  private at = 0;
  private nodes = 0;
  private depth = 0;
  private stopped = false;
  /** The height of every node built that has a child; a node absent from it is 1 high. */
  private readonly heights = new Map<CelNode, number>();

  constructor(
    private readonly source: string,
    private readonly tokens: readonly Token[],
    private readonly diagnostics: FirstSyntaxDiagnostic,
    private readonly limits: CelParseLimits,
    private readonly optionalSyntax: boolean,
  ) {}

  parse(): CelNode {
    const root = this.conditional();
    if (!this.stopped && this.peek().type !== "eof") this.unexpected(this.peek());
    return root;
  }

  // --- token access -------------------------------------------------------

  private peek(ahead = 0): Token {
    return this.tokens[Math.min(this.at + ahead, this.tokens.length - 1)]!;
  }

  private advance(): Token {
    const token = this.peek();
    if (this.at < this.tokens.length - 1) this.at += 1;
    return token;
  }

  private isPunct(text: string): boolean {
    const token = this.peek();
    return token.type === "punct" && token.text === text;
  }

  private takePunct(text: string): boolean {
    if (!this.isPunct(text)) return false;
    this.advance();
    return true;
  }

  private expectPunct(text: string): boolean {
    if (this.takePunct(text)) return true;
    this.unexpected(this.peek(), text);
    return false;
  }

  // --- diagnostics and budgets -------------------------------------------

  private unexpected(token: Token, expected?: string): void {
    const wanted = expected === undefined ? "" : `, expected ${JSON.stringify(expected)}`;
    if (token.type === "eof") {
      this.diagnostics.report(
        "unexpected_end",
        `the expression ends before it is complete${wanted}`,
        token.start,
        token.end,
      );
    } else {
      this.diagnostics.report(
        "unexpected_token",
        `${JSON.stringify(this.source.slice(token.start, token.end))} cannot stand here${wanted}`,
        token.start,
        token.end,
      );
    }
    this.stopped = true;
  }

  private limit(what: string, max: number, start: number, end: number): void {
    this.diagnostics.report(
      "limit_exceeded",
      `the expression has more ${what} than the limit of ${max}`,
      start,
      end,
    );
    this.stopped = true;
  }

  /** Counts a node against the node budget and measures it against the depth limit. */
  private keep<T extends CelNode>(node: T): T {
    this.nodes += 1;
    if (this.nodes > this.limits.maxNodes && !this.stopped) {
      this.limit("nodes", this.limits.maxNodes, node.range[0], node.range[1]);
    }
    let tallest = 0;
    for (const child of childNodes(node)) tallest = Math.max(tallest, this.heights.get(child) ?? 1);
    if (tallest === 0) return node;
    this.heights.set(node, tallest + 1);
    if (tallest + 1 > this.limits.maxDepth && !this.stopped) {
      this.limit("nesting", this.limits.maxDepth, node.range[0], node.range[1]);
    }
    return node;
  }

  private enter(start: number): boolean {
    this.depth += 1;
    if (this.depth <= this.limits.maxDepth) return true;
    if (!this.stopped) this.limit("nesting", this.limits.maxDepth, start, start);
    return false;
  }

  private leave(): void {
    this.depth -= 1;
  }

  private unparsed(start: number, end = start): CelNode {
    return this.keep({ kind: "unparsed", range: [start, end] as SourceRange });
  }

  private spanning(left: CelNode, right: CelNode): SourceRange {
    return [left.range[0], right.range[1]];
  }

  // --- the grammar -------------------------------------------------------

  private conditional(): CelNode {
    const start = this.peek().start;
    if (!this.enter(start)) return this.unparsed(start);
    try {
      const condition = this.binary(0);
      if (this.stopped || !this.isPunct("?")) return condition;
      this.advance();
      const whenTrue = this.conditional();
      const whenFalse =
        this.stopped || !this.expectPunct(":")
          ? this.unparsed(whenTrue.range[1])
          : this.conditional();
      return this.keep({
        kind: "conditional",
        condition,
        whenTrue,
        whenFalse,
        range: this.spanning(condition, whenFalse),
      });
    } finally {
      this.leave();
    }
  }

  /**
   * The binary levels, lowest first: `||`, `&&`, the relations, `+ -`, `* / %`.
   * One loop per level, each left-associative.
   */
  private binary(level: number): CelNode {
    if (level >= 5) return this.unary();
    let left = this.binary(level + 1);
    while (!this.stopped) {
      const operator = this.binaryOperatorAt(level);
      if (!operator) return left;
      this.advance();
      const right = this.binary(level + 1);
      left = this.keep({ kind: "binary", operator, left, right, range: this.spanning(left, right) });
      if (right.kind === "unparsed") return left;
    }
    return left;
  }

  private binaryOperatorAt(level: number): CelBinaryOperator | undefined {
    const token = this.peek();
    if (level === 2 && token.type === "keyword" && token.text === "in") return "in";
    if (token.type !== "punct") return undefined;
    const text = token.text;
    const wanted =
      level === 0 ? ["||"] : level === 1 ? ["&&"] : level === 2 ? RELATIONS : level === 3 ? ADDITIVE : MULTIPLICATIVE;
    return wanted.includes(text) ? (text as CelBinaryOperator) : undefined;
  }

  private unary(): CelNode {
    const token = this.peek();
    if (token.type === "punct" && (token.text === "!" || token.text === "-")) {
      const folded = token.text === "-" ? this.foldedNumber(token) : undefined;
      if (folded) return this.postfix(folded);
      if (!this.enter(token.start)) return this.unparsed(token.start);
      try {
        this.advance();
        const operand = this.unary();
        return this.keep({
          kind: "unary",
          operator: token.text as CelUnaryOperator,
          operand,
          range: [token.start, operand.range[1]],
        });
      } finally {
        this.leave();
      }
    }
    return this.postfix(this.primary());
  }

  /** `-` directly on an int or double literal is part of the literal. */
  private foldedNumber(minus: Token): CelNode | undefined {
    const number = this.peek(1);
    if (number.type !== "int" && number.type !== "double") return undefined;
    this.advance();
    this.advance();
    const literal =
      number.type === "int"
        ? ({ type: "int", value: -number.int! } as const)
        : ({ type: "double", value: -number.double! } as const);
    return this.keep({ kind: "literal", literal, range: [minus.start, number.end] });
  }

  private postfix(operand: CelNode): CelNode {
    let node = operand;
    while (!this.stopped) {
      if (this.takePunct(".")) {
        const optional = this.takePunct("?");
        const name = this.peek();
        const quoted = name.type === "quotedIdent";
        if (!this.expectMemberName(name)) {
          // The member is unnamed: the select stands with an empty field, which is
          // what an editor reads to complete a member after the dot.
          return this.keep({
            kind: "select",
            operand: node,
            field: "",
            fieldRange: [name.start, name.start],
            optional,
            quoted: false,
            range: [node.range[0], name.start],
          });
        }
        this.advance();
        const fieldRange: SourceRange = [name.start, name.end];
        if (quoted && this.isPunct("(")) {
          // cel-spec admits a quoted name where a FIELD is read (`member '.' escapeIdent`)
          // and nowhere else: a called function is always an identifier. Keeping that line
          // is also what keeps a namespaced call to exactly one spelling.
          this.unexpected(this.peek(), "a member read — a quoted name is a field, not a call");
          return this.keep({
            kind: "select",
            operand: node,
            field: name.text,
            fieldRange,
            optional,
            quoted,
            range: [node.range[0], name.end],
          });
        }
        if (this.isPunct("(")) {
          const args = this.callArguments();
          node = this.keep({
            kind: "receiverCall",
            receiver: node,
            name: name.text,
            nameRange: fieldRange,
            args: args.nodes,
            range: [node.range[0], args.end],
          });
          continue;
        }
        node = this.keep({
          kind: "select",
          operand: node,
          field: name.text,
          fieldRange,
          optional,
          quoted,
          range: [node.range[0], name.end],
        });
        continue;
      }
      if (this.isPunct("[")) {
        this.advance();
        const optional = this.takePunct("?");
        const index = this.conditional();
        const closed = !this.stopped && this.expectPunct("]");
        const end = closed ? this.tokens[this.at - 1]!.end : index.range[1];
        node = this.keep({ kind: "index", operand: node, index, optional, range: [node.range[0], end] });
        if (!closed) return node;
        continue;
      }
      return node;
    }
    return node;
  }

  /**
   * A field or a called function may be named by any word, however that word is read
   * elsewhere — `{'let': 1}.let`, `a.in` and `a.true` are all CEL. A member names a
   * value's entry, not a name in the expression's scope.
   */
  private expectMemberName(token: Token): boolean {
    if (token.type === "ident" || token.type === "reserved" || token.type === "keyword") return true;
    // A name between backticks, which is how a member not spelled as an identifier is read.
    if (token.type === "quotedIdent") {
      if (token.text !== "") return true;
      this.unexpected(token, "a name between the backticks");
      return false;
    }
    return this.expectIdentifier(token);
  }

  /** A name: no reserved word is one, the three read as literals elsewhere included. */
  private expectIdentifier(token: Token): boolean {
    const literalWord = token.type === "ident" && wordReading(token.text) === "literal";
    if (token.type === "ident" && !literalWord) return true;
    if (token.type === "reserved" || literalWord) {
      this.diagnostics.report(
        "reserved_identifier",
        `${JSON.stringify(token.text)} is a reserved word and cannot be used as a name`,
        token.start,
        token.end,
      );
      this.stopped = true;
      return false;
    }
    this.unexpected(token, "a name");
    return false;
  }

  private primary(): CelNode {
    const token = this.peek();
    switch (token.type) {
      case "int":
        this.advance();
        if (token.atIntBoundary) {
          // 2^63 is a magnitude, not a value: it is only the int64 minimum, which
          // the fold under a unary minus has already taken.
          this.diagnostics.report(
            "invalid_integer",
            `${token.text} is outside the range of a 64-bit integer`,
            token.start,
            token.end,
          );
          this.stopped = true;
          return this.unparsed(token.start, token.end);
        }
        return this.keep({
          kind: "literal",
          literal: { type: "int", value: token.int! },
          range: [token.start, token.end],
        });
      case "uint":
        this.advance();
        return this.keep({
          kind: "literal",
          literal: { type: "uint", value: token.int! },
          range: [token.start, token.end],
        });
      case "double":
        this.advance();
        return this.keep({
          kind: "literal",
          literal: { type: "double", value: token.double! },
          range: [token.start, token.end],
        });
      case "string":
        this.advance();
        return this.keep({
          kind: "literal",
          literal: { type: "string", value: token.string! },
          range: [token.start, token.end],
        });
      case "bytes":
        this.advance();
        return this.keep({
          kind: "literal",
          literal: { type: "bytes", value: token.bytes! },
          range: [token.start, token.end],
        });
      case "reserved":
        this.expectIdentifier(token);
        return this.unparsed(token.start, token.end);
      case "keyword":
        // An operator written as a word, where an expression must begin.
        this.unexpected(token);
        return this.unparsed(token.start, token.end);
      case "quotedIdent":
        // A quoted name reads a MEMBER; nothing else in the language is written that way.
        this.unexpected(token, "a member read, as in a.`b`");
        return this.unparsed(token.start, token.end);
      case "ident":
        return this.word(token);
      case "punct":
        if (token.text === "(") return this.parenthesized(token);
        if (token.text === "[") return this.list(token);
        if (token.text === "{") return this.map(token);
        if (token.text === ".") return this.absoluteName(token);
        this.unexpected(token);
        return this.unparsed(token.start, token.end);
      case "eof":
        this.unexpected(token);
        return this.unparsed(token.start, token.end);
    }
  }

  /**
   * `.y` — a name resolved against the environment alone. It is the only spelling for an
   * outer name a comprehension variable of the same name would otherwise hide.
   */
  private absoluteName(dot: Token): CelNode {
    this.advance();
    const name = this.peek();
    // A NAME, not a member: cel-spec's leading-dot form takes an identifier, so neither a
    // reserved word nor a quoted name opens one.
    if (!this.expectIdentifier(name)) return this.unparsed(dot.start, name.start);
    this.advance();
    return this.keep({ kind: "ident", name: name.text, absolute: true, range: [dot.start, name.end] });
  }

  private word(token: Token): CelNode {
    this.advance();
    const range: SourceRange = [token.start, token.end];
    if (token.text === "true" || token.text === "false") {
      return this.keep({ kind: "literal", literal: { type: "bool", value: token.text === "true" }, range });
    }
    if (token.text === "null") {
      return this.keep({ kind: "literal", literal: { type: "null" }, range });
    }
    if (!this.isPunct("(")) return this.keep({ kind: "ident", name: token.text, absolute: false, range });
    const args = this.callArguments();
    return this.keep({
      kind: "call",
      name: token.text,
      nameRange: range,
      args: args.nodes,
      range: [token.start, args.end],
    });
  }

  private parenthesized(open: Token): CelNode {
    this.advance();
    const inner = this.conditional();
    if (!this.stopped) this.expectPunct(")");
    return inner;
  }

  /** The arguments of a call, the open paren being the current token. */
  private callArguments(): { nodes: CelNode[]; end: number } {
    const open = this.advance();
    const nodes: CelNode[] = [];
    while (!this.stopped && !this.isPunct(")")) {
      const argument = this.conditional();
      nodes.push(argument);
      if (nodes.length > this.limits.maxCallArguments) {
        this.limit("call arguments", this.limits.maxCallArguments, open.start, argument.range[1]);
        break;
      }
      if (!this.takePunct(",")) break;
    }
    if (this.stopped) return { nodes, end: nodes.at(-1)?.range[1] ?? open.end };
    const close = this.peek();
    if (!this.expectPunct(")")) return { nodes, end: close.end };
    return { nodes, end: close.end };
  }

  private list(open: Token): CelNode {
    this.advance();
    const elements: CelListElement[] = [];
    while (!this.stopped && !this.isPunct("]")) {
      const optional = this.optionalSyntax && this.takePunct("?");
      const value = this.conditional();
      elements.push({ value, optional });
      if (elements.length > this.limits.maxListElements) {
        this.limit("list elements", this.limits.maxListElements, open.start, value.range[1]);
        break;
      }
      if (!this.takePunct(",")) break;
    }
    const end = this.closingEnd("]", open, elements.at(-1)?.value.range[1]);
    return this.keep({ kind: "list", elements, range: [open.start, end] });
  }

  private map(open: Token): CelNode {
    this.advance();
    const entries: CelMapEntry[] = [];
    while (!this.stopped && !this.isPunct("}")) {
      const optional = this.optionalSyntax && this.takePunct("?");
      const key = this.conditional();
      if (this.stopped || !this.expectPunct(":")) {
        entries.push({ key, value: this.unparsed(key.range[1]), optional });
        break;
      }
      const value = this.conditional();
      entries.push({ key, value, optional });
      if (entries.length > this.limits.maxMapEntries) {
        this.limit("map entries", this.limits.maxMapEntries, open.start, value.range[1]);
        break;
      }
      if (!this.takePunct(",")) break;
    }
    const end = this.closingEnd("}", open, entries.at(-1)?.value.range[1]);
    return this.keep({ kind: "map", entries, range: [open.start, end] });
  }

  /** Where an aggregate ends: at its closing bracket, or at what it did read. */
  private closingEnd(bracket: string, open: Token, lastRead: number | undefined): number {
    if (!this.stopped && this.expectPunct(bracket)) return this.tokens[this.at - 1]!.end;
    return lastRead ?? open.end;
  }
}

/**
 * Reads one CEL expression. Always answers a tree; `diagnostics` holds at most one
 * entry, and holds one exactly when the whole source could not be read.
 */
export function parseSyntax(source: string, options?: ParseOptions): ParseResult {
  const limits = resolveParseLimits(options?.limits);
  const lexed = tokenize(source);
  const diagnostics = new FirstSyntaxDiagnostic();
  const root = new Parser(source, lexed.tokens, diagnostics, limits, options?.optionalSyntax ?? false).parse();
  const cut = lexed.tokens.at(-1)!.start;
  return { source, root, diagnostics: firstInSourceOrder(lexed.diagnostics.first, diagnostics.first, cut) };
}
