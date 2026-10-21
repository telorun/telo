import { describe, expect, it } from "vitest";
import { StaticAnalyzer } from "../src/analyzer.js";
import { collectModuleDocuments, flattenForAnalyzer } from "../src/flatten-for-analyzer.js";
import { Loader } from "../src/manifest-loader.js";
import type { ManifestSource } from "../src/types.js";

/**
 * `x-telo-context-from-referrer` — a referent kind's binding typed by the scope
 * at each slot referencing the resource: a field's `values` is its form's
 * record, an option source's the record of the form its field sits in.
 */

const KINDS = `kind: Telo.Definition
metadata:
  name: Form
capability: Telo.Provider
controllers:
  - pkg:telo/local/js?path=./x.mjs#X
schema:
  type: object
  additionalProperties: false
  properties:
    model: { x-telo-ref: { kind: Telo.Type, use: schema } }
    fields:
      type: array
      x-telo-context:
        type: object
        properties:
          values: { x-telo-context-from-root: model, x-telo-context-eval: accessor }
      items:
        anyOf:
          - type: string
          - x-telo-ref: { kind: Self.Field, use: dependency }
---
kind: Telo.Definition
metadata:
  name: Field
capability: Telo.Provider
controllers:
  - pkg:telo/local/js?path=./x.mjs#X
schema:
  type: object
  additionalProperties: false
  properties:
    property: { type: string }
    shown:
      type: object
      x-telo-context:
        type: object
        properties:
          values: { x-telo-context-from-referrer: values, x-telo-context-eval: accessor }
      properties:
        at: { x-telo-eval: accessor }
    options:
      x-telo-ref: { kind: Self.Options, use: dependency }
      x-telo-context:
        type: object
        properties:
          values: { x-telo-context-from-referrer: values, x-telo-context-eval: accessor }
---
kind: Telo.Definition
metadata:
  name: Options
capability: Telo.Provider
controllers:
  - pkg:telo/local/js?path=./x.mjs#X
schema:
  type: object
  additionalProperties: false
  properties:
    filters:
      type: object
      x-telo-context:
        type: object
        properties:
          values: { x-telo-context-from-referrer: values, x-telo-context-eval: accessor }
      additionalProperties: { x-telo-eval: accessor }
`;

const SHAPES = `---
kind: Telo.JsonSchema
metadata: { name: M }
schema:
  type: object
  additionalProperties: false
  properties:
    title: { type: string }
    sheet: { type: string }
---
kind: Telo.JsonSchema
metadata: { name: N }
schema:
  type: object
  additionalProperties: false
  properties:
    title: { type: string }
`;

const source = (files: Record<string, string>): ManifestSource => ({
  supports: () => true,
  async read(url: string) {
    const text = files[url];
    if (text === undefined) throw new Error(`File not found: ${url}`);
    return { text, source: url };
  },
  resolveRelative: (base: string, relative: string) => new URL(relative, `file://${base}`).pathname,
});

async function findings(files: Record<string, string>, entry = "/app/telo.yaml") {
  const graph = await new Loader([source(files)]).loadGraph(entry, { desugarImports: true });
  return new StaticAnalyzer()
    .analyze(flattenForAnalyzer(graph), { moduleDocuments: collectModuleDocuments(graph) })
    .filter((d) => d.severity === 1)
    .map((d) => [d.code, d.data?.resource?.name, d.data?.path, d.message] as const);
}

const app = (body: string) => ({
  "/app/telo.yaml": `kind: Telo.Application
metadata: { name: App }
---
${KINDS}${SHAPES}${body}`,
});

describe("x-telo-context-from-referrer", () => {
  it("types an inline field's binding from its form's scope", async () => {
    const found = await findings(
      app(`---
kind: App.Form
metadata: { name: f }
model: !ref M
fields:
  - title
  - kind: App.Field
    property: sheet
    shown: { at: !cel "values.titel" }
`),
    );
    expect(found.map(([code, , path]) => [code, path])).toEqual([["CEL_UNKNOWN_FIELD", "fields[1].shown.at"]]);
  });

  it("follows a chain: an option source reads the form its field sits in", async () => {
    const found = await findings(
      app(`---
kind: App.Form
metadata: { name: f }
model: !ref M
fields:
  - kind: App.Field
    property: title
    options:
      kind: App.Options
      filters:
        sheet: !cel "values.sheet"
        other: !cel "values.shet"
`),
    );
    expect(found.map(([code, , path]) => [code, path])).toEqual([
      ["CEL_UNKNOWN_FIELD", "fields[0].options.filters.other"],
    ]);
  });

  it("judges a field two forms reference under each, naming the one a finding holds for", async () => {
    const found = await findings(
      app(`---
kind: App.Form
metadata: { name: f }
model: !ref M
fields: [!ref shared]
---
kind: App.Form
metadata: { name: g }
model: !ref N
fields: [!ref shared]
---
kind: App.Field
metadata: { name: shared }
property: title
shown: { at: !cel "values.sheet" }
`),
    );
    expect(found).toHaveLength(1);
    expect(found[0]![0]).toBe("CEL_UNKNOWN_FIELD");
    expect(found[0]![3]).toContain("(as App.Form/g references it)");
  });

  it("reports a referent another module declares at the entry's referencing slot", async () => {
    const found = await findings({
      "/lib/telo.yaml": `kind: Telo.Library
metadata: { name: Lib, version: 0.1.0 }
exports:
  kinds: [Form, Field, Options]
  resources: [shared]
---
${KINDS}---
kind: Self.Field
metadata: { name: shared }
property: title
shown: { at: !cel "values.sheet" }
`,
      "/app/telo.yaml": `kind: Telo.Application
metadata: { name: App }
imports:
  Lib: ../lib/telo.yaml
---
${SHAPES.replace(/^---\n/, "")}---
kind: Lib.Form
metadata: { name: g }
model: !ref N
fields: [!ref Lib.shared]
`,
    });
    expect(found.map(([code, name, path]) => [code, name, path])).toEqual([["CEL_UNKNOWN_FIELD", "g", "fields[0]"]]);
  });

  it("leaves a binding nothing references untyped", async () => {
    const found = await findings(
      app(`---
kind: App.Field
metadata: { name: lonely }
property: title
shown: { at: !cel "values.whatever" }
`),
    );
    expect(found).toEqual([]);
  });

  it("refuses the annotation on a binding that exists outside accessor fields", async () => {
    const found = await findings({
      "/app/telo.yaml": `kind: Telo.Application
metadata: { name: App }
---
kind: Telo.Definition
metadata: { name: Bad }
capability: Telo.Provider
controllers:
  - pkg:telo/local/js?path=./x.mjs#X
schema:
  type: object
  properties:
    shown:
      type: object
      x-telo-context:
        type: object
        properties:
          values: { x-telo-context-from-referrer: values, x-telo-context-eval: [accessor, runtime] }
      properties:
        at: { x-telo-eval: accessor }
`,
    });
    expect(found.map(([code]) => code)).toEqual(["CONTEXT_FROM_REFERRER_INVALID"]);
  });
});
