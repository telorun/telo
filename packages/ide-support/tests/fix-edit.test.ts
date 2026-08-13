import { describe, expect, it } from "vitest";

import { isPlainSafe, quoteStyleOf, renderFixReplacement } from "../src/diagnostics/fix-edit.js";

/**
 * A repair's `replacement` is a bare value, but the span it replaces is the
 * value node AS WRITTEN — quotes included, YAML tag excluded. Dropping the
 * quotes is what would silently turn a repaired CEL expression into something
 * that is no longer one scalar.
 */
describe("renderFixReplacement", () => {
  it("keeps a double-quoted scalar double-quoted", () => {
    expect(renderFixReplacement(`"startsWith(a, 'x')"`, `a.startsWith('x')`)).toBe(
      `"a.startsWith('x')"`,
    );
  });

  it("keeps a single-quoted scalar single-quoted, doubling inner quotes", () => {
    // CEL string literals use single quotes constantly, so this is the case a
    // naive implementation breaks first.
    expect(renderFixReplacement(`'startsWith(a, x)'`, `a.startsWith('x')`)).toBe(
      `'a.startsWith(''x'')'`,
    );
  });

  it("escapes a double quote and a backslash inside a double-quoted scalar", () => {
    expect(renderFixReplacement(`"x"`, `a.startsWith("x\\y")`)).toBe(
      `"a.startsWith(\\"x\\\\y\\")"`,
    );
  });

  it("leaves a plain scalar plain when the new value survives unquoted", () => {
    // A kind name: quoting it would be a correct but noisy diff.
    expect(renderFixReplacement("Run.Sequenc", "Run.Sequence")).toBe("Run.Sequence");
  });

  it("promotes a plain scalar to double quotes when the value would reparse", () => {
    // `: ` opens a mapping, so this cannot stay plain.
    expect(renderFixReplacement("x", "a.startsWith('k: v')")).toBe(`"a.startsWith('k: v')"`);
  });

  it("refuses a block scalar — its span carries the indicator AND the newline", () => {
    // Writing a single-line scalar over `>-\n  body\n` deletes the line break
    // that ended the mapping entry, gluing the next key onto the value.
    expect(renderFixReplacement(">-\n  'a' + startsWith(x, 'y')\n", "'a' + x.startsWith('y')")).toBeUndefined();
    expect(renderFixReplacement("|\n  line one\n  line two\n", "one line")).toBeUndefined();
  });

  it("refuses a multi-line replacement — its later lines would land at column 0", () => {
    expect(renderFixReplacement(`"x"`, "first\nsecond")).toBeUndefined();
  });
});

describe("isPlainSafe", () => {
  it("rejects values that stop being one scalar unquoted", () => {
    for (const unsafe of ["k: v", "trailing #c", "*anchor", "&ref", "%directive", "- item", "ends:", " padded", ""]) {
      expect(isPlainSafe(unsafe), unsafe).toBe(false);
    }
  });

  it("accepts ordinary values, including ones merely containing a colon", () => {
    // `a:b` is a plain scalar — only `: ` opens a mapping.
    for (const safe of ["Run.Sequence", "a:b", "nowIso()", "x-1"]) {
      expect(isPlainSafe(safe), safe).toBe(true);
    }
  });
});

describe("quoteStyleOf", () => {
  it("reads the style off the source span", () => {
    expect(quoteStyleOf(`"a"`)).toBe("double");
    expect(quoteStyleOf(`'a'`)).toBe("single");
    expect(quoteStyleOf(`a`)).toBe("plain");
    // A quote on one side only is not a quoted scalar.
    expect(quoteStyleOf(`"a`)).toBe("plain");
  });
});
