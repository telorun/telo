import { isCompiledValue } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { createInheritedController } from "../src/controllers/resource-definition/resource-inherited-controller.js";
import { createTemplateController } from "../src/controllers/resource-definition/resource-template-controller.js";

/**
 * A pass resolving `self` before the step engine runs leaves every expression
 * inside a pure step's `value:` compiled — the engine reads a number there as
 * one the author wrote. Each body is expanded against stub contexts, so what the
 * pass hands on is its own output.
 */

const selfRatio = () => ({
  __compiled: true as const,
  source: "self.ratio",
  refs: ["self"],
  call: (activation: Record<string, unknown>) => (activation.self as { ratio: unknown }).ratio,
});

const sequenceKind = {
  kind: "Telo.Definition",
  metadata: { name: "Sequence" },
  capability: "Telo.Invocable",
  schema: {
    type: "object",
    properties: {
      label: {},
      with: { "x-telo-scope": ["/steps"] },
      steps: { type: "array", items: { "x-telo-fragment": "Step", type: "object" } },
    },
  },
};

const definitionOf = (kind: string) => (kind === "Lib.Sequence" ? sequenceKind : undefined);

describe("template body expansion of a step's `value:`", () => {
  it("leaves an expression in a `value:` slot compiled, in the entry and in a `with:` member", async () => {
    const whole = selfRatio();
    const member = selfRatio();
    const scoped = selfRatio();
    const registered: any[] = [];
    const childContext = {
      owner: undefined as unknown,
      bindContextValue: () => {},
      registerManifest: (manifest: unknown) => registered.push(manifest),
      initializeResources: async () => {},
      teardownResources: async () => {},
    };
    const definingContext = {
      expandWith: (value: unknown) => value,
      spawnChildContext: () => childContext,
      getDefinition: definitionOf,
    };
    const controller = createTemplateController({
      metadata: { name: "Scale" },
      schema: { type: "object", properties: { ratio: { type: "number" } } },
      resources: [
        {
          kind: "Lib.Sequence",
          metadata: { name: "inner" },
          label: selfRatio(),
          with: [
            {
              kind: "Lib.Sequence",
              metadata: { name: "scoped" },
              label: selfRatio(),
              steps: [{ name: "scoped", value: scoped }],
            },
          ],
          steps: [
            { name: "whole", value: whole },
            { name: "wrapped", value: { r: member } },
          ],
        },
      ],
    });

    const instance = await controller.create!(
      { kind: "Lib.Scale", metadata: { name: "scale" }, ratio: 3 } as any,
      { moduleContext: { resolveKindScope: () => definingContext }, ownerPrefix: "" } as any,
    );
    await instance!.init!({ effect: (reason: string, body: () => unknown) => body() } as any);

    const [inner] = registered;
    expect(inner.steps[0].value).toBe(whole);
    expect(inner.steps[1].value.r).toBe(member);
    expect(inner.with[0].steps[0].value).toBe(scoped);
    expect(inner.label).toBe(3);
    expect(inner.with[0].label).toBe(3);
  });
});

describe("`base:` expansion of a step's `value:`", () => {
  it("leaves an expression in a `value:` slot compiled, reading the instance's `self` when evaluated", async () => {
    let parent: any;
    const definingContext = {
      expandWith: (value: any, scope: Record<string, unknown>) => value.call(scope),
    };
    const controller = createInheritedController(
      {
        kind: "Telo.Definition",
        metadata: { name: "Scale" },
        extends: "Lib.Sequence",
        schema: { type: "object", properties: { ratio: { type: "number" } } },
        base: {
          label: selfRatio(),
          steps: [{ name: "whole", value: selfRatio() }],
        },
      } as any,
      definitionOf as any,
    );

    await controller.create!(
      { kind: "Lib.Scale", metadata: { name: "scale" }, ratio: 3 },
      {
        moduleContext: { resolveKindScope: () => definingContext },
        createInheritedInstance: async (_: unknown, resource: unknown) => {
          parent = resource;
          return {};
        },
      } as any,
    );

    expect(parent.label).toBe(3);
    const value = parent.steps[0].value;
    expect(isCompiledValue(value)).toBe(true);
    const activation: Record<string, unknown> = { self: "the parent's own" };
    expect(value.call(activation)).toBe(3);
    expect(activation.self).toBe("the parent's own");
  });
});
