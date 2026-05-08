import { isCompiledValue } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { buildCelEnvironment } from "../src/cel/environment.js";
import { celEngine } from "../src/engines/cel.js";
import { literalEngine } from "../src/engines/literal.js";

const celEnv = buildCelEnvironment();

describe("celEngine.compile", () => {
  it("treats the entire source as a single CEL expression — no ${{ }} stripping", () => {
    const cv = celEngine.compile("1.0 + 2.0", { celEnv });
    expect(isCompiledValue(cv)).toBe(true);
    if (isCompiledValue(cv)) expect(cv.call({})).toBe(3);
  });

  it("evaluates against a runtime context like the untagged path", () => {
    const cv = celEngine.compile("variables.port * 2.0", { celEnv });
    if (!isCompiledValue(cv)) throw new Error("expected CompiledValue");
    expect(cv.call({ variables: { port: 21 } })).toBe(42);
  });

  it("throws on CEL syntax errors at compile time", () => {
    expect(() => celEngine.compile("variables.", { celEnv })).toThrow();
  });
});

describe("celEngine.analyze", () => {
  it("returns no diagnostics for a syntactically valid expression with an open context", () => {
    expect(celEngine.analyze("variables.port", { celEnv, contextSchema: null })).toEqual([]);
  });

  it("reports CEL_SYNTAX_ERROR with the parser's message", () => {
    const findings = celEngine.analyze("variables.", { celEnv, contextSchema: null });
    expect(findings).toHaveLength(1);
    expect(findings[0].code).toBe("CEL_SYNTAX_ERROR");
  });

  it("reports CEL_UNKNOWN_FIELD when a chain steps off a closed context", () => {
    const closed = {
      type: "object",
      properties: {
        request: {
          type: "object",
          properties: { name: { type: "string" } },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    };
    const findings = celEngine.analyze("request.missing", { celEnv, contextSchema: closed });
    expect(findings).toHaveLength(1);
    expect(findings[0].code).toBe("CEL_UNKNOWN_FIELD");
    expect(findings[0].message).toContain("missing");
  });

  it("ignores well-formed chains against an open `additionalProperties: true` schema", () => {
    const open = { type: "object", properties: {}, additionalProperties: true };
    expect(celEngine.analyze("anything.goes.here", { celEnv, contextSchema: open })).toEqual([]);
  });
});

describe("literalEngine", () => {
  it("compile returns the source string verbatim, including ${{ }} text", () => {
    expect(literalEngine.compile("Hello ${{ x }}", { celEnv })).toBe("Hello ${{ x }}");
    expect(literalEngine.compile("", { celEnv })).toBe("");
  });

  it("analyze always returns an empty diagnostic list", () => {
    expect(literalEngine.analyze("anything", { celEnv, contextSchema: null })).toEqual([]);
  });

  it("declares no Monaco language id (intentionally inert)", () => {
    expect(literalEngine.language).toBeUndefined();
  });
});
