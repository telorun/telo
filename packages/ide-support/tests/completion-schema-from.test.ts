import { AnalysisRegistry } from "@telorun/analyzer";
import type { ResourceDefinition } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { buildCompletions } from "../src/completions/build.js";
import { buildHover } from "../src/hover/build-hover.js";

/**
 * A slot whose shape comes from `x-telo-schema-from`.
 *
 * Such a slot declares NO `properties` of its own — an `Http.Api` route's
 * `request:` is exactly this — so a walk that reads `properties` finds an empty
 * node and offers nothing. That is silent: a whole field of the standard library
 * behaves like an unknown one, with no diagnostic anywhere to say why.
 */

const MATCHER: ResourceDefinition = {
  kind: "Telo.Definition",
  metadata: { name: "Request", module: "http-dispatch" },
  capability: "Telo.Type",
  schema: {
    type: "object",
    $defs: {
      Matcher: {
        type: "object",
        required: ["method", "path"],
        properties: {
          method: { type: "string", description: "HTTP method to match." },
          path: { type: "string" },
          schema: { type: "object" },
        },
      },
    },
  },
} as unknown as ResourceDefinition;

const API: ResourceDefinition = {
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
            request: {
              title: "Request",
              "x-telo-schema-from": "HttpDispatch.Request/$defs/Matcher",
            },
          },
        },
      },
    },
  },
} as unknown as ResourceDefinition;

function registry(): AnalysisRegistry {
  const r = new AnalysisRegistry();
  r.registerModuleIdentity("std", "http-dispatch");
  r.registerModuleIdentity("std", "http-server");
  r.registerImport("Http", "http-server", ["Api"]);
  r.registerImport("HttpDispatch", "http-dispatch", ["Request"]);
  r.registerDefinition(MATCHER);
  r.registerDefinition(API);
  return r;
}

const HEAD = ["kind: Http.Api", "metadata:", "  name: api", "routes:", "  - request:"];

describe("x-telo-schema-from slots", () => {
  it("completes the derived keys inside a sequence item", async () => {
    const text = [...HEAD, "      "].join("\n");
    const results = await buildCompletions(text, 5, 6, registry());
    expect(results.map((r) => r.label).sort()).toEqual(["method", "path", "schema"]);
  });

  it("excludes keys the author already wrote", async () => {
    const text = [...HEAD, "      path: /x", "      method: GET", "      "].join("\n");
    const results = await buildCompletions(text, 7, 6, registry());
    expect(results.map((r) => r.label)).toEqual(["schema"]);
  });

  it("marks the derived required keys", async () => {
    const text = [...HEAD, "      "].join("\n");
    const results = await buildCompletions(text, 5, 6, registry());
    expect(results.find((r) => r.label === "method")?.preselect).toBe(true);
    expect(results.find((r) => r.label === "schema")?.preselect).toBeUndefined();
  });

  it("hovers a derived key with the description its source declares", () => {
    const text = [...HEAD, "      method: GET"].join("\n");
    const hover = buildHover(text, 5, 8, registry());
    expect(hover?.contents).toContain("HTTP method to match.");
  });
});
