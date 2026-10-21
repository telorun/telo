import {
  AnalysisRegistry,
  Loader,
  StaticAnalyzer,
  collectModuleDocuments,
  flattenForAnalyzer,
  type ManifestSource,
} from "@telorun/analyzer";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { celCompletionAt } from "../src/completions/cel-completion-at.js";
import { buildViewModel } from "../src/view-model/build-view-model.js";
import { outputSlotSites } from "../src/view-model/output-refusals.js";

const OWNER = fileURLToPath(new URL("./__fixtures__/view-model/telo.yaml", import.meta.url));
const uriOf = (source: string) => pathToFileURL(source).href;

class DiskSource implements ManifestSource {
  supports(url: string): boolean {
    return isAbsolute(url);
  }
  async read(url: string) {
    const path = statSync(url).isDirectory() ? join(url, "telo.yaml") : url;
    return { text: readFileSync(path, "utf8"), source: path };
  }
  resolveRelative(base: string, relative: string): string {
    return resolve(dirname(base), relative);
  }
  async exists(base: string, relative: string) {
    return existsSync(resolve(dirname(base), relative));
  }
}

/** The owner analysed exactly as `telo check` analyses it, fresh each call. */
async function analyse() {
  const graph = await new Loader([new DiskSource()]).loadGraph(OWNER, { desugarImports: true, migrate: true });
  const manifests = flattenForAnalyzer(graph);
  const registry = new AnalysisRegistry();
  new StaticAnalyzer().analyze(manifests, { moduleDocuments: collectModuleDocuments(graph) }, registry);
  return { graph, registry, analysis: registry.analysisOf(manifests) };
}

async function viewModel() {
  return buildViewModel({ owner: uriOf(OWNER), revision: 3, ...(await analyse()), uriOfSource: uriOf, documents: {} });
}

describe("buildViewModel", () => {
  it("is plain JSON", async () => {
    const model = await viewModel();
    expect(JSON.parse(JSON.stringify(model))).toEqual(model);
  });

  it("draws the owner as the analyzer's module graph rooted at its module document", async () => {
    const model = await viewModel();
    const { analysis, registry } = await analyse();
    const root = analysis.manifests.find((m) => m.kind === "Telo.Application")!;
    const options = { root, entryModule: "Shop" };
    const expected = analysis.moduleGraph(registry.moduleGraphDeps(analysis.manifests, options), options);
    expect(model.moduleGraph).toEqual(
      JSON.parse(
        JSON.stringify({
          root: expected.root,
          nodes: expected.nodes,
          edges: expected.edges,
          regions: expected.regions,
          kinds: expected.kinds,
        }),
      ),
    );
  });

  it("draws each templated kind's body, its definition addressed by URI", async () => {
    const { templates } = await viewModel();
    expect(Object.keys(templates)).toEqual(["Shop.Pipeline"]);
    const pipeline = templates["Shop.Pipeline"]!;
    expect(pipeline).toMatchObject({ kindId: "Shop.Pipeline", name: "Pipeline", module: "Shop", capability: "Telo.Runnable" });
    expect((pipeline.definition.metadata as { source: string }).source).toBe(uriOf(OWNER));
    const named = (name: string) => pipeline.graph.nodes.find((n) => n.name === name)!.id;
    expect(pipeline.graph.edges.some((e) => e.from === named("first") && e.to === named("second"))).toBe(true);
  });

  it("lists every reference the owner's documents write, the module document as a resource", async () => {
    expect((await viewModel()).referenceSites).toEqual([
      { source: { kind: "Work.Task", name: "main" }, path: "next", target: "tail" },
      { source: { kind: "Work.Task", name: "main" }, path: "source", target: "words" },
      { source: { kind: "Telo.Definition", name: "Pipeline" }, path: "run", target: "first" },
      { source: { kind: "Telo.Application", name: "Shop" }, path: "targets[0]", target: "main" },
    ]);
  });

  it("carries the registry's answers about kinds, constraints and contracts", async () => {
    const model = await viewModel();
    const { registry } = await analyse();
    expect(model.kindSpellings["Work.Task"]).toBe("Jobs.Task");
    expect(model.refConstraints["Jobs.Task"]).toEqual({
      accepted: [...registry.acceptedKindsForRef("Jobs.Task")!].sort(),
      userFacing: registry.userFacingKindsForRef("Jobs.Task"),
    });
    expect(model.refConstraints["Jobs.Task"]!.userFacing).toEqual(["Work.Task"]);
    expect(model.contracts["Jobs.Source"]).toEqual({ outputType: registry.outputTypeForKind("Jobs.Source") });
    expect(model.moduleRootSchema).toEqual(registry.resolveDefinitionIn("Telo.Application")!.schema);
  });

  it("names a kind spelling written only in a template body", async () => {
    expect((await viewModel()).kindSpellings["Work.Count"]).toBe("Jobs.Count");
  });

  it("refuses an owner resource at a slot, addressed by its kind and pointer, whose outputType it does not return", async () => {
    const { outputRefusals } = await viewModel();
    expect(outputRefusals.map(({ kind, pointer, refusals }) => ({ kind, pointer, refused: Object.keys(refusals) }))).toEqual([
      { kind: "Jobs.Task", pointer: "/properties/source", refused: ["words"] },
    ]);
  });

  it("judges a template body's entries in the body's own scope, never by an owner resource of the same name", async () => {
    const { templates } = await viewModel();
    const refusals = templates["Shop.Pipeline"]!.outputRefusals;
    expect(refusals.map(({ kind, pointer, refusals }) => ({ kind, pointer, refused: Object.keys(refusals) }))).toEqual([
      { kind: "Jobs.Task", pointer: "/properties/source", refused: ["src"] },
    ]);
  });
});

describe("outputSlotSites", () => {
  it("addresses each output-constrained slot by its JSON Pointer, escaping each segment", () => {
    const outputType = { type: "object" };
    const sites = outputSlotSites({
      properties: {
        "a/b~c": { "x-telo-ref": { kind: "Telo.Invocable", use: "call", outputType } },
        plain: { "x-telo-ref": { kind: "Telo.Invocable", use: "call" } },
      },
    });
    expect(sites.map((s) => s.pointer)).toEqual(["/properties/a~1b~0c"]);
    expect(sites[0]!.slot.outputType).toBe(outputType);
  });
});

describe("celCompletionAt", () => {
  it("completes a field's CEL value against the field's scope", async () => {
    const { analysis } = await analyse();
    const labels = celCompletionAt(analysis, {
      resource: { kind: "Work.Task", name: "main" },
      path: "label",
      tag: "cel",
      text: "Self.",
      offset: "Self.".length,
    }).map((r) => r.label);
    expect(labels).toEqual(["shout"]);
  });
});
