import type { ResourceManifest } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { StaticAnalyzer } from "../src/analyzer.js";
import { withSyntheticPositions } from "../src/with-synthetic-positions.js";

const lib = (kinds: string[]): ResourceManifest =>
  ({
    kind: "Telo.Library",
    metadata: { name: "widget" },
    exports: { kinds },
  }) as unknown as ResourceManifest;

const def = (name: string, description?: string): ResourceManifest =>
  ({
    kind: "Telo.Definition",
    metadata: { name, module: "widget", ...(description ? { description } : {}) },
    capability: "Telo.Invocable",
    schema: { type: "object", additionalProperties: true },
  }) as unknown as ResourceManifest;

const missing = (ds: ReturnType<StaticAnalyzer["analyze"]>) =>
  ds.filter((d) => d.code === "KIND_MISSING_DESCRIPTION");

describe("validateKindDescriptions", () => {
  it("warns on an exported kind with no metadata.description", () => {
    const diagnostics = new StaticAnalyzer().analyze(
      withSyntheticPositions([lib(["Thing"]), def("Thing")]),
    );
    const violations = missing(diagnostics);
    expect(violations).toHaveLength(1);
    expect(violations[0].severity).toBe(2); // Warning
    expect(violations[0].message).toContain("widget.Thing");
  });

  it("is silent when the exported kind has a description", () => {
    const diagnostics = new StaticAnalyzer().analyze(
      withSyntheticPositions([lib(["Thing"]), def("Thing", "Does a thing.")]),
    );
    expect(missing(diagnostics)).toHaveLength(0);
  });

  it("is silent for a blank/whitespace-only description", () => {
    const diagnostics = new StaticAnalyzer().analyze(
      withSyntheticPositions([lib(["Thing"]), def("Thing", "   ")]),
    );
    expect(missing(diagnostics)).toHaveLength(1);
  });

  it("skips re-exported kinds (Alias.Kind)", () => {
    const diagnostics = new StaticAnalyzer().analyze(
      withSyntheticPositions([lib(["Other.Thing"]), def("Thing")]),
    );
    expect(missing(diagnostics)).toHaveLength(0);
  });

  it("does not warn on a defined-but-not-exported kind", () => {
    const diagnostics = new StaticAnalyzer().analyze(
      withSyntheticPositions([lib([]), def("Thing")]),
    );
    expect(missing(diagnostics)).toHaveLength(0);
  });
});
