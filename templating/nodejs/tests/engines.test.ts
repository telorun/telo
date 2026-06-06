import { isCompiledValue } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { buildCelEnvironment } from "../src/cel/environment.js";
import { celEngine } from "../src/engines/cel.js";
import { literalEngine } from "../src/engines/literal.js";
import { isParameterizedSql, sqlEngine } from "../src/engines/sql.js";

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

describe("sqlEngine.compile", () => {
  it("evaluates to a parameterized value: fragments + bound values, not a joined string", () => {
    const cv = sqlEngine.compile("WHERE id = ${{ variables.id }} AND n = ${{ variables.n }}", {
      celEnv,
    });
    if (!isCompiledValue(cv)) throw new Error("expected CompiledValue");
    const result = cv.call({ variables: { id: 7, n: "x" } });
    if (!isParameterizedSql(result)) throw new Error("expected ParameterizedSql");
    expect(result.fragments).toEqual(["WHERE id = ", " AND n = ", ""]);
    expect(result.values).toEqual([7, "x"]);
  });

  it("keeps a value with a quote intact (bound, never spliced)", () => {
    const cv = sqlEngine.compile("name = ${{ variables.name }}", { celEnv });
    if (!isCompiledValue(cv)) throw new Error("expected CompiledValue");
    const result = cv.call({ variables: { name: "O'Brien" } });
    if (!isParameterizedSql(result)) throw new Error("expected ParameterizedSql");
    expect(result.values).toEqual(["O'Brien"]);
  });

  it("handles a plain SQL string with no interpolation", () => {
    const cv = sqlEngine.compile("SELECT 1", { celEnv });
    if (!isCompiledValue(cv)) throw new Error("expected CompiledValue");
    const result = cv.call({});
    if (!isParameterizedSql(result)) throw new Error("expected ParameterizedSql");
    expect(result.fragments).toEqual(["SELECT 1"]);
    expect(result.values).toEqual([]);
  });
});

describe("sqlEngine.analyze", () => {
  it("reports CEL_SYNTAX_ERROR for a malformed interpolation", () => {
    const findings = sqlEngine.analyze("SELECT ${{ variables. }}", { celEnv, contextSchema: null });
    expect(findings).toHaveLength(1);
    expect(findings[0].code).toBe("CEL_SYNTAX_ERROR");
  });

  it("reports CEL_UNKNOWN_FIELD when an interpolation steps off a closed context", () => {
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
    const findings = sqlEngine.analyze("SELECT ${{ request.missing }}", {
      celEnv,
      contextSchema: closed,
    });
    expect(findings).toHaveLength(1);
    expect(findings[0].code).toBe("CEL_UNKNOWN_FIELD");
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
