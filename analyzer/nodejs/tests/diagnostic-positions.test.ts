import type { ResourceManifest } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { StaticAnalyzer } from "../src/analyzer.js";
import { withSyntheticPositions } from "../src/with-synthetic-positions.js";

/** Smoke tests for diagnostic positioning:
 *  - Layer 1: ref diagnostics carry the concrete `[N]` path so position-index
 *    lookups by the IDE land on the offending array element, not the resource's
 *    first line.
 *  - Layer 2: diagnostics on inline-extracted (synthetic) manifests reroute
 *    back to the chain root and accumulate the path so they resolve against
 *    the parent doc's YAML positions. */

const userApp: ResourceManifest = {
  kind: "Telo.Application",
  metadata: { name: "test-app", version: "1.0.0" },
} as unknown as ResourceManifest;

const handlerImplDef: ResourceManifest = {
  kind: "Telo.Definition",
  metadata: { name: "Script", module: "std" },
  capability: "Telo.Invocable",
  schema: {
    type: "object",
    properties: {
      code: { type: "string" },
    },
  },
} as unknown as ResourceManifest;

/** A Telo.Definition with a routes-array whose entries each carry a handler
 *  ref slot — mirroring Http.Api.routes[].handler in the std lib. The ref
 *  targets the concrete `std/Script` kind to keep the fixture self-contained
 *  (no abstract/extends/import dance needed). */
const apiDef: ResourceManifest = {
  kind: "Telo.Definition",
  metadata: { name: "Api", module: "std" },
  capability: "Telo.Mount",
  schema: {
    type: "object",
    properties: {
      routes: {
        type: "array",
        items: {
          type: "object",
          properties: {
            path: { type: "string" },
            handler: {
              "x-telo-ref": "std#Script",
            },
          },
        },
      },
    },
  },
} as unknown as ResourceManifest;

const baseManifests = [userApp, handlerImplDef, apiDef];

describe("ref diagnostics — Layer 1 (concrete path threading)", () => {
  it("UNRESOLVED_REFERENCE carries the concrete [N] path, not the field-map wildcard", () => {
    const api: ResourceManifest = {
      kind: "std.Api",
      metadata: { name: "MyApi" },
      routes: [
        { path: "/a", handler: { kind: "std.Script", name: "Known" } },
        { path: "/b", handler: { kind: "std.Script", name: "DoesNotExist" } },
      ],
    } as unknown as ResourceManifest;

    const knownHandler: ResourceManifest = {
      kind: "std.Script",
      metadata: { name: "Known" },
      code: "noop",
    } as unknown as ResourceManifest;

    const diags = new StaticAnalyzer().analyze(withSyntheticPositions([...baseManifests, api, knownHandler]));
    const unresolved = diags.find((d) => d.code === "UNRESOLVED_REFERENCE");
    expect(unresolved).toBeDefined();
    expect((unresolved!.data as { path: string }).path).toBe("routes[1].handler");
    expect(unresolved!.message).toContain("routes[1].handler");
  });

});

describe("ref diagnostics — Layer 2 (synthetic origin rewriting)", () => {
  it("reroutes diagnostics from an inline-extracted child to the parent's doc + nested path", () => {
    // The handler is inline (no name) — Phase 2 extracts it as a synthetic
    // manifest. Any diagnostic on the synthetic should be rewritten to point
    // at the parent (MyApi) with the full path `routes[0].handler.<...>`.
    const inlineWithBadChild: ResourceManifest = {
      kind: "std.Api",
      metadata: { name: "MyApi" },
      routes: [
        {
          path: "/a",
          handler: {
            // Inline std.Script with a schema violation — `code` should be a string.
            kind: "std.Script",
            code: 42,
          },
        },
      ],
    } as unknown as ResourceManifest;

    const diags = new StaticAnalyzer().analyze(withSyntheticPositions([...baseManifests, inlineWithBadChild]));
    const schemaViolation = diags.find((d) => d.code === "SCHEMA_VIOLATION");
    expect(schemaViolation).toBeDefined();

    const data = schemaViolation!.data as { resource?: { kind?: string; name?: string }; path?: string };
    // Rerouted: data.resource now points at the parent doc, not the synthetic.
    expect(data.resource).toEqual({ kind: "std.Api", name: "MyApi" });
    // Path is prefixed with the parent-relative location of the inline.
    expect(data.path).toMatch(/^routes\[0\]\.handler\./);
  });
});
