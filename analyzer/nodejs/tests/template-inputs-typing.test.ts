import type { ResourceManifest } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { StaticAnalyzer } from "../src/analyzer.js";
import { DiagnosticSeverity } from "../src/types.js";
import { withSyntheticPositions } from "../src/with-synthetic-positions.js";

/** Build a Telo.Abstract that declares an `inputType`. The concrete definition
 *  inherits this via `extends:` and the analyzer should fall back to it when
 *  the concrete doesn't declare `inputType` directly. */
const repositoryAbstract: ResourceManifest = {
  kind: "Telo.Abstract",
  metadata: { name: "Find", module: "repo" },
  inputType: {
    type: "object",
    additionalProperties: false,
    properties: {
      filters: { type: "object", additionalProperties: true },
    },
  },
} as unknown as ResourceManifest;

const aliasImport: ResourceManifest = {
  kind: "Telo.Import",
  metadata: { name: "Repo", resolvedModuleName: "repo" },
  source: "repo",
} as unknown as ResourceManifest;

describe("Telo.Definition: static CEL validation for `inputs`", () => {
  it("types top-level `inputs` from the definition's own inputType", () => {
    const def: ResourceManifest = {
      kind: "Telo.Definition",
      metadata: { name: "Read", module: "repo" },
      capability: "Telo.Invocable",
      inputType: {
        type: "object",
        additionalProperties: false,
        properties: { filters: { type: "object", additionalProperties: true } },
      },
      schema: { type: "object", properties: {} },
      invoke: { kind: "Sql.Query", name: "x" },
      inputs: { sql: "${{ keys(inputs.filters).size() > 0 ? 'y' : 'n' }}" },
    } as unknown as ResourceManifest;

    const diagnostics = new StaticAnalyzer().analyze(withSyntheticPositions([def]));
    const unknown = diagnostics.filter((d) => d.code === "CEL_UNKNOWN_FIELD");
    expect(unknown).toEqual([]);
  });

  it("falls back to extends-declared abstract's inputType when own is absent", () => {
    const def: ResourceManifest = {
      kind: "Telo.Definition",
      metadata: { name: "Read", module: "repo" },
      capability: "Telo.Invocable",
      extends: "Repo.Find",
      schema: { type: "object", properties: {} },
      invoke: { kind: "Sql.Query", name: "x" },
      inputs: { sql: "${{ keys(inputs.filters).size() > 0 ? 'y' : 'n' }}" },
    } as unknown as ResourceManifest;

    const diagnostics = new StaticAnalyzer().analyze(withSyntheticPositions([aliasImport, repositoryAbstract, def]));
    const unknown = diagnostics.filter((d) => d.code === "CEL_UNKNOWN_FIELD");
    expect(unknown).toEqual([]);
  });

  it("rejects an unknown `inputs.X` field against a typed inputType", () => {
    const def: ResourceManifest = {
      kind: "Telo.Definition",
      metadata: { name: "Read", module: "repo" },
      capability: "Telo.Invocable",
      inputType: {
        type: "object",
        additionalProperties: false,
        properties: { filters: { type: "object", additionalProperties: true } },
      },
      schema: { type: "object", properties: {} },
      invoke: { kind: "Sql.Query", name: "x" },
      inputs: { sql: "${{ inputs.bogus }}" },
    } as unknown as ResourceManifest;

    const diagnostics = new StaticAnalyzer().analyze(withSyntheticPositions([def]));
    const unknown = diagnostics.filter((d) => d.code === "CEL_UNKNOWN_FIELD");
    expect(unknown.length).toBeGreaterThanOrEqual(1);
    expect(unknown[0].severity).toBe(DiagnosticSeverity.Error);
    expect(unknown[0].message).toContain("inputs.bogus");
  });

  it("treats `inputs` as opaque when no inputType is declared anywhere", () => {
    const def: ResourceManifest = {
      kind: "Telo.Definition",
      metadata: { name: "Read", module: "repo" },
      capability: "Telo.Invocable",
      schema: { type: "object", properties: {} },
      invoke: { kind: "Sql.Query", name: "x" },
      inputs: { sql: "${{ inputs.anything }}" },
    } as unknown as ResourceManifest;

    const diagnostics = new StaticAnalyzer().analyze(withSyntheticPositions([def]));
    const unknown = diagnostics.filter((d) => d.code === "CEL_UNKNOWN_FIELD");
    expect(unknown).toEqual([]);
  });

  it("exposes `inputs` inside `resources[]` template entries too", () => {
    const def: ResourceManifest = {
      kind: "Telo.Definition",
      metadata: { name: "Create", module: "repo" },
      capability: "Telo.Invocable",
      inputType: {
        type: "object",
        additionalProperties: false,
        properties: { data: { type: "object", additionalProperties: true } },
      },
      schema: { type: "object", properties: {} },
      resources: [
        {
          kind: "Sql.Exec",
          metadata: { name: "${{ self.name }}-exec" },
          inputs: {
            sql: "${{ 'INSERT INTO X (' + join(keys(inputs.data), ',') + ')' }}",
          },
        },
      ],
      invoke: "${{ self.name }}-exec",
    } as unknown as ResourceManifest;

    const diagnostics = new StaticAnalyzer().analyze(withSyntheticPositions([def]));
    const unknown = diagnostics.filter((d) => d.code === "CEL_UNKNOWN_FIELD");
    expect(unknown).toEqual([]);
  });
});
