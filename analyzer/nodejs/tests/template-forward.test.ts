import type { ResourceManifest } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { StaticAnalyzer } from "../src/analyzer.js";
import { withSyntheticPositions } from "../src/with-synthetic-positions.js";
import { DiagnosticSeverity } from "../src/types.js";

/**
 * A value a template body forwards with a bare `self.<path>` is, at boot, a
 * field of a resource of the entry's kind. `telo check` validates it as one and
 * reports what it finds at the consumer's own path.
 */

const ref = (source: string) => ({ __tagged: true, engine: "ref", source });
const cel = (source: string) => ({ __tagged: true, engine: "cel", source });

/** The response rules, derived by the router's `returns:` through
 *  `x-telo-schema-from` — the way `Http.Api` gets them. */
const outcomesKind = {
  kind: "Telo.Definition",
  metadata: { name: "Outcomes", module: "http" },
  capability: "Telo.Type",
  schema: {
    type: "object",
    $defs: {
      Returns: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["status"],
          properties: { status: { type: "integer" }, body: {} },
        },
      },
    },
  },
} as unknown as ResourceManifest;

const apiKind = {
  kind: "Telo.Definition",
  metadata: { name: "Api", module: "http" },
  capability: "Telo.Mount",
  schema: {
    type: "object",
    required: ["routes", "title"],
    properties: {
      title: { type: "string" },
      routes: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["path", "returns"],
          properties: {
            path: { type: "string" },
            handler: {
              "x-telo-ref": { kind: "Telo.Executable", use: "trigger.inbound" },
            },
            returns: {
              type: "array",
              "x-telo-schema-from": "Self.Outcomes/$defs/Returns",
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
            },
          },
        },
      },
    },
  },
} as unknown as ResourceManifest;

const greeterKind = {
  kind: "Telo.Definition",
  metadata: { name: "Greeter", module: "app" },
  capability: "Telo.Invocable",
  outputType: {
    type: "object",
    additionalProperties: false,
    properties: { greeting: { type: "string" } },
  },
  schema: { type: "object", properties: {} },
} as unknown as ResourceManifest;

const shapeKind = {
  kind: "Telo.Definition",
  metadata: { name: "Shape", module: "app" },
  capability: "Telo.Type",
  schema: { type: "object", additionalProperties: true },
} as unknown as ResourceManifest;

/** The wrapper declares only what it adds — the handler slot. Its own `title`
 *  is literal content the router also checks, and no business of a consumer. */
function routesKind(workflows: Record<string, unknown>): ResourceManifest {
  return {
    kind: "Telo.Definition",
    metadata: { name: "Routes", module: "Lib" },
    capability: "Telo.Mount",
    schema: { type: "object", required: ["workflows"], properties: { workflows } },
    resources: [
      { kind: "http.Api", metadata: { name: "api" }, title: 42, routes: cel("self.workflows") },
    ],
    mount: ref("api"),
  } as unknown as ResourceManifest;
}

const workflowsSlot = {
  type: "array",
  items: {
    type: "object",
    properties: {
      handler: { "x-telo-ref": { kind: "Telo.Executable", use: "trigger.inbound" } },
    },
  },
};

function consumer(workflow: Record<string, unknown>): ResourceManifest {
  return {
    kind: "Lib.Routes",
    metadata: { name: "app" },
    workflows: [{ path: "/greet", handler: ref("greet"), ...workflow }],
  } as unknown as ResourceManifest;
}

const greet = { kind: "app.Greeter", metadata: { name: "greet" } } as unknown as ResourceManifest;

function errors(...manifests: ResourceManifest[]) {
  return new StaticAnalyzer()
    .analyze(
      withSyntheticPositions([outcomesKind, apiKind, greeterKind, shapeKind, greet, ...manifests]),
    )
    .filter((d) => d.severity === DiagnosticSeverity.Error);
}

describe("a template forward is checked as the entry kind's field", () => {
  it("reports a violation of the entry's derived schema at the consumer's own path", () => {
    const found = errors(
      routesKind(workflowsSlot),
      consumer({ returns: [{ status: "notanumber" }] }),
    );
    expect(found.map((d) => [d.code, d.data?.resource, d.data?.path])).toEqual([
      [
        "DEPENDENT_SCHEMA_MISMATCH",
        { kind: "Lib.Routes", name: "app" },
        "workflows[0].returns[0].status",
      ],
    ]);
    expect(found[0]!.message).toContain("must be integer");
  });

  it("types the forwarded CEL in the entry's contexts, not the wrapper's", () => {
    const found = errors(
      routesKind(workflowsSlot),
      consumer({ returns: [{ status: 200, body: cel("result.greting") }] }),
    );
    // The wrapper declares no context for `returns`; the router does, typing
    // `result` from the handler's output — so the typo is reported, and the
    // expression is not "never evaluated".
    expect(found.map((d) => [d.code, d.data?.path])).toEqual([
      ["CEL_UNKNOWN_FIELD", "workflows[0].returns[0].body"],
    ]);
  });

  it("reports nothing about what the consumer did not write", () => {
    // The entry's literal `title: 42` and the view's missing `title` are the
    // library's; a valid consumer checks clean.
    expect(
      errors(routesKind(workflowsSlot), consumer({ returns: [{ status: 200, body: cel("result") }] })),
    ).toEqual([]);
  });

  it("reports an issue the wrapper's own schema already reports once", () => {
    const shape = { kind: "app.Shape", metadata: { name: "Shape" } } as unknown as ResourceManifest;
    const found = errors(
      routesKind(workflowsSlot),
      shape,
      consumer({ handler: ref("Shape"), returns: [{ status: 200 }] }),
    );
    expect(found.map((d) => [d.code, d.data?.path])).toEqual([
      ["REFERENCE_KIND_MISMATCH", "workflows[0].handler"],
    ]);
  });
});

describe("a forwarded field's declaration must be assignable to the entry's", () => {
  it("reports a definite mismatch at the wrapper's schema property, in its own module's check", () => {
    const library = {
      kind: "Telo.Library",
      metadata: { name: "Lib", version: "1.0.0" },
    } as unknown as ResourceManifest;
    const found = errors(library, routesKind({ type: "string" }));
    expect(found.map((d) => [d.code, d.data?.resource, d.data?.path])).toEqual([
      [
        "TEMPLATE_FORWARD_INCOMPATIBLE",
        { kind: "Telo.Definition", name: "Routes" },
        "schema.properties.workflows",
      ],
    ]);
    expect(found[0]!.message).toContain("source is 'string', target expects 'array'");
  });
});
