import { describe, expect, it } from "vitest";
import { parseToAst, type AstMap, type AstScalar } from "../src/yaml-ast.js";
import type { CelNode } from "../src/cel-ast.js";

/** `celSegments()` locates the `${{ }}` / `!cel` regions of a scalar in
 *  document offsets, and `ast()` (via `wrapCelAst`) maps every node's range
 *  to absolute document offsets. CEL parsing stays lazy — only `ast()` invokes
 *  the parser. */

function scalarAt(text: string, key: string): AstScalar {
  const [doc] = parseToAst(text);
  const map = doc.root as AstMap;
  const pair = map.entries.find((e) => (e.key as AstScalar).value === key);
  return pair!.value as AstScalar;
}

describe("celSegments — segment location", () => {
  it("yields one segment spanning a `!cel` scalar body", () => {
    const text = 'foo: !cel "variables.port"\n';
    const segs = scalarAt(text, "foo").celSegments();
    expect(segs).toHaveLength(1);
    expect(segs[0].open).toBe(false);
    expect(segs[0].source).toBe("variables.port");
    expect(text.slice(segs[0].range[0], segs[0].range[1])).toBe("variables.port");
  });

  it("yields one segment per `${{ }}` match in an interpolated string", () => {
    const text = 'foo: "a ${{ variables.x }} b ${{ variables.y }}"\n';
    const segs = scalarAt(text, "foo").celSegments();
    expect(segs).toHaveLength(2);
    expect(segs.map((s) => s.source)).toEqual(["variables.x", "variables.y"]);
    // Range includes the `${{ }}` wrapper.
    expect(text.slice(segs[0].range[0], segs[0].range[1])).toBe("${{ variables.x }}");
  });

  it("yields an open segment for a dangling `${{`", () => {
    const text = 'foo: "${{ req"\n';
    const segs = scalarAt(text, "foo").celSegments();
    expect(segs).toHaveLength(1);
    expect(segs[0].open).toBe(true);
    expect(segs[0].source).toBe("req");
  });
});

describe("wrapCelAst — absolute node ranges", () => {
  it("maps a nested member access to absolute document offsets", () => {
    const text = 'foo: "${{ variables.port }}"\n';
    const seg = scalarAt(text, "foo").celSegments()[0];
    const ast = seg.ast();
    expect(ast.kind).toBe("member");
    const member = ast as Extract<CelNode, { kind: "member" }>;
    expect(member.property).toBe("port");
    // `variables.port` sits at offset 10 in the document.
    expect(text.slice(member.range[0], member.range[1])).toBe("variables.port");
    expect(text.slice(member.propertyRange[0], member.propertyRange[1])).toBe("port");
    expect(member.target.kind).toBe("ident");
    expect(text.slice(member.target.range[0], member.target.range[1])).toBe("variables");
  });

  it("maps call / index / ternary node kinds", () => {
    const text = 'foo: !cel "cond ? items[0] : size(items)"\n';
    const ast = scalarAt(text, "foo").celSegments()[0].ast();
    expect(ast.kind).toBe("ternary");
    const t = ast as Extract<CelNode, { kind: "ternary" }>;
    expect(t.then.kind).toBe("index");
    expect(t.else.kind).toBe("call");
    expect((t.else as Extract<CelNode, { kind: "call" }>).name).toBe("size");
  });
});
