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
