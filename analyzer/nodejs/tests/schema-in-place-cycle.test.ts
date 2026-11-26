import { describe, expect, it } from "vitest";
import { StaticAnalyzer } from "../src/analyzer.js";
import { collectFilePositions } from "../src/diagnostic-location.js";
import { collectModuleDocuments, flattenForAnalyzer } from "../src/flatten-for-analyzer.js";
import { Loader } from "../src/manifest-loader.js";
import type { ManifestSource } from "../src/types.js";

function inMemorySource(files: Record<string, string>): ManifestSource {
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

/** Every diagnostic the entry's analysis reports, as `[code, path, message]`. */
async function check(files: Record<string, string>): Promise<Array<[string, string, string]>> {
  const graph = await new Loader([inMemorySource(files)]).loadGraph("/app/telo.yaml", { desugarImports: true });
  return new StaticAnalyzer()
    .analyze(flattenForAnalyzer(graph), { moduleDocuments: collectModuleDocuments(graph), positions: collectFilePositions(graph) })
    .map((d) => [String(d.code), String((d.data as { path?: unknown } | undefined)?.path), d.message]);
}

const app = (body: string) => ({ "/app/telo.yaml": `kind: Telo.Application\nmetadata: { name: App }\n---\n${body}` });

const TAIL =
  "so validating any value against it never ends. A schema may refer back to itself only beneath 'properties', " +
  "'patternProperties', 'additionalProperties', 'items', 'additionalItems', 'prefixItems' or 'contains'.";

/** A kind whose `s` holds a value of the named shape `S1`, and a resource giving one. */
const HOLDER = `kind: Telo.Definition
metadata: { name: Holder }
capability: Telo.Provider
controllers: ["pkg:telo/local/js?path=./x.mjs"]
schema:
  type: object
  properties:
    s: { $ref: "telo://Self/S1" }
---
kind: Self.Holder
metadata: { name: h }
s: 3
`;

describe("a schema recursing in place", () => {
  it("is one finding at a named shape referring to itself through anyOf, and no value is validated against it", async () => {
    expect(
      await check(
        app(`kind: Telo.JsonSchema
metadata: { name: S1 }
schema:
  anyOf:
    - { $ref: "telo://Self/S1" }
    - { type: string }
---
${HOLDER}`),
      ),
    ).toEqual([
      [
        "SCHEMA_IN_PLACE_CYCLE",
        "schema",
        `Telo.JsonSchema 'S1': its schema comes back to where it started without descending into the value — 'anyOf/0' of S1 refers to S1 — ${TAIL}`,
      ],
    ]);
  });

  it("is one finding at the first of two named shapes referring to each other through oneOf", async () => {
    expect(
      await check(
        app(`kind: Telo.JsonSchema
metadata: { name: S1 }
schema: { oneOf: [{ $ref: "telo://Self/S2" }, { type: string }] }
---
kind: Telo.JsonSchema
metadata: { name: S2 }
schema: { oneOf: [{ $ref: "telo://Self/S1" }, { type: integer }] }
---
${HOLDER}`),
      ),
    ).toEqual([
      [
        "SCHEMA_IN_PLACE_CYCLE",
        "schema",
        `Telo.JsonSchema 'S1': its schema comes back to where it started without descending into the value — 'oneOf/0' of S1 refers to S2, where 'oneOf/0' of S2 refers to S1 — ${TAIL}`,
      ],
    ]);
  });

  it("is one finding at a kind whose schema refers to its own root through anyOf", async () => {
    expect(
      await check(
        app(`kind: Telo.Definition
metadata: { name: Holder }
capability: Telo.Provider
controllers: ["pkg:telo/local/js?path=./x.mjs"]
schema: { anyOf: [{ $ref: "#" }] }
---
kind: Self.Holder
metadata: { name: h }
`),
      ),
    ).toEqual([
      [
        "SCHEMA_IN_PLACE_CYCLE",
        "schema",
        `Telo.Definition 'Holder': its schema comes back to where it started without descending into the value — 'anyOf/0' of schema refers to schema — ${TAIL}`,
      ],
    ]);
  });

  it("leaves a named shape referring to itself beneath an item alone", async () => {
    expect(
      await check(
        app(`kind: Telo.JsonSchema
metadata: { name: S1 }
schema:
  type: object
  properties:
    children: { type: array, items: { $ref: "telo://Self/S1" } }
---
kind: Telo.Definition
metadata: { name: Holder }
capability: Telo.Provider
controllers: ["pkg:telo/local/js?path=./x.mjs"]
schema:
  type: object
  properties:
    s: { $ref: "telo://Self/S1" }
---
kind: Self.Holder
metadata: { name: h }
s: { children: [{ children: [] }] }
`),
      ),
    ).toEqual([]);
  });

  it("reports a library's cyclic named shape at the consumer's imports: entry", async () => {
    const files = {
      "/app/telo.yaml": `kind: Telo.Application
metadata: { name: App }
imports: { Lib: ../lib/telo.yaml }
`,
      "/lib/telo.yaml": `kind: Telo.Library
metadata: { name: CyclicLib }
---
kind: Telo.JsonSchema
metadata: { name: S1 }
schema: { allOf: [{ $ref: "telo://Self/S1" }] }
`,
    };
    expect(await check(files)).toEqual([
      [
        "SCHEMA_IN_PLACE_CYCLE",
        "imports.Lib",
        "Imported library 'CyclicLib', reached through import 'Lib': Telo.JsonSchema 'S1': its schema comes back to where it " +
          `started without descending into the value — 'allOf/0' of S1 refers to S1 — ${TAIL}`,
      ],
    ]);
  });

  it("is a finding at a kind document declared as a scope member", async () => {
    const found = await check(
      app(`kind: Telo.Sequence
metadata: { name: main }
with:
  - kind: Telo.Definition
    metadata: { name: Inner }
    capability: Telo.Provider
    controllers: ["pkg:telo/local/js?path=./x.mjs"]
    schema: { oneOf: [{ $ref: "#" }] }
steps: []
`),
    );
    expect(found.map(([code, path]) => [code, path])).toEqual([["SCHEMA_IN_PLACE_CYCLE", "with[0].schema"]]);
  });

  it("is a finding at a function's own parameter schema", async () => {
    const found = await check(
      app(`kind: Telo.Function
metadata: { name: twice }
params:
  - name: x
    schema: { anyOf: [{ $ref: "#" }, { type: integer }] }
returns: { schema: { type: integer } }
body: !cel "x * 2"
`),
    );
    expect(found.map(([code, path]) => [code, path])).toEqual([["SCHEMA_IN_PLACE_CYCLE", "params[0].schema"]]);
  });

  it("is a finding at a need type's field, the field read as its own root", async () => {
    const found = await check(
      app(`kind: Telo.NeedType
metadata: { name: Db }
fields:
  url: { $defs: { L: { anyOf: [{ $ref: "#/$defs/L" }] } }, $ref: "#/$defs/L" }
`),
    );
    expect(found.map(([code, path]) => [code, path])).toEqual([["SCHEMA_IN_PLACE_CYCLE", "fields.url"]]);
  });
});

describe("a local reference naming nothing in a schema validated alone", () => {
  it("is one finding at the reference in a need type's field", async () => {
    const found = await check(
      app(`kind: Telo.NeedType
metadata: { name: Db }
fields:
  url: { type: string, allOf: [{ $ref: "#/properties/url" }] }
`),
    );
    expect(found).toEqual([
      [
        "SCHEMA_COMPILE_ERROR",
        "fields.url.allOf[0].$ref",
        "Telo.NeedType 'Db': the schema at 'fields.url' does not compile: its $ref '#/properties/url' names no node of it. " +
          "A '#' reference is read from the root of 'fields.url', which is a schema of its own.",
      ],
    ]);
  });

  it("is one finding at the reference in a module's variables: entry", async () => {
    const found = await check({
      "/app/telo.yaml": `kind: Telo.Application
metadata: { name: App }
variables:
  b: { env: B, type: object, default: {}, $ref: "#/$defs/Nope" }
`,
    });
    expect(found.filter(([code]) => code === "SCHEMA_COMPILE_ERROR").map(([code, path]) => [code, path])).toEqual([
      ["SCHEMA_COMPILE_ERROR", "variables.b.$ref"],
    ]);
  });

  it("reports a library's at the consumer's imports: entry", async () => {
    const files = {
      "/app/telo.yaml": `kind: Telo.Application
metadata: { name: App }
imports: { Lib: { source: ../lib/telo.yaml, variables: { b: 1 } } }
`,
      "/lib/telo.yaml": `kind: Telo.Library
metadata: { name: DanglingLib }
variables:
  b: { $ref: "#/$defs/Nope" }
`,
    };
    expect(await check(files)).toEqual([
      [
        "SCHEMA_COMPILE_ERROR",
        "imports.Lib",
        "Imported library 'DanglingLib', reached through import 'Lib': Telo.Library 'DanglingLib': the schema at 'variables.b' " +
          "does not compile: its $ref '#/$defs/Nope' names no node of it. A '#' reference is read from the root of 'variables.b', " +
          "which is a schema of its own.",
      ],
    ]);
  });
});
