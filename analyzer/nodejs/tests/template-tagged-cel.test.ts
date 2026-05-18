import type { ResourceManifest } from "@telorun/sdk";
import { makeTaggedSentinel } from "@telorun/templating";
import { describe, expect, it } from "vitest";
import { StaticAnalyzer } from "../src/analyzer.js";
import { DiagnosticSeverity } from "../src/types.js";

/** Parity tests: `!cel`-tagged forms inside a template body must produce the
 *  same chain-validation diagnostics as the `${{ }}` interpolated form. */
describe("Telo.Definition template bodies: tagged-CEL parity", () => {
  it("rejects `!cel \"self.tabel\"` typo with CEL_UNKNOWN_FIELD (matching the ${{ }} form)", () => {
    const def: ResourceManifest = {
      kind: "Telo.Definition",
      metadata: { name: "Read", module: "repo" },
      capability: "Telo.Invocable",
      schema: {
        type: "object",
        required: ["table"],
        properties: { table: { type: "string" } },
      },
      resources: [
        {
          kind: "Sql.Query",
          metadata: { name: makeTaggedSentinel("cel", "self.tabel") },
        },
      ],
      invoke: "x",
    } as unknown as ResourceManifest;

    const diagnostics = new StaticAnalyzer().analyze([def]);
    const unknown = diagnostics.filter((d) => d.code === "CEL_UNKNOWN_FIELD");
    expect(unknown.length).toBeGreaterThanOrEqual(1);
    expect(unknown[0].severity).toBe(DiagnosticSeverity.Error);
    expect(unknown[0].message).toContain("self.tabel");
  });

  it("accepts `!cel \"self.<declared>\"` (positive parity)", () => {
    const def: ResourceManifest = {
      kind: "Telo.Definition",
      metadata: { name: "Read", module: "repo" },
      capability: "Telo.Invocable",
      schema: {
        type: "object",
        required: ["table"],
        properties: { table: { type: "string" } },
      },
      resources: [
        {
          kind: "Sql.Query",
          metadata: { name: makeTaggedSentinel("cel", "self.table") },
        },
      ],
      invoke: "x",
    } as unknown as ResourceManifest;

    const diagnostics = new StaticAnalyzer().analyze([def]);
    const cel = diagnostics.filter(
      (d) => d.code === "CEL_UNKNOWN_FIELD" || d.code === "CEL_SYNTAX_ERROR",
    );
    expect(cel).toEqual([]);
  });

  it("produces the same diagnostic code for `${{ self.X }}` and `!cel \"self.X\"` typos", () => {
    const taggedDef: ResourceManifest = {
      kind: "Telo.Definition",
      metadata: { name: "T", module: "m" },
      capability: "Telo.Invocable",
      schema: { type: "object", properties: { table: { type: "string" } } },
      run: makeTaggedSentinel("cel", "self.tabel"),
    } as unknown as ResourceManifest;

    const untaggedDef: ResourceManifest = {
      kind: "Telo.Definition",
      metadata: { name: "U", module: "m" },
      capability: "Telo.Invocable",
      schema: { type: "object", properties: { table: { type: "string" } } },
      run: "${{ self.tabel }}",
    } as unknown as ResourceManifest;

    const taggedDiag = new StaticAnalyzer()
      .analyze([taggedDef])
      .filter((d) => d.code === "CEL_UNKNOWN_FIELD");
    const untaggedDiag = new StaticAnalyzer()
      .analyze([untaggedDef])
      .filter((d) => d.code === "CEL_UNKNOWN_FIELD");

    expect(taggedDiag.length).toBeGreaterThanOrEqual(1);
    expect(untaggedDiag.length).toBeGreaterThanOrEqual(1);
    expect(taggedDiag[0].code).toBe(untaggedDiag[0].code);
    expect(taggedDiag[0].message).toContain("self.tabel");
    expect(untaggedDiag[0].message).toContain("self.tabel");
  });
});
