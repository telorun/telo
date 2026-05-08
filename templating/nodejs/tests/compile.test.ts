import { isCompiledValue } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { buildCelEnvironment } from "../src/cel/environment.js";
import { compileExpression, compileString } from "../src/cel/compile.js";

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
});
