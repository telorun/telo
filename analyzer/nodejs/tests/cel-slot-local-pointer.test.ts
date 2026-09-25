import type { ResourceManifest } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { StaticAnalyzer } from "../src/analyzer.js";
import { withSyntheticPositions } from "../src/with-synthetic-positions.js";

describe("a CEL value below any document-local $ref", () => {
  it("is typed against the slot the pointer names, as the eval-path reader reaches it", () => {
    const manifests = [
      { kind: "Telo.Application", metadata: { name: "app", source: "telo.yaml" } },
      {
        kind: "Telo.Definition",
        metadata: { name: "Pick", module: "app" },
        capability: "Telo.Invocable",
        schema: {
          type: "object",
          definitions: {
            F: {
              type: "object",
              properties: { selector: { type: "string", "x-telo-eval": "compile" } },
            },
          },
          properties: { field: { $ref: "#/definitions/F" } },
        },
      },
      {
        kind: "app.Pick",
        metadata: { name: "pick", source: "telo.yaml" },
        field: { selector: { __tagged: true, engine: "cel", source: "2" } },
      },
    ] as unknown as ResourceManifest[];

    const typeErrors = new StaticAnalyzer()
      .analyze(withSyntheticPositions(manifests))
      .filter((d) => d.code === "CEL_TYPE_ERROR");
    expect(typeErrors).toHaveLength(1);
    expect(typeErrors[0]!.message).toContain("string");
  });
});
