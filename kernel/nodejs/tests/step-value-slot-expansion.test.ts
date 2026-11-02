import { isCompiledValue } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { buildCelEnvironment, compileExpression } from "@telorun/templating";
import { EvaluationContext } from "../src/evaluation-context.js";
import { expandMapping } from "../src/inherited-mapping.js";
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

const templateHost = {
  referencePositionsOf: () => [],
  shapeLookup: () => undefined,
  expansionSitesOf: () => new Map(),
  referenceSitesOf: () => [],
  analysisContext: () => {
    throw new Error("a body with no construct is not expanded");
  },
} as any;

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
      metadata: { name: "Scale", module: "Lib" },
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
    }, templateHost);

    const instance = await controller.create!(
      { kind: "Lib.Scale", metadata: { name: "scale" }, ratio: 3 } as any,
      {
        moduleContext: { resolveKindScope: () => definingContext, resolveKind: () => "Lib.Scale" },
        ownerPrefix: "",
      } as any,
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
  it("leaves an expression in a `value:` slot compiled, bound to the mapping's scope and the instance's `self`", () => {
    const self = { ratio: 3 };
    const bound: Array<{ value: unknown; bindings: Record<string, unknown> }> = [];
    const context = {
      expandWith: (value: any, scope: Record<string, unknown>) => value.call(scope),
      boundExpression: (value: unknown, bindings: Record<string, unknown>) => {
        bound.push({ value, bindings });
        return value;
      },
    };
    const kept = selfRatio();
    const mapped = expandMapping(
      { label: selfRatio(), steps: [{ name: "whole", value: kept }] },
      { context: context as any, bindings: { self }, forward: (keys) => (self as any)[keys[0]!], owner: "Lib.Scale", kept: ["base.steps[0].value"] },
      "base",
    ) as any;

    expect(mapped.label).toBe(3);
    expect(isCompiledValue(mapped.steps[0].value)).toBe(true);
    expect(bound).toEqual([{ value: kept, bindings: { self } }]);
  });

  it("evaluates a kept expression against the writer's globals and `self`, not the caller's globals", () => {
    const writer = new EvaluationContext(
      "writer",
      { variables: { who: "writer" } },
      async () => null,
      new Set(),
      async () => {},
    );
    const kept = compileExpression(
      "variables.who + '/' + string(self.n) + '/' + steps.s",
      buildCelEnvironment(),
    );

    const bound = writer.boundExpression(kept, { self: { n: 3 } }, "base.steps[0].value of Lib.Scale");

    expect(bound.call({ variables: { who: "caller" }, steps: { s: "call-local" } })).toBe("writer/3/call-local");
  });
});
