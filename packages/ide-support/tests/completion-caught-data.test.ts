import {
  AnalysisRegistry,
  Loader,
  StaticAnalyzer,
  collectModuleDocuments,
  flattenForAnalyzer,
  type ManifestSource,
} from "@telorun/analyzer";
import { describe, expect, it } from "vitest";
import { buildCompletions } from "../src/completions/build.js";

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

/** A route catch list whose `problem` binding marks its data, and a handler
 *  whose one code declares `data: { id }`. */
const DOC = (body: string) => `kind: Telo.Application
metadata: { name: Shop, version: 0.1.0 }
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
                problem:
                  type: object
                  additionalProperties: false
                  properties:
                    code: { type: string, x-telo-caught-member: code }
                    data: { type: object, additionalProperties: true, x-telo-caught-member: data }
            items:
              type: object
              properties:
                when: { type: boolean }
                body: {}
---
kind: Telo.Definition
metadata: { name: Lookup }
capability: Telo.Invocable
controllers:
  - pkg:telo/local/js?path=./nodejs/shop.mjs&local_path=./nodejs/src/index.ts#Lookup
throws:
  codes:
    ORDER_NOT_FOUND:
      description: No such order.
      data: { type: object, properties: { id: { type: string } }, required: [id] }
schema: { type: object, properties: {} }
---
kind: Shop.Lookup
metadata: { name: lookup }
---
kind: Shop.Router
metadata: { name: orders }
routes:
  - handler: !ref lookup
    catches:
      - when: !cel "problem.code == 'ORDER_NOT_FOUND'"
        body: !cel "${body}"
`;

describe("completion inside a catch entry", () => {
  it("offers the data the entry's matched code declares after a data-marked member", async () => {
    const marker = "problem.data.|";
    const raw = DOC(marker);
    const offset = raw.indexOf("|");
    const text = raw.slice(0, offset) + raw.slice(offset + 1);
    const before = text.slice(0, offset).split("\n");
    const url = "/app/telo.yaml";
    const graph = await new Loader([inMemorySource({ [url]: text })]).loadGraph(url, {
      desugarImports: true,
      migrate: true,
    });
    const manifests = flattenForAnalyzer(graph);
    const registry = new AnalysisRegistry();
    new StaticAnalyzer().analyze(manifests, { moduleDocuments: collectModuleDocuments(graph) }, registry);
    const results = await buildCompletions(
      text,
      before.length - 1,
      before[before.length - 1]!.length,
      registry,
      undefined,
      undefined,
      registry.analysisOf(manifests),
    );
    expect(results.map((r) => r.label)).toEqual(["id"]);
  });
});
