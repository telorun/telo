import { AnalysisRegistry } from "@telorun/analyzer";
import type { ResourceDefinition, ResourceManifest } from "@telorun/sdk";
import { makeTaggedSentinel } from "@telorun/templating";
import { describe, expect, it } from "vitest";
import { buildCompletions } from "../src/completions/build.js";

/**
 * A `with:` member's creation-time field reads the inputs of the call that
 * opened the scope, so completion there offers the holder's input contract —
 * exactly what `telo check` accepts.
 */

const CREDENTIAL: ResourceDefinition = {
  kind: "Telo.Definition",
  metadata: { name: "Credential", module: "test-fx" },
  capability: "Telo.Provider",
  schema: { type: "object", properties: { key: { type: "string" } } },
} as unknown as ResourceDefinition;

const SEQUENCE = {
  kind: "Telo.Sequence",
  metadata: { name: "byok", module: "test-app" },
  inputType: {
    kind: "Telo.JsonSchema",
    schema: {
      type: "object",
      required: ["apiKey", "prompt"],
      properties: { apiKey: { type: "string", "x-telo-sensitive": true }, prompt: { type: "string" } },
    },
  },
  with: [
    {
      kind: "Fx.Credential",
      metadata: { name: "credential", module: "test-app" },
      key: makeTaggedSentinel("cel", "inputs."),
    },
  ],
  steps: [{ name: "noop", value: 1 }],
} as unknown as ResourceManifest;

const TEXT = [
  "kind: Telo.Sequence",
  "metadata:",
  "  name: byok",
  "with:",
  "  - kind: Fx.Credential",
  "    metadata:",
  "      name: credential",
  '    key: !cel "inputs."',
];

describe("completion in a scope member's creation-time field", () => {
  it("offers the opening call's inputs, typed by the holder's contract", async () => {
    const registry = new AnalysisRegistry();
    registry.registerModuleIdentity("std", "test-fx");
    registry.registerImport("Fx", "test-fx", ["Credential"]);
    registry.registerDefinition(CREDENTIAL);
    const analysis = registry.analysisOf([SEQUENCE]);
    const line = TEXT.length - 1;
    const character = TEXT[line]!.indexOf("inputs.") + "inputs.".length;
    const results = await buildCompletions(TEXT.join("\n"), line, character, registry, undefined, undefined, analysis);
    expect(results.map((result) => result.label).sort()).toEqual(["apiKey", "prompt"]);
  });

  it("offers nothing in a member of a scope not opened by dispatch", async () => {
    const registry = new AnalysisRegistry();
    registry.registerModuleIdentity("std", "test-fx");
    registry.registerImport("Fx", "test-fx", ["Credential", "Holder"]);
    registry.registerDefinition(CREDENTIAL);
    registry.registerDefinition({
      kind: "Telo.Definition",
      metadata: { name: "Holder", module: "test-fx" },
      capability: "Telo.Runnable",
      inputType: { kind: "Telo.JsonSchema", schema: { type: "object", properties: { apiKey: { type: "string" } } } },
      schema: {
        type: "object",
        properties: {
          with: { type: "array", "x-telo-scope": "/steps", items: { type: "object" } },
          steps: { type: "array", items: { $ref: "telo://manifest#/$defs/Step" } },
        },
      },
    } as unknown as ResourceDefinition);
    const holder = { ...SEQUENCE, kind: "Fx.Holder", inputType: undefined } as unknown as ResourceManifest;
    const text = TEXT.map((line) => line.replace("Telo.Sequence", "Fx.Holder"));
    const line = text.length - 1;
    const character = text[line]!.indexOf("inputs.") + "inputs.".length;
    const results = await buildCompletions(
      text.join("\n"),
      line,
      character,
      registry,
      undefined,
      undefined,
      registry.analysisOf([holder]),
    );
    expect(results.map((result) => result.label)).toEqual([]);
  });
});
