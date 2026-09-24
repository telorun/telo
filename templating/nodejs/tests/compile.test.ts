import { isCompiledValue } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { buildCelEnvironment } from "../src/cel/environment.js";
import { compileExpression } from "../src/cel/compile.js";

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
