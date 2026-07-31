import { DiagnosticSeverity } from "@telorun/analyzer";
import { describe, expect, it } from "vitest";

import { staticDiagnosticToRuntime } from "../src/static-analysis-diagnostics.js";

/**
 * The mapper is the whole reason `telo run` can point at a line: what it drops
 * here, no renderer can recover — the alternative is re-parsing a rendered
 * message, which is what this replaced.
 */
describe("staticDiagnosticToRuntime", () => {
  it("carries the file, field path and resource a renderer locates from", () => {
    const runtime = staticDiagnosticToRuntime({
      severity: DiagnosticSeverity.Error,
      code: "UNDEFINED_KIND",
      source: "telo-analyzer",
      message: "No Telo.Definition found for kind 'Type.JsonSchema'.",
      data: {
        filePath: "file:///app/telo.yaml",
        path: "kind",
        resource: { kind: "Type.JsonSchema", name: "nope" },
      },
    });

    expect(runtime).toMatchObject({
      severity: "error",
      code: "UNDEFINED_KIND",
      resource: "Type.JsonSchema.nope",
      origin: {
        filePath: "file:///app/telo.yaml",
        path: "kind",
        resource: { kind: "Type.JsonSchema", name: "nope" },
      },
    });
  });

  // A parse failure has no parsed tree to index a field path against, so its own
  // range is the only position it will ever have.
  it("carries the diagnostic's own range for a failure with no field path", () => {
    const runtime = staticDiagnosticToRuntime({
      severity: DiagnosticSeverity.Error,
      code: "MANIFEST_PARSE_FAILED",
      source: "telo-analyzer",
      message: "Sequence item without - indicator",
      range: { start: { line: 11, character: 0 }, end: { line: 11, character: 3 } },
      data: { filePath: "file:///app/telo.yaml" },
    });

    expect(runtime.origin?.range?.start).toEqual({ line: 11, character: 0 });
    expect(runtime.resource).toBeUndefined();
  });

  // Every current caller passes a pre-filtered error set, so a hard-coded
  // "error" was right by accident; a warning routed through here would be
  // printed in red and counted toward the exit code.
  it("maps severity rather than stamping every entry as an error", () => {
    const warning = staticDiagnosticToRuntime({
      severity: DiagnosticSeverity.Warning,
      code: "MODULE_VERSION_HOISTED",
      source: "telo-analyzer",
      message: "hoisted to 0.2.0",
      data: { filePath: "file:///app/telo.yaml" },
    });
    expect(warning.severity).toBe("warning");
  });

  // `origin` is the "this came from static analysis" predicate, so an entry
  // with nothing to locate must not carry an object of undefined fields.
  it("omits origin entirely when there is nothing to locate", () => {
    const bare = staticDiagnosticToRuntime({
      severity: DiagnosticSeverity.Error,
      source: "telo-analyzer",
      message: "something failed",
    });
    expect(bare.origin).toBeUndefined();
  });

  it("renders whichever half of the resource identity is present", () => {
    const halfNamed = staticDiagnosticToRuntime({
      severity: DiagnosticSeverity.Error,
      source: "telo-analyzer",
      message: "something failed",
      data: { resource: { name: "orphan" } },
    });
    expect(halfNamed.resource).toBe("orphan");
  });
});
