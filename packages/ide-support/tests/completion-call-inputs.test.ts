import { AnalysisRegistry } from "@telorun/analyzer";
import type { ResourceDefinition, ResourceManifest } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { buildCompletions } from "../src/completions/build.js";

/**
 * The keys an `inputs:` map may carry.
 *
 * The map itself is an open object — its shape is the INVOKED resource's
 * declared `inputType`, and the only thing tying the two together is the
 * `inputs:` JSON Pointer on the sibling ref's own `x-telo-ref`. Resolution goes
 * through the shared contract resolver, so what is offered is what `telo check`
 * validates the call against and the kernel binds at dispatch.
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
            inputs: { type: "object", additionalProperties: true },
          },
        },
      },
    },
  },
} as unknown as ResourceDefinition;

const SEQUENCE: ResourceDefinition = {
  kind: "Telo.Definition",
  metadata: { name: "Sequence", module: "test-run" },
  capability: "Telo.Runnable",
  schema: { type: "object" },
} as unknown as ResourceDefinition;

/** The handler narrows the contract on its OWN manifest, which is the common
 *  shape for a `Run.Sequence` used as a route handler. */
const HANDLER: ResourceManifest = {
  kind: "Run.Sequence",
  metadata: { name: "chatStart", module: "test-app" },
  inputType: {
    kind: "Telo.JsonSchema",
    schema: {
      type: "object",
      required: ["message"],
      properties: {
        conversationId: { type: "string" },
        message: { type: "string", description: "The user's message." },
        clientIp: { type: "string" },
      },
    },
  },
} as unknown as ResourceManifest;

const ROUTES: ResourceManifest = {
  kind: "Http.Api",
  metadata: { name: "api", module: "test-app" },
  routes: [
    {
      handler: { kind: "Run.Sequence", name: "chatStart" },
      inputs: {},
    },
  ],
} as unknown as ResourceManifest;

function setup() {
  const r = new AnalysisRegistry();
  r.registerModuleIdentity("std", "test-http");
  r.registerModuleIdentity("std", "test-run");
  r.registerImport("Http", "test-http", ["Api"]);
  r.registerImport("Run", "test-run", ["Sequence"]);
  r.registerDefinition(API);
  r.registerDefinition(SEQUENCE);
  return { registry: r, analysis: r.analysisOf([ROUTES, HANDLER]) };
}

const TEXT = [
  "kind: Http.Api",
  "metadata:",
  "  name: api",
  "routes:",
  "  - handler: !ref chatStart",
  "    inputs:",
  "      ",
].join("\n");

describe("call inputs", () => {
  it("offers the invoked target's declared input keys", async () => {
    const { registry, analysis } = setup();
    const results = await buildCompletions(TEXT, 6, 6, registry, undefined, undefined, analysis);
    expect(results.map((r) => r.label).sort()).toEqual(["clientIp", "conversationId", "message"]);
  });

  it("carries the contract's required flag and descriptions", async () => {
    const { registry, analysis } = setup();
    const results = await buildCompletions(TEXT, 6, 6, registry, undefined, undefined, analysis);
    expect(results.find((r) => r.label === "message")?.preselect).toBe(true);
    expect(results.find((r) => r.label === "message")?.documentation).toBe("The user's message.");
    expect(results.find((r) => r.label === "clientIp")?.preselect).toBeUndefined();
  });

  it("drops a key already written", async () => {
    const { registry, analysis } = setup();
    const text = [
      "kind: Http.Api",
      "metadata:",
      "  name: api",
      "routes:",
      "  - handler: !ref chatStart",
      "    inputs:",
      "      message: hi",
      "      ",
    ].join("\n");
    const results = await buildCompletions(text, 7, 6, registry, undefined, undefined, analysis);
    expect(results.map((r) => r.label).sort()).toEqual(["clientIp", "conversationId"]);
  });

  it("offers nothing without the analysis — the target cannot be resolved", async () => {
    const { registry } = setup();
    expect(await buildCompletions(TEXT, 6, 6, registry)).toEqual([]);
  });
});
