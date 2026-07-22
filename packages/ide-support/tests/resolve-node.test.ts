import { parseToAst } from "@telorun/analyzer";
import { describe, expect, it } from "vitest";
import { resolveNodeAtPosition } from "../src/completions/resolve-node.js";

/** Structural resolution (Approach B): the AST drives node/path/replaceRange;
 *  the cursor column resolves empty-space key positions. `cel` is populated for
 *  a future CEL-completion feature but not consumed by this refactor. */

function resolve(text: string, line: number, character: number) {
  return resolveNodeAtPosition(text, parseToAst(text), line, character);
}

describe("resolveNodeAtPosition — structural slots", () => {
  it("resolves a top-level kind value", () => {
    const r = resolve("kind: Sql.Connection\n", 0, "kind: Sql.Co".length);
    expect(r?.slot).toBe("value");
    expect(r?.path).toEqual(["kind"]);
    expect(r?.docKind).toBe("Sql.Connection");
    // Whole-node replace range spans the entire scalar.
    expect(r?.replaceRange).toEqual({
      start: { line: 0, character: "kind: ".length },
      end: { line: 0, character: "kind: Sql.Connection".length },
    });
  });

  it("resolves a nested value with its full key path", () => {
    const text = "connection:\n  kind: Sql.Connection\n  name: Db\n";
    const r = resolve(text, 2, "  name: D".length);
    expect(r?.slot).toBe("value");
    expect(r?.path).toEqual(["connection", "name"]);
    expect(r?.siblingKind).toBe("Sql.Connection");
  });

  it("resolves an empty value slot to a zero-width replace range", () => {
    const r = resolve("kind: \n", 0, 6);
    expect(r?.slot).toBe("value");
    expect(r?.replaceRange).toEqual({
      start: { line: 0, character: 6 },
      end: { line: 0, character: 6 },
    });
  });

  it("resolves a blank line in a map to the enclosing container by column", () => {
    const text = "metadata:\n  name: a\n  \n";
    const r = resolve(text, 2, 2);
    expect(r?.slot).toBe("key");
    expect(r?.path).toEqual(["metadata"]);
    expect(r?.existingKeys).toEqual(new Set(["name"]));
  });

  it("excludes the edited key from existingKeys when the cursor is on it", () => {
    const text = "metadata:\n  name: a\n  version: 1\n";
    const r = resolve(text, 2, 4); // inside "version"
    expect(r?.slot).toBe("key");
    expect(r?.existingKeys).toEqual(new Set(["name"]));
  });

  it("resolves a bare scalar sequence item without crashing (no keyed siblings)", () => {
    // Regression: a scalar directly under a seq (`targets:\n  - One`) must not
    // treat the seq as a map — `container` is undefined and no sibling-kind
    // lookup is attempted.
    const text = "targets:\n  - One\n";
    const r = resolve(text, 1, "  - O".length);
    expect(r?.slot).toBe("value");
    expect(r?.container).toBeUndefined();
    expect(r?.siblingKind).toBeUndefined();
    expect(r?.path).toEqual(["targets"]);
    expect(r?.node?.kind).toBe("scalar");
  });

  it("selects the document a multi-doc cursor falls in", () => {
    const text = "kind: A\n---\nkind: B\n";
    const r = resolve(text, 2, "kind: B".length);
    expect(r?.docIndex).toBe(1);
    expect(r?.docKind).toBe("B");
  });
});

describe("resolveNodeAtPosition — CEL cursor", () => {
  it("sets cel with open=true inside an unclosed ${{", () => {
    const text = 'foo: "${{ req"\n';
    const r = resolve(text, 0, 'foo: "${{ req'.length);
    expect(r?.cel).toBeDefined();
    expect(r?.cel?.segment.open).toBe(true);
    expect(r?.cel?.segment.source).toBe("req");
  });

  it("sets cel with open=false inside a closed ${{ }}", () => {
    const text = 'foo: "${{ variables.x }}"\n';
    const r = resolve(text, 0, "foo: \"${{ vari".length);
    expect(r?.cel).toBeDefined();
    expect(r?.cel?.segment.open).toBe(false);
  });

  it("leaves cel unset for literal text outside ${{ }}", () => {
    const text = 'foo: "plain text"\n';
    const r = resolve(text, 0, "foo: \"pla".length);
    expect(r?.cel).toBeUndefined();
  });
});
