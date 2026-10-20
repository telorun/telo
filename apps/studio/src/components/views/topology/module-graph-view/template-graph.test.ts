import { expect, it } from "vitest";
import { analysedApp } from "../../../../language/__tests__/view-model-fixture";
import { templateGraphFromViewModel } from "./template-graph";

it("reads a templated kind's body from the view model, its graph indexed for lookups", async () => {
  const { model } = await analysedApp();
  const data = model.templates["Shop.Pipeline"]!;
  const served = templateGraphFromViewModel(model, "Shop.Pipeline")!;

  expect(served).toMatchObject({ kindId: data.kindId, name: data.name, module: data.module, capability: data.capability });
  expect(served.graph.nodes.map((n) => n.id)).toEqual(data.graph.nodes.map((n) => n.id));
  for (const node of data.graph.nodes) {
    expect(served.graph.edgesFrom(node.id).map((e) => e.id)).toEqual(
      data.graph.edges.filter((e) => e.from === node.id).map((e) => e.id),
    );
  }
  expect(templateGraphFromViewModel(model, "Shop.Missing")).toBeNull();
});
