import { expect, it } from "vitest";
import { moduleGraphFromData } from "../module-graph-from-data";
import { analysedApp } from "./view-model-fixture";

it("answers a module graph's lookups over served data as the analyzer's graph does", async () => {
  const { model, registry, analysis } = await analysedApp();
  const root = analysis.manifests.find((m) => m.kind === "Telo.Application")!;
  const options = { root, entryModule: "Shop" };
  const expected = analysis.moduleGraph(registry.moduleGraphDeps(analysis.manifests, options), options);
  const graph = moduleGraphFromData(model.moduleGraph!);

  expect(graph.nodes.length).toBeGreaterThan(0);
  const json = (value: unknown) => JSON.parse(JSON.stringify(value ?? null));
  for (const node of expected.nodes) {
    expect(graph.nodeById(node.id)).toEqual(json(node));
    expect(graph.edgesFrom(node.id)).toEqual(json(expected.edgesFrom(node.id)));
    expect(graph.edgesTo(node.id)).toEqual(json(expected.edgesTo(node.id)));
  }
  expect(moduleGraphFromData(model.moduleGraph!)).toBe(graph);
});
