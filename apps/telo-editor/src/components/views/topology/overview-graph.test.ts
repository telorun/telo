import { AnalysisRegistry } from "@telorun/analyzer";
import type { ResourceDefinition, ResourceManifest } from "@telorun/sdk";
import { describe, expect, it } from "vitest";

function definition(
  name: string,
  capability: string,
  properties: Record<string, unknown> = {},
): ResourceDefinition {
  return {
    kind: "Telo.Definition",
    metadata: { name, module: "demo" },
    capability,
    schema: { type: "object", properties },
  } as unknown as ResourceDefinition;
}

function registry(): AnalysisRegistry {
  const reg = new AnalysisRegistry();
  reg.registerDefinition(
    definition("Worker", "Telo.Runnable", {
      uses: { "x-telo-ref": "demo#Conf" },
      next: { "x-telo-ref": "demo#Worker" },
    }),
  );
  reg.registerDefinition(definition("Conf", "Telo.Provider"));
  return reg;
}

describe("buildOverviewGraph", () => {
  it("splits refs into edges (node targets) and chips (ambient targets)", async () => {
    const { buildOverviewGraph } = await import("./overview-graph");
    const resources: ResourceManifest[] = [
      {
        kind: "demo.Worker",
        metadata: { name: "w" },
        uses: { kind: "demo.Conf", name: "c" },
        next: { kind: "demo.Worker", name: "w2" },
      },
      { kind: "demo.Worker", metadata: { name: "w2" } },
      { kind: "demo.Conf", metadata: { name: "c" } },
    ] as unknown as ResourceManifest[];

    const graph = buildOverviewGraph(resources, registry());

    expect(graph.edges).toEqual([{ from: "w", to: "w2", label: "next" }]);
    expect(graph.chips).toEqual([{ on: "w", target: "c", label: "uses" }]);
  });

  it("resolves a bare-name ref to its declared kind's capability", async () => {
    const { buildOverviewGraph } = await import("./overview-graph");
    const resources: ResourceManifest[] = [
      { kind: "demo.Worker", metadata: { name: "w" }, next: "w2" },
      { kind: "demo.Worker", metadata: { name: "w2" } },
    ] as unknown as ResourceManifest[];

    const graph = buildOverviewGraph(resources, registry());

    expect(graph.edges).toEqual([{ from: "w", to: "w2", label: "next" }]);
    expect(graph.chips).toEqual([]);
  });
});
