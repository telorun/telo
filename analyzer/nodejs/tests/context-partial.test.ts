import { collectFilePositions } from "../src/diagnostic-location.js";
import { describe, expect, it } from "vitest";
import { StaticAnalyzer } from "../src/analyzer.js";
import { collectModuleDocuments, flattenForAnalyzer } from "../src/flatten-for-analyzer.js";
import { Loader } from "../src/manifest-loader.js";
import type { ManifestSource } from "../src/types.js";

/**
 * `x-telo-context-partial: true`: a binding typed as some members of a record —
 * the object type its typing annotation or its own `properties` give it, every
 * member optional and nullable — through a referrer as well.
 */

const WITHHELD = "a destination reads only the roots bound where it is written.";

const KINDS = (destinationPartial: boolean) => `kind: Telo.JsonSchema
metadata: { name: Task }
schema:
  type: object
  additionalProperties: false
  required: [title, owner]
  properties:
    title: { type: string }
    owner:
      type: object
      additionalProperties: false
      required: [name]
      properties: { name: { type: string } }
---
kind: Telo.Definition
metadata: { name: Form }
capability: Telo.Service
controllers: [pkg:telo/local/js?path=./x.mjs#X]
schema:
  type: object
  additionalProperties: false
  properties:
    model: { x-telo-ref: { kind: Telo.Type, use: schema } }
    show:
      x-telo-eval: runtime
      x-telo-context:
        type: object
        properties:
          values: { x-telo-context-from: model, x-telo-context-partial: true, type: object, properties: {}, additionalProperties: false }
          draft:
            x-telo-context-partial: true
            type: object
            additionalProperties: false
            required: [owner]
            properties:
              owner: { type: object, additionalProperties: false, required: [name], properties: { name: { type: string } } }
---
kind: Telo.Abstract
metadata: { name: Destination }
capability: Telo.Invocable
schema:
  type: object
  x-telo-context:
    type: object
    properties:
      values:
        x-telo-context-from-referrer: values${destinationPartial ? "\n        x-telo-context-partial: true" : ""}
        x-telo-context-withheld: ${WITHHELD}
  properties: { href: { x-telo-eval: runtime } }
---
kind: Telo.Definition
metadata: { name: Go }
extends: Self.Destination
controllers: [pkg:telo/local/js?path=./x.mjs#X]
schema: { type: object, properties: {} }
---
kind: Telo.Definition
metadata: { name: Listing }
capability: Telo.Invocable
controllers: [pkg:telo/local/js?path=./x.mjs#X]
schema:
  type: object
  properties:
    model: { x-telo-ref: { kind: Telo.Type, use: schema } }
    create:
      x-telo-ref: { kind: Self.Destination, use: call }
      x-telo-context:
        type: object
        properties:
          values: { x-telo-context-from: model, x-telo-context-partial: true, type: object, properties: {}, additionalProperties: false }
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

async function diagnostics(body: string, kinds: string) {
  const files = { "/app/telo.yaml": `kind: Telo.Application\nmetadata: { name: App }\n---\n${kinds}${body}` };
  const graph = await new Loader([source(files)]).loadGraph("/app/telo.yaml", { desugarImports: true });
  return new StaticAnalyzer()
    .analyze(flattenForAnalyzer(graph), { moduleDocuments: collectModuleDocuments(graph), positions: collectFilePositions(graph) })
    .filter((d) => d.severity === 1)
    .map((d) => `${d.code} ${d.data?.resource?.name} ${d.data?.path}: ${d.message}`)
    .sort();
}

const FORM = (read: string) => `---
kind: App.Form
metadata: { name: form }
model: !ref Task
show: !cel "${read}"
`;

describe("a partial binding", () => {
  it("types each member of the record it is typed from as optional and nullable", async () => {
    const kinds = KINDS(false);
    expect(await diagnostics(FORM("values.owner == null ? '' : values.owner.name"), kinds)).toEqual([]);
    expect(await diagnostics(FORM("values.title"), kinds)).toEqual([]);
    const [nullable] = await diagnostics(FORM("values.owner.name"), kinds);
    expect(nullable).toMatch(/^CEL_NULLABLE_ACCESS form show: /);
    expect(await diagnostics(FORM("values.nope"), kinds)).toEqual([
      "CEL_UNKNOWN_FIELD form show: App.Form/form: !cel: 'values.nope' is not defined (available: title, owner)",
    ]);
  });

  it("types a node by its own properties the same way", async () => {
    const kinds = KINDS(false);
    const [nullable] = await diagnostics(FORM("draft.owner.name"), kinds);
    expect(nullable).toMatch(/^CEL_NULLABLE_ACCESS form show: /);
    expect(await diagnostics(FORM("draft.nope"), kinds)).toEqual([
      "CEL_UNKNOWN_FIELD form show: App.Form/form: !cel: 'draft.nope' is not defined (available: owner)",
    ]);
  });

  it("reaches a destination typed from its referrer, partial again or not, and withheld where none binds it", async () => {
    const body = `---
kind: App.Listing
metadata: { name: tasks }
model: !ref Task
create: { kind: App.Go, href: !cel "values.owner.name" }
---
kind: App.Listing
metadata: { name: typo }
model: !ref Task
create: { kind: App.Go, href: !cel "values.nope" }
---
kind: App.Go
metadata: { name: orphan }
href: !cel "values.title"
`;
    const once = await diagnostics(body, KINDS(false));
    expect(once.map((line) => line.split(":")[0])).toEqual([
      "CEL_NULLABLE_ACCESS tasks create.href",
      "CEL_UNKNOWN_FIELD typo create.href",
      "CEL_UNKNOWN_IDENTIFIER orphan href",
    ]);
    expect(once[2]).toBe(`CEL_UNKNOWN_IDENTIFIER orphan href: App.Go/orphan: !cel: 'values' is not available here: ${WITHHELD}`);
    expect(await diagnostics(body, KINDS(true))).toEqual(once);
  });
});

const BAD_KIND = (context: string, extra = "") => `---
kind: Telo.Definition
metadata: { name: Bad }
capability: Telo.Provider
controllers: [pkg:telo/local/js?path=./x.mjs#X]
schema:
  type: object
  properties:
    items: { type: array, items: { type: string } }${extra}
    shown:
      type: object
      x-telo-context:
        type: object
        properties:
${context}
      properties:
        at: { x-telo-eval: runtime }
`;

async function misuse(context: string, extra?: string) {
  const files = { "/app/telo.yaml": `kind: Telo.Application\nmetadata: { name: App }\n${BAD_KIND(context, extra)}` };
  const graph = await new Loader([source(files)]).loadGraph("/app/telo.yaml", { desugarImports: true });
  return new StaticAnalyzer()
    .analyze(flattenForAnalyzer(graph), { moduleDocuments: collectModuleDocuments(graph), positions: collectFilePositions(graph) })
    .map((d) => [d.code, d.data?.path]);
}

describe("a misplaced or malformed x-telo-context-partial", () => {
  const where = (node: string) => `schema.properties.shown.x-telo-context.properties.${node}.x-telo-context-partial`;

  it("is refused off a binding, on a node nothing gives an object type, and on one typed as no object", async () => {
    expect(await misuse("          values: { type: string }", "\n    loose: { type: object, properties: {}, x-telo-context-partial: true }")).toEqual([
      ["CONTEXT_PARTIAL_INVALID", "schema.properties.loose.x-telo-context-partial"],
    ]);
    expect(await misuse("          values: { type: object, x-telo-context-partial: true }")).toEqual([["CONTEXT_PARTIAL_INVALID", where("values")]]);
    expect(await misuse("          values: { type: string, x-telo-context-partial: true }")).toEqual([
      ["CONTEXT_PARTIAL_INVALID", where("values")],
    ]);
    expect(await misuse("          values: { x-telo-context-collection-from: items, x-telo-context-partial: true }")).toEqual([
      ["CONTEXT_PARTIAL_INVALID", where("values")],
    ]);
    expect(await misuse("          values: { type: object, properties: {}, x-telo-context-partial: yes }")).toEqual([
      ["SCHEMA_VIOLATION", where("values")],
    ]);
  });

  it("is accepted on a member of a binding, and beside a referrer typing that is withheld", async () => {
    expect(
      await misuse("          values:\n            type: object\n            properties:\n              owner: { type: object, properties: {}, x-telo-context-partial: true }"),
    ).toEqual([]);
    expect(
      await misuse("          values: { x-telo-context-from-referrer: values, x-telo-context-partial: true, x-telo-context-withheld: not here. }"),
    ).toEqual([]);
  });
});
