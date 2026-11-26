import { describe, expect, it } from "vitest";
import { StaticAnalyzer } from "../src/analyzer.js";
import { collectModuleDocuments, flattenForAnalyzer } from "../src/flatten-for-analyzer.js";
import { Loader } from "../src/manifest-loader.js";
import type { ManifestSource } from "../src/types.js";

/**
 * An `x-telo-context` at a kind's schema root: in force at every CEL site of
 * the resource, marking no field as evaluated, joined along `extends` by a
 * merge-form child and not inherited by a `base:` one.
 */

const KINDS = `kind: Telo.Abstract
metadata: { name: Cell }
capability: Telo.Provider
schema:
  type: object
  x-telo-context:
    type: object
    properties:
      row: { x-telo-context-from-root: model, x-telo-context-eval: accessor }
      tenant: { type: string }
  properties:
    model: { x-telo-ref: { kind: Telo.Type, use: schema } }
    value: { x-telo-eval: accessor }
    title: { type: string }
---
kind: Telo.Definition
metadata: { name: Pick }
extends: Self.Cell
controllers: [pkg:telo/local/js?path=./x.mjs#X]
schema: { type: object, properties: { label: { type: string } } }
---
kind: Telo.Definition
metadata: { name: Keyed }
extends: Self.Cell
controllers: [pkg:telo/local/js?path=./x.mjs#X]
schema:
  type: object
  x-telo-context:
    type: object
    properties:
      key: { type: object, properties: { id: { type: string } }, additionalProperties: false, x-telo-context-eval: accessor }
  properties:
    keyAt: { x-telo-eval: accessor }
---
kind: Telo.Definition
metadata: { name: Narrow }
extends: Self.Pick
base: { title: fixed }
schema: { type: object, properties: { caption: { type: string } } }
---
kind: Telo.Definition
metadata: { name: Card }
capability: Telo.Invocable
controllers: [pkg:telo/local/js?path=./x.mjs#X]
schema:
  type: object
  x-telo-context:
    type: object
    properties:
      tenant: { type: string }
  properties:
    note: { type: string }
    shown: { type: string, x-telo-eval: runtime }
---
kind: Telo.JsonSchema
metadata: { name: Todo }
schema:
  type: object
  additionalProperties: false
  properties:
    text: { type: string }
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

async function findings(body: string) {
  const files = {
    "/app/telo.yaml": `kind: Telo.Application
metadata: { name: App }
---
${KINDS}---
${body}`,
  };
  const graph = await new Loader([source(files)]).loadGraph("/app/telo.yaml", { desugarImports: true });
  return new StaticAnalyzer()
    .analyze(flattenForAnalyzer(graph), { moduleDocuments: collectModuleDocuments(graph) })
    .filter((d) => d.severity === 1)
    .map((d) => [d.code, (d.data as { path?: string } | undefined)?.path] as const);
}

describe("a context at a kind's schema root", () => {
  it("types its binding at an accessor field", async () => {
    expect(
      await findings(`kind: App.Pick
metadata: { name: a }
model: !ref Todo
value: !cel "row.txt"
`),
    ).toEqual([["CEL_UNKNOWN_FIELD", "value"]]);
  });

  it("drops an accessor-only binding at a provider's compile-eval field", async () => {
    expect(
      await findings(`kind: App.Pick
metadata: { name: a }
model: !ref Todo
value: !cel "row.text"
title: !cel "row.text"
label: !cel "tenant"
`),
      // One finding: the engine refuses the dropped binding, and no second walk reports it.
    ).toEqual([["CEL_UNKNOWN_IDENTIFIER", "title"]]);
  });

  it("marks no field as evaluated", async () => {
    expect(
      await findings(`kind: App.Card
metadata: { name: c }
note: !cel "tenant"
shown: !cel "tenant"
`),
    ).toEqual([["CEL_IN_NON_EVAL_FIELD", "note"]]);
  });

  it("joins along extends: a merge-form child adds a binding and keeps the inherited ones", async () => {
    expect(
      await findings(`kind: App.Keyed
metadata: { name: k }
model: !ref Todo
value: !cel "row.text"
keyAt: !cel "key.idd"
title: !cel "tenant"
`),
    ).toEqual([["CEL_UNKNOWN_FIELD", "keyAt"]]);
  });

  it("is not inherited by a base-form child, whose schema is its own", async () => {
    expect(
      await findings(`kind: App.Narrow
metadata: { name: n }
caption: !cel "tenant"
`),
    ).toEqual([["CEL_UNKNOWN_IDENTIFIER", "caption"]]);
  });
});
