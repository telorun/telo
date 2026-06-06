import { isCompiledValue } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { buildCelEnvironment } from "../src/cel/environment.js";
import { compileExpression, compileString, toParameterized } from "../src/cel/compile.js";

const env = buildCelEnvironment();

describe("compileExpression", () => {
  it("returns a CompiledValue that evaluates against a runtime context", () => {
    const cv = compileExpression("variables.port", env);
    expect(isCompiledValue(cv)).toBe(true);
    expect(cv.call({ variables: { port: 8080 } })).toBe(8080);
  });

  it("captures the source text on the CompiledValue", () => {
    const cv = compileExpression("a + b", env);
    expect(cv.source).toBe("a + b");
  });

  it("throws on syntax errors", () => {
    expect(() => compileExpression("variables.", env)).toThrow();
  });
});

describe("compileString", () => {
  it("returns the input string unchanged when there is no ${{ }}", () => {
    expect(compileString("plain text", env)).toBe("plain text");
  });

  it("returns a CompiledValue for an exact ${{ expr }} match", () => {
    const result = compileString("${{ 1.0 + 2.0 }}", env);
    expect(isCompiledValue(result)).toBe(true);
    if (isCompiledValue(result)) {
      expect(result.call({})).toBe(3);
    }
  });

  it("preserves leading and trailing whitespace inside an exact match", () => {
    const result = compileString("  ${{ variables.x }}  ", env);
    // Per EXACT_TEMPLATE_REGEX, trimmed whitespace counts as exact.
    expect(isCompiledValue(result)).toBe(true);
  });

  it("interpolates literal text with multiple ${{ }} segments", () => {
    const result = compileString("Hello ${{ 'world' }}, port ${{ 80 }}", env);
    expect(isCompiledValue(result)).toBe(true);
    if (isCompiledValue(result)) {
      expect(result.call({})).toBe("Hello world, port 80");
    }
  });

  it("stringifies null sub-expression results to empty in the interpolation", () => {
    const result = compileString("foo=${{ null }}", env);
    expect(isCompiledValue(result)).toBe(true);
    if (isCompiledValue(result)) {
      expect(result.call({})).toBe("foo=");
    }
  });

  it("throws on syntax errors inside ${{ }}", () => {
    expect(() => compileString("x${{ . }}y", env)).toThrow();
  });

  it("exposes parts on an interpolated CompiledValue", () => {
    const result = compileString("a ${{ 1 }} b ${{ 2 }}", env);
    expect(isCompiledValue(result)).toBe(true);
    if (isCompiledValue(result)) {
      expect(result.parts?.length).toBe(4);
    }
  });

  it("omits parts on a bare single expression", () => {
    const result = compileString("${{ 1 }}", env);
    expect(isCompiledValue(result)).toBe(true);
    if (isCompiledValue(result)) {
      expect(result.parts).toBeUndefined();
    }
  });
});

describe("toParameterized", () => {
  it("treats a plain string as a single fragment with no values", () => {
    expect(toParameterized("SELECT 1", {})).toEqual({ fragments: ["SELECT 1"], values: [] });
  });

  it("yields one value and surrounding fragments for an interpolated string", () => {
    const cv = compileString("WHERE id = ${{ variables.id }} AND n = ${{ variables.n }}", env);
    const result = toParameterized(cv, { variables: { id: 7, n: "x" } });
    expect(result.fragments).toEqual(["WHERE id = ", " AND n = ", ""]);
    expect(result.values).toEqual([7, "x"]);
    expect(result.fragments.length).toBe(result.values.length + 1);
  });

  it("keeps raw (non-stringified) values for binding", () => {
    const cv = compileString("v = ${{ variables.v }}", env);
    const result = toParameterized(cv, { variables: { v: null } });
    expect(result.values).toEqual([null]);
  });

  it("wraps a bare single expression as empty surrounding fragments", () => {
    const cv = compileExpression("variables.v", env);
    expect(toParameterized(cv, { variables: { v: 42 } })).toEqual({
      fragments: ["", ""],
      values: [42],
    });
  });
});
