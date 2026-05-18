import type { ResourceManifest } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { StaticAnalyzer } from "../src/analyzer.js";
import { DiagnosticSeverity } from "../src/types.js";

const sessionAbstract: ResourceManifest = {
  kind: "Telo.Abstract",
  metadata: { name: "SessionProvider", module: "mcp" },
  outputType: {
    type: "object",
    additionalProperties: false,
    required: ["sessionId"],
    properties: { sessionId: { type: "string" } },
  },
} as unknown as ResourceManifest;

const httpRequestKind: ResourceManifest = {
  kind: "Telo.Definition",
  metadata: { name: "Request", module: "http-client" },
  capability: "Telo.Invocable",
  outputType: {
    type: "object",
    additionalProperties: false,
    properties: {
      body: {
        type: "object",
        additionalProperties: false,
        properties: {
          data: {
            type: "object",
            additionalProperties: false,
            properties: { session_id: { type: "string" } },
          },
        },
      },
    },
  },
  schema: { type: "object", additionalProperties: true },
} as unknown as ResourceManifest;

const mcpImport: ResourceManifest = {
  kind: "Telo.Import",
  metadata: { name: "Mcp", resolvedModuleName: "mcp" },
  source: "mcp",
} as unknown as ResourceManifest;

function makeVaultSession(resultBody: Record<string, unknown>): ResourceManifest {
  return {
    kind: "Telo.Definition",
    metadata: { name: "VaultSession", module: "mcp-client" },
    capability: "Telo.Provider",
    extends: "Mcp.SessionProvider",
    schema: { type: "object", additionalProperties: true },
    resources: [
      { kind: "http-client.Request", metadata: { name: "${{ self.name }}-read" } },
    ],
    provide: {
      kind: "http-client.Request",
      name: "${{ self.name }}-read",
    },
    result: resultBody,
  } as unknown as ResourceManifest;
}

describe("Telo.Definition: structural validation of top-level `result`", () => {
  it("accepts a result that satisfies the abstract's outputType", () => {
    const def = makeVaultSession({ sessionId: "${{ result.body.data.session_id }}" });
    const diagnostics = new StaticAnalyzer().analyze([mcpImport, sessionAbstract, httpRequestKind, def]);
    const violations = diagnostics.filter(
      (d) => d.code === "TEMPLATE_TARGET_MISMATCH" || d.code === "CEL_UNKNOWN_FIELD",
    );
    expect(violations).toEqual([]);
  });

  it("rejects CEL access to fields not on the dispatch target's outputType", () => {
    // `result.body.data.session_id` is correct; `result.bogus` is not.
    const def = makeVaultSession({ sessionId: "${{ result.bogus }}" });
    const diagnostics = new StaticAnalyzer().analyze([mcpImport, sessionAbstract, httpRequestKind, def]);
    const unknown = diagnostics.filter((d) => d.code === "CEL_UNKNOWN_FIELD");
    expect(unknown.length).toBeGreaterThanOrEqual(1);
    expect(unknown[0].severity).toBe(DiagnosticSeverity.Error);
    expect(unknown[0].message).toContain("result.bogus");
  });

  it("rejects a result missing a required property of the abstract's outputType", () => {
    // outputType requires `sessionId`; we provide a different property.
    const def: ResourceManifest = {
      kind: "Telo.Definition",
      metadata: { name: "Bad", module: "mcp-client" },
      capability: "Telo.Provider",
      extends: "Mcp.SessionProvider",
      schema: { type: "object", additionalProperties: true },
      provide: { kind: "http-client.Request", name: "x" },
      result: { other: "static-value" },
    } as unknown as ResourceManifest;

    const diagnostics = new StaticAnalyzer().analyze([
      mcpImport,
      sessionAbstract,
      httpRequestKind,
      def,
    ]);
    const violations = diagnostics.filter((d) => d.code === "TEMPLATE_TARGET_MISMATCH");
    expect(violations.length).toBeGreaterThanOrEqual(1);
    expect(violations[0].severity).toBe(DiagnosticSeverity.Error);
    expect(violations[0].message).toContain("Mcp.SessionProvider");
  });
});
