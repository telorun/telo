import type { ResourceManifest } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { StaticAnalyzer } from "../src/analyzer.js";
import { DiagnosticSeverity } from "../src/types.js";
import { withSyntheticPositions } from "../src/with-synthetic-positions.js";

/**
 * One test per diagnostic the invocation-contract pass produces, following the
 * per-diagnostic convention of the other analyzer tests.
 */

const m = (x: unknown) => x as unknown as ResourceManifest;

const analyze = (manifests: unknown[]) =>
  new StaticAnalyzer().analyze(withSyntheticPositions(manifests.map(m) as ResourceManifest[]));
const codes = (diags: Array<{ code?: string }>) => diags.map((d) => d.code);

/** A concrete invocable kind with a controller — a valid `extends` parent. */
const scriptKind = {
  kind: "Telo.Definition",
  metadata: { name: "Script", module: "javascript" },
  capability: "Telo.Invocable",
  controllers: [{ runtime: "node", entry: "x" }],
  schema: {
    type: "object",
    additionalProperties: false,
    properties: { code: { type: "string" } },
  },
  inputType: {
    type: "object",
    required: ["input"],
    properties: { input: { type: "string" } },
  },
};

/** An invocable kind whose contract is declared on the KIND, so instances of it
 *  are dispatch targets with a known signature. */
const echoKind = (inputType: unknown) => ({
  kind: "Telo.Definition",
  metadata: { name: "Echo", module: "demo" },
  capability: "Telo.Invocable",
  controllers: [{ runtime: "node", entry: "x" }],
  schema: { type: "object", additionalProperties: true },
  inputType,
});

describe("CONTRACT_MISSING_MAPPING", () => {
  const child = (extra: Record<string, unknown>) => ({
    kind: "Telo.Definition",
    metadata: { name: "Shout", module: "demo" },
    extends: "javascript.Script",
    schema: { type: "object", properties: {} },
    base: { code: "function main(i) { return i }" },
    inputType: {
      type: "object",
      required: ["msg"],
      properties: { msg: { type: "string" } },
    },
    ...extra,
  });

  it("rejects a controller-inheriting child that replaces a contract without bridging it", async () => {
    expect(codes(analyze([scriptKind, child({})]))).toContain("CONTRACT_MISSING_MAPPING");
  });

  it("accepts the same child once `inputs:` bridges it", async () => {
    const diags = analyze([scriptKind, child({ inputs: { input: "x" } })]);
    expect(codes(diags)).not.toContain("CONTRACT_MISSING_MAPPING");
  });

  it("exempts a child that brings its own controller", async () => {
    const diags = analyze([
      scriptKind,
      child({ controllers: [{ runtime: "node", entry: "own" }], base: undefined }),
    ]);
    expect(codes(diags)).not.toContain("CONTRACT_MISSING_MAPPING");
  });
});

describe("CONTRACT_INPUTS_SCHEMA_FORM", () => {
  it("rejects a leftover `inputs:` property map on a kind whose contract is inputType", async () => {
    const kind = {
      kind: "Telo.Definition",
      metadata: { name: "Seq", module: "demo" },
      capability: "Telo.Runnable",
      controllers: [{ runtime: "node", entry: "x" }],
      schema: {
        type: "object",
        additionalProperties: true,
        properties: { inputType: { "x-telo-ref": "Telo.Type" } },
      },
    };
    const instance = {
      kind: "demo.Seq",
      metadata: { name: "Stale", module: "root" },
      inputs: { n: { type: "integer" } },
    };
    expect(codes(analyze([kind, instance]))).toContain("CONTRACT_INPUTS_SCHEMA_FORM");
  });
});

describe("CONTRACT_TYPE_NOT_FOUND", () => {
  it("rejects a kind-level contract naming a type that does not exist", async () => {
    const diags = analyze([
      {
        kind: "Telo.Definition",
        metadata: { name: "Thing", module: "ghost" },
        capability: "Telo.Invocable",
        controllers: [{ runtime: "node", entry: "x" }],
        schema: { type: "object", additionalProperties: true },
        inputType: "NoSuchType",
      },
    ]);
    // The instance-level slot was already covered by the ordinary reference
    // check; `Telo.Definition` is excluded from it, so the same typo written on
    // a KIND used to reach dispatch before anything noticed.
    expect(codes(diags)).toContain("CONTRACT_TYPE_NOT_FOUND");
  });

  it("accepts a contract naming a type that is declared", async () => {
    const diags = analyze([
      { kind: "Telo.JsonSchema", metadata: { name: "Shape", module: "ghost" }, schema: { type: "object" } },
      {
        kind: "Telo.Definition",
        metadata: { name: "Thing", module: "ghost" },
        capability: "Telo.Invocable",
        controllers: [{ runtime: "node", entry: "x" }],
        schema: { type: "object", additionalProperties: true },
        inputType: "Shape",
      },
    ]);
    expect(codes(diags)).not.toContain("CONTRACT_TYPE_NOT_FOUND");
  });

  it("ignores an inline shape, which names nothing", async () => {
    const diags = analyze([
      {
        kind: "Telo.Definition",
        metadata: { name: "Thing", module: "ghost" },
        capability: "Telo.Invocable",
        controllers: [{ runtime: "node", entry: "x" }],
        schema: { type: "object", additionalProperties: true },
        inputType: { kind: "Telo.JsonSchema", schema: { type: "object" } },
      },
    ]);
    expect(codes(diags)).not.toContain("CONTRACT_TYPE_NOT_FOUND");
  });
});

describe("CONTRACT_NOT_SUBSTITUTABLE", () => {
  /** An abstract stating a floor every implementation must answer with — the
   *  identity later calls are addressed by, plus where the work stands. */
  const runAbstract = {
    kind: "Telo.Abstract",
    metadata: { name: "Run", module: "durable" },
    capability: "Telo.Invocable",
    outputType: {
      type: "object",
      additionalProperties: true,
      required: ["runId", "status"],
      properties: { runId: { type: "string" }, status: { type: "string" } },
    },
    inputType: {
      type: "object",
      additionalProperties: true,
      properties: { run: { type: "string" } },
    },
  };

  const engine = (extra: Record<string, unknown>) => ({
    kind: "Telo.Definition",
    metadata: { name: "Workflow", module: "engine" },
    capability: "Telo.Invocable",
    extends: "durable.Run",
    controllers: [{ runtime: "node", entry: "x" }],
    schema: { type: "object", additionalProperties: true },
    ...extra,
  });

  it("rejects an engine whose own outputType drops a field the abstract requires", async () => {
    // The failure the rule exists for: contracts replace rather than merge, so
    // this engine is compared against `durable.Run` by nothing — not the pass,
    // not dispatch — and a slot typed by the abstract is typed by a promise the
    // implementation does not keep.
    const diags = analyze([
      runAbstract,
      engine({
        outputType: {
          type: "object",
          required: ["status"],
          properties: { status: { type: "string" } },
        },
      }),
    ]);
    expect(codes(diags)).toContain("CONTRACT_NOT_SUBSTITUTABLE");
  });

  it("accepts an engine that restates the floor and adds its own vocabulary", async () => {
    const diags = analyze([
      runAbstract,
      engine({
        outputType: {
          type: "object",
          additionalProperties: false,
          required: ["runId", "status"],
          properties: {
            runId: { type: "string" },
            status: { type: "string" },
            attached: { type: "boolean" },
          },
        },
      }),
    ]);
    expect(codes(diags)).not.toContain("CONTRACT_NOT_SUBSTITUTABLE");
  });

  it("accepts an engine that declares nothing — the abstract's contract binds it", async () => {
    expect(codes(analyze([runAbstract, engine({})]))).not.toContain("CONTRACT_NOT_SUBSTITUTABLE");
  });

  it("rejects an input contract that demands what a caller through the abstract cannot send", async () => {
    // Contravariant: a caller holding this through `durable.Run` sends the
    // abstract's shape, so an extra REQUIRED input is unsatisfiable for them.
    const diags = analyze([
      runAbstract,
      engine({
        inputType: {
          type: "object",
          required: ["deploymentId"],
          properties: { deploymentId: { type: "string" } },
        },
      }),
    ]);
    expect(codes(diags)).toContain("CONTRACT_NOT_SUBSTITUTABLE");
  });

  it("checks a contract that NAMES its type, in the declaring module and outside it", async () => {
    // A named type resolves against the whole manifest set, exactly as
    // `analyzerContractScope` hands it to `resolveContract`. Scoping the lookup to
    // the declaring module read as more careful and silently switched the check
    // off for every library that factors its shapes into a shared module — and
    // nothing else caught it, since `CONTRACT_TYPE_NOT_FOUND` resolves the same
    // name through its own global fallback. Both placements are asserted here
    // because only the pair pins the behaviour: one alone passes under the bug.
    const shortfall = {
      type: "object",
      required: ["status"],
      properties: { status: { type: "string" } },
    };
    const named = (module: string) => ({
      kind: "Telo.JsonSchema",
      metadata: { name: "Started", module },
      schema: shortfall,
    });

    for (const module of ["engine", "shapes"]) {
      const diags = analyze([runAbstract, named(module), engine({ outputType: "Started" })]);
      expect(codes(diags), `named type declared in '${module}'`).toContain(
        "CONTRACT_NOT_SUBSTITUTABLE",
      );
    }
  });

  it("accepts an input contract that only narrows a field's type", async () => {
    const diags = analyze([
      runAbstract,
      engine({
        inputType: {
          type: "object",
          properties: { run: { type: "string" }, wait: { type: "string" } },
        },
      }),
    ]);
    expect(codes(diags)).not.toContain("CONTRACT_NOT_SUBSTITUTABLE");
  });
});

describe("CONTRACT_NOT_SUBSTITUTABLE — what it deliberately does not reach", () => {
  /** A CONCRETE parent: a controller with a call signature of its own, which a
   *  child puts a friendlier schema over. This is the sanctioned pattern — `base:`
   *  reshapes the config and `inputs:` translates the call — so the child is
   *  supposed to take different inputs, and checking substitutability here would
   *  reject every custom-kind example in the repo. */
  const webhookKind = {
    kind: "Telo.Definition",
    metadata: { name: "Webhook", module: "notify" },
    capability: "Telo.Invocable",
    controllers: [{ runtime: "node", entry: "x" }],
    schema: { type: "object", additionalProperties: true },
    inputType: {
      type: "object",
      required: ["payload"],
      properties: { payload: { type: "object" } },
    },
  };

  it("leaves a friendlier schema over a concrete parent alone", async () => {
    const diags = analyze([
      webhookKind,
      {
        kind: "Telo.Definition",
        metadata: { name: "Slack", module: "notify" },
        extends: "notify.Webhook",
        schema: { type: "object", additionalProperties: true },
        inputType: {
          type: "object",
          required: ["text"],
          properties: { text: { type: "string" } },
        },
        inputs: { payload: { text: "x" } },
      },
    ]);
    expect(codes(diags)).not.toContain("CONTRACT_NOT_SUBSTITUTABLE");
  });

  it("leaves a bridged direction alone even under an abstract", async () => {
    // The mapping is the author saying the shapes differ deliberately and are
    // translated — the same statement `CONTRACT_MISSING_MAPPING` demands one hop
    // down.
    const diags = analyze([
      {
        kind: "Telo.Abstract",
        metadata: { name: "Sink", module: "pipe" },
        capability: "Telo.Invocable",
        outputType: {
          type: "object",
          required: ["written"],
          properties: { written: { type: "integer" } },
        },
      },
      {
        kind: "Telo.Definition",
        metadata: { name: "FileSink", module: "pipe" },
        capability: "Telo.Invocable",
        extends: "pipe.Sink",
        controllers: [{ runtime: "node", entry: "x" }],
        schema: { type: "object", additionalProperties: true },
        outputType: { type: "object", properties: { bytes: { type: "integer" } } },
        result: { written: "x" },
      },
    ]);
    expect(codes(diags)).not.toContain("CONTRACT_NOT_SUBSTITUTABLE");
  });
});
