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
    const unknown = analyzeWithReturn({ __tagged: true, engine: "cel", source: "result.reasson" }).filter(
      (d) => d.code === "CEL_UNKNOWN_FIELD",
    );
    expect(unknown.length).toBeGreaterThan(0);
    expect(unknown[0].message).toContain("reasson");
  });

  it("accepts a field the handler kind does declare", () => {
    const unknown = analyzeWithReturn({ __tagged: true, engine: "cel", source: "result.ok" }).filter(
      (d) => d.code === "CEL_UNKNOWN_FIELD",
    );
    expect(unknown).toEqual([]);
  });
});

/** The same binding declared inside a plain nested object rather than an array
 *  item: the reference it is typed from sits beside the annotated field. */
const reviewedDef = {
  kind: "Telo.Definition",
  metadata: { name: "Reviewed", module: "review" },
  capability: "Telo.Invocable",
  schema: {
    type: "object",
    properties: {
      approver: {
        type: "object",
        properties: {
          invoke: { "x-telo-ref": "Telo.Invocable" },
          result: {
            type: "object",
            properties: { reason: { type: "string" } },
            "x-telo-context": {
              type: "object",
              additionalProperties: false,
              properties: { result: { "x-telo-context-ref-from": "invoke/outputType" } },
            },
          },
        },
      },
    },
  },
} as unknown as ResourceManifest;

describe("x-telo-context-ref-from inside a nested object", () => {
  it("types `result` from the reference beside the annotated field", () => {
    const reviewed = {
      kind: "review.Reviewed",
      metadata: { name: "reviewed", module: "test" },
      approver: {
        invoke: { kind: "oauth-client.Callback", name: "oauthCallback" },
        result: { reason: { __tagged: true, engine: "cel", source: "result.reasson" } },
      },
    } as unknown as ResourceManifest;
    const unknown = new StaticAnalyzer()
      .analyze(withSyntheticPositions([reviewedDef, callbackDef, callbackInstance, reviewed]))
      .filter((d) => d.code === "CEL_UNKNOWN_FIELD");
    expect(unknown).toHaveLength(1);
    expect(unknown[0]!.message).toContain("reasson");
  });
});

/** The reference is read on the object holding the annotated field and nowhere
 *  else: a key of that name on the enclosing array item is not it. */
const rulesDef = {
  kind: "Telo.Definition",
  metadata: { name: "Rules", module: "review" },
  capability: "Telo.Invocable",
  schema: {
    type: "object",
    properties: {
      rules: {
        type: "array",
        items: {
          type: "object",
          properties: {
            invoke: { "x-telo-ref": "Telo.Invocable" },
            approver: {
              type: "object",
              properties: {
                result: {
                  type: "object",
                  properties: { reason: { type: "string" } },
                  "x-telo-context": {
                    type: "object",
                    additionalProperties: false,
                    properties: { result: { "x-telo-context-ref-from": "invoke/outputType" } },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
} as unknown as ResourceManifest;

describe("x-telo-context-ref-from beneath an array item", () => {
  it("leaves `result` open when only the item, not the holder, has the reference's key", () => {
    const rules = {
      kind: "review.Rules",
      metadata: { name: "rules", module: "test" },
      rules: [
        {
          invoke: { kind: "oauth-client.Callback", name: "oauthCallback" },
          approver: {
            result: { reason: { __tagged: true, engine: "cel", source: "result.reasson" } },
          },
        },
      ],
    } as unknown as ResourceManifest;
    // Nothing is said about the expression: the binding is untyped there.
    const aboutCel = new StaticAnalyzer()
      .analyze(withSyntheticPositions([rulesDef, callbackDef, callbackInstance, rules]))
      .filter((d) => String(d.code).startsWith("CEL_"));
    expect(aboutCel).toEqual([]);
  });
});
