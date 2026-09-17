import { describe, expect, it } from "vitest";
import { StaticAnalyzer } from "../src/analyzer.js";
import { flattenForAnalyzer } from "../src/flatten-for-analyzer.js";
import { Loader } from "../src/manifest-loader.js";
import type { ManifestSource } from "../src/types.js";

/**
 * A module call judged against what it reaches: its result type, its arity, its
 * arguments, and — for a function written in CEL — the body against the declared
 * result and parameters.
 */

function source(files: Record<string, string>): ManifestSource {
  return {
    supports: () => true,
    async read(url: string) {
      const text = files[url];
      if (text === undefined) throw new Error(`File not found: ${url}`);
      return { text, source: url };
    },
    resolveRelative: (base: string, relative: string) =>
      new URL(relative, `file://${base}`).pathname,
  };
}

async function check(
  files: Record<string, string>,
  entry = "/lib/telo.yaml",
): Promise<Array<[string, string]>> {
  const graph = await new Loader([source(files)]).loadGraph(entry, { desugarImports: true });
  return new StaticAnalyzer()
    .analyze(flattenForAnalyzer(graph))
    .map((d) => [String(d.code), d.message]);
}

const BILLING = `kind: Telo.Library
metadata: { name: Billing, version: 0.1.0 }
exports: { resources: [total, label, amountOf] }
---
kind: Telo.JsonSchema
metadata: { name: Money }
schema:
  type: object
  required: [amount, currency]
  properties:
    amount: { type: integer }
    currency: { type: string }
---
kind: Telo.Function
metadata: { name: total }
params:
  - name: items
    schema: { type: array, items: !ref Money }
returns:
  schema: !ref Money
body: !cel "items[0]"
---
kind: Telo.Function
metadata: { name: label }
params:
  - name: value
    schema: !ref Money
  - name: prefix
    schema: { type: string, default: "" }
    optional: true
returns:
  schema: { type: string }
body: !cel "prefix + value.currency"
---
kind: Telo.Function
metadata: { name: amountOf }
params:
  - name: value
    schema: !ref Money
returns:
  schema: { type: integer }
body: !cel "value.amount"
`;

const withFunction = (body: string) => ({
  "/lib/telo.yaml": `${BILLING}---
kind: Telo.Function
metadata: { name: probe }
params:
  - name: items
    schema: { type: array, items: !ref Money }
  - name: maybe
    schema: !ref Money
    nullable: true
  - name: tag
    schema: { type: object, required: [name], properties: { name: { type: string } } }
  - name: omitted
    schema: !ref Money
    optional: true
returns:
  schema: { type: string }
body: ${body}
`,
});

describe("a module call's result", () => {
  it("types as the callee's declared result, operators included", async () => {
    const diagnostics = await check(withFunction(`!cel "string(Self.amountOf(items[0]) + 'x')"`));
    expect(diagnostics).toEqual([
      ["CEL_TYPE_ERROR", "Telo.Function/probe: !cel at 'body': no such overload: int + string"],
    ]);
  });

  it("types a declared null result as CEL's null", async () => {
    const files = withFunction(`!cel "Self.nothing() == null ? 'none' : 'some'"`);
    files["/lib/telo.yaml"] += `---
kind: Telo.Function
metadata: { name: nothing }
returns:
  schema: { type: "null" }
body: !cel "null"
`;
    expect(await check(files)).toEqual([]);
  });

  it("checks a member read off it against the declared result's schema", async () => {
    const diagnostics = await check(withFunction(`!cel "Self.total(items).currancy"`));
    expect(diagnostics.map(([code]) => code)).toEqual(["CEL_UNKNOWN_FIELD"]);
    expect(diagnostics[0]![1]).toContain("currancy");
  });
});

describe("a module call's arguments", () => {
  it("are counted against the parameter list, optional parameters included", async () => {
    const diagnostics = await check(withFunction(`!cel "Self.label(items[0], 'a', 'b')"`));
    expect(diagnostics).toEqual([
      [
        "FUNCTION_ARITY_MISMATCH",
        "Telo.Function/probe: CEL at 'body' calls 'Self.label' with 3 argument(s), but it takes 1 to 2 (value, prefix?).",
      ],
    ]);
  });

  it("are checked by type against each parameter's schema", async () => {
    const diagnostics = await check(withFunction(`!cel "Self.label(items[0], 1)"`));
    expect(diagnostics).toEqual([
      [
        "FUNCTION_ARGUMENT_MISMATCH",
        "Telo.Function/probe: CEL at 'body' calls 'Self.label' passing a 'int' for parameter 'prefix', which expects 'string'.",
      ],
    ]);
  });

  it("are checked by declared shape when an argument names a value", async () => {
    const diagnostics = await check(withFunction(`!cel "Self.label(tag)"`));
    expect(diagnostics.map(([code]) => code)).toEqual(["FUNCTION_ARGUMENT_MISMATCH"]);
    expect(diagnostics[0]![1]).toContain("passing 'tag' for parameter 'value', whose declared shape disagrees with it");
  });
});

describe("a module call in an import's variables", () => {
  it("is judged once, at the import it configures", async () => {
    const diagnostics = await check(
      {
        "/lib/telo.yaml": `kind: Telo.Library
metadata: { name: Rates, version: 0.1.0 }
variables:
  rate: { type: integer }
`,
        "/app/telo.yaml": `kind: Telo.Application
metadata: { name: Shop, version: 0.1.0 }
imports:
  Rates:
    source: ../lib/telo.yaml
    variables:
      rate: !cel "Self.missing()"
`,
      },
      "/app/telo.yaml",
    );
    expect(diagnostics.map(([code]) => code)).toEqual(["FUNCTION_UNRESOLVED"]);
  });
});

describe("a template body's module call", () => {
  it("resolves through the module that defines the kind", async () => {
    const diagnostics = await check({
      "/lib/telo.yaml": `${BILLING}---
kind: Telo.Definition
metadata: { name: Echo }
capability: Telo.Invocable
schema:
  type: object
  properties:
    value: { x-telo-eval: compile }
controllers:
  - pkg:telo/local/js?path=./nowhere.mjs#Never
---
kind: Telo.Definition
metadata: { name: Priced }
capability: Telo.Invocable
schema: { type: object }
resources:
  - kind: Self.Echo
    metadata: { name: body }
    value: !cel "Self.amountOf()"
invoke: !ref body
`,
    });
    expect(diagnostics.map(([code]) => code)).toEqual(["FUNCTION_ARITY_MISMATCH"]);
  });
});

describe("a function body", () => {
  it("must produce the declared result", async () => {
    const diagnostics = await check(withFunction(`!cel "size(items)"`));
    expect(diagnostics).toEqual([
      [
        "FUNCTION_RETURN_MISMATCH",
        "Telo.Function/probe: CEL at 'body' returns 'int' but 'returns' declares 'string'.",
      ],
    ]);
  });

  it("sees through a named shape nested in a parameter's schema", async () => {
    const diagnostics = await check(withFunction(`!cel "items[0].currancy"`));
    expect(diagnostics.map(([code]) => code)).toEqual(["CEL_UNKNOWN_FIELD"]);
  });

  it("guards a nullable parameter and an optional one with no default", async () => {
    const nullable = await check(withFunction(`!cel "maybe.currency"`));
    const optional = await check(withFunction(`!cel "omitted.currency"`));
    for (const diagnostics of [nullable, optional]) {
      expect(diagnostics.map(([code]) => code)).toEqual(["CEL_NULLABLE_ACCESS"]);
    }
  });
});

describe("a function in the resources scope", () => {
  it("is absent, since a function publishes no reading", async () => {
    const diagnostics = await check({
      "/lib/telo.yaml": `${BILLING.replace("kind: Telo.Library", "kind: Telo.Application").replace("exports: { resources: [total, label, amountOf] }\n", "")}---
kind: Telo.Definition
metadata: { name: Probe }
capability: Telo.Invocable
schema:
  type: object
  properties:
    value: { x-telo-eval: runtime, x-telo-context: { type: object, properties: {} } }
controllers:
  - pkg:telo/local/js?path=./nowhere.mjs#Never
---
kind: Self.Probe
metadata: { name: probe }
value: !cel "resources.label"
`,
    });
    expect(diagnostics.map(([code]) => code)).toEqual(["CEL_UNKNOWN_FIELD"]);
    expect(diagnostics[0]![1]).toContain("resources.label");
  });
});
