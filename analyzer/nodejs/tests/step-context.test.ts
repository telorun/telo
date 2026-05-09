import type { ResourceManifest } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { StaticAnalyzer } from "../src/analyzer.js";

/** Minimal Run.Sequence-shaped definition: a `steps` array with a step that
 *  may carry either an `invoke` (real result-producer) or a `try`/`then`
 *  branch (control-flow wrapper that does not produce a result). The
 *  `x-telo-topology-role` annotations let `buildStepContextSchema` walk the
 *  branches; the `x-telo-step-context` annotation tells it which sibling on
 *  each step is the invoke. */
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
            additionalProperties: true,
          },
          inputs: {
            "x-telo-topology-role": "inputs",
            type: "object",
            additionalProperties: true,
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
          catch: {
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
      outputs: { type: "object", additionalProperties: true },
    },
  },
} as unknown as ResourceManifest;

describe("buildStepContextSchema (control-flow wrappers)", () => {
  it("does not register a try-step's name as a result-producer", () => {
    const seq = {
      kind: "run.Sequence",
      metadata: { name: "Seq", module: "test" },
      steps: [
        {
          name: "wrapParse",
          try: [{ name: "doParse", invoke: { kind: "Yaml.Parse" } }],
          catch: [],
        },
        {
          name: "useParse",
          invoke: { kind: "Some.Sink" },
          inputs: {
            // Refers to the try-wrapper, which never lands in `steps`.
            // Pre-fix this slipped through because every named step was
            // registered with a permissive `result: additionalProperties: true`.
            value: "${{ steps.wrapParse.result.docs }}",
          },
        },
      ],
    } as unknown as ResourceManifest;

    const diagnostics = new StaticAnalyzer().analyze([sequenceDef, seq]);
    const unknown = diagnostics.filter((d) => d.code === "CEL_UNKNOWN_FIELD");
    expect(unknown.length).toBeGreaterThan(0);
    expect(unknown[0].message).toContain("'steps.wrapParse' is not defined");
    expect(unknown[0].message).toContain("doParse");
  });

  it("does not register an if-wrapper's name either", () => {
    const seq = {
      kind: "run.Sequence",
      metadata: { name: "Seq", module: "test" },
      steps: [
        {
          name: "checkSomething",
          if: "${{ true }}",
          then: [{ name: "doWork", invoke: { kind: "Some.Sink" } }],
        },
        {
          name: "useCheck",
          invoke: { kind: "Some.Sink" },
          inputs: { value: "${{ steps.checkSomething.result }}" },
        },
      ],
    } as unknown as ResourceManifest;

    const diagnostics = new StaticAnalyzer().analyze([sequenceDef, seq]);
    const unknown = diagnostics.filter((d) => d.code === "CEL_UNKNOWN_FIELD");
    expect(unknown.length).toBeGreaterThan(0);
    expect(unknown[0].message).toContain("'steps.checkSomething' is not defined");
  });

  it("recognises a real invoke step's name (no false positive)", () => {
    const seq = {
      kind: "run.Sequence",
      metadata: { name: "Seq", module: "test" },
      steps: [
        { name: "first", invoke: { kind: "Some.Sink" } },
        {
          name: "second",
          invoke: { kind: "Some.Sink" },
          inputs: { value: "${{ steps.first.result }}" },
        },
      ],
    } as unknown as ResourceManifest;

    const diagnostics = new StaticAnalyzer().analyze([sequenceDef, seq]);
    const unknown = diagnostics.filter((d) => d.code === "CEL_UNKNOWN_FIELD");
    expect(unknown).toEqual([]);
  });

  it("flags an unknown-step reference even when wrapped in unary `!` and optional access", () => {
    // The exact shape that escaped the analyzer in the registry's PublishHandler:
    // a unary `!` wrapping an `in` over an optional-access chain whose root
    // (`steps.parseManifest`) is a try-wrapper, not an invoke.
    const seq = {
      kind: "run.Sequence",
      metadata: { name: "Seq", module: "test" },
      steps: [
        {
          name: "parseManifest",
          try: [{ name: "doParse", invoke: { kind: "Yaml.Parse" } }],
        },
        {
          name: "validateRootDoc",
          if: "${{ !(steps.parseManifest.result.docs[?0].?kind.orValue('') in ['A','B']) }}",
          then: [{ name: "noop", invoke: { kind: "Some.Sink" } }],
        },
      ],
    } as unknown as ResourceManifest;

    const diagnostics = new StaticAnalyzer().analyze([sequenceDef, seq]);
    const unknown = diagnostics.filter((d) => d.code === "CEL_UNKNOWN_FIELD");
    expect(unknown.length).toBeGreaterThan(0);
    expect(unknown[0].message).toContain("'steps.parseManifest' is not defined");
    expect(unknown[0].message).toContain("doParse");
  });
});
