import type { ResourceManifest } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { StaticAnalyzer } from "../src/analyzer.js";
import { validateSchemaProjection } from "../src/validate-schema-projection.js";
import { withSyntheticPositions } from "../src/with-synthetic-positions.js";

/**
 * A malformed `x-telo-schema-projection-from` is reported where it is written —
 * inside any schema region of any manifest — and nowhere else.
 */
const malformed = { from: "", pikc: "/y" };

describe("where a malformed projection derivation is reported", () => {
  it("does not report the key outside a schema region", () => {
    const manifest = {
      kind: "app.Store",
      metadata: { name: "notes", module: "app" },
      value: { "x-telo-schema-projection-from": malformed },
    } as unknown as ResourceManifest;
    expect(validateSchemaProjection(manifest)).toEqual([]);
  });

  it("reports one on a definition's contract exactly once, with no consumer duplicate", () => {
    const definition = {
      kind: "Telo.Definition",
      metadata: { name: "Write", module: "lib" },
      capability: "Telo.Invocable",
      inputType: {
        type: "object",
        properties: { row: { "x-telo-schema-projection-from": malformed } },
      },
      schema: { type: "object" },
    };
    const instance = { kind: "lib.Write", metadata: { name: "write", module: "lib" } };
    const library = { kind: "Telo.Library", metadata: { name: "lib", module: "lib" } };
    const diagnostics = new StaticAnalyzer().analyze(
      withSyntheticPositions([library, definition, instance] as unknown as ResourceManifest[]),
    );
    const reported = diagnostics
      .filter((d) => d.code.startsWith("SCHEMA_PROJECTION"))
      .map((d) => ({ code: d.code, path: (d.data as { path?: string }).path }));
    expect(reported).toEqual([
      {
        code: "SCHEMA_PROJECTION_INVALID",
        path: "inputType.properties.row.x-telo-schema-projection-from",
      },
    ]);
  });
});
