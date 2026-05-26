import type { ResourceManifest } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { StaticAnalyzer } from "../src/analyzer.js";
import { DiagnosticSeverity } from "../src/types.js";
import { withSyntheticPositions } from "../src/with-synthetic-positions.js";

// A concrete invocable kind whose outputType narrows what `result` CEL can read.
const echoKind: ResourceManifest = {
  kind: "Telo.Definition",
  metadata: { name: "Echo", module: "echo" },
  capability: "Telo.Invocable",
  outputType: {
    type: "object",
    additionalProperties: false,
    properties: { raw: { type: "string" } },
    required: ["raw"],
  },
  schema: { type: "object", additionalProperties: true },
} as unknown as ResourceManifest;

// An abstract whose outputType the wrapping definition must satisfy via `result:`.
const reshaperAbstract: ResourceManifest = {
  kind: "Telo.Abstract",
  metadata: { name: "Token", module: "auth" },
  outputType: {
    type: "object",
    additionalProperties: false,
    required: ["token"],
    properties: { token: { type: "string" } },
  },
} as unknown as ResourceManifest;

const authImport: ResourceManifest = {
  kind: "Telo.Import",
  metadata: { name: "Auth", resolvedModuleName: "auth" },
  source: "auth",
} as unknown as ResourceManifest;

function makeInvokeReshaper(result: Record<string, unknown>): ResourceManifest {
  return {
    kind: "Telo.Definition",
    metadata: { name: "Wrap", module: "wrap" },
    capability: "Telo.Invocable",
    extends: "Auth.Token",
    schema: { type: "object", additionalProperties: true },
    resources: [{ kind: "echo.Echo", metadata: { name: "${{ self.name }}-src" } }],
    invoke: { kind: "echo.Echo", name: "${{ self.name }}-src" },
    inputs: {},
    result,
  } as unknown as ResourceManifest;
}

describe("Telo.Definition: top-level `result:` on `invoke:` template targets", () => {
  it("accepts a result that satisfies the abstract's outputType", () => {
    const def = makeInvokeReshaper({ token: "bearer ${{ result.raw }}" });
    const diagnostics = new StaticAnalyzer().analyze(withSyntheticPositions([
      authImport,
      reshaperAbstract,
      echoKind,
      def,
    ]));
    const violations = diagnostics.filter(
      (d) => d.code === "TEMPLATE_TARGET_MISMATCH" || d.code === "CEL_UNKNOWN_FIELD",
    );
    expect(violations).toEqual([]);
  });

  it("rejects CEL access to fields not on the invoke target's outputType", () => {
    const def = makeInvokeReshaper({ token: "bearer ${{ result.bogus }}" });
    const diagnostics = new StaticAnalyzer().analyze(withSyntheticPositions([
      authImport,
      reshaperAbstract,
      echoKind,
      def,
    ]));
    const unknown = diagnostics.filter((d) => d.code === "CEL_UNKNOWN_FIELD");
    expect(unknown.length).toBeGreaterThanOrEqual(1);
    expect(unknown[0].severity).toBe(DiagnosticSeverity.Error);
    expect(unknown[0].message).toContain("result.bogus");
  });

  it("rejects a result missing a required property of the abstract's outputType", () => {
    const def = makeInvokeReshaper({ other: "${{ result.raw }}" });
    const diagnostics = new StaticAnalyzer().analyze(withSyntheticPositions([
      authImport,
      reshaperAbstract,
      echoKind,
      def,
    ]));
    const violations = diagnostics.filter((d) => d.code === "TEMPLATE_TARGET_MISMATCH");
    expect(violations.length).toBeGreaterThanOrEqual(1);
    expect(violations[0].message).toContain("Auth.Token");
  });
});
