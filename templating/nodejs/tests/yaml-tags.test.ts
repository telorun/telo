import { describe, expect, it } from "vitest";
import { Document, parseAllDocuments } from "yaml";
import { makeTaggedSentinel } from "../src/sentinel.js";
import { defaultCustomTags } from "../src/yaml-tags.js";

const customTags = defaultCustomTags();

describe("defaultCustomTags — parse path", () => {
  it("resolves a !cel scalar to a TaggedSentinel", () => {
    const docs = parseAllDocuments("expr: !cel 'variables.port'\n", { customTags });
    expect(docs[0].toJSON()).toEqual({
      expr: { __tagged: true, engine: "cel", source: "variables.port" },
    });
  });

  it("resolves a !literal scalar verbatim, preserving ${{ }} text", () => {
    const docs = parseAllDocuments("expr: !literal 'Hello ${{ x }}'\n", { customTags });
    expect(docs[0].toJSON()).toEqual({
      expr: { __tagged: true, engine: "literal", source: "Hello ${{ x }}" },
    });
  });

  it("leaves untagged scalars as plain strings (no sentinel wrapping)", () => {
    const docs = parseAllDocuments("expr: variables.port\n", { customTags });
    expect(docs[0].toJSON()).toEqual({ expr: "variables.port" });
  });

  it("leaves an unknown tag unresolved (no engine claim)", () => {
    // !unknown is not registered — yaml's default behavior takes over.
    // We just verify our resolvers don't accidentally claim it.
    const docs = parseAllDocuments("expr: !unknown 'value'\n", { customTags });
    const json = docs[0].toJSON() as { expr: unknown };
    expect((json.expr as { engine?: string }).engine).not.toBe("cel");
    expect((json.expr as { engine?: string }).engine).not.toBe("literal");
  });

  it("returns a fresh customTags array each call so registry mutations propagate", () => {
    // The array is rebuilt every call from `defaultRegistry()` — same engines,
    // new array reference. Confirms that adding a new engine to the registry
    // (e.g. in tests or future runtime hooks) shows up in the next parse
    // without needing to clear a cache.
    const a = defaultCustomTags();
    const b = defaultCustomTags();
    expect(a).not.toBe(b);
    // Same shape: one tag per engine, in the same order.
    expect(a.map((t) => t.tag)).toEqual(b.map((t) => t.tag));
  });
});

describe("defaultCustomTags — serialize path", () => {
  it("round-trips a !cel-tagged scalar back to its YAML form", () => {
    const docs = parseAllDocuments("expr: !cel 'variables.port'\n", { customTags });
    const out = String(docs[0]);
    expect(out).toContain("!cel");
    expect(out).toContain("variables.port");
  });

  it("round-trips a !literal-tagged scalar with ${{ }} text intact", () => {
    const docs = parseAllDocuments("expr: !literal 'Hello ${{ x }}'\n", { customTags });
    const out = String(docs[0]);
    expect(out).toContain("!literal");
    expect(out).toContain("Hello ${{ x }}");
  });

  it("emits a tag exactly once on serialize (no double-prefix)", () => {
    const docs = parseAllDocuments("expr: !cel 'variables.port'\n", { customTags });
    const out = String(docs[0]);
    // "!cel !cel" would indicate the stringify is also prepending the tag
    // (the yaml lib already emits it from Scalar.tag).
    expect(out).not.toMatch(/!cel\s+!cel/);
  });

  it("survives a parse → serialize → parse round-trip with both engines on the same doc", () => {
    const text =
      "kind: Foo\nmetadata:\n  name: m\ncel: !cel 'x.y'\nlit: !literal 'literal-${{ untouched }}'\n";
    const docs = parseAllDocuments(text, { customTags });
    const serialized = String(docs[0]);
    const reparsed = parseAllDocuments(serialized, { customTags });
    expect(reparsed[0].toJSON()).toEqual({
      kind: "Foo",
      metadata: { name: "m" },
      cel: { __tagged: true, engine: "cel", source: "x.y" },
      lit: { __tagged: true, engine: "literal", source: "literal-${{ untouched }}" },
    });
  });

  it("stringifies a hand-built sentinel value via Document.set + tag", () => {
    // Simulates what setTag in the editor does: the user adds a tag to an
    // existing scalar; serialize must succeed even though the underlying
    // `value` is a primitive (not a sentinel).
    const doc = new Document({ expr: "variables.port" });
    const exprNode = doc.getIn(["expr"], true) as { tag?: string };
    exprNode.tag = "!cel";
    const out = doc.toString({ customTags } as never);
    expect(out).toContain("!cel");
    expect(out).toContain("variables.port");
  });
});

describe("escape handling", () => {
  it("preserves embedded double quotes and backslashes through round-trip", () => {
    // YAML single-quoted strings keep backslashes literal — the JS source
    // `\\\\` is two characters (`\\`), and the YAML parsed value contains
    // those two characters verbatim. After serialize-then-reparse, the
    // value must still be the same two-character string.
    const text = `expr: !literal 'has "quotes" and \\\\ slashes'\n`;
    const docs = parseAllDocuments(text, { customTags });
    const reparsed = parseAllDocuments(String(docs[0]), { customTags });
    const json = reparsed[0].toJSON() as { expr: { source: string } };
    expect(json.expr.source).toBe('has "quotes" and \\\\ slashes');
  });

  it("preserves embedded newlines through round-trip (no folding)", () => {
    // A literal LF inside the source must survive serialize → parse. With a
    // hand-rolled stringifier this regression is silent: a flow double-quoted
    // scalar containing an unescaped LF is folded on parse into a single
    // space, dropping the line break. yaml/util's stringifyString picks a
    // style (or escapes \n) so the value round-trips intact.
    const docs = new Document(
      { expr: makeTaggedSentinelInDoc("literal", "line1\nline2\nline3") },
      { customTags },
    );
    const out = String(docs);
    const reparsed = parseAllDocuments(out, { customTags });
    const json = reparsed[0].toJSON() as { expr: { source: string } };
    expect(json.expr.source).toBe("line1\nline2\nline3");
  });

  it("preserves embedded tabs and other control characters through round-trip", () => {
    const docs = new Document(
      { expr: makeTaggedSentinelInDoc("literal", "col1\tcol2\tcol3") },
      { customTags },
    );
    const out = String(docs);
    const reparsed = parseAllDocuments(out, { customTags });
    const json = reparsed[0].toJSON() as { expr: { source: string } };
    expect(json.expr.source).toBe("col1\tcol2\tcol3");
  });

  it("preserves the user's single-quote style on round-trip", () => {
    // The user wrote `!cel 'variables.port'` (single-quoted). After one
    // serialize cycle the choice should survive.
    const docs = parseAllDocuments("expr: !cel 'variables.port'\n", { customTags });
    const out = String(docs[0]);
    // Should contain a single-quoted body, not a double-quoted one.
    expect(out).toMatch(/!cel\s+'variables\.port'/);
  });

  it("preserves the user's double-quote style on round-trip", () => {
    const docs = parseAllDocuments('expr: !cel "variables.port"\n', { customTags });
    const out = String(docs[0]);
    expect(out).toMatch(/!cel\s+"variables\.port"/);
  });
});

function makeTaggedSentinelInDoc(engine: string, source: string): unknown {
  return makeTaggedSentinel(engine, source);
}
