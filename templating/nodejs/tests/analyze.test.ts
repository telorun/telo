import { describe, expect, it } from "vitest";
import {
  extractAccessChains,
  extractReadChains,
  extractValueReadChains,
  validateChainAgainstSchema,
} from "../src/cel/analyze.js";
import { buildCelEnvironment } from "../src/cel/environment.js";

const env = buildCelEnvironment();

describe("extractAccessChains", () => {
  it("returns a single chain for a dotted member access", () => {
    const ast = env.parse("request.query.name").root;
    expect(extractAccessChains(ast)).toEqual([["request", "query", "name"]]);
  });

  it("treats bracket index access as a sentinel `[*]` segment", () => {
    const ast = env.parse("items[0].value").root;
    expect(extractAccessChains(ast)).toEqual([["items", "[*]", "value"]]);
  });

  it("returns multiple chains when several roots are referenced", () => {
    const ast = env.parse("variables.a + secrets.b").root;
    const chains = extractAccessChains(ast);
    expect(chains).toContainEqual(["variables", "a"]);
    expect(chains).toContainEqual(["secrets", "b"]);
  });

  it("ignores variables bound by comprehension macros", () => {
    const ast = env.parse("items.filter(x, x.valid)").root;
    const chains = extractAccessChains(ast);
    // `items` should be captured; `x.valid` is bound to the macro and skipped.
    expect(chains).toContainEqual(["items"]);
    expect(chains.some((c) => c[0] === "x")).toBe(false);
  });

  it("descends through unary operators (`!`, `-`)", () => {
    // A unary node holds its single `operand` — the walker has to descend
    // through it or chains hidden under `!(...)` slip past static analysis.
    const negated = env.parse("!steps.parseManifest.result").root;
    expect(extractAccessChains(negated)).toEqual([["steps", "parseManifest", "result"]]);
    const negative = env.parse("-counter.value").root;
    expect(extractAccessChains(negative)).toEqual([["counter", "value"]]);
  });

  it("recovers chains from inside optional access (`.?`, `[?]`)", () => {
    const ast = env.parse("steps.x.result.docs[?0].?kind.orValue('')").root;
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

  it("judges nothing below an index into an object that declares properties", () => {
    // `settings["theme"].mode` may name the declared `theme`, not a value of the
    // map's open half.
    const settings = {
      type: "object",
      properties: {
        settings: {
          type: "object",
          properties: { theme: { type: "object", properties: { mode: { type: "string" } } } },
          additionalProperties: { type: "object", properties: { enabled: { type: "boolean" } } },
        },
      },
    };
    expect(validateChainAgainstSchema(["settings", "[*]", "mode"], settings)).toBeNull();
  });

  it("flags member access past a live-typed property", () => {
    const streamSchema = {
      type: "object",
      properties: {
        result: {
          type: "object",
          properties: {
            output: { "x-telo-type": "Telo.Stream" },
          },
        },
      },
    };
    // Reaching .output is fine (terminal), .output.text is not.
    expect(validateChainAgainstSchema(["result", "output"], streamSchema)).toBeNull();
    expect(
      validateChainAgainstSchema(["result", "output", "text"], streamSchema),
    ).toContain("is a Telo.Stream, which holds no members");
  });
});

describe("cel.bind", () => {
  it("scopes the bound name to the body and leaves init in the enclosing scope", () => {
    const ast = env.parse("cel.bind(c, request.q, string(c) + item.x)").root;
    const chains = extractAccessChains(ast);
    expect(chains).toContainEqual(["request", "q"]);
    expect(chains).toContainEqual(["item", "x"]);
    expect(chains).not.toContainEqual(["c"]);
  });

  it("does not emit a chain for the `cel` pseudo-receiver", () => {
    const ast = env.parse("cel.bind(c, 150, string(c))").root;
    expect(extractAccessChains(ast)).not.toContainEqual(["cel"]);
  });

  it("still reports a name used in init, which the binding does not cover", () => {
    const ast = env.parse("cel.bind(c, c, string(c))").root;
    expect(extractAccessChains(ast)).toEqual([["c"]]);
  });

  it("resolves both names when binds are nested", () => {
    const ast = env.parse("cel.bind(a, variables.x, cel.bind(b, a + 1, string(a) + string(b)))").root;
    const chains = extractAccessChains(ast);
    expect(chains).toEqual([["variables", "x"]]);
  });
});

describe("extractReadChains", () => {
  it("follows a cel.bind name to the value it binds", () => {
    const ast = env.parse("cel.bind(t, self.table, t.size > 0 && t == self.other)").root;
    expect(extractReadChains(ast)).toEqual([["self", "table", "size"], ["self", "table"], ["self", "other"]]);
  });

  it("reads a bound value nothing reads through whole, since it is still evaluated", () => {
    const ast = env.parse("cel.bind(t, self.table.name, self.size > 0)").root;
    expect(extractReadChains(ast)).toEqual([["self", "size"], ["self", "table", "name"]]);
  });
});

describe("validateChainAgainstSchema — conjuncts and local references", () => {
  it("reads a member through an allOf of a reference into the document's $defs", () => {
    const contract = {
      $defs: { reached: { type: "object", properties: { total: { type: "integer" } } } },
      type: "object",
      properties: { result: { allOf: [{ $ref: "#/$defs/reached" }] } },
    };
    const context = { type: "object", properties: { out: contract } };
    expect(validateChainAgainstSchema(["out", "result", "total"], context)).toBeNull();
    expect(validateChainAgainstSchema(["out", "result", "missing"], context)).toContain(
      "'out.result.missing' is not defined (available: total)",
    );
    expect(
      validateChainAgainstSchema(["out", "result", "missing"], {
        type: "object",
        properties: { out: { properties: { result: { allOf: [{ $ref: "telo:Lib/Shape" }] } } } },
      }),
    ).toBeNull();
  });
});

describe("validateChainAgainstSchema — unions", () => {
  const message = { type: "object", additionalProperties: false, properties: { orderId: { type: "string" } } };
  const context = {
    type: "object",
    properties: {
      result: {
        $defs: { reached: message },
        type: "object",
        properties: { message: { anyOf: [{ type: "null" }, { allOf: [{ $ref: "#/$defs/reached" }] }] } },
      },
    },
  };

  it("reads a member through the alternatives that can hold an object", () => {
    expect(validateChainAgainstSchema(["result", "message", "orderId"], context)).toBeNull();
    expect(validateChainAgainstSchema(["result", "message", "orderIdd"], context)).toContain(
      "'result.message.orderIdd' is not defined (available: orderId)",
    );
  });

  it("leaves the chain unjudged when an alternative is open", () => {
    const open = { type: "object", properties: { m: { anyOf: [message, { type: "object" }] } } };
    expect(validateChainAgainstSchema(["m", "anything"], open)).toBeNull();
  });
});

describe("extractValueReadChains", () => {
  const readsOf = (source: string) => extractValueReadChains(env.parse(source).root);
  const wholeOf = (source: string) => extractReadChains(env.parse(source).root);

  it("reads a bare iteration variable as each element of its range", () => {
    expect(readsOf("self.m.all(k, k in self.names)")).toContainEqual(["self", "m", "[]", "[]!"]);
    expect(wholeOf("self.m.all(k, k in self.names)")).toContainEqual(["self", "m"]);
  });

  it("reads the range of an `in` test as each element of it", () => {
    expect(readsOf("n in self.m")).toContainEqual(["self", "m", "[]", "[]!"]);
    expect(wholeOf("n in self.m")).toContainEqual(["self", "m"]);
  });

  it("keeps a member read through the variable as before", () => {
    expect(readsOf("self.xs.all(x, x.path != '')")).toContainEqual(["self", "xs", "[]", "path"]);
  });

  it("leaves a range that is only iterated unread", () => {
    expect(readsOf("self.xs.all(x, true)")).toEqual([["self", "xs", "[]"]]);
  });
});
