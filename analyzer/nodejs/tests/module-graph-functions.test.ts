import { describe, expect, it } from "vitest";
import { AnalysisRegistry } from "../src/analysis-registry.js";
import { StaticAnalyzer } from "../src/analyzer.js";
import { flattenForAnalyzer } from "../src/flatten-for-analyzer.js";
import { Loader } from "../src/manifest-loader.js";
import type { ManifestSource } from "../src/types.js";

function inMemorySource(files: Record<string, string>): ManifestSource {
  return {
    supports() {
      return true;
    },
    async read(url: string) {
      const text = files[url];
      if (text === undefined) throw new Error(`File not found: ${url}`);
      return { text, source: url };
    },
    resolveRelative(base: string, relative: string): string {
      return new URL(relative, `file://${base}`).pathname;
    },
  };
}

const APP = `kind: Telo.Application
metadata:
  name: Billing
  version: 0.1.0
---
kind: Telo.JsonSchema
metadata:
  name: Money
schema: { type: number }
---
kind: Telo.Function
metadata:
  name: withVat
params:
  - name: net
    schema: !ref Money
returns:
  schema: !ref Money
body: !cel "net * 1.2"
---
kind: Telo.Function
metadata:
  name: gross
params:
  - name: net
    schema: { type: number }
returns:
  schema: { type: number }
body: !cel "Self.withVat(net) + Self.withVat(net)"
`;

describe("functions in the module graph", () => {
  it("draws a function as a box holding what it calls, shaped by the records its signature names", async () => {
    const url = "/app/telo.yaml";
    const graph = await new Loader([inMemorySource({ [url]: APP })]).loadGraph(url, { desugarImports: true });
    const manifests = flattenForAnalyzer(graph);
    const registry = new AnalysisRegistry();
    const diagnostics = new StaticAnalyzer().analyze(manifests, {}, registry);
    expect(diagnostics.filter((d) => d.severity === 1)).toEqual([]);
    const options = { entryModule: "Billing" };
    const moduleGraph = registry
      .analysisOf(manifests)
      .moduleGraph(registry.moduleGraphDeps(manifests, options), options);

    const id = (name: string) => moduleGraph.nodes.find((n) => n.name === name)?.id;
    expect(id("withVat")).toBeDefined();
    expect(id("gross")).toBeDefined();
    const summary = moduleGraph.edges
      .filter((e) => e.from === id("gross") || e.from === id("withVat"))
      .map((e) => ({ from: e.from, to: e.to, class: e.class, call: e.call }));
    expect(summary).toContainEqual({ from: id("gross"), to: id("withVat"), class: "holds", call: "withVat" });
    expect(summary.filter((e) => e.call === "withVat")).toHaveLength(1);
    expect(summary).toContainEqual({ from: id("withVat"), to: id("Money"), class: "shape", call: undefined });
  });
});
