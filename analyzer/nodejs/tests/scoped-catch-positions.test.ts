import type { ResourceManifest } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { StaticAnalyzer } from "../src/analyzer.js";
import { withSyntheticPositions } from "../src/with-synthetic-positions.js";

/** A `with:`-scoped declaration is not a top-level document, so a diagnostic
 *  about it has to route through its OWNER and carry the owner-relative path to
 *  the declaration. Without that it anchors on the owner's first line and names
 *  a resource that has no `catches:` at all — the developer-friendliness goal
 *  inverted exactly where scoped checking claims to serve it.
 *
 *  Asserted here rather than in the runtime manifest test, which exercises what
 *  the ladder RENDERS and says nothing about where a diagnostic lands. */

const app: ResourceManifest = {
  kind: "Telo.Application",
  metadata: { name: "scoped-app", version: "1.0.0" },
} as unknown as ResourceManifest;

const handlerDef: ResourceManifest = {
  kind: "Telo.Definition",
  metadata: { name: "Script", module: "std" },
  capability: "Telo.Invocable",
  throws: { codes: { NOT_FOUND: {} } },
  schema: { type: "object", properties: { code: { type: "string" } } },
} as unknown as ResourceManifest;

/** A router with a scope-level catch list, mirroring `Http.Api`. */
const apiDef: ResourceManifest = {
  kind: "Telo.Definition",
  metadata: { name: "Api", module: "std" },
  capability: "Telo.Mount",
  schema: {
    type: "object",
    properties: {
      catches: {
        type: "array",
        "x-telo-outcome-list": "catches",
        "x-telo-catches-for": "",
        items: { type: "object", properties: { status: { type: "integer" } } },
      },
      routes: {
        type: "array",
        items: {
          type: "object",
          properties: {
            handler: { "x-telo-ref": { kind: "std.Script", use: "trigger.inbound" } },
          },
        },
      },
    },
  },
} as unknown as ResourceManifest;

/** A composer whose `with:` field declares scoped resources, mirroring
 *  `Run.Sequence` — including the detail that `x-telo-scope` names the
 *  VISIBILITY regions (`/steps`), never the declaring field (`with`). */
const seqDef: ResourceManifest = {
  kind: "Telo.Definition",
  metadata: { name: "Sequence", module: "std" },
  capability: "Telo.Runnable",
  schema: {
    type: "object",
    properties: {
      with: { type: "array", "x-telo-scope": ["/steps"], items: { type: "object" } },
      steps: { type: "array", items: { type: "object" } },
    },
  },
} as unknown as ResourceManifest;

const handler: ResourceManifest = {
  kind: "std.Script",
  metadata: { name: "throwsNotFound" },
  code: "x",
} as unknown as ResourceManifest;

/** The scoped router names a code nothing it drives can throw. */
const seq: ResourceManifest = {
  kind: "std.Sequence",
  metadata: { name: "seq" },
  with: [
    {
      kind: "std.Api",
      metadata: { name: "scopedApi" },
      catches: [{ status: 418, when: { __tagged: true, engine: "cel", source: "error.code == 'BOGUS'" } }],
      routes: [{ handler: { kind: "std.Script", name: "throwsNotFound" } }],
    },
  ],
  steps: [],
} as unknown as ResourceManifest;

describe("scoped catch-list diagnostics", () => {
  it("routes through the owner and anchors at the declaration's own path", () => {
    const diagnostics = new StaticAnalyzer().analyze(
      withSyntheticPositions([app, handlerDef, apiDef, seqDef, handler, seq]),
    );
    const undeclared = diagnostics.filter((d) => d.code === "UNDECLARED_THROW_CODE");

    expect(undeclared).toHaveLength(1);
    const data = undeclared[0]!.data as {
      resource?: { kind: string; name: string };
      path?: string;
    };
    // Routed through the owner, because position lookup finds top-level docs.
    expect(data.resource).toEqual({ kind: "std.Sequence", name: "seq" });
    // …at the path the declaration is written at inside that document. The
    // declaring field is `with`, NOT the `/steps` visibility pointer.
    expect(data.path).toBe("with[0].catches[0].when");
    // The message still names the resource whose list is wrong.
    expect(undeclared[0]!.message).toContain("BOGUS");
  });
});
