import type { ResourceDefinition, ResourceManifest } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { AnalysisRegistry } from "../src/analysis-registry.js";
import { withSyntheticPositions } from "../src/with-synthetic-positions.js";
import { StaticAnalyzer } from "../src/analyzer.js";

/**
 * A call made through a REFERENCE SLOT is checked like a step's.
 *
 * The slot names its argument map on its own `x-telo-ref` (`inputs: /inputs`);
 * without that the map is an open object beside a ref and nothing connects the
 * two. An HTTP route is exactly this shape, and it is not a step — so before
 * this the editor could complete those keys while the checker said nothing.
 */

const API: ResourceDefinition = {
  kind: "Telo.Definition",
  metadata: { name: "Api", module: "test-http" },
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
            inputs: { type: "object", additionalProperties: true, "x-telo-eval": "runtime" },
          },
        },
      },
    },
  },
} as unknown as ResourceDefinition;

const TARGET_DEF: ResourceDefinition = {
  kind: "Telo.Definition",
  metadata: { name: "Task", module: "test-run" },
  capability: "Telo.Invocable",
  schema: { type: "object", properties: { inputType: { type: "object" } } },
} as unknown as ResourceDefinition;

function target(): ResourceManifest {
  return {
    kind: "Run.Task",
    metadata: { name: "chatStart", module: "app" },
    inputType: {
      kind: "Telo.JsonSchema",
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["message"],
        properties: { conversationId: { type: "string" }, message: { type: "string" } },
      },
    },
  } as unknown as ResourceManifest;
}

function api(inputs: Record<string, unknown>): ResourceManifest {
  return {
    kind: "Http.Api",
    metadata: { name: "api", module: "app" },
    routes: [{ handler: { kind: "Run.Task", name: "chatStart" }, inputs }],
  } as unknown as ResourceManifest;
}

function check(inputs: Record<string, unknown>): string[] {
  const registry = new AnalysisRegistry();
  registry.registerModuleIdentity("std", "test-http");
  registry.registerModuleIdentity("std", "test-run");
  registry.registerModuleIdentity("std", "app");
  registry.registerImport("Http", "test-http", ["Api"]);
  registry.registerImport("Run", "test-run", ["Task"]);
  registry.registerDefinition(API);
  registry.registerDefinition(TARGET_DEF);
  const app = {
    kind: "Telo.Application",
    metadata: { name: "App" },
  } as unknown as ResourceManifest;
  return new StaticAnalyzer()
    .analyze(withSyntheticPositions([app, target(), api(inputs)]), undefined, registry)
    .map((d) => d.message);
}

describe("call inputs through a reference slot", () => {
  /** The fixture writes the loader's INTERNAL `{kind, name}` ref form, which the
   *  author-facing check rejects on sight; that diagnostic is not what these
   *  assert, so they read the contract findings only. */
  const contractFindings = (messages: string[]): string[] =>
    messages.filter((m) => /inputs|required|additional/i.test(m));

  it("accepts a call that satisfies the target's contract", () => {
    expect(contractFindings(check({ message: "hi", conversationId: "c1" }))).toEqual([]);
  });

  it("reports a key the target does not declare", () => {
    const messages = check({ message: "hi", conversationIdd: "c1" });
    expect(messages.join("\n")).toMatch(/conversationIdd/);
  });

  it("reports a required input the call omits", () => {
    expect(check({ conversationId: "c1" }).join("\n")).toMatch(/message/);
  });
});
