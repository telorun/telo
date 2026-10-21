import { describe, expect, it } from "vitest";
import { AnalysisRegistry } from "../src/analysis-registry.js";
import { StaticAnalyzer } from "../src/analyzer.js";
import { celEvalModeAt, celEvalSites } from "../src/eval-paths.js";
import { textSlotAccessorProblems } from "../src/text-slot-accessor.js";
import { flattenForAnalyzer } from "../src/flatten-for-analyzer.js";
import { Loader } from "../src/manifest-loader.js";
import type { ManifestSource } from "../src/types.js";

/**
 * Typing inside a node tree: context regions, eval paths and accessor sites
 * reached through a recursive named shape; nested regions adding to the one
 * enclosing them; bindings that exist only where a value is named; a schema
 * matched against the accessor it names.
 */

function source(files: Record<string, string>): ManifestSource {
  return {
    supports: () => true,
    async read(url: string) {
      const text = files[url];
      if (text === undefined) throw new Error(`File not found: ${url}`);
      return { text, source: url };
    },
    resolveRelative: (base: string, relative: string) => new URL(relative, `file://${base}`).pathname,
  };
}

const URL_ = "/lib/telo.yaml";

const KINDS = `kind: Telo.Library
metadata: { name: Tree, version: 0.1.0 }
---
kind: Telo.JsonSchema
metadata: { name: Node }
schema:
  type: object
  additionalProperties: false
  properties:
    children: { type: array, items: { $ref: "#" } }
    note:
      type: string
      x-telo-context:
        type: object
        additionalProperties: false
        properties:
          item:
            type: object
            additionalProperties: false
            properties: { name: { type: string } }
    shown:
      type: object
      additionalProperties: false
      x-telo-context:
        type: object
        additionalProperties: false
        properties:
          row:
            x-telo-context-eval: accessor
            type: object
            additionalProperties: false
            properties:
              amount: { type: integer }
              status: { type: string }
      properties:
        at: { x-telo-eval: accessor }
        matches: { type: object, x-telo-match-for: /at }
        label: { type: string, x-telo-eval: runtime }
    tags:
      type: object
      additionalProperties:
        type: string
        x-telo-context:
          type: object
          additionalProperties: false
          properties:
            tag:
              type: object
              additionalProperties: false
              properties: { code: { type: string } }
---
kind: Telo.Definition
metadata: { name: View }
capability: Telo.Invocable
controllers:
  - pkg:telo/local/js?path=./nowhere.mjs#Never
schema:
  type: object
  properties:
    title: { type: string, x-telo-eval: compile }
    content:
      x-telo-context:
        type: object
        additionalProperties: false
        properties:
          page:
            type: object
            additionalProperties: false
            properties: { heading: { type: string } }
      $ref: "telo://Self/Node"
`;

async function analyze(body: string, kinds = KINDS) {
  const graph = await new Loader([source({ [URL_]: kinds + body })]).loadGraph(URL_, {
    desugarImports: true,
  });
  const manifests = flattenForAnalyzer(graph);
  const registry = new AnalysisRegistry();
  const diagnostics = new StaticAnalyzer().analyze(manifests, {}, registry);
  return { diagnostics, manifests, registry };
}

const codes = (diagnostics: Array<{ code?: unknown; message: string; data?: unknown }>, code: string) =>
  diagnostics
    .filter((d) => d.code === code)
    .map((d) => `${(d.data as { path?: string } | undefined)?.path}: ${d.message}`);

const view = (content: string) => `---
kind: Self.View
metadata: { name: page }
content:
${content}
`;

describe("typing inside a recursive named shape", () => {
  it("reaches a region three levels down and reports an undeclared member there", async () => {
    const { diagnostics } = await analyze(
      view(`  children:
    - children:
        - children:
            - note: !cel "item.nmae"
              children: []
          `),
    );
    expect(codes(diagnostics, "CEL_UNKNOWN_FIELD")).toEqual([
      expect.stringMatching(/^content\.children\[0\]\.children\[0\]\.children\[0\]\.note: .*item\.nmae/),
    ]);
  });

  it("adds a nested region to the one enclosing it", async () => {
    const { diagnostics } = await analyze(
      view(`  children:
    - note: !cel "item.name + page.heading"
      children: []
  note: !cel "page.heading + page.missing"`),
    );
    expect(codes(diagnostics, "CEL_UNKNOWN_FIELD")).toEqual([
      expect.stringMatching(/^content\.note: .*page\.missing/),
    ]);
  });

  it("reaches a region under a map value", async () => {
    const { diagnostics } = await analyze(view(`  tags: { first: !cel "tag.cod" }`));
    expect(codes(diagnostics, "CEL_UNKNOWN_FIELD")).toEqual([
      expect.stringMatching(/^content\.tags\.first: .*tag\.cod/),
    ]);
    expect(codes(diagnostics, "CEL_IN_NON_EVAL_FIELD")).toEqual([]);
  });

  it("names the eval paths of the shape in the pattern grammar", async () => {
    const { registry, manifests } = await analyze(view(`  children: []`));
    const definition = registry.resolveDefinition("Tree.View")!;
    const sites = celEvalSites(definition.schema as Record<string, any>, registry.shapeLookup);
    expect(sites.accessor?.map((site) => [site.path, [...site.bindings].sort()])).toEqual([
      ["content(.children[*])*.shown.at", ["page", "row"]],
    ]);
    expect(sites.runtime).toEqual(["content(.children[*])*.shown.label"]);
    expect(celEvalModeAt(sites, "content.children[2].children[0].shown.label")).toBe("runtime");
    expect(manifests.length).toBeGreaterThan(0);
  });
});

describe("a named shape reused at many sites", () => {
  it("is walked once", () => {
    let reads = 0;
    const shape = new Proxy(
      {
        type: "object",
        properties: { at: { "x-telo-eval": "accessor" }, next: { $ref: "#" } },
      } as Record<string, any>,
      {
        get(target, key) {
          if (key === "properties") reads++;
          return target[key as string];
        },
      },
    );
    const schema = {
      type: "object",
      properties: Object.fromEntries(
        Array.from({ length: 30 }, (_, i) => [`f${i}`, { $ref: "telo:Shapes/Reused" }]),
      ),
    };
    const sites = celEvalSites(schema, (id) => (id === "telo:Shapes/Reused" ? shape : undefined));
    expect(sites.accessor).toHaveLength(30);
    expect(sites.accessor?.[0]?.path).toBe("f0(.next)*.at");
    expect(reads).toBeLessThan(5);
  });
});

describe("a binding marked x-telo-context-eval", () => {
  it("is in scope at an accessor field and unknown in an evaluated expression", async () => {
    const { diagnostics } = await analyze(
      view(`  shown:
    at: !cel "row.amount"
    matches: { type: integer }
    label: !cel "row.status"`),
    );
    expect(codes(diagnostics, "CEL_UNKNOWN_IDENTIFIER")).toEqual([
      expect.stringMatching(/^content\.shown\.label: .*row/),
    ]);
  });

  it("drops a binding not listing the site's mode, an accessor chain included", async () => {
    const kinds = KINDS.replace(
      "        label: { type: string, x-telo-eval: runtime }\n",
      "        label: { type: string, x-telo-eval: runtime }\n        note: { type: string, x-telo-eval: runtime }\n        other: { x-telo-eval: accessor }\n",
    ).replace(
      "          row:\n            x-telo-context-eval: accessor\n",
      "          stamp: { type: string, x-telo-context-eval: compile }\n          probe: { type: string, x-telo-context-eval: [runtime, accessor] }\n          row:\n            x-telo-context-eval: accessor\n",
    );
    const { diagnostics } = await analyze(
      view(`  shown:
    at: !cel "probe"
    other: !cel "stamp"
    matches: { type: string }
    label: !cel "probe"
    note: !cel "stamp"`),
      kinds,
    );
    expect(codes(diagnostics, "CEL_UNKNOWN_IDENTIFIER")).toEqual([
      expect.stringMatching(/^content\.shown\.other: .*stamp/),
      expect.stringMatching(/^content\.shown\.note: .*stamp/),
    ]);
  });

  it("is a schema violation when it names no mode, and a warning anywhere but a binding", async () => {
    const kinds = KINDS.replace("x-telo-context-eval: accessor", "x-telo-context-eval: [accessor, accessor]").replace(
      "note:\n      type: string\n",
      "note:\n      type: string\n      x-telo-context-eval: runtime\n",
    );
    const { diagnostics } = await analyze(view(`  children: []`), kinds);
    expect(codes(diagnostics, "SCHEMA_VIOLATION")).toEqual([
      expect.stringMatching(/^schema\.properties\.shown\.x-telo-context\.properties\.row\.x-telo-context-eval: /),
    ]);
    expect(codes(diagnostics, "CONTEXT_EVAL_MISPLACED")).toEqual([
      expect.stringMatching(/^schema\.properties\.note\.x-telo-context-eval: /),
    ]);
  });
});

describe("compile-time evaluation beside an accessor", () => {
  it("leaves the accessor alone and evaluates its siblings under one compile root", () => {
    const sites = celEvalSites({
      type: "object",
      "x-telo-eval": "compile",
      properties: {
        content: {
          type: "object",
          properties: { at: { "x-telo-eval": "accessor" }, text: { type: "string" } },
        },
      },
    });
    expect(celEvalModeAt(sites, "content.at")).toBe("accessor");
    expect(celEvalModeAt(sites, "content.text")).toBe("compile");
  });
});

describe("x-telo-match-for", () => {
  it("refuses a schema that can never hold for the accessor's type", async () => {
    const { diagnostics } = await analyze(
      view(`  children:
    - shown:
        at: !cel "row.amount"
        matches: { const: billing }
      children: []
  shown:
    at: !cel "row.amount"
    matches: { type: string }`),
    );
    expect(codes(diagnostics, "MATCH_UNSATISFIABLE")).toEqual([
      expect.stringMatching(/^content\.children\[0\]\.shown\.matches: .*'content\.children\[0\]\.shown\.at'/),
      expect.stringMatching(/^content\.shown\.matches: .*requires string/),
    ]);
  });

  it("accepts a schema that may hold, and judges a literal accessor as its value", async () => {
    const holds = await analyze(
      view(`  shown:
    at: !cel "row.status"
    matches: { enum: [paid, open] }`),
    );
    expect(codes(holds.diagnostics, "MATCH_UNSATISFIABLE")).toEqual([]);
    const literal = await analyze(
      view(`  shown:
    at: 3
    matches: { minimum: 1, type: string }`),
    );
    expect(codes(literal.diagnostics, "MATCH_UNSATISFIABLE")).toEqual([
      expect.stringMatching(/^content\.shown\.matches: /),
    ]);
  });

  it("is judged in a template body's entry and in a scope member", async () => {
    const { diagnostics } = await analyze(`---
kind: Telo.Definition
metadata: { name: Wrapper }
capability: Telo.Invocable
schema: { type: object, properties: { kind_: { type: string } } }
resources:
  - kind: Self.View
    metadata: { name: inner }
    content:
      shown:
        at: !cel "row.amount"
        matches: { type: boolean }
invoke: !ref inner
---
kind: Telo.Definition
metadata: { name: Scoped }
capability: Telo.Invocable
controllers:
  - pkg:telo/local/js?path=./nowhere.mjs#Never
schema:
  type: object
  properties:
    with:
      type: array
      x-telo-scope: /with
      items: { type: object }
---
kind: Self.Scoped
metadata: { name: scoped }
with:
  - kind: Self.View
    metadata: { name: member }
    content:
      shown:
        at: !cel "row.amount"
        matches: { type: "null" }
`);
    expect(codes(diagnostics, "MATCH_UNSATISFIABLE")).toEqual([
      expect.stringMatching(/^resources\[0\]\.content\.shown\.matches: .*requires boolean/),
      expect.stringMatching(/^with\[0\]\.content\.shown\.matches: .*requires null/),
    ]);
  });

  it("is judged in what a consumer forwards into a template body, at the consumer's path", async () => {
    const { diagnostics } = await analyze(`---
kind: Telo.Definition
metadata: { name: Framed }
capability: Telo.Invocable
schema:
  type: object
  properties:
    content: { type: object }
resources:
  - kind: Self.View
    metadata: { name: inner }
    content: !cel "self.content"
invoke: !ref inner
---
kind: Self.Framed
metadata: { name: framed }
content:
  shown:
    at: !cel "row.amount"
    matches: { enum: [a, b] }
`);
    expect(codes(diagnostics, "MATCH_UNSATISFIABLE")).toEqual([
      expect.stringMatching(/^content\.shown\.matches: .*one of "a", "b"/),
    ]);
  });

  it("is refused where it names no accessor", async () => {
    const kinds = KINDS.replace("x-telo-match-for: /at", "x-telo-match-for: /label").replace(
      "children: { type: array, items: { $ref: \"#\" } }",
      "children: { type: array, items: { $ref: \"#\" }, x-telo-match-for: /x }",
    );
    const { diagnostics } = await analyze(view(`  children: []`), kinds);
    expect(codes(diagnostics, "MATCH_FOR_INVALID")).toEqual([
      expect.stringMatching(/^schema\.properties\.children\.x-telo-match-for: .*declares nothing/),
      expect.stringMatching(/^schema\.properties\.shown\.properties\.matches\.x-telo-match-for: .*not an 'x-telo-eval: accessor'/),
    ]);
  });
});

const RULES = `kind: Telo.Library
metadata: { name: Forms, version: 0.1.0 }
---
kind: Telo.Definition
metadata: { name: Model }
capability: Telo.Provider
controllers:
  - pkg:telo/local/js?path=./nowhere.mjs#Never
schema:
  type: object
  properties:
    columns: { type: array, items: { type: string } }
---
kind: Telo.Definition
metadata: { name: Field }
capability: Telo.Provider
controllers:
  - pkg:telo/local/js?path=./nowhere.mjs#Never
schema:
  type: object
  properties:
    name: { type: string }
  x-telo-referrer-rules:
    - referrer: Self.Form
      resolve: [/model]
      condition: !cel "self.name in referrer.model.columns"
      code: FIELD_NOT_IN_MODEL
      message: the field names no column of the form's model
---
kind: Telo.Definition
metadata: { name: Form }
capability: Telo.Provider
controllers:
  - pkg:telo/local/js?path=./nowhere.mjs#Never
schema:
  type: object
  properties:
    model: { x-telo-ref: { kind: Self.Model, use: dependency } }
    fields:
      type: array
      items: { x-telo-ref: { kind: Self.Field, use: dependency } }
---
kind: Self.Model
metadata: { name: model }
columns: [id, total]
---
kind: Self.Field
metadata: { name: total }
name: total
---
kind: Self.Field
metadata: { name: owner }
name: owner
`;

describe("a referrer rule's resolve:", () => {
  it("reads the declaration a reference slot of the referrer names", async () => {
    const { diagnostics } = await analyze(
      `---
kind: Self.Form
metadata: { name: form }
model: !ref model
fields: [!ref total, !ref owner]
`,
      RULES,
    );
    expect(codes(diagnostics, "REFERRER_RULE_VIOLATED")).toEqual([
      expect.stringMatching(/^fields\[1\]: .*no column/),
    ]);
    expect(codes(diagnostics, "REFERRER_RULE_SKIPPED")).toEqual([]);
  });

  it("is refused without referrer:, and for a pointer the referrer does not declare", async () => {
    const kinds = RULES.replace("resolve: [/model]", "resolve: [/modl]").replace(
      "      message: the field names no column of the form's model",
      "      message: the field names no column of the form's model\n    - resolve: [/model]\n      condition: !cel \"true\"\n      code: UNFILTERED\n      message: m",
    );
    const { diagnostics } = await analyze("", kinds);
    expect(codes(diagnostics, "REFERRER_RULE_INVALID")).toEqual([
      expect.stringMatching(/\[0\]\.resolve\[0\]: .*does not declare/),
      expect.stringMatching(/\[1\]\.resolve: .*must also declare 'referrer:'/),
    ]);
  });
});

describe("a text typed beneath an accessor field inside a named shape", () => {
  it("is refused at the kind's field naming the shape", () => {
    const card = {
      type: "object",
      properties: {
        caption: { "x-telo-eval": "accessor", "x-telo-fragment": "Text" },
        more: { type: "array", items: { $ref: "#" } },
      },
    };
    const problems = textSlotAccessorProblems(
      "Kinds.Board",
      { type: "object", properties: { card: { $ref: "telo:Kinds/Card" } } },
      (ref) => (ref === "telo:Kinds/Card" ? card : undefined),
    );
    expect(problems).toEqual([
      {
        path: "schema.properties.card",
        message: expect.stringContaining(
          "'Kinds.Board' declares 'schema.properties.card', which reaches 'properties.caption.x-telo-eval: accessor' in the named shape 'Card' it names",
        ),
      },
    ]);
  });
});

