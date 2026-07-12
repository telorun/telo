import type { ResourceManifest } from "@telorun/sdk";
import { makeTaggedSentinel } from "@telorun/templating";
import { describe, expect, it } from "vitest";
import { StaticAnalyzer } from "../src/analyzer.js";
import { withSyntheticPositions } from "../src/with-synthetic-positions.js";

/** The reference field map does not descend into step `invoke` slots (they sit
 *  behind the step `$ref`, and descending would make Phase 5 inject there), so
 *  `validateReferences` never sees them. `validateStepInvokeReferences` covers
 *  exactly those slots: an `invoke: !ref <name>` that names a missing instance —
 *  or a kind rather than an exported instance — must be flagged statically. */

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
            type: "object",
            anyOf: [{ "x-telo-ref": "telo#Invocable" }, { "x-telo-ref": "telo#Runnable" }],
          },
          if: { type: "boolean", "x-telo-topology-role": "predicate" },
          then: {
            "x-telo-topology-role": "branch",
            type: "array",
            items: { $ref: "#/$defs/step" },
          },
          try: {
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
        "x-telo-step-context": { invoke: "invoke", outputType: "outputType" },
        type: "array",
        items: { $ref: "#/$defs/step" },
      },
    },
  },
} as unknown as ResourceManifest;

const sinkDef = {
  kind: "Telo.Definition",
  metadata: { name: "Sink", module: "run" },
  capability: "Telo.Invocable",
  schema: { type: "object", additionalProperties: true },
} as unknown as ResourceManifest;

const sink = {
  kind: "run.Sink",
  metadata: { name: "Target" },
} as unknown as ResourceManifest;

const providerDef = {
  kind: "Telo.Definition",
  metadata: { name: "Store", module: "run" },
  capability: "Telo.Provider",
  schema: { type: "object", additionalProperties: true },
} as unknown as ResourceManifest;

const provider = {
  kind: "run.Store",
  metadata: { name: "Config" },
} as unknown as ResourceManifest;

const base = [sequenceDef, sinkDef, sink, providerDef, provider];

const unresolved = (m: ResourceManifest[]) =>
  new StaticAnalyzer()
    .analyze(withSyntheticPositions(m))
    .filter((d) => d.code === "UNRESOLVED_REFERENCE");

describe("validateStepInvokeReferences", () => {
  it("flags a step invoke `!ref` to a missing instance", () => {
    const seq = {
      kind: "run.Sequence",
      metadata: { name: "Main" },
      steps: [{ name: "go", invoke: makeTaggedSentinel("ref", "Ghost") }],
    } as unknown as ResourceManifest;

    const diags = unresolved([...base, seq]);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("Ghost");
    expect((diags[0].data as { path: string }).path).toBe("steps[0].invoke");
  });

  it("accepts a step invoke `!ref` to an existing instance", () => {
    const seq = {
      kind: "run.Sequence",
      metadata: { name: "Main" },
      steps: [{ name: "go", invoke: makeTaggedSentinel("ref", "Target") }],
    } as unknown as ResourceManifest;

    expect(unresolved([...base, seq])).toEqual([]);
  });

  it("flags a missing `!ref` nested inside a control-flow branch", () => {
    const seq = {
      kind: "run.Sequence",
      metadata: { name: "Main" },
      steps: [
        {
          name: "gate",
          if: true,
          then: [{ name: "inner", invoke: makeTaggedSentinel("ref", "Ghost") }],
        },
      ],
    } as unknown as ResourceManifest;

    const diags = unresolved([...base, seq]);
    expect(diags).toHaveLength(1);
    expect((diags[0].data as { path: string }).path).toBe("steps[0].then[0].invoke");
  });

  it("does not flag an inline `{ kind }` invoke (not a reference)", () => {
    const seq = {
      kind: "run.Sequence",
      metadata: { name: "Main" },
      steps: [{ name: "go", invoke: { kind: "run.Sink" } }],
    } as unknown as ResourceManifest;

    expect(unresolved([...base, seq])).toEqual([]);
  });

  it("flags a step invoke of a resolved instance whose capability has no invoke/run", () => {
    // The instance exists, so the ref resolves — but a Telo.Provider structurally
    // has no invoke/run method. Mirrors the kernel's ERR_RESOURCE_NOT_INVOKABLE.
    const seq = {
      kind: "run.Sequence",
      metadata: { name: "Main" },
      steps: [{ name: "go", invoke: makeTaggedSentinel("ref", "Config") }],
    } as unknown as ResourceManifest;

    const diags = new StaticAnalyzer()
      .analyze(withSyntheticPositions([...base, seq]))
      .filter((d) => d.code === "REFERENCE_KIND_MISMATCH");
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("run.Store");
    expect(diags[0].message).toContain("Telo.Provider");
    expect(diags[0].message).toContain("ERR_RESOURCE_NOT_INVOKABLE");
    expect((diags[0].data as { path: string }).path).toBe("steps[0].invoke");
  });
});
