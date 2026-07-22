import { describe, expect, it } from "vitest";
import { parseToAst, type AstMap, type AstScalar, type AstSeq } from "../src/yaml-ast.js";

/** The read-only AST is the shared structural source of truth for IDE
 *  features. These pin node shape + byte-offset ranges (value-end, so a range
 *  spans exactly the node's own text), tag surfacing for `!cel` / `!ref`, and
 *  multi-document partitioning. */

describe("parseToAst — node shape + ranges", () => {
  it("adapts a top-level map with scalar entries", () => {
    const text = "kind: Foo\nname: bar\n";
    const [doc] = parseToAst(text);
    expect(doc.root?.kind).toBe("map");
    const map = doc.root as AstMap;
    expect(map.entries).toHaveLength(2);

    const kind = map.entries[0];
    expect((kind.key as AstScalar).value).toBe("kind");
    const kindValue = kind.value as AstScalar;
    expect(kindValue.kind).toBe("scalar");
    expect(text.slice(kindValue.range[0], kindValue.range[1])).toBe("Foo");
  });

  it("adapts sequences", () => {
    const text = "targets:\n  - One\n  - Two\n";
    const [doc] = parseToAst(text);
    const map = doc.root as AstMap;
    const seq = map.entries[0].value as AstSeq;
    expect(seq.kind).toBe("seq");
    expect(seq.items).toHaveLength(2);
    expect(text.slice(seq.items[0].range[0], seq.items[0].range[1])).toBe("One");
  });

  it("represents an empty value as a zero-width scalar at the cursor slot", () => {
    const text = "kind: \nmetadata:\n  name: foo\n";
    const [doc] = parseToAst(text);
    const map = doc.root as AstMap;
    const kindValue = map.entries[0].value as AstScalar;
    expect(kindValue.kind).toBe("scalar");
    expect(kindValue.value).toBeNull();
    expect(kindValue.range[0]).toBe(kindValue.range[1]); // zero-width
    expect(kindValue.range[0]).toBe(6); // right after "kind: "
  });

  it("surfaces `!cel` and `!ref` tags on scalars", () => {
    const text = 'foo: !cel "variables.port"\nbar: !ref Sql.conn\n';
    const [doc] = parseToAst(text);
    const map = doc.root as AstMap;
    const cel = map.entries[0].value as AstScalar;
    const ref = map.entries[1].value as AstScalar;
    expect(cel.tag).toBe("!cel");
    expect(ref.tag).toBe("!ref");
  });

  it("partitions multi-document files by range", () => {
    const text = "kind: A\nname: x\n---\nkind: B\nname: y\n";
    const docs = parseToAst(text);
    expect(docs).toHaveLength(2);
    const secondB = (docs[1].root as AstMap).entries[0].value as AstScalar;
    expect(text.slice(secondB.range[0], secondB.range[1])).toBe("B");
    // Document ranges are disjoint and ordered.
    expect(docs[0].range[1]).toBeLessThanOrEqual(docs[1].range[0]);
  });
});
