import { describe, expect, it } from "vitest";
import { DEFAULT_PARSE_LIMITS } from "../src/parse-limits.js";
import { parseSyntax } from "../src/parser.js";
import { RESERVED_WORDS } from "../src/reserved-words.js";
import { resolveNamespaces } from "../src/namespace-resolution.js";
import { qualifiedCalls } from "../src/qualified-calls.js";
import { rootReferences } from "../src/root-references.js";
import { serializeTree } from "../src/serializer.js";
import { type CelNode, childNodes } from "../src/syntax-tree.js";
import { treesEqual, } from "../src/tree-equality.js";

function tree(source: string): CelNode {
  const parsed = parseSyntax(source);
  expect(parsed.diagnostics, source).toEqual([]);
  return parsed.root;
}

/** A node with no child is 1 high, any other one more than its tallest child. */
function treeHeight(root: CelNode): number {
  let tallest = 0;
  const pending: [CelNode, number][] = [[root, 1]];
  for (let next = pending.pop(); next; next = pending.pop()) {
    const [node, height] = next;
    tallest = Math.max(tallest, height);
    for (const child of childNodes(node)) pending.push([child, height + 1]);
  }
  return tallest;
}

/** The pairs an unparenthesized source must group exactly as its parenthesized twin. */
const PRECEDENCE: readonly [string, string][] = [
  ["a + b * c", "a + (b * c)"],
  ["a * b + c", "(a * b) + c"],
  ["a - b - c", "(a - b) - c"],
  ["a / b % c", "(a / b) % c"],
  ["a == b && c != d", "(a == b) && (c != d)"],
  ["a && b || c", "(a && b) || c"],
  ["a in b == c", "(a in b) == c"],
  ["a < b + c", "a < (b + c)"],
  ["!a && b", "(!a) && b"],
  ["-a * b", "(-a) * b"],
  ["-a.b", "-(a.b)"],
  ["a[0].b", "(a[0]).b"],
  ["a.b.c(1)", "(a.b).c(1)"],
  ["a ? b : c ? d : e", "a ? b : (c ? d : e)"],
  ["a || b ? c : d", "(a || b) ? c : d"],
];

describe("the expression grammar", () => {
  it.each(PRECEDENCE)("groups %s as %s", (written, parenthesized) => {
    expect(treesEqual(tree(written), tree(parenthesized))).toBe(true);
  });

  it("reads member and index access in both their forms", () => {
    expect(tree("a.?b[?0]")).toEqual({
      kind: "index",
      optional: true,
      range: [0, 8],
      index: { kind: "literal", literal: { type: "int", value: 0n }, range: [6, 7] },
      operand: {
        kind: "select",
        field: "b",
        fieldRange: [3, 4],
        optional: true,
        quoted: false,
        range: [0, 4],
        operand: { kind: "ident", name: "a", absolute: false, range: [0, 1] },
      },
    });
  });

  it("reads a global call and a receiver call, each node ranged", () => {
    expect(tree("size(xs.filter(i, i > 0))")).toEqual({
      kind: "call",
      name: "size",
      nameRange: [0, 4],
      range: [0, 25],
      args: [
        {
          kind: "receiverCall",
          name: "filter",
          nameRange: [8, 14],
          range: [5, 24],
          receiver: { kind: "ident", name: "xs", absolute: false, range: [5, 7] },
          args: [
            { kind: "ident", name: "i", absolute: false, range: [15, 16] },
            {
              kind: "binary",
              operator: ">",
              range: [18, 23],
              left: { kind: "ident", name: "i", absolute: false, range: [18, 19] },
              right: { kind: "literal", literal: { type: "int", value: 0n }, range: [22, 23] },
            },
          ],
        },
      ],
    });
  });

  it("reads list and map literals, nested", () => {
    expect(tree("[{'a': [1]}]")).toEqual({
      kind: "list",
      range: [0, 12],
      elements: [
        {
          optional: false,
          value: {
            kind: "map",
            range: [1, 11],
            entries: [
              {
                optional: false,
                key: { kind: "literal", literal: { type: "string", value: "a" }, range: [2, 5] },
                value: {
                  kind: "list",
                  range: [7, 10],
                  elements: [
                    {
                      optional: false,
                      value: { kind: "literal", literal: { type: "int", value: 1n }, range: [8, 9] },
                    },
                  ],
                },
              },
            ],
          },
        },
      ],
    });
  });

  it("leaves a macro call as an ordinary call", () => {
    expect(tree("has(a.b)").kind).toBe("call");
    expect(tree("[1].all(i, i > 0)").kind).toBe("receiverCall");
    expect(tree("cel.bind(x, 1, x)")).toMatchObject({
      kind: "receiverCall",
      name: "bind",
      receiver: { kind: "ident", name: "cel" },
    });
  });

  it("lets no reserved word be read as a name", () => {
    // cel-spec's RESERVED, excluded from IDENT. Three of the 21 are refused by being
    // read as something else, which is the only reason they are reserved at all.
    const refused = [
      "as",
      "break",
      "const",
      "continue",
      "else",
      "for",
      "function",
      "if",
      "import",
      "let",
      "loop",
      "package",
      "namespace",
      "return",
      "var",
      "void",
      "while",
    ];
    expect([...refused, "in", ...["true", "false", "null"]].sort()).toEqual([...RESERVED_WORDS].sort());
    for (const word of refused) {
      expect(parseSyntax(word).diagnostics[0]?.code, word).toBe("reserved_identifier");
      expect(parseSyntax(`${word}(1)`).diagnostics[0]?.code, `${word}(1)`).toBe("reserved_identifier");
    }
    for (const word of ["cel", "optional", "has", "self", "x"]) {
      expect(parseSyntax(word).diagnostics, word).toEqual([]);
    }
  });

  it("reads `in` as the membership operator, never as a name", () => {
    expect(parseSyntax("in").diagnostics).toEqual([
      { code: "unexpected_token", message: '"in" cannot stand here', range: [0, 2] },
    ]);
    expect(parseSyntax("in(1)").diagnostics[0]?.range).toEqual([0, 2]);
    expect(parseSyntax("in + 1").diagnostics[0]?.range).toEqual([0, 2]);
    expect(tree("a in b")).toMatchObject({ kind: "binary", operator: "in" });
  });

  it("reads `true`, `false` and `null` as literals, never as names", () => {
    for (const word of ["true", "false", "null"]) {
      expect(tree(word).kind, word).toBe("literal");
      expect(parseSyntax(`${word}(1)`).diagnostics[0]?.code, `${word}(1)`).toBe("unexpected_token");
    }
  });

  it("reads a member name between backticks, and only where a member is read", () => {
    const quoted = tree("headers.`content-type`");
    expect(quoted).toMatchObject({
      kind: "select",
      field: "content-type",
      quoted: true,
      fieldRange: [8, 22],
      operand: { kind: "ident", name: "headers" },
    });
    expect(tree("m.`foo.txt`")).toMatchObject({ field: "foo.txt", quoted: true });
    expect(tree("m.?`a-b`")).toMatchObject({ field: "a-b", quoted: true, optional: true });
    // Everywhere else a backtick is a syntax error, and a quoted name never names a call.
    expect(parseSyntax("`a`").diagnostics[0]?.code).toBe("unexpected_token");
    expect(parseSyntax("a + `b`").diagnostics[0]?.code).toBe("unexpected_token");
    expect(parseSyntax("a.`b`(1)").diagnostics[0]?.code).toBe("unexpected_token");
    expect(parseSyntax("a.`b").diagnostics[0]?.code).toBe("unterminated_string");
  });

  it("reads an optional entry only where the optional syntax is enabled", () => {
    const list = parseSyntax("[?a, b]", { optionalSyntax: true });
    expect(list.diagnostics).toEqual([]);
    expect(list.root).toMatchObject({
      kind: "list",
      elements: [{ optional: true, value: { name: "a" } }, { optional: false, value: { name: "b" } }],
    });
    const map = parseSyntax("{?'k': v, 'j': w}", { optionalSyntax: true });
    expect(map.diagnostics).toEqual([]);
    expect(map.root).toMatchObject({
      kind: "map",
      entries: [{ optional: true }, { optional: false }],
    });
    // Off, the question mark is an ordinary misplaced token.
    expect(parseSyntax("[?a]").diagnostics[0]?.code).toBe("unexpected_token");
    expect(parseSyntax("{?'k': v}").diagnostics[0]?.code).toBe("unexpected_token");
  });

  it("reads a name a dot opens as an absolute one", () => {
    expect(tree(".y")).toEqual({ kind: "ident", name: "y", absolute: true, range: [0, 2] });
    expect(tree(".y.z")).toMatchObject({
      kind: "select",
      field: "z",
      operand: { kind: "ident", name: "y", absolute: true },
    });
    expect(tree("y")).toMatchObject({ absolute: false });
    expect(parseSyntax(".1 + 2").diagnostics).toEqual([]);
    expect(parseSyntax(". y").diagnostics).toEqual([]);
    expect(parseSyntax(".+").diagnostics[0]?.code).toBe("unexpected_token");
    // A name, not a member: neither a reserved word nor a quoted name opens one.
    expect(parseSyntax(".if").diagnostics[0]?.code).toBe("reserved_identifier");
    expect(parseSyntax(".`a-b`").diagnostics[0]?.code).toBe("unexpected_token");
  });

  it("refuses a word read as a literal where a dot opens a name", () => {
    for (const [source, word] of [
      [".true", "true"],
      [".false", "false"],
      [".null", "null"],
      [".true.x", "true"],
      [".null(1)", "null"],
    ] as const) {
      const parsed = parseSyntax(source);
      expect(parsed.diagnostics, source).toEqual([
        {
          code: "reserved_identifier",
          message: `"${word}" is a reserved word and cannot be used as a name`,
          range: [1, 1 + word.length],
        },
      ]);
      expect(parsed.root, source).toEqual({ kind: "unparsed", range: [0, 1] });
    }
  });

  it("folds a minus into the number after it, whatever stands between the two tokens", () => {
    expect(tree("- 1")).toEqual({ kind: "literal", literal: { type: "int", value: -1n }, range: [0, 3] });
    expect(tree("- // the minimum\n 9223372036854775808")).toMatchObject({
      kind: "literal",
      literal: { type: "int", value: -9223372036854775808n },
    });
    expect(tree("- 1.5")).toMatchObject({ kind: "literal", literal: { type: "double", value: -1.5 } });
    // A minus before a parenthesis never folds.
    expect(tree("-(1)")).toMatchObject({ kind: "unary", operand: { kind: "literal" } });
  });

  it("reads any word as a member name", () => {
    // Including `in`, `true` and a host's own property names: a member names a value's
    // entry, not a name in scope. Keeping a host property out of a CEL value is the
    // member read's guarantee over every form — a word list cannot judge `a[k]`.
    const sources = [
      "{'let': 1}.let",
      "a.while()",
      "a.in",
      "{'in': 1}.in",
      "a.true",
      "a.null()",
      "a.__proto__",
      "a.prototype()",
      "a.constructor",
    ];
    for (const source of sources) {
      const parsed = parseSyntax(source);
      expect(parsed.diagnostics, source).toEqual([]);
      const written = serializeTree(parsed.root);
      expect(treesEqual(parsed.root, parseSyntax(written).root), `${source} → ${written}`).toBe(true);
    }
  });
});

describe("error recovery", () => {
  it("keeps the longest prefix it read and says where it stopped", () => {
    const parsed = parseSyntax("1 + ");
    expect(parsed.diagnostics).toEqual([
      { code: "unexpected_end", message: "the expression ends before it is complete", range: [4, 4] },
    ]);
    expect(parsed.root).toMatchObject({
      kind: "binary",
      operator: "+",
      left: { kind: "literal", literal: { type: "int", value: 1n } },
      right: { kind: "unparsed", range: [4, 4] },
    });
  });

  it("leaves a member read with no name as a select an editor can complete", () => {
    const parsed = parseSyntax("request.query.");
    expect(parsed.diagnostics[0]?.range).toEqual([14, 14]);
    expect(parsed.root).toMatchObject({
      kind: "select",
      field: "",
      operand: { kind: "select", field: "query", operand: { kind: "ident", name: "request" } },
    });
  });

  it("reports one diagnostic, for the first thing it could not read", () => {
    expect(parseSyntax("a ` b ` c").diagnostics).toHaveLength(1);
    expect(parseSyntax("[1, , 2] + +").diagnostics).toHaveLength(1);
  });

  it("reads every token before text the lexer cannot read, as it reads the source cut there", () => {
    const sources = [
      "1 + 2 + 'abc",
      "f(1, 'abc",
      "[1, 'abc",
      "{1: 2, 'abc",
      "a.b #",
      "- 'abc",
      "(((a 'abc",
      ". 'abc",
      "'abc",
      "r'abc",
    ];
    const cuts = [8, 5, 4, 7, 4, 2, 5, 2, 0, 0];
    const read = sources.map((source) => parseSyntax(source));
    // Ranges included: the tree is the cut source's tree, node for node.
    expect(read.map((parsed) => parsed.root)).toEqual(
      sources.map((source, at) => parseSyntax(source.slice(0, cuts[at])).root),
    );
    expect(read.map((parsed) => parsed.diagnostics)).toEqual([
      [{ code: "unterminated_string", message: "unterminated string", range: [8, 12] }],
      [{ code: "unterminated_string", message: "unterminated string", range: [5, 9] }],
      [{ code: "unterminated_string", message: "unterminated string", range: [4, 8] }],
      [{ code: "unterminated_string", message: "unterminated string", range: [7, 11] }],
      [{ code: "unexpected_character", message: 'unexpected character "#"', range: [4, 5] }],
      [{ code: "unterminated_string", message: "unterminated string", range: [2, 6] }],
      [{ code: "unterminated_string", message: "unterminated string", range: [5, 9] }],
      [{ code: "unterminated_string", message: "unterminated string", range: [2, 6] }],
      [{ code: "unterminated_string", message: "unterminated string", range: [0, 4] }],
      [{ code: "unterminated_string", message: "unterminated string", range: [1, 5] }],
    ]);
    expect(read[0]!.root).toMatchObject({
      kind: "binary",
      range: [0, 8],
      left: { kind: "binary", range: [0, 5] },
      right: { kind: "unparsed", range: [8, 8] },
    });
    expect(read[1]!.root).toMatchObject({
      kind: "call",
      range: [0, 5],
      args: [{ kind: "literal" }, { kind: "unparsed", range: [5, 5] }],
    });
    expect(read[2]!.root).toMatchObject({
      kind: "list",
      elements: [{ value: { kind: "literal" } }, { value: { kind: "unparsed", range: [4, 4] } }],
    });
    expect(read[3]!.root).toMatchObject({
      kind: "map",
      entries: [{ key: { kind: "literal" } }, { key: { kind: "unparsed", range: [7, 7] } }],
    });
    expect(read[4]!.root).toMatchObject({ kind: "select", field: "b", range: [0, 3] });
  });

  it("reports the diagnostic that starts first, the lexer's on a tie", () => {
    const earlier = parseSyntax(") + 'abc");
    expect(earlier.diagnostics).toEqual([
      { code: "unexpected_token", message: '")" cannot stand here', range: [0, 1] },
    ]);
    expect(earlier.root).toEqual({ kind: "unparsed", range: [0, 1] });
    const boundary = parseSyntax("9223372036854775808 #");
    expect(boundary.diagnostics).toEqual([
      {
        code: "invalid_integer",
        message: "9223372036854775808 is outside the range of a 64-bit integer",
        range: [0, 19],
      },
    ]);
    expect(boundary.root).toEqual({ kind: "unparsed", range: [0, 19] });
  });

  it("leaves an empty quoted member as a member with no name", () => {
    const message = '"``" cannot stand here, expected "a name between the backticks"';
    const plain = parseSyntax("a.``");
    expect(plain.diagnostics).toEqual([{ code: "unexpected_token", message, range: [2, 4] }]);
    expect(plain.root).toEqual({
      kind: "select",
      operand: { kind: "ident", name: "a", absolute: false, range: [0, 1] },
      field: "",
      fieldRange: [2, 2],
      optional: false,
      quoted: false,
      range: [0, 2],
    });
    const optional = parseSyntax("a.?``");
    expect(optional.diagnostics).toEqual([{ code: "unexpected_token", message, range: [3, 5] }]);
    expect(optional.root).toMatchObject({ kind: "select", field: "", optional: true, quoted: false, range: [0, 3] });
    const chained = parseSyntax("a.``.b");
    expect(chained.diagnostics).toEqual(plain.diagnostics);
    expect(chained.root).toEqual(plain.root);
  });
});

describe("the input limits", () => {
  it("refuses more nodes, depth, elements, entries or arguments than the limit allows", () => {
    const refusals = [
      parseSyntax(`[${Array.from({ length: 100001 }, () => "1").join(",")}]`, {
        limits: { maxListElements: 200000 },
      }),
      parseSyntax(`${"(".repeat(300)}1${")".repeat(300)}`),
      parseSyntax(`[${Array.from({ length: 1001 }, () => "1").join(",")}]`),
      parseSyntax(`{${Array.from({ length: 1001 }, (unused, at) => `${at}: 1`).join(",")}}`),
      parseSyntax(`f(${Array.from({ length: 33 }, () => "1").join(",")})`),
    ];
    expect(refusals.map((parsed) => parsed.diagnostics[0]?.code)).toEqual(Array(5).fill("limit_exceeded"));
    expect(refusals.map((parsed) => parsed.diagnostics[0]?.message)).toEqual([
      `the expression has more nodes than the limit of ${DEFAULT_PARSE_LIMITS.maxNodes}`,
      `the expression has more nesting than the limit of ${DEFAULT_PARSE_LIMITS.maxDepth}`,
      `the expression has more list elements than the limit of ${DEFAULT_PARSE_LIMITS.maxListElements}`,
      `the expression has more map entries than the limit of ${DEFAULT_PARSE_LIMITS.maxMapEntries}`,
      `the expression has more call arguments than the limit of ${DEFAULT_PARSE_LIMITS.maxCallArguments}`,
    ]);
  });

  it("reads an expression at every limit", () => {
    expect(parseSyntax(`[${Array.from({ length: 1000 }, () => "1").join(",")}]`).diagnostics).toEqual([]);
    expect(parseSyntax(`f(${Array.from({ length: 32 }, () => "1").join(",")})`).diagnostics).toEqual([]);
    expect(parseSyntax(`${"(".repeat(124)}1${")".repeat(124)}`).diagnostics).toEqual([]);
  });

  it("counts a chain as nesting: a tree is at most the depth limit high", () => {
    const sum = (operands: number) => Array.from({ length: operands }, () => "1").join("+");
    const members = (count: number) => `a${".b".repeat(count)}`;
    const message = `the expression has more nesting than the limit of ${DEFAULT_PARSE_LIMITS.maxDepth}`;
    expect(treeHeight(tree(sum(250)))).toBe(250);
    expect(treeHeight(tree(members(249)))).toBe(250);
    for (const source of [sum(251), members(250)]) {
      const refused = parseSyntax(source);
      expect(refused.diagnostics).toEqual([{ code: "limit_exceeded", message, range: [0, 501] }]);
      // The node past the limit is kept.
      expect(treeHeight(refused.root)).toBe(251);
    }
    expect(parseSyntax(sum(251), { limits: { maxDepth: 251 } }).diagnostics).toEqual([]);
    // The grammar's own nesting is counted where it always was.
    expect(parseSyntax(`${"(".repeat(250)}1`).diagnostics).toEqual([
      { code: "limit_exceeded", message, range: [250, 250] },
    ]);
    // On one node, the node count is judged first.
    expect(parseSyntax("1+1+1", { limits: { maxNodes: 4, maxDepth: 2 } }).diagnostics).toEqual([
      { code: "limit_exceeded", message: "the expression has more nodes than the limit of 4", range: [0, 5] },
    ]);
  });

  it("bounds a tree read with a diagnostic, which every walker finishes", () => {
    // Every open grammar level closes around the node that was refused: a bracket and the
    // five binary levels before it. This is the tallest tree a read under the default limits leaves.
    const level = "a || b && c == d + e * [";
    const source = `${level.repeat(249)}a || b && c == d + e * a${".b".repeat(250)}`;
    const parsed = parseSyntax(source);
    expect(parsed.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["limit_exceeded"]);
    expect(treeHeight(parsed.root)).toBe(7 * DEFAULT_PARSE_LIMITS.maxDepth);
    expect(resolveNamespaces(parsed.root, ["a"])).toBe(parsed.root);
    // Nothing in it is a hole: the node past the limit is kept and each bracket closes on it.
    expect(serializeTree(parsed.root)).toBe(`${source}${"]".repeat(249)}`);
    expect(rootReferences(parsed.root)).toEqual(["a", "b", "c", "d", "e"]);
    expect(qualifiedCalls(parsed.root)).toEqual([]);
    expect(treesEqual(parsed.root, parseSyntax(source).root)).toBe(true);
  });
});
