import type { ResourceManifest } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { AnalysisRegistry } from "../src/analysis-registry.js";
import { StaticAnalyzer } from "../src/analyzer.js";
import { flattenForAnalyzer } from "../src/flatten-for-analyzer.js";
import { Loader } from "../src/manifest-loader.js";
import { templateModule } from "../src/module-graph.js";
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

const KINDS = `kind: Telo.Definition
metadata: { name: Job }
capability: Telo.Invocable
controllers: [pkg:npm/@telorun/fixture@0.1.0#Job]
schema: { type: object }
---
kind: Telo.Definition
metadata: { name: Other }
capability: Telo.Invocable
controllers: [pkg:npm/@telorun/fixture@0.1.0#Other]
schema: { type: object }
---
kind: Telo.Definition
metadata: { name: Poller }
capability: Telo.Runnable
controllers: [pkg:npm/@telorun/fixture@0.1.0#Poller]
schema:
  type: object
  properties:
    job: { x-telo-ref: { kind: Telo.Executable, use: call } }
`;

async function analysisOf(text: string) {
  const url = "/app/telo.yaml";
  const graph = await new Loader([inMemorySource({ [url]: text })]).loadGraph(url, { desugarImports: true });
  const manifests = flattenForAnalyzer(graph);
  const registry = new AnalysisRegistry();
  new StaticAnalyzer().analyze(manifests, {}, registry);
  return { manifests, registry, analysis: registry.analysisOf(manifests) };
}

const APP = `kind: Telo.Application
metadata: { name: Choice }
variables:
  dialect:
    env: DIALECT
    type: string
    enum: [alpha, beta]
    default: beta
---
${KINDS}---
kind: Self.Poller
metadata: { name: poller }
job: !ref db
--- !switch
metadata: { name: db }
switch: !cel "variables.dialect"
cases:
  alpha: { kind: Self.Job }
  beta: { kind: Self.Other }
`;

describe("the module graph in a configuration", () => {
  it("lists the dimensions with their defaults, and draws one box per choice whose kind follows the pick", async () => {
    const { manifests, registry, analysis } = await analysisOf(APP);
    expect(analysis.graphConfigurations).toEqual({
      dimensions: [{ key: "variables.dialect", values: ["alpha", "beta"], default: "beta" }],
      default: { "variables.dialect": "beta" },
    });

    const drawn = (configuration: Record<string, unknown>) => {
      const options = { configuration };
      const graph = registry.analysisOf(manifests).moduleGraph(registry.moduleGraphDeps(manifests, options), options);
      return graph.nodes.find((n) => n.name === "db")!;
    };
    const beta = drawn({});
    const alpha = drawn({ "variables.dialect": "alpha" });
    expect(beta.id).toBe(alpha.id);
    expect([alpha.kind, beta.kind]).toEqual(["Self.Job", "Self.Other"]);
    expect(beta.choice).toEqual({
      path: "",
      tag: "switch",
      alternatives: [
        { key: "alpha", kind: "Self.Job" },
        { key: "beta", kind: "Self.Other" },
      ],
      selected: "beta",
    });
  });
});

describe("a template body with tagged entries", () => {
  it("draws a family as one box with a repeat marker, a choice as one box, and a repeat in targets as one row", async () => {
    const text = `kind: Telo.Library
metadata: { name: Blue }
exports: { kinds: [App] }
${KINDS}---
kind: Telo.Definition
metadata: { name: App }
capability: Telo.Service
schema:
  type: object
  properties:
    names: { type: array, items: { type: string } }
resources:
  - !for-each
    metadata: { name: jobs }
    in: !cel "self.names"
    as: n
    emit: { kind: Self.Job }
  - !if
    metadata: { name: pick }
    if: !cel "true"
    then: { kind: Self.Job }
  - kind: Self.Poller
    metadata: { name: poller }
    job: !ref "jobs[n.index]"
targets:
  - !for-each
    in: !cel "self.names"
    as: n
    emit: !ref "jobs[n.index]"
`;
    const url = "/blue/telo.yaml";
    const graph = await new Loader([inMemorySource({ [url]: text })]).loadGraph(url, { desugarImports: true });
    const manifests = flattenForAnalyzer(graph);
    const registry = new AnalysisRegistry();
    new StaticAnalyzer().analyze(manifests, {}, registry);
    const definition = manifests.find((m) => m.kind === "Telo.Definition" && m.metadata?.name === "App") as ResourceManifest;
    const body = templateModule(definition, manifests.find((m) => m.kind === "Telo.Library"), manifests);
    const all = [...body.resources, body.root];
    const built = registry.analysisOf(all).moduleGraph(registry.moduleGraphDeps(all, body.options), body.options);

    const nodes = built.nodes.filter((n) => !n.root);
    expect(nodes.map((n) => [n.name, n.kind])).toEqual([
      ["jobs", "Self.Job"],
      ["pick", "Self.Job"],
      ["poller", "Self.Poller"],
    ]);
    expect(nodes[0]!.family).toEqual({ source: "self.names", as: "n" });
    expect(nodes[1]!.choice).toMatchObject({ tag: "if", selected: "then", alternatives: [{ key: "then" }, { key: "absent" }] });
    expect(built.edges.find((e) => e.path === "job")!.to).toBe(nodes[0]!.id);
    expect(built.root!.rows).toMatchObject([{ kind: "repeat", repeat: { source: "self.names", as: "n" } }]);
  });
});
