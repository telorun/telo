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

const LIBRARY = `kind: Telo.Library
metadata:
  name: Blue
exports:
  kinds: [App]
---
kind: Telo.Definition
metadata:
  name: Job
capability: Telo.Invocable
controllers:
  - pkg:npm/@telorun/fixture@0.1.0#Job
schema:
  type: object
---
kind: Telo.Definition
metadata:
  name: Poller
capability: Telo.Runnable
controllers:
  - pkg:npm/@telorun/fixture@0.1.0#Poller
schema:
  type: object
  properties:
    job:
      x-telo-ref:
        kind: Telo.Executable
        use: call
---
kind: Telo.Definition
metadata:
  name: App
capability: Telo.Service
schema:
  type: object
resources:
  - kind: Self.Job
    metadata: { name: job }
  - kind: Self.Poller
    metadata: { name: poller }
    job: !ref job
  - kind: Self.Poller
    metadata: { name: idle }
    job: !ref job
targets:
  - !ref poller
`;

async function templateGraphOf(text: string, name: string) {
  const url = "/blue/telo.yaml";
  const graph = await new Loader([inMemorySource({ [url]: text })]).loadGraph(url, {
    desugarImports: true,
  });
  const manifests = flattenForAnalyzer(graph);
  const registry = new AnalysisRegistry();
  new StaticAnalyzer().analyze(manifests, {}, registry);
  const definition = manifests.find(
    (m) => m.kind === "Telo.Definition" && m.metadata?.name === name,
  ) as ResourceManifest;
  const moduleDoc = manifests.find((m) => m.kind === "Telo.Library");
  const body = templateModule(definition, moduleDoc, manifests);
  const all = [...body.resources, body.root];
  return registry
    .analysisOf(all)
    .moduleGraph(registry.moduleGraphDeps(all, body.options), body.options);
}

describe("a template body as a module graph", () => {
  it("draws each entry as a box, a sibling reference as an edge, and `targets:` as the boot list", async () => {
    const graph = await templateGraphOf(LIBRARY, "App");
    const id = (name: string) => graph.nodes.find((n) => !n.root && n.name === name)?.id;

    expect(graph.nodes.filter((n) => !n.root).map((n) => [n.name, n.capability])).toEqual([
      ["job", "Telo.Invocable"],
      ["poller", "Telo.Runnable"],
      ["idle", "Telo.Runnable"],
    ]);
    expect(
      graph.edges
        .filter((e) => !e.boot)
        .map((e) => ({ from: e.from, to: e.to, class: e.class, path: e.path })),
    ).toEqual([
      { from: id("poller"), to: id("job"), class: "flow", path: "job" },
      { from: id("idle"), to: id("job"), class: "flow", path: "job" },
    ]);
    expect(graph.root!.rows).toMatchObject([
      { kind: "target", index: 0, target: "poller", targetNode: id("poller") },
    ]);
    expect(graph.edgesFrom(graph.root!.id).map((e) => [e.to, e.boot])).toEqual([
      [id("poller"), true],
    ]);
  });

  it("draws a module resource the body references as the module's, with the edge to it", async () => {
    const graph = await templateGraphOf(
      `${LIBRARY}---
kind: Self.Job
metadata: { name: helper }
---
kind: Self.Poller
metadata: { name: shared }
job: !ref helper
---
kind: Self.Job
metadata: { name: unused }
---
kind: Telo.Definition
metadata:
  name: Outer
capability: Telo.Service
schema:
  type: object
resources:
  - kind: Self.Job
    metadata: { name: helper }
  - kind: Self.Poller
    metadata: { name: poller }
    job: !ref shared
`,
      "Outer",
    );
    const shared = graph.nodes.find((n) => n.name === "shared")!;
    expect(graph.nodes.filter((n) => !n.root).map((n) => [n.name, n.ownership])).toEqual([
      ["helper", "named"],
      ["poller", "named"],
      ["shared", "enclosing"],
    ]);
    const poller = graph.nodes.find((n) => n.name === "poller")!.id;
    expect(graph.edgesTo(shared.id).map((e) => [e.from, e.path, e.class])).toEqual([
      [poller, "job", "flow"],
    ]);
    // Its own `!ref helper` names the MODULE's helper, not the body's.
    expect(graph.edgesFrom(shared.id)).toEqual([]);
  });

  it("stands a node for each forwarded field, reached from every slot forwarding it", async () => {
    const graph = await templateGraphOf(
      `${LIBRARY}---
kind: Telo.Definition
metadata:
  name: Seq
capability: Telo.Runnable
controllers:
  - pkg:npm/@telorun/fixture@0.1.0#Seq
schema:
  type: object
  $defs:
    step:
      type: object
      properties:
        name: { type: string }
        invoke:
          x-telo-ref: { kind: Telo.Executable, use: call }
  properties:
    steps:
      x-telo-step-context: { invoke: invoke }
      type: array
      items: { $ref: "#/$defs/step" }
---
kind: Telo.Definition
metadata:
  name: Relay
capability: Telo.Runnable
schema:
  type: object
  properties:
    onDone:
      x-telo-ref: { kind: Telo.Executable, use: call }
resources:
  - kind: Self.Poller
    metadata: { name: poller }
    job: !cel "self.onDone"
  - kind: Self.Seq
    metadata: { name: flow }
    steps:
      - name: finish
        invoke: !cel "self.onDone"
run: !ref flow
`,
      "Relay",
    );
    const forwarded = graph.nodes.filter((n) => n.ownership === "forwarded");
    expect(forwarded.map((n) => [n.kind, n.name])).toEqual([["Blue.Relay", "onDone"]]);
    const id = (name: string) => graph.nodes.find((n) => n.name === name)!.id;
    expect(
      graph.edgesTo(forwarded[0]!.id).map((e) => [e.from, e.path, e.toName, e.class, !!e.row]),
    ).toEqual([
      [id("poller"), "job", "self.onDone", "flow", false],
      [id("flow"), "steps[0].invoke", "self.onDone", "flow", true],
    ]);
    expect(graph.nodes.find((n) => n.name === "flow")!.rows[0]).toMatchObject({
      name: "finish",
      target: "self.onDone",
      targetNode: forwarded[0]!.id,
    });
  });

  it("draws an entry extracted from a sibling's inline declaration as owned by that sibling", async () => {
    const graph = await templateGraphOf(
      LIBRARY.replace(
        "    job: !ref job\n  - kind: Self.Poller\n    metadata: { name: idle }\n    job: !ref job\n",
        [
          "    job: { kind: Self.Job, name: poller_job }",
          "  - kind: Self.Job",
          "    metadata:",
          "      name: poller_job",
          "      xTeloOrigin: { parentKind: Self.Poller, parentName: poller, pathFromParent: job }",
          "",
        ].join("\n"),
      ),
      "App",
    );
    const poller = graph.nodes.find((n) => n.name === "poller")!;
    const extracted = graph.nodes.find((n) => n.name === "poller_job")!;
    expect(extracted).toMatchObject({ ownership: "inline", owner: poller.id, ownerSite: "job" });
    expect(graph.regions).toContainEqual(
      expect.objectContaining({ kind: "inline", owner: poller.id, members: [extracted.id] }),
    );
    expect(graph.edgesFrom(poller.id).map((e) => [e.path, e.to])).toEqual([["job", extracted.id]]);
  });

  it("boots a lone `run:` target the way it boots a `targets:` entry", async () => {
    const graph = await templateGraphOf(
      LIBRARY.replace("targets:\n  - !ref poller\n", "run: !ref idle\n"),
      "App",
    );
    const idle = graph.nodes.find((n) => !n.root && n.name === "idle")!.id;
    expect(graph.root!.rows).toMatchObject([{ kind: "target", index: 0, targetNode: idle }]);
  });
});
