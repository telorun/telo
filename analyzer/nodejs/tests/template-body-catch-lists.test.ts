import { describe, expect, it } from "vitest";
import { AnalysisRegistry } from "../src/analysis-registry.js";
import { StaticAnalyzer } from "../src/analyzer.js";
import { collectModuleDocuments } from "../src/index.js";
import { flattenForAnalyzer } from "../src/flatten-for-analyzer.js";
import { Loader } from "../src/manifest-loader.js";
import type { ManifestSource } from "../src/types.js";

/**
 * A catch list a template body writes whole is its definition's: no consumer
 * can change it, so a consumer's check does not judge it. One the consumer
 * forwards is judged as that consumer instantiates it.
 */
const LIB = `kind: Telo.Library
metadata: { name: Shop, version: 0.1.0 }
exports:
  kinds: [Fixed, Open]
---
kind: Telo.Definition
metadata: { name: Router }
capability: Telo.Mount
controllers:
  - pkg:telo/local/js?path=./nodejs/shop.mjs&local_path=./nodejs/src/index.ts#Router
schema:
  type: object
  properties:
    routes:
      type: array
      items:
        type: object
        properties:
          handler:
            x-telo-ref: { kind: Telo.Invocable, use: trigger.inbound }
          catches:
            type: array
            x-telo-outcome-list: catches
            x-telo-catches-for: handler
            x-telo-context:
              type: object
              additionalProperties: false
              properties:
                error:
                  type: object
                  additionalProperties: false
                  properties:
                    code: { type: string, x-telo-caught-member: code }
            items:
              type: object
              additionalProperties: false
              properties:
                when: { type: boolean }
                status: { type: integer }
---
kind: Telo.Definition
metadata: { name: Lookup }
capability: Telo.Invocable
controllers:
  - pkg:telo/local/js?path=./nodejs/shop.mjs&local_path=./nodejs/src/index.ts#Lookup
throws:
  codes:
    ORDER_NOT_FOUND: { description: No such order. }
schema: { type: object, properties: {} }
---
kind: Telo.Definition
metadata: { name: Fixed }
capability: Telo.Provider
schema: { type: object, additionalProperties: false, properties: {} }
resources:
  - kind: Self.Lookup
    metadata: { name: lookup }
  - kind: Self.Router
    metadata: { name: router }
    routes:
      - handler: !ref lookup
provide: !ref lookup
---
kind: Telo.Definition
metadata: { name: Open }
capability: Telo.Provider
schema:
  type: object
  additionalProperties: false
  properties:
    catches: { type: array, items: { type: object } }
resources:
  - kind: Self.Lookup
    metadata: { name: lookup }
  - kind: Self.Router
    metadata: { name: router }
    routes:
      - handler: !ref lookup
        catches: !cel "self.catches"
provide: !ref lookup
`;

const APP = `kind: Telo.Application
metadata: { name: App, version: 0.1.0 }
imports:
  Shop: ../lib/telo.yaml
---
kind: Shop.Fixed
metadata: { name: fixed }
---
kind: Shop.Open
metadata: { name: open }
catches:
  - when: !cel "error.code == 'ORDER_MISSING'"
    status: 404
`;

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

describe("a catch list a template body holds", () => {
  it("is judged at a consumer only where the consumer forwards it", async () => {
    const url = "/app/telo.yaml";
    const graph = await new Loader([inMemorySource({ [url]: APP, "/lib/telo.yaml": LIB })]).loadGraph(url, {
      desugarImports: true,
    });
    const diagnostics = new StaticAnalyzer().analyze(
      flattenForAnalyzer(graph),
      { moduleDocuments: collectModuleDocuments(graph) },
      new AnalysisRegistry(),
    );
    const coverage = diagnostics
      .filter((d) => ["UNCOVERED_THROW_CODE", "UNDECLARED_THROW_CODE"].includes(String(d.code)))
      .map((d) => [d.code, (d.data as { resource?: { name?: string } }).resource?.name, (d.data as { path?: string }).path]);
    expect(coverage).toEqual([
      ["UNDECLARED_THROW_CODE", "open", "catches[0].when"],
      ["UNCOVERED_THROW_CODE", "open", "catches"],
    ]);
  });
});
