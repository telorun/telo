import { describe, expect, it } from "vitest";
import { createTemplateController } from "../src/controllers/resource-definition/resource-template-controller.js";

const reading = (source: string) => ({
  __compiled: true as const,
  source,
  refs: ["self"],
  call: (activation: Record<string, unknown>) => (activation.self as { factor: unknown }).factor,
});

describe("`self` in a template body", () => {
  it("reads a declared integer as an integer in an expression, and a bare forward as written", async () => {
    const registered: any[] = [];
    const childContext = {
      owner: undefined as unknown,
      bindContextValue: () => {},
      registerManifest: (manifest: unknown) => registered.push(manifest),
      initializeResources: async () => {},
      teardownResources: async () => {},
    };
    const definingContext = {
      expandWith: (value: any, scope: Record<string, unknown>) => (typeof value?.call === "function" ? value.call(scope) : value),
      spawnChildContext: () => childContext,
      getDefinition: () => undefined,
    };
    const controller = createTemplateController(
      {
        metadata: { name: "Scale" },
        schema: { type: "object", properties: { factor: { type: "integer" } } },
        resources: [
          {
            kind: "Lib.Unknown",
            metadata: { name: "inner" },
            forwarded: reading("self.factor"),
            computed: reading("self.factor + 0"),
          },
        ],
      },
      {
        referencePositionsOf: () => [],
        shapeLookup: () => undefined,
        expansionSitesOf: () => new Map(),
        referenceSitesOf: () => [],
        analysisContext: () => {
          throw new Error("a body with no construct is not expanded");
        },
      } as any,
    );

    const instance = await controller.create!(
      { kind: "Lib.Scale", metadata: { name: "scale" }, factor: 3 } as any,
      { moduleContext: { resolveKindScope: () => definingContext }, ownerPrefix: "" } as any,
    );
    await instance!.init!({ effect: (reason: string, body: () => unknown) => body() } as any);

    expect(registered[0].forwarded).toBe(3);
    expect(registered[0].computed).toBe(3n);
  });
});
