import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AnalysisRegistry } from "../src/analysis-registry.js";
import { StaticAnalyzer } from "../src/analyzer.js";
import { collectModuleDocuments } from "../src/index.js";
import { flattenForAnalyzer } from "../src/flatten-for-analyzer.js";
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

async function analyze(text: string) {
  const url = "/app/telo.yaml";
  const graph = await new Loader([inMemorySource({ [url]: text })]).loadGraph(url, { desugarImports: true });
  const manifests = flattenForAnalyzer(graph);
  const registry = new AnalysisRegistry();
  const diagnostics = new StaticAnalyzer().analyze(
    manifests,
    { moduleDocuments: collectModuleDocuments(graph) },
    registry,
  );
  const root = manifests.find((m) => m.kind === "Telo.Application")!;
  const options = { root, entryModule: root.metadata!.name as string };
  const analysis = registry.analysisOf(manifests);
  const deps = registry.moduleGraphDeps(manifests, options);
  return { diagnostics, analysis, deps, options, registry, manifests };
}

const APPLICATION = readFileSync(
  new URL("../../outline-conformance/vectors/application/telo.yaml", import.meta.url),
  "utf8",
);

/** A router mounted on two servers, one rendering every code and one none. */
const TWO_SERVERS = `kind: Telo.Application
metadata: { name: Doors, version: 0.1.0 }
targets:
  - !ref publicDoor
  - !ref internalDoor
---
kind: Telo.Definition
metadata: { name: Server }
capability: Telo.Service
controllers:
  - pkg:telo/local/js?path=./nodejs/doors.mjs&local_path=./nodejs/src/index.ts#Server
schema:
  type: object
  properties:
    mounts:
      type: array
      x-telo-topology-role: entries
      items:
        type: object
        properties:
          prefix: { type: string, x-telo-topology-role: matcher }
          router:
            x-telo-topology-role: handler
            x-telo-ref: { kind: Doors.Router, use: dependency, throwsThrough: true }
    catches:
      type: array
      x-telo-outcome-list: catches
      x-telo-catches-for: ""
      x-telo-context:
        type: object
        properties:
          error: { type: object, properties: { code: { type: string, x-telo-caught-member: code } } }
      items: { type: object, properties: { when: { type: boolean }, status: { type: integer } } }
---
kind: Telo.Definition
metadata: { name: Router }
capability: Telo.Mount
controllers:
  - pkg:telo/local/js?path=./nodejs/doors.mjs&local_path=./nodejs/src/index.ts#Router
schema:
  type: object
  properties:
    routes:
      type: array
      x-telo-topology-role: entries
      items:
        type: object
        properties:
          path: { type: string, x-telo-topology-role: matcher }
          handler:
            x-telo-topology-role: handler
            x-telo-ref: { kind: Telo.Invocable, use: trigger.inbound }
          catches:
            type: array
            x-telo-outcome-list: catches
            x-telo-catches-for: handler
            x-telo-context:
              type: object
              properties:
                error: { type: object, properties: { code: { type: string, x-telo-caught-member: code } } }
            items: { type: object, properties: { when: { type: boolean }, status: { type: integer } } }
---
kind: Telo.Definition
metadata: { name: Task }
capability: Telo.Invocable
throws:
  codes:
    ERR_BUSY: { description: Busy. }
controllers:
  - pkg:telo/local/js?path=./nodejs/doors.mjs&local_path=./nodejs/src/index.ts#Task
schema: { type: object, properties: {} }
---
kind: Doors.Task
metadata: { name: work }
---
kind: Doors.Router
metadata: { name: routes }
routes:
  - path: /work
    handler: !ref work
---
kind: Doors.Server
metadata: { name: publicDoor }
mounts:
  - prefix: /
    router: !ref routes
catches:
  - status: 500
---
kind: Doors.Server
metadata: { name: internalDoor }
mounts:
  - prefix: /
    router: !ref routes
`;

/** A step whose `name:` is written before its `if:` and reads the same text. */
const NAME_LIKE_PREDICATE = `kind: Telo.Application
metadata: { name: Gate, version: 0.1.0 }
targets:
  - name: open
    invoke: !ref gate
---
kind: Telo.Definition
metadata: { name: Sequence }
capability: Telo.Invocable
controllers:
  - pkg:telo/local/js?path=./nodejs/gate.mjs&local_path=./nodejs/src/index.ts#Sequence
schema:
  type: object
  properties:
    steps:
      type: array
      x-telo-topology-role: steps
      items: { $ref: "telo://manifest#/$defs/Step" }
---
kind: Gate.Sequence
metadata: { name: gate }
steps:
  - name: "true"
    if: !cel "true"
    then:
      - name: done
        value: 1
`;

describe("the outline", () => {
  it("reports a step's predicate under the field the step grammar names, whatever else reads the same", async () => {
    const { analysis, deps, options } = await analyze(NAME_LIKE_PREDICATE);
    const gate = analysis.outline(deps, options).resources.find((r) => r.name === "gate")!;
    expect(gate.rows[0]).toMatchObject({
      path: "steps[0]",
      predicateField: "if",
      predicate: { tag: "cel", source: "true", type: "bool" },
    });
  });

  it("names every item by its module-graph id and labels an entry point by its row's match", async () => {
    const { analysis, deps, options } = await analyze(APPLICATION);
    const graph = analysis.moduleGraph(deps, options);
    const outline = analysis.outline(deps, options);

    for (const resource of outline.resources) {
      const node = graph.nodeById(resource.id);
      expect(node).toBeDefined();
      expect(resource.rows.map((r) => r.id)).toEqual(
        node!.rows.filter((r) => r.kind !== "target" && r.kind !== "export").map((r) => r.id),
      );
    }
    const edges = new Map(graph.edges.map((e) => [e.id, e] as const));
    for (const entryPoint of outline.entryPoints) {
      const edge = edges.get(entryPoint.id)!;
      const row = graph.nodeById(entryPoint.owner)!.rows.find((r) => r.id === edge.row);
      expect(entryPoint.match).toEqual(edge.match ?? row?.match);
    }
    expect(outline.entryPoints.find((e) => e.path === "routes[0].handler")?.match).toEqual({ path: "/orders" });
  });

  it("keeps the module graph and the outline only for the same deps and options objects", async () => {
    const { analysis, deps, options, registry, manifests } = await analyze(APPLICATION);
    const graph = analysis.moduleGraph(deps, options);
    const outline = analysis.outline(deps, options);
    expect(analysis.moduleGraph(deps, options)).toBe(graph);
    expect(analysis.outline(deps, options)).toBe(outline);

    const otherOptions = { ...options };
    const graphForOptions = analysis.moduleGraph(deps, otherOptions);
    expect(graphForOptions).not.toBe(graph);
    expect(analysis.outline(deps, otherOptions)).not.toBe(outline);
    const graphForDeps = analysis.moduleGraph(registry.moduleGraphDeps(manifests, options), options);
    expect(graphForDeps).not.toBe(graph);
    expect(graphForDeps).not.toBe(graphForOptions);
  });

  it("answers a router on two servers per server, uncovered as the coverage pass reports it", async () => {
    const { diagnostics, analysis, deps, options } = await analyze(TWO_SERVERS);
    const outline = analysis.outline(deps, options);
    const [entryPoint] = outline.entryPoints;
    expect(entryPoint!.catches).toEqual([
      {
        code: "ERR_BUSY",
        covered: false,
        scope: {
          resource: "Doors\u0000Doors.Router\u0000routes",
          covered: false,
          enclosers: [
            {
              resource: "Doors\u0000Doors.Server\u0000publicDoor",
              covered: true,
              list: { list: "catches", entry: 0, undecided: [] },
              enclosers: [],
            },
            {
              resource: "Doors\u0000Doors.Server\u0000internalDoor",
              covered: false,
              enclosers: [],
            },
          ],
        },
      },
    ]);
    expect(
      diagnostics.filter((d) => d.code === "UNCOVERED_THROW_CODE").map((d) => (d.data as { uncovered: string[] }).uncovered),
    ).toEqual([["ERR_BUSY"]]);
  });
});
