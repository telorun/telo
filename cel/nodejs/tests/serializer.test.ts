import { describe, expect, it } from "vitest";
import { parseExpression } from "../src/cel-expression.js";
import { parseSyntax } from "../src/parser.js";
import { CelSerializeError, serializeTree } from "../src/serializer.js";
import type { CelNode } from "../src/syntax-tree.js";
import { treesEqual } from "../src/tree-equality.js";

/** Every expression form, written as a reader would write it. */
const EXPRESSIONS: readonly string[] = [
  "0",
  "-9223372036854775808",
  "9223372036854775807",
  "18446744073709551615u",
  "1.0",
  "-0.0",
  "1e-7",
  "1e999",
  "''",
  "'a\\nb'",
  '"\\x00\\u270c"',
  "b'\\000\\xff'",
  "true",
  "null",
  "[]",
  "[1, 'a', [2]]",
  "{}",
  "{'a': 1, 2: b}",
  "a.b.c",
  "a.?b",
  "a[0]",
  "a[?'k']",
  "size(a)",
  "a.startsWith('x')",
  "xs.map(i, i + 1)",
  "has(a.b)",
  "cel.bind(x, 1, x + 1)",
  "optional.of(1)",
  "!a",
  "-a",
  "-(1)",
  "a + b * (c - d)",
  "a - (b - c)",
  "(a || b) && c",
  "a in [1, 2]",
  "a == b ? c : d",
  "(a ? b : c) ? d : e",
  "a > 1 && b <= 2 || !c",
  ".99",
  "br'\\n'",
  "headers.`content-type`",
  "m.`foo.txt`.`a-b`",
  "m.?`a-b`",
  ".y",
  ".y.z",
  "[1].map(y, .y)",
];

/** Forms the optional library's own syntax adds, read only where it is enabled. */
const OPTIONAL_SYNTAX: readonly string[] = ["[?a]", "[?a, b]", "{?'k': v}", "{?'k': v, 'j': w}"];

describe("the serializer", () => {
  it.each(EXPRESSIONS)("writes %s back to an equal tree", (source) => {
    const parsed = parseSyntax(source);
    expect(parsed.diagnostics, source).toEqual([]);
    const written = serializeTree(parsed.root);
    const reread = parseSyntax(written);
    expect(reread.diagnostics, written).toEqual([]);
    expect(treesEqual(parsed.root, reread.root), `${source} → ${written}`).toBe(true);
  });

  it.each(OPTIONAL_SYNTAX)("writes %s back to an equal tree", (source) => {
    const parsed = parseSyntax(source, { optionalSyntax: true });
    expect(parsed.diagnostics, source).toEqual([]);
    const written = serializeTree(parsed.root);
    const reread = parseSyntax(written, { optionalSyntax: true });
    expect(reread.diagnostics, written).toEqual([]);
    expect(treesEqual(parsed.root, reread.root), `${source} → ${written}`).toBe(true);
  });

  it("quotes a member name that has no other spelling, and refuses one with none at all", () => {
    const plain: CelNode = {
      kind: "select",
      operand: { kind: "ident", name: "m", absolute: false, range: [0, 1] },
      field: "content-type",
      fieldRange: [2, 14],
      optional: false,
      quoted: false,
      range: [0, 14],
    };
    // Written without backticks, it is still quoted: that is the name's only spelling.
    expect(serializeTree(plain)).toBe("m.`content-type`");
    expect(() => serializeTree({ ...plain, field: "a`b" })).toThrow(CelSerializeError);
  });

  it("writes a qualified call back as the text it was read from", () => {
    const expression = parseExpression("Billing.total(x, 1)", { namespaces: ["Billing"] });
    expect(serializeTree(expression.root)).toBe("Billing.total(x, 1)");
  });

  it("refuses a tree that has no source", () => {
    const incomplete = parseSyntax("1 +").root;
    expect(() => serializeTree(incomplete)).toThrow(CelSerializeError);
    const nameless = parseSyntax("a.").root;
    expect(() => serializeTree(nameless)).toThrow(CelSerializeError);
    const notANumber: CelNode = { kind: "literal", literal: { type: "double", value: NaN }, range: [0, 0] };
    expect(() => serializeTree(notANumber)).toThrow(CelSerializeError);
    const tooLarge: CelNode = {
      kind: "literal",
      literal: { type: "int", value: 9223372036854775808n },
      range: [0, 0],
    };
    expect(() => serializeTree(tooLarge)).toThrow(CelSerializeError);
  });

  it("writes a hand-built negation of a literal without folding it away", () => {
    const negated: CelNode = {
      kind: "unary",
      operator: "-",
      operand: { kind: "literal", literal: { type: "int", value: 1n }, range: [0, 1] },
      range: [0, 2],
    };
    const written = serializeTree(negated);
    expect(written).toBe("-(1)");
    expect(treesEqual(parseSyntax(written).root, negated)).toBe(true);
  });

  it("parenthesizes the number a negated chain begins with, which would read back folded", () => {
    // Each source is its own written text, and reads back to an equal tree.
    const sources = ["-(1).a", "-(1)[0]", "-(1).f()", "-(1.5).a", "-(0).a", "-(1).a[0].f().b", "-(-1).a", "-1u.a"];
    for (const source of sources) {
      const parsed = parseSyntax(source);
      expect(parsed.diagnostics, source).toEqual([]);
      const written = serializeTree(parsed.root);
      expect(written).toBe(source);
      const reread = parseSyntax(written);
      expect(reread.diagnostics, written).toEqual([]);
      expect(treesEqual(parsed.root, reread.root), source).toBe(true);
    }
    // The minus reaches only what the operand's text begins with.
    expect(serializeTree(parseSyntax("-a[1].b(2)").root)).toBe("-a[1].b(2)");
  });
});
