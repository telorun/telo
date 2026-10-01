import { AnalysisRegistry } from "@telorun/analyzer";
import type { ResourceDefinition, ResourceManifest } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { buildCompletions } from "../src/completions/build.js";

/**
 * Parity between a contract node declared INLINE and the same node typed by a
 * reached type (`x-telo-value-schema-from` inside `inputType`): whatever the
 * editor offers for a call to the first, it offers for a call to the second.
 */

const HOST: ResourceDefinition = {
  kind: "Telo.Definition",
  metadata: { name: "Host", module: "test-fx" },
  capability: "Telo.Mount",
  schema: {
    type: "object",
    properties: {
      routes: {
        type: "array",
        items: {
          type: "object",
          properties: {
            handler: {
              "x-telo-ref": { kind: "Telo.Executable", use: "trigger.inbound", inputs: "/inputs" },
            },
            inputs: { type: "object", additionalProperties: true },
          },
        },
      },
    },
  },
} as unknown as ResourceDefinition;

const TURN = {
  type: "object",
  required: ["turnId"],
  properties: { turnId: { type: "string" } },
};

/** The control: its `context` input declares its members itself. */
const INLINE: ResourceDefinition = {
  kind: "Telo.Definition",
  metadata: { name: "Inline", module: "test-fx" },
  capability: "Telo.Invocable",
  schema: { type: "object" },
  inputType: {
    kind: "Telo.JsonSchema",
    schema: { type: "object", properties: { context: { ...TURN, default: {} } } },
  },
} as unknown as ResourceDefinition;

/** Its `context` input is whatever its own `contextType` declares. */
const TYPED: ResourceDefinition = {
  kind: "Telo.Definition",
  metadata: { name: "Typed", module: "test-fx" },
  capability: "Telo.Invocable",
  schema: {
    type: "object",
    properties: { contextType: { "x-telo-ref": { kind: "Telo.Type", use: "schema" } } },
  },
  inputType: {
    kind: "Telo.JsonSchema",
    schema: {
      type: "object",
      properties: {
        context: { type: "object", default: {}, "x-telo-value-schema-from": "contextType" },
      },
    },
  },
} as unknown as ResourceDefinition;

const TARGET_KIND = { inline: "Fx.Inline", typed: "Fx.Typed" } as const;

const resource = (name: string, kind: string, body: Record<string, unknown> = {}) =>
  ({ kind, metadata: { name, module: "test-app" }, ...body }) as unknown as ResourceManifest;

const RESOURCES = [
  resource("inline", "Fx.Inline"),
  resource("typed", "Fx.Typed", { contextType: { kind: "Telo.JsonSchema", schema: TURN } }),
  ...(["inline", "typed"] as const).map((target) =>
    resource(`${target}Api`, "Fx.Host", {
      routes: [{ handler: { kind: TARGET_KIND[target], name: target }, inputs: { context: {} } }],
    }),
  ),
];

function setup() {
  const registry = new AnalysisRegistry();
  registry.registerModuleIdentity("std", "test-fx");
  registry.registerImport("Fx", "test-fx", ["Host", "Inline", "Typed"]);
  for (const definition of [HOST, INLINE, TYPED]) registry.registerDefinition(definition);
  return { registry, analysis: registry.analysisOf(RESOURCES) };
}

/** The host calling `target`, with the cursor on a blank line beneath `under`. */
function at(target: "inline" | "typed", under: "inputs" | "context") {
  const lines = [
    "kind: Fx.Host",
    "metadata:",
    `  name: ${target}Api`,
    "routes:",
    `  - handler: !ref ${target}`,
    "    inputs:",
    ...(under === "inputs" ? ["      "] : ["      context:", "        "]),
  ];
  const line = lines.length - 1;
  return { text: lines.join("\n"), line, character: lines[line]!.length };
}

async function offered(target: "inline" | "typed", under: "inputs" | "context") {
  const { registry, analysis } = setup();
  const { text, line, character } = at(target, under);
  const results = await buildCompletions(text, line, character, registry, undefined, undefined, analysis);
  return results.map((result) => result.label).sort();
}

describe("call inputs typed by a reached type", () => {
  it("offers the typed key at the argument map, as for an inline node", async () => {
    expect(await offered("inline", "inputs")).toEqual(["context"]);
    expect(await offered("typed", "inputs")).toEqual(["context"]);
  });

  it("offers beneath the typed key exactly what an inline node offers there", async () => {
    expect(await offered("typed", "context")).toEqual(await offered("inline", "context"));
  });
});
