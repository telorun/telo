import type { ResourceManifest } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { StaticAnalyzer } from "../src/analyzer.js";
import { withSyntheticPositions } from "../src/with-synthetic-positions.js";

/** Run.Sequence-shaped definition whose `steps[].invoke` slot is a real
 *  x-telo-ref reference (the production schema's shape), reachable only through
 *  the shared `#/$defs/step`. `then` mirrors the branch nesting so we can prove
 *  recursion into nested step trees. */
const sequenceDef = {
  kind: "Telo.Definition",
  metadata: { name: "Sequence", module: "run" },
  capability: "Telo.Runnable",
  schema: {
    type: "object",
    $defs: {
      step: {
        type: "object",
        properties: {
          name: { type: "string" },
          invoke: {
            "x-telo-topology-role": "invoke",
            anyOf: [{ "x-telo-ref": "telo#Invocable" }],
          },
          inputs: {
            "x-telo-topology-role": "inputs",
            type: "object",
            additionalProperties: true,
          },
          then: {
            "x-telo-topology-role": "branch",
            type: "array",
            items: { $ref: "#/$defs/step" },
          },
        },
      },
    },
    properties: {
      steps: {
        "x-telo-topology-role": "steps",
        type: "array",
        items: { $ref: "#/$defs/step" },
      },
    },
  },
} as unknown as ResourceManifest;

/** Invocable whose runtime input (`prompt`) lives in `inputType`, while its
 *  construction config is closed (`additionalProperties: false`). Putting
 *  `prompt` on the inline invoke object is therefore a config violation. */
const sinkDef = {
  kind: "Telo.Definition",
  metadata: { name: "ReadLine", module: "console" },
  capability: "Telo.Invocable",
  inputType: {
    kind: "Type.JsonSchema",
    schema: {
      type: "object",
      properties: { prompt: { type: "string" } },
      required: ["prompt"],
      additionalProperties: false,
    },
  },
  schema: { type: "object", additionalProperties: false },
} as unknown as ResourceManifest;

function schemaViolations(manifests: ResourceManifest[]) {
  return new StaticAnalyzer()
    .analyze(withSyntheticPositions(manifests))
    .filter((d) => d.code === "SCHEMA_VIOLATION");
}

describe("nested inline resource validation", () => {
  it("flags an input placed on an inline step invoke instead of inputs", () => {
    const seq = {
      kind: "run.Sequence",
      metadata: { name: "Loop", module: "test" },
      steps: [{ name: "Read", invoke: { kind: "console.ReadLine", prompt: "you › " } }],
    } as unknown as ResourceManifest;

    const violations = schemaViolations([sequenceDef, sinkDef, seq]);
    expect(violations.length).toBe(1);
    expect(violations[0].message).toContain("inline console.ReadLine at 'steps[0].invoke'");
    expect(violations[0].message).toContain("'prompt' is not allowed");
  });

  it("accepts a correct inline step invoke with the input under inputs", () => {
    const seq = {
      kind: "run.Sequence",
      metadata: { name: "Loop", module: "test" },
      steps: [
        { name: "Read", invoke: { kind: "console.ReadLine" }, inputs: { prompt: "you › " } },
      ],
    } as unknown as ResourceManifest;

    expect(schemaViolations([sequenceDef, sinkDef, seq])).toEqual([]);
  });

  it("recurses into nested branch steps", () => {
    const seq = {
      kind: "run.Sequence",
      metadata: { name: "Loop", module: "test" },
      steps: [
        {
          name: "Outer",
          invoke: { kind: "console.ReadLine" },
          inputs: { prompt: "you › " },
          then: [{ name: "Inner", invoke: { kind: "console.ReadLine", prompt: "nested › " } }],
        },
      ],
    } as unknown as ResourceManifest;

    const violations = schemaViolations([sequenceDef, sinkDef, seq]);
    expect(violations.length).toBe(1);
    expect(violations[0].message).toContain("'steps[0].then[0].invoke'");
  });

  it("resolves an inline kind written via an import alias", () => {
    // `Run` / `Console` are root-scope import aliases; the inline kind
    // `Console.ReadLine` must resolve through `aliases.resolveKind` to
    // `console.ReadLine` before its config is validated.
    const app = { kind: "Telo.Application", metadata: { name: "app" }, targets: [] };
    const runImport = { kind: "Telo.Import", metadata: { name: "Run" }, source: "run" };
    const consoleImport = { kind: "Telo.Import", metadata: { name: "Console" }, source: "console" };
    const seq = {
      kind: "Run.Sequence",
      metadata: { name: "Loop" },
      steps: [{ name: "Read", invoke: { kind: "Console.ReadLine", prompt: "you › " } }],
    };

    const violations = schemaViolations([
      sequenceDef,
      sinkDef,
      app,
      runImport,
      consoleImport,
      seq,
    ] as unknown as ResourceManifest[]);
    expect(violations.length).toBe(1);
    expect(violations[0].message).toContain("inline Console.ReadLine at 'steps[0].invoke'");
    expect(violations[0].message).toContain("'prompt' is not allowed");
  });

  it("flags an unknown inline kind that no other pass can see", () => {
    const seq = {
      kind: "run.Sequence",
      metadata: { name: "Loop", module: "test" },
      steps: [{ name: "Read", invoke: { kind: "console.Missing" } }],
    } as unknown as ResourceManifest;

    const undefinedKinds = new StaticAnalyzer()
      .analyze(withSyntheticPositions([sequenceDef, sinkDef, seq]))
      .filter((d) => d.code === "UNDEFINED_KIND");
    expect(undefinedKinds.length).toBe(1);
    expect(undefinedKinds[0].message).toContain("console.Missing");
    expect((undefinedKinds[0].data as { path?: string }).path).toBe("steps[0].invoke.kind");
  });
});
