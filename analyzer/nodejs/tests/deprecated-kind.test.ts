import type { ResourceManifest } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { StaticAnalyzer } from "../src/analyzer.js";
import { DiagnosticSeverity, DiagnosticTag } from "../src/types.js";
import { withSyntheticPositions } from "../src/with-synthetic-positions.js";

/**
 * `metadata.deprecated` was indexed by the hub and read by nobody else: a kind
 * could be marked superseded and every manifest declaring it stayed silent, so
 * the one audience the block is written for never saw it. The warning lands at
 * the declaration's `kind:` line, which is what has to change.
 *
 * It is a WARNING throughout — a deprecated kind still works, and refusing to
 * run a manifest over a successor recommendation gets the cost backwards.
 */

const deprecatedDef = (deprecated: unknown): ResourceManifest =>
  ({
    kind: "Telo.Definition",
    metadata: { name: "Script", module: "javascript", deprecated },
    capability: "Telo.Invocable",
    schema: { type: "object", additionalProperties: true },
  }) as unknown as ResourceManifest;

const liveDef = {
  kind: "Telo.Definition",
  metadata: { name: "Script", module: "starlark" },
  capability: "Telo.Invocable",
  schema: { type: "object", additionalProperties: true },
} as unknown as ResourceManifest;

function analyze(docs: ResourceManifest[]): string[] {
  const app = { kind: "Telo.Application", metadata: { name: "App" } } as unknown as ResourceManifest;
  return new StaticAnalyzer()
    .analyze(withSyntheticPositions([app, ...docs]))
    .filter((d) => d.code === "DEPRECATED_KIND")
    .map((d) => d.message);
}

const use = (kind: string, module?: string): ResourceManifest =>
  ({
    kind,
    metadata: { name: "script", ...(module ? { module } : {}) },
  }) as unknown as ResourceManifest;

describe("declaring a deprecated kind", () => {
  it("warns with the author's reason", () => {
    const [message] = analyze([
      deprecatedDef({ reason: "Inline JavaScript is opaque to static analysis." }),
      use("javascript.Script"),
    ]);
    expect(message).toContain("'javascript.Script' is deprecated");
    expect(message).toContain("Inline JavaScript is opaque to static analysis.");
  });

  it("says nothing about a kind that is not deprecated", () => {
    expect(analyze([liveDef, use("starlark.Script")])).toEqual([]);
  });

  it("names the successor when one is declared", () => {
    const [message] = analyze([
      deprecatedDef({ reason: "Superseded.", replacedBy: "Telo.JsonSchema" }),
      use("javascript.Script"),
    ]);
    expect(message).toContain("Use 'Telo.JsonSchema' instead.");
  });

  // `replacedBy` is written in the DECLARING module's alias scope, so it is
  // resolved before being quoted. One that resolves to nothing degrades to the
  // author's spelling rather than to silence — `validate-module-metadata`
  // reports the unresolvable target at the declaration, where it is fixable.
  it("quotes an unresolvable successor verbatim rather than dropping it", () => {
    const [message] = analyze([
      deprecatedDef({ reason: "Superseded.", replacedBy: "Absent.Thing" }),
      use("javascript.Script"),
    ]);
    expect(message).toContain("Use 'Absent.Thing' instead.");
  });

  // A malformed block is the strict half's to report, at the declaration. Read
  // as absent here so a dependency's bad declaration never becomes a warning at
  // a use site the consumer cannot fix either way.
  it("ignores a block with no usable reason", () => {
    expect(analyze([deprecatedDef(true), use("javascript.Script")])).toEqual([]);
    expect(analyze([deprecatedDef({ reason: "   " }), use("javascript.Script")])).toEqual([]);
    expect(analyze([deprecatedDef({ replacedBy: "Telo.JsonSchema" }), use("javascript.Script")])).toEqual([]);
  });

  // Entry-module-scoped, like every other "not the consumer's to fix" check: a
  // library's own use of a kind its author deprecated is that author's concern.
  it("does not report a use declared by a module the entry does not own", () => {
    expect(
      analyze([deprecatedDef({ reason: "Superseded." }), use("javascript.Script", "vendor")]),
    ).toEqual([]);
  });

  // Severity says how loudly it asks to be dealt with; the tag says what it IS.
  // Both are needed: warning-grade alone cannot tell an editor to strike the
  // kind through, which is the rendering that reads as "deprecated" rather than
  // as "something is wrong here".
  it("carries the deprecation tag at warning severity", () => {
    const app = {
      kind: "Telo.Application",
      metadata: { name: "App" },
    } as unknown as ResourceManifest;
    const [d] = new StaticAnalyzer()
      .analyze(
        withSyntheticPositions([
          app,
          deprecatedDef({ reason: "Superseded." }),
          use("javascript.Script"),
        ]),
      )
      .filter((x) => x.code === "DEPRECATED_KIND");
    expect(d?.severity).toBe(DiagnosticSeverity.Warning);
    expect(d?.tags).toEqual([DiagnosticTag.Deprecated]);
  });
});
