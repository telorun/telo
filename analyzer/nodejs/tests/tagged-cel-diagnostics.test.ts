import type { ResourceManifest } from "@telorun/sdk";
import { makeTaggedSentinel } from "@telorun/templating";
import { describe, expect, it } from "vitest";
import { StaticAnalyzer } from "../src/analyzer.js";
import { DiagnosticSeverity } from "../src/types.js";
import { withSyntheticPositions } from "../src/with-synthetic-positions.js";

/** Build a `Telo.Definition` for an arbitrary kind so the analyzer can resolve
 *  it. `metadata.module` is what the registry keys on (the loader stamps it
 *  from the owning module; in unit tests we set it manually). The definition
 *  declares an `x-telo-context` on the field that holds the tagged scalar —
 *  that's what drives chain validation against a closed schema. */
function makeKindWithContext(kind: string, fieldContext: Record<string, unknown>): ResourceManifest {
  const [moduleName, typeName] = kind.split(".") as [string, string];
  return {
    kind: "Telo.Definition",
    metadata: { name: typeName, module: moduleName },
    capability: "Telo.Service",
    schema: {
      type: "object",
      properties: {
        expr: {
          type: "string",
          "x-telo-context": fieldContext,
        },
      },
    },
  } as unknown as ResourceManifest;
}

const requestContext = {
  type: "object",
  properties: {
    request: {
      type: "object",
      properties: { name: { type: "string" } },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
};

describe("StaticAnalyzer with !cel-tagged values", () => {
  it("reports CEL_UNKNOWN_FIELD for a chain that steps off the closed context", () => {
    const def = makeKindWithContext("Test.Thing", requestContext);
    const resource: ResourceManifest = {
      kind: "Test.Thing",
      metadata: { name: "r" },
      expr: makeTaggedSentinel("cel", "request.bogus"),
    } as unknown as ResourceManifest;

    const diagnostics = new StaticAnalyzer().analyze(withSyntheticPositions([def, resource]));
    const unknownField = diagnostics.filter((d) => d.code === "CEL_UNKNOWN_FIELD");
    expect(unknownField).toHaveLength(1);
    expect(unknownField[0].severity).toBe(DiagnosticSeverity.Error);
    expect(unknownField[0].message).toContain("'request.bogus' is not defined");
    expect((unknownField[0].data as { path?: string }).path).toBe("expr");
  });

  it("reports CEL_SYNTAX_ERROR for a malformed tagged expression", () => {
    const def = makeKindWithContext("Test.Thing", requestContext);
    const resource: ResourceManifest = {
      kind: "Test.Thing",
      metadata: { name: "r" },
      expr: makeTaggedSentinel("cel", "@@@"),
    } as unknown as ResourceManifest;

    const diagnostics = new StaticAnalyzer().analyze(withSyntheticPositions([def, resource]));
    const syntax = diagnostics.filter((d) => d.code === "CEL_SYNTAX_ERROR");
    expect(syntax).toHaveLength(1);
    expect(syntax[0].severity).toBe(DiagnosticSeverity.Error);
    expect((syntax[0].data as { path?: string }).path).toBe("expr");
  });

  it("returns no CEL diagnostics for a tagged expression that resolves cleanly", () => {
    const def = makeKindWithContext("Test.Thing", requestContext);
    const resource: ResourceManifest = {
      kind: "Test.Thing",
      metadata: { name: "r" },
      expr: makeTaggedSentinel("cel", "request.name"),
    } as unknown as ResourceManifest;

    const diagnostics = new StaticAnalyzer().analyze(withSyntheticPositions([def, resource]));
    const cel = diagnostics.filter(
      (d) => d.code === "CEL_UNKNOWN_FIELD" || d.code === "CEL_SYNTAX_ERROR",
    );
    expect(cel).toEqual([]);
  });

  it("emits no diagnostics for a !literal-tagged value (literal engine returns no findings)", () => {
    const def = makeKindWithContext("Test.Thing", requestContext);
    const resource: ResourceManifest = {
      kind: "Test.Thing",
      metadata: { name: "r" },
      expr: makeTaggedSentinel("literal", "anything goes ${{ even.this }}"),
    } as unknown as ResourceManifest;

    const diagnostics = new StaticAnalyzer().analyze(withSyntheticPositions([def, resource]));
    const cel = diagnostics.filter(
      (d) => d.code === "CEL_UNKNOWN_FIELD" || d.code === "CEL_SYNTAX_ERROR",
    );
    expect(cel).toEqual([]);
  });

  it("preserves the same diagnostic codes as the untagged ${{ }} path for parity", () => {
    // Same chain, same context, two delivery modes: the diagnostic codes must
    // match exactly so downstream filtering doesn't have to special-case the
    // tagged path.
    const def = makeKindWithContext("Test.Thing", requestContext);
    const tagged: ResourceManifest = {
      kind: "Test.Thing",
      metadata: { name: "tagged" },
      expr: makeTaggedSentinel("cel", "request.bogus"),
    } as unknown as ResourceManifest;
    const untagged: ResourceManifest = {
      kind: "Test.Thing",
      metadata: { name: "untagged" },
      expr: "${{ request.bogus }}",
    } as unknown as ResourceManifest;

    const taggedDiag = new StaticAnalyzer()
      .analyze(withSyntheticPositions([def, tagged]))
      .filter((d) => d.code === "CEL_UNKNOWN_FIELD");
    const untaggedDiag = new StaticAnalyzer()
      .analyze(withSyntheticPositions([def, untagged]))
      .filter((d) => d.code === "CEL_UNKNOWN_FIELD");

    expect(taggedDiag).toHaveLength(1);
    expect(untaggedDiag).toHaveLength(1);
    expect(taggedDiag[0].code).toBe(untaggedDiag[0].code);
    // Bodies differ only by the resource name prefix; the chain-error tail is identical.
    expect(taggedDiag[0].message).toContain("'request.bogus' is not defined");
    expect(untaggedDiag[0].message).toContain("'request.bogus' is not defined");
  });

  it("emits no SCHEMA_VIOLATION for a tagged scalar on a typed field", () => {
    // Schema validation must treat !cel / !literal sentinels the same as the
    // untagged `${{ }}` form: substitute a placeholder of the field's type
    // before AJV runs. Without this, every typed field (string, integer, …)
    // rejects tagged values because the parsed sentinel is an object, not the
    // declared type.
    const def = makeKindWithContext("Test.Thing", requestContext);
    const literalRes: ResourceManifest = {
      kind: "Test.Thing",
      metadata: { name: "lit" },
      expr: makeTaggedSentinel("literal", "anything goes ${{ even.this }}"),
    } as unknown as ResourceManifest;
    const celRes: ResourceManifest = {
      kind: "Test.Thing",
      metadata: { name: "cel" },
      expr: makeTaggedSentinel("cel", "request.name"),
    } as unknown as ResourceManifest;

    const diagnostics = new StaticAnalyzer().analyze(withSyntheticPositions([def, literalRes, celRes]));
    const schemaViolations = diagnostics.filter((d) => d.code === "SCHEMA_VIOLATION");
    expect(schemaViolations).toEqual([]);
  });
});
