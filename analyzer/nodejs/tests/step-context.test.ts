import type { ResourceManifest } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { StaticAnalyzer } from "../src/analyzer.js";
import { withSyntheticPositions } from "../src/with-synthetic-positions.js";

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
          throw: { type: "object", additionalProperties: true },
        },
      },
    },
    properties: {
      finally: {
        "x-telo-step-context": { invoke: "invoke", outputType: "outputType" },
        type: "array",
        items: { $ref: "#/$defs/step" },
      },
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
            value: { __tagged: true, engine: "cel", source: "steps.wrapParse.result.docs" },
          },
        },
      ],
    } as unknown as ResourceManifest;

    const diagnostics = new StaticAnalyzer().analyze(withSyntheticPositions([sequenceDef, seq]));
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
          if: { __tagged: true, engine: "cel", source: "true" },
          then: [{ name: "doWork", invoke: { kind: "Some.Sink" } }],
        },
        {
          name: "useCheck",
          invoke: { kind: "Some.Sink" },
          inputs: { value: { __tagged: true, engine: "cel", source: "steps.checkSomething.result" } },
        },
      ],
    } as unknown as ResourceManifest;

    const diagnostics = new StaticAnalyzer().analyze(withSyntheticPositions([sequenceDef, seq]));
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
          inputs: { value: { __tagged: true, engine: "cel", source: "steps.first.result" } },
        },
      ],
    } as unknown as ResourceManifest;

    const diagnostics = new StaticAnalyzer().analyze(withSyntheticPositions([sequenceDef, seq]));
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
          if: { __tagged: true, engine: "cel", source: "!(steps.parseManifest.result.docs[?0].?kind.orValue('') in ['A','B'])" },
          then: [{ name: "noop", invoke: { kind: "Some.Sink" } }],
        },
      ],
    } as unknown as ResourceManifest;

    const diagnostics = new StaticAnalyzer().analyze(withSyntheticPositions([sequenceDef, seq]));
    const unknown = diagnostics.filter((d) => d.code === "CEL_UNKNOWN_FIELD");
    expect(unknown.length).toBeGreaterThan(0);
    expect(unknown[0].message).toContain("'steps.parseManifest' is not defined");
    expect(unknown[0].message).toContain("doParse");
  });

  const cel = (source: string) => ({ __tagged: true, engine: "cel", source });
  const celCodes = (manifests: unknown[]) =>
    new StaticAnalyzer()
      .analyze(withSyntheticPositions(manifests as ResourceManifest[]))
      .filter((d) => d.code?.startsWith("CEL_"))
      .map((d) => `${d.code}: ${d.message}`);

  it("puts `inputs` in scope, typed from the input contract, in a body producing no result", () => {
    const body = (inputType?: Record<string, any>) => ({
      kind: "run.Sequence",
      metadata: { name: "Seq", module: "test" },
      ...(inputType ? { inputType } : {}),
      steps: [
        {
          name: "check",
          if: cel("inputs.a == 'x'"),
          then: [{ name: "refuse", throw: { message: cel("'got ' + inputs.a") } }],
        },
      ],
    });
    const contract = { type: "object", properties: { a: { type: "string" } }, required: ["a"] };

    expect(celCodes([sequenceDef, body(contract)])).toEqual([]);
    expect(celCodes([sequenceDef, body()])).toEqual([]);

    const typo = body(contract);
    (typo.steps[0] as any).if = cel("inputs.typo == 'x'");
    const codes = celCodes([sequenceDef, typo]);
    expect(codes).toHaveLength(1);
    expect(codes[0]).toMatch(/^CEL_UNKNOWN_FIELD: .*inputs\.typo/);
  });

  it("gives such a body an empty, closed `steps` map", () => {
    const seq = {
      kind: "run.Sequence",
      metadata: { name: "Seq", module: "test" },
      steps: [{ name: "check", if: cel("steps.missing.result"), then: [] }],
    };
    const codes = celCodes([sequenceDef, seq]);
    expect(codes).toHaveLength(1);
    expect(codes[0]).toMatch(/^CEL_UNKNOWN_FIELD: .*steps\.missing/);
  });

  it("types a later step slot's results when an earlier slot produces none", () => {
    const seq = {
      kind: "run.Sequence",
      metadata: { name: "Seq", module: "test" },
      finally: [{ name: "check", if: cel("steps.made.result != null"), then: [] }],
      steps: [
        { name: "made", invoke: { kind: "Some.Sink" } },
        { name: "use", if: cel("steps.nope.result != null"), then: [] },
      ],
    };
    const codes = celCodes([sequenceDef, seq]);
    expect(codes).toHaveLength(1);
    expect(codes[0]).toMatch(/^CEL_UNKNOWN_FIELD: .*steps\.nope/);
  });
});
