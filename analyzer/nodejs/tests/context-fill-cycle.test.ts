import { describe, expect, it } from "vitest";
import { StaticAnalyzer } from "../src/analyzer.js";
import { collectModuleDocuments, flattenForAnalyzer } from "../src/flatten-for-analyzer.js";
import { Loader } from "../src/manifest-loader.js";
import type { ManifestSource } from "../src/types.js";

/** `x-telo-context-item-fills` and `CONTEXT_FILL_CYCLE`: entries of a list
 *  that fill a record's members and read each other's in a cycle. */

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
          values: { x-telo-context-from-root: model, x-telo-context-eval: accessor, x-telo-context-item-fills: ["", "/property"] }
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

const source = (files: Record<string, string>): ManifestSource => ({
  supports: () => true,
  async read(url: string) {
    const text = files[url];
    if (text === undefined) throw new Error(`File not found: ${url}`);
    return { text, source: url };
  },
  resolveRelative: (base: string, relative: string) => new URL(relative, `file://${base}`).pathname,
});

async function cycles(body: string) {
  const files = {
    "/app/telo.yaml": `kind: Telo.Application
metadata: { name: App }
---
${KINDS}---
kind: Telo.JsonSchema
metadata: { name: M }
schema:
  type: object
  properties:
    title: { type: string }
    sheet: { type: string }
---
${body}`,
  };
  const graph = await new Loader([source(files)]).loadGraph("/app/telo.yaml", { desugarImports: true });
  return new StaticAnalyzer()
    .analyze(flattenForAnalyzer(graph), { moduleDocuments: collectModuleDocuments(graph) })
    .filter((d) => d.code === "CONTEXT_FILL_CYCLE" || d.code === "CONTEXT_ITEM_FILLS_INVALID")
    .map((d) => [d.code, d.data?.path] as const);
}

describe("CONTEXT_FILL_CYCLE", () => {
  it("reports each read of a cycle running through a forwarded option source", async () => {
    expect(
      await cycles(`kind: App.Form
metadata: { name: f }
model: !ref M
fields:
  - kind: App.Field
    property: sheet
    shown: { at: !cel "values.title" }
  - kind: App.Field
    property: title
    options:
      kind: App.Options
      filters:
        sheet: !cel "values.sheet"
`),
    ).toEqual([
      ["CONTEXT_FILL_CYCLE", "fields[0].shown.at"],
      ["CONTEXT_FILL_CYCLE", "fields[1].options.filters.sheet"],
    ]);
  });

  it("reports an entry that reads the member it fills itself", async () => {
    expect(
      await cycles(`kind: App.Form
metadata: { name: f }
model: !ref M
fields:
  - title
  - kind: App.Field
    property: sheet
    shown: { at: !cel "values.sheet" }
`),
    ).toEqual([["CONTEXT_FILL_CYCLE", "fields[1].shown.at"]]);
  });

  it("says nothing of reads that only run one way", async () => {
    expect(
      await cycles(`kind: App.Form
metadata: { name: f }
model: !ref M
fields:
  - title
  - kind: App.Field
    property: sheet
    shown: { at: !cel "values.title" }
`),
    ).toEqual([]);
  });

  it("refuses the annotation off a list", async () => {
    const found = await cycles(`kind: Telo.Definition
metadata: { name: Bad }
capability: Telo.Provider
controllers:
  - pkg:telo/local/js?path=./x.mjs#X
schema:
  type: object
  properties:
    single:
      type: object
      x-telo-context:
        type: object
        properties:
          values: { x-telo-context-eval: accessor, x-telo-context-item-fills: [""] }
`);
    expect(found.map(([code]) => code)).toEqual(["CONTEXT_ITEM_FILLS_INVALID"]);
  });
});
