import { describe, expect, it } from "vitest";
import { AnalysisRegistry } from "../src/analysis-registry.js";
import { StaticAnalyzer } from "../src/analyzer.js";
import { flattenForAnalyzer } from "../src/flatten-for-analyzer.js";
import { Loader } from "../src/manifest-loader.js";
import type { ManifestSource } from "../src/types.js";

/**
 * A named shape nested inside a contract types the CEL that reads it. A `!ref`
 * below an `inputType` or `outputType` property is a `$ref` in the resolved
 * contract, which the member walk cannot see through — so a typo under it went
 * unreported and completion offered nothing there.
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
metadata: { name: Shapes, version: 0.1.0 }
---
kind: Telo.JsonSchema
metadata: { name: Local }
schema:
  type: object
  additionalProperties: false
  properties: { a: { type: string } }
---
kind: Telo.JsonSchema
metadata: { name: Tree }
schema:
  type: object
  additionalProperties: false
  properties:
    label: { type: string }
    children: { type: array, items: !ref Tree }
---
kind: Telo.Definition
metadata: { name: Flow }
capability: Telo.Runnable
controllers:
  - pkg:telo/local/js?path=./nowhere.mjs#Never
inputType:
  type: object
  properties:
    other: !ref Local
    tree: !ref Tree
schema:
  type: object
  properties:
    steps:
      type: array
      items: { $ref: "telo://manifest#/$defs/Step" }
---
kind: Telo.Definition
metadata: { name: Producer }
capability: Telo.Invocable
controllers:
  - pkg:telo/local/js?path=./nowhere.mjs#Never
outputType:
  type: object
  properties:
    other: !ref Local
schema: { type: object }
---
kind: Self.Producer
metadata: { name: produce }
`;

async function analyze(body: string) {
  const graph = await new Loader([source({ [URL_]: KINDS + body })]).loadGraph(URL_, {
    desugarImports: true,
  });
  const manifests = flattenForAnalyzer(graph);
  const registry = new AnalysisRegistry();
  const diagnostics = new StaticAnalyzer().analyze(manifests, {}, registry);
  return { diagnostics, manifests, registry };
}

function unknownFields(diagnostics: Array<{ code?: unknown; message: string }>): string[] {
  return diagnostics.filter((d) => d.code === "CEL_UNKNOWN_FIELD").map((d) => d.message);
}

const flow = (expression: string) => `---
kind: Self.Flow
metadata: { name: flow }
steps:
  - name: read
    value: !cel "${expression}"
`;

describe("a named shape nested in a contract", () => {
  it("types `inputs` below it: a misspelled field is reported, a declared one is not", async () => {
    const typo = await analyze(flow("inputs.other.b"));
    expect(unknownFields(typo.diagnostics)).toEqual([
      expect.stringContaining("'inputs.other.b' is not defined (available: a)"),
    ]);
    const declared = await analyze(flow("inputs.other.a"));
    expect(unknownFields(declared.diagnostics)).toEqual([]);
  });

  it("types `inputs` inside a template body the same way", async () => {
    const { diagnostics } = await analyze(`---
kind: Telo.Definition
metadata: { name: Wrapper }
capability: Telo.Runnable
schema: { type: object }
resources:
  - kind: Self.Flow
    metadata: { name: body }
    steps:
      - name: read
        value: !cel "inputs.other.b"
run: !ref body
`);
    expect(unknownFields(diagnostics)).toEqual([
      expect.stringContaining("'inputs.other.b' is not defined (available: a)"),
    ]);
  });

  it("types `steps.<name>.result` when the invoked output contract nests one", async () => {
    const { diagnostics } = await analyze(`---
kind: Self.Flow
metadata: { name: flow }
steps:
  - name: made
    invoke: !ref produce
  - name: read
    value: !cel "steps.made.result.other.b"
`);
    expect(unknownFields(diagnostics)).toEqual([
      expect.stringContaining("'steps.made.result.other.b' is not defined (available: a)"),
    ]);
  });

  it("offers the shape's fields to a scope query below it", async () => {
    const { manifests, registry } = await analyze(flow("inputs.other.a"));
    const query = registry.analysisOf(manifests).celScope;
    const resource = query.resourceFor("Self.Flow", "flow")!;
    const scope = query.scopeAt(resource, "steps[0].value");
    expect(Object.keys(scope.contextSchema?.properties?.inputs?.properties?.other?.properties ?? {})).toEqual([
      "a",
    ]);
  });

  it("reads a shape the registry holds without compiling it", async () => {
    // `Wrapped` spells its inner reference in the legacy authority form, which
    // the registry's copy keeps; compiling it throws, so the lookup must not.
    const files = {
      [URL_]: `kind: Telo.Library
metadata: { name: Legacy, version: 0.1.0 }
---
kind: Telo.JsonSchema
metadata: { name: Inner }
schema: { type: string }
---
kind: Telo.JsonSchema
metadata: { name: Wrapped }
schema:
  type: object
  additionalProperties: false
  properties:
    inner: { $ref: "telo://Self/Inner" }
---
kind: Telo.Definition
metadata: { name: Flow }
capability: Telo.Runnable
controllers:
  - pkg:telo/local/js?path=./nowhere.mjs#Never
inputType:
  type: object
  properties:
    wrapped: !ref Wrapped
schema:
  type: object
  properties:
    steps:
      type: array
      items: { $ref: "telo://manifest#/$defs/Step" }
---
kind: Self.Flow
metadata: { name: flow }
steps:
  - name: read
    value: !cel "inputs.wrapped.innr"
`,
    };
    const graph = await new Loader([source(files)]).loadGraph(URL_, { desugarImports: true });
    const diagnostics = new StaticAnalyzer().analyze(flattenForAnalyzer(graph));
    expect(unknownFields(diagnostics)).toEqual([
      expect.stringContaining("'inputs.wrapped.innr' is not defined (available: inner)"),
    ]);
  });

  it("expands a recursive shape once and still types its first level", async () => {
    const { diagnostics } = await analyze(flow("inputs.tree.lable"));
    expect(unknownFields(diagnostics)).toEqual([
      expect.stringContaining("'inputs.tree.lable' is not defined (available: label, children)"),
    ]);
  });
});
