import { describe, expect, it } from "vitest";
import { extractAccessChains, validateChainAgainstSchema } from "../src/cel/analyze.js";
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
