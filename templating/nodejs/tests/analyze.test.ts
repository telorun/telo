import { describe, expect, it } from "vitest";
import {
  extractAccessChains,
  findNullableAccessIssues,
  validateChainAgainstSchema,
} from "../src/cel/analyze.js";
import { buildCelEnvironment } from "../src/cel/environment.js";

const env = buildCelEnvironment();

describe("extractAccessChains", () => {
  it("returns a single chain for a dotted member access", () => {
    const ast = env.parse("request.query.name").ast;
    expect(extractAccessChains(ast)).toEqual([["request", "query", "name"]]);
  });

  it("treats bracket index access as a sentinel `[*]` segment", () => {
    const ast = env.parse("items[0].value").ast;
    expect(extractAccessChains(ast)).toEqual([["items", "[*]", "value"]]);
  });

  it("returns multiple chains when several roots are referenced", () => {
    const ast = env.parse("variables.a + secrets.b").ast;
    const chains = extractAccessChains(ast);
    expect(chains).toContainEqual(["variables", "a"]);
    expect(chains).toContainEqual(["secrets", "b"]);
  });

  it("ignores variables bound by comprehension macros", () => {
    const ast = env.parse("items.filter(x, x.valid)").ast;
    const chains = extractAccessChains(ast);
    // `items` should be captured; `x.valid` is bound to the macro and skipped.
    expect(chains).toContainEqual(["items"]);
    expect(chains.some((c) => c[0] === "x")).toBe(false);
  });

  it("descends through unary operators (`!`, `-`)", () => {
    // cel-js represents unary ops with a single ASTNode in `args`, not a
    // one-element array — the walker has to handle both shapes or chains
    // hidden under `!(...)` slip past static analysis.
    const negated = env.parse("!steps.parseManifest.result").ast;
    expect(extractAccessChains(negated)).toEqual([["steps", "parseManifest", "result"]]);
    const negative = env.parse("-counter.value").ast;
    expect(extractAccessChains(negative)).toEqual([["counter", "value"]]);
  });

  it("recovers chains from inside optional access (`.?`, `[?]`)", () => {
    const ast = env.parse("steps.x.result.docs[?0].?kind.orValue('')").ast;
    const chains = extractAccessChains(ast);
    expect(chains).toContainEqual(["steps", "x", "result", "docs"]);
  });
});

describe("validateChainAgainstSchema", () => {
  const schema = {
    type: "object",
    properties: {
      request: {
        type: "object",
        properties: {
          query: {
            type: "object",
            properties: { name: { type: "string" } },
          },
        },
      },
    },
  };

  it("returns null for a chain that resolves cleanly through the schema", () => {
    expect(validateChainAgainstSchema(["request", "query", "name"], schema)).toBeNull();
  });

  it("reports an error string for an unknown leaf field on a closed schema", () => {
    const closed = {
      type: "object",
      properties: { a: { type: "string" } },
      additionalProperties: false,
    };
    expect(validateChainAgainstSchema(["b"], closed)).toContain("'b' is not defined");
  });

  it("returns null when `additionalProperties: true` opens the parent", () => {
    const open = { type: "object", properties: {}, additionalProperties: true };
    expect(validateChainAgainstSchema(["anything"], open)).toBeNull();
  });

  it("flags member access past an x-telo-stream-marked property", () => {
    const streamSchema = {
      type: "object",
      properties: {
        result: {
          type: "object",
          properties: {
            output: { "x-telo-stream": true },
          },
        },
      },
    };
    // Reaching .output is fine (terminal), .output.text is not.
    expect(validateChainAgainstSchema(["result", "output"], streamSchema)).toBeNull();
    expect(
      validateChainAgainstSchema(["result", "output", "text"], streamSchema),
    ).toContain("yields a stream");
  });
});

describe("findNullableAccessIssues", () => {
  // `error` admits null; `value` is a plain object.
  const schema = {
    type: "object",
    properties: {
      error: {
        type: ["object", "null"],
        properties: { code: { type: "string" } },
        additionalProperties: false,
      },
      value: {
        type: "object",
        properties: { code: { type: "string" } },
      },
    },
  };
  const issues = (expr: string) => findNullableAccessIssues(env.parse(expr).ast, schema);

  it("flags an unguarded member access on a nullable value", () => {
    expect(issues("error.code")).toEqual([{ path: "error", member: "code" }]);
  });

  it("flags unguarded index access on a nullable value", () => {
    expect(issues("error[0]")).toEqual([{ path: "error", member: "[index]" }]);
  });

  it("descends into an index expression to catch a nullable used as the index", () => {
    expect(issues("value[error.code]")).toEqual([{ path: "error", member: "code" }]);
  });

  it("does not flag access on a non-nullable value", () => {
    expect(issues("value.code")).toEqual([]);
  });

  it("recognises a `!= null` guard in a ternary true branch", () => {
    expect(issues("error != null ? error.code : 'x'")).toEqual([]);
  });

  it("recognises an `== null` guard in a ternary false branch", () => {
    expect(issues("error == null ? 'x' : error.code")).toEqual([]);
  });

  it("recognises an `&&` short-circuit guard", () => {
    expect(issues("error != null && error.code == 'X'")).toEqual([]);
  });

  it("recognises an `||` short-circuit guard", () => {
    expect(issues("error == null || error.code == 'X'")).toEqual([]);
  });

  it("still flags an access outside the guarded branch", () => {
    // The guard narrows only the false branch; the then-branch access is unsafe.
    expect(issues("error == null ? error.code : 'x'")).toEqual([
      { path: "error", member: "code" },
    ]);
  });
});
