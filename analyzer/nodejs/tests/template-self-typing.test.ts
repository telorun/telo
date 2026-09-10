import type { ResourceManifest } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { StaticAnalyzer } from "../src/analyzer.js";
import { DiagnosticSeverity } from "../src/types.js";
import { withSyntheticPositions } from "../src/with-synthetic-positions.js";

/** Definition whose `schema:` declares two typed fields. The template body
 *  references both via `${{ self.X }}`; `sql` lands in the top-level `inputs:`
 *  sibling, a `self`-bearing slot. Used across positive/negative cases. */
function makeReadDefinition(sql: string): ResourceManifest {
  return {
    kind: "Telo.Definition",
    metadata: { name: "Read", module: "repo" },
    capability: "Telo.Invocable",
    schema: {
      type: "object",
      required: ["connection", "table"],
      properties: {
        connection: { type: "string" },
        table: { type: "string" },
      },
    },
    resources: [
      {
        kind: "Sql.Query",
        metadata: { name: "query" },
        connection: "${{ self.connection }}",
      },
    ],
    invoke: { __tagged: true, engine: "ref", source: "query" },
    inputs: { sql },
  } as unknown as ResourceManifest;
}

describe("Telo.Definition: static CEL validation for `self`", () => {
  it("accepts `${{ self.<declared field> }}` inside the template body", () => {
    const diagnostics = new StaticAnalyzer().analyze(withSyntheticPositions([makeReadDefinition("SELECT * FROM ${{ self.table }}")]));
    const cel = diagnostics.filter(
      (d) => d.code === "CEL_UNKNOWN_FIELD" || d.code === "CEL_SYNTAX_ERROR",
    );
    expect(cel).toEqual([]);
  });

  it("rejects a typo on a declared field with CEL_UNKNOWN_FIELD", () => {
    // `self.tabel` is a typo for `self.table` — was previously silent because
    // template bodies were skipped by the analyzer.
    const def = makeReadDefinition("SELECT * FROM ${{ self.tabel }}");
    const diagnostics = new StaticAnalyzer().analyze(withSyntheticPositions([def]));
    const unknown = diagnostics.filter((d) => d.code === "CEL_UNKNOWN_FIELD");
    expect(unknown.length).toBeGreaterThanOrEqual(1);
    expect(unknown[0].severity).toBe(DiagnosticSeverity.Error);
    expect(unknown[0].message).toContain("self.tabel");
  });

  it("accepts the synthetic `self.name` / `self.kind` / `self.metadata.name` fields", () => {
    const def: ResourceManifest = {
      kind: "Telo.Definition",
      metadata: { name: "Read", module: "repo" },
      capability: "Telo.Invocable",
      schema: { type: "object", properties: {} },
      resources: [
        {
          kind: "X",
          metadata: { name: "body" },
          a: "${{ self.name }}",
          b: "${{ self.kind }}",
          c: "${{ self.metadata.name }}",
        },
      ],
      run: { __tagged: true, engine: "ref", source: "body" },
    } as unknown as ResourceManifest;

    const diagnostics = new StaticAnalyzer().analyze(withSyntheticPositions([def]));
    const cel = diagnostics.filter(
      (d) => d.code === "CEL_UNKNOWN_FIELD" || d.code === "CEL_SYNTAX_ERROR",
    );
    expect(cel).toEqual([]);
  });

  it("rejects access to an undeclared `self` field even when the schema is empty", () => {
    const def: ResourceManifest = {
      kind: "Telo.Definition",
      metadata: { name: "R", module: "m" },
      capability: "Telo.Invocable",
      schema: { type: "object", properties: {} },
      resources: [{ kind: "X", metadata: { name: "body" }, a: "${{ self.nothing }}" }],
      run: { __tagged: true, engine: "ref", source: "body" },
    } as unknown as ResourceManifest;

    const diagnostics = new StaticAnalyzer().analyze(withSyntheticPositions([def]));
    const unknown = diagnostics.filter((d) => d.code === "CEL_UNKNOWN_FIELD");
    expect(unknown.length).toBeGreaterThanOrEqual(1);
    expect(unknown[0].message).toContain("self.nothing");
  });
});
