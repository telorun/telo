import { isCompiledValue, isParameterizedSql, RuntimeError } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { buildCelEnvironment } from "../src/cel/environment.js";
import { interpolationShape, readInterpolationHoles } from "../src/cel/interpolation-holes.js";
import { celExpressionsOf } from "../src/builtins.js";
import { interpolateEngine } from "../src/engines/interpolate.js";
import { sqlEngine } from "../src/engines/sql.js";

const celEnv = buildCelEnvironment();

function holes(source: string): string[] {
  const reading = readInterpolationHoles(source);
  if (!reading.ok) throw new Error(reading.message);
  return reading.holes.map((h) => h.expr);
}

describe("readInterpolationHoles", () => {
  it("reads a map literal and braces inside string literals as part of the hole", () => {
    expect(holes("${{ {'type': 'image', 'n': 1} }}")).toEqual(["{'type': 'image', 'n': 1}"]);
    expect(holes("a ${{ '}}' + x }} b ${{ \"{\" }}")).toEqual(["'}}' + x", '"{"']);
  });

  it("yields a literal ${{ from a hole holding it", () => {
    expect(holes("${{ '${{' }}")).toEqual(["'${{'"]);
  });

  it("treats a raw string's backslash as text", () => {
    expect(holes("${{ r'\\' }} x")).toEqual(["r'\\'"]);
  });

  it("offsets each expression within the source", () => {
    const reading = readInterpolationHoles("port ${{  ports.http }}!");
    expect(reading.ok && reading.holes[0]).toMatchObject({ start: 5, end: 23, exprStart: 10 });
  });

  it("refuses a hole that never closes", () => {
    const reading = readInterpolationHoles("a ${{ foo");
    expect(reading.ok).toBe(false);
    expect(!reading.ok && reading.offset).toBe(2);
  });

  it("classifies a scalar's shape", () => {
    expect(interpolationShape("plain")).toBe("none");
    expect(interpolationShape("  ${{ x }} ")).toBe("lone-hole");
    expect(interpolationShape("${{ x }}${{ y }}")).toBe("interpolated");
    expect(interpolationShape("a ${{ x }}")).toBe("interpolated");
    expect(interpolationShape("${{ x")).toBe("malformed");
  });
});

describe("interpolate engine", () => {
  const run = (source: string, ctx: Record<string, unknown>) => {
    const compiled = interpolateEngine.compile(source, { celEnv });
    if (!isCompiledValue(compiled)) throw new Error("not compiled");
    return compiled.call(ctx);
  };

  it("joins text with each hole converted by CEL's string()", () => {
    expect(
      run("${{ n }} at ${{ t }} after ${{ d }}: ${{ b }} ${{ ok }}", {
        n: 42n,
        t: new Date("2026-01-02T03:04:05Z"),
        d: celEnv.evaluate("duration('90m')"),
        b: new TextEncoder().encode("hi"),
        ok: true,
      }),
    ).toBe("42 at 2026-01-02T03:04:05.000Z after 5400s: hi true");
  });

  it("refuses a hole that is null at runtime, naming it", () => {
    expect(() => run("id ${{ x }}", { x: null })).toThrow(RuntimeError);
    try {
      run("id ${{ x }}", { x: null });
    } catch (error) {
      expect((error as RuntimeError).code).toBe("ERR_INTERPOLATION_HOLE_NOT_CONVERTIBLE");
      expect((error as Error).message).toContain("'${{ x }}'");
      expect((error as Error).message).toContain("null");
    }
  });

  it("carries every hole's roots and declares a string", () => {
    const compiled = interpolateEngine.compile("${{ a.x }}-${{ b }}", { celEnv });
    expect(isCompiledValue(compiled) && compiled.refs).toEqual(["a", "b"]);
    expect(interpolateEngine.producedType?.()).toEqual({ type: "string" });
  });

  it("refuses a hole CEL cannot convert, and passes one it can", () => {
    const analyze = (source: string) =>
      interpolateEngine.analyze(source, { celEnv, contextSchema: null }).diagnostics.map((d) => d.code);
    expect(analyze("${{ {'a': 1} }}")).toEqual(["INTERPOLATION_HOLE_NOT_CONVERTIBLE"]);
    expect(analyze("${{ [1] }}")).toEqual(["INTERPOLATION_HOLE_NOT_CONVERTIBLE"]);
    expect(analyze("${{ duration('1s') }} ${{ timestamp('2026-01-01T00:00:00Z') }} ${{ 1 }}")).toEqual([]);
    expect(analyze("${{ x")).toEqual(["CEL_SYNTAX_ERROR"]);
  });

  it("reports a nullable hole", () => {
    const { diagnostics } = interpolateEngine.analyze("${{ variables.x }}", {
      celEnv,
      contextSchema: {
        type: "object",
        properties: { variables: { type: "object", properties: { x: { type: ["string", "null"] } } } },
      },
    });
    expect(diagnostics.map((d) => d.code)).toEqual(["CEL_NULLABLE_ACCESS"]);
  });

  it("exposes its holes as expression regions", () => {
    expect(celExpressionsOf("interpolate", "a ${{ x.y }} b ${{ z }}")).toEqual(["x.y", "z"]);
    expect(celExpressionsOf("cel", "x + 1")).toEqual(["x + 1"]);
    expect(celExpressionsOf("literal", "${{ x }}")).toEqual([]);
  });
});

describe("sql engine", () => {
  it("binds each hole and keeps the text between them", () => {
    const compiled = sqlEngine.compile("WHERE id = ${{ id }} AND tag = '}'", { celEnv });
    const value = isCompiledValue(compiled) ? compiled.call({ id: 7n }) : undefined;
    expect(isParameterizedSql(value) && value).toMatchObject({
      fragments: ["WHERE id = ", " AND tag = '}'"],
      values: [7n],
    });
  });
});
