import type { ResourceManifest } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { StaticAnalyzer } from "../src/analyzer.js";
import { withSyntheticPositions } from "../src/with-synthetic-positions.js";

/** A route-shaped definition: `returns[].when` sees `result`, typed from the
 *  referenced handler via `x-telo-context-ref-from` — the annotation `Http.Api`
 *  uses. */
const apiDef = {
  kind: "Telo.Definition",
  metadata: { name: "Api", module: "http-server" },
  capability: "Telo.Mount",
  schema: {
    type: "object",
    properties: {
      routes: {
        type: "array",
        items: {
          type: "object",
          properties: {
            handler: { "x-telo-ref": "Telo.Invocable" },
            returns: {
              type: "array",
              "x-telo-context": {
                type: "object",
                additionalProperties: false,
                properties: {
                  result: {
                    "x-telo-context-ref-from": "handler/outputType",
                    type: "object",
                    additionalProperties: true,
                  },
                },
              },
              items: {
                type: "object",
                properties: { when: { type: "string" } },
              },
            },
          },
        },
      },
    },
  },
} as unknown as ResourceManifest;

/** A handler kind with ONE fixed output shape, declared on the definition —
 *  not exposed as an author-writable field, so no instance ever restates it. */
const callbackDef = {
  kind: "Telo.Definition",
  metadata: { name: "Callback", module: "oauth-client" },
  capability: "Telo.Invocable",
  outputType: {
    type: "object",
    additionalProperties: false,
    required: ["ok"],
    properties: {
      ok: { type: "boolean" },
      reason: { type: "string" },
    },
  },
  schema: { type: "object", properties: {} },
} as unknown as ResourceManifest;

const callbackInstance = {
  kind: "oauth-client.Callback",
  metadata: { name: "oauthCallback", module: "test" },
} as unknown as ResourceManifest;

function analyzeWithReturn(when: string) {
  const api = {
    kind: "http-server.Api",
    metadata: { name: "routes", module: "test" },
    routes: [
      {
        handler: { kind: "oauth-client.Callback", name: "oauthCallback" },
        returns: [{ when }],
      },
    ],
  } as unknown as ResourceManifest;

  return new StaticAnalyzer().analyze(
    withSyntheticPositions([apiDef, callbackDef, callbackInstance, api]),
  );
}

describe("x-telo-context-ref-from falls back to the referenced kind", () => {
  it("types `result` from the handler kind when the instance declares no outputType", () => {
    const unknown = analyzeWithReturn("${{ result.reasson }}").filter(
      (d) => d.code === "CEL_UNKNOWN_FIELD",
    );
    expect(unknown.length).toBeGreaterThan(0);
    expect(unknown[0].message).toContain("reasson");
  });

  it("accepts a field the handler kind does declare", () => {
    const unknown = analyzeWithReturn("${{ result.ok }}").filter(
      (d) => d.code === "CEL_UNKNOWN_FIELD",
    );
    expect(unknown).toEqual([]);
  });
});
