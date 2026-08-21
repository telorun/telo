import { AnalysisRegistry } from "@telorun/analyzer";
import type { ResourceDefinition } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { buildCompletions } from "../src/completions/build.js";

/**
 * Suggested keys and values, both open and closed.
 *
 * One rule in two positions: `propertyNames` says what a NAME-KEYED map's keys
 * may be, the field's own schema says what a VALUE may be, and in each position
 * `enum` closes the set while `examples` only suggests. Both are stock JSON
 * Schema, so nothing here knows what a media type is — a module declares its
 * own and any name-keyed field gains the behaviour by doing the same.
 */

const DEF: ResourceDefinition = {
  kind: "Telo.Definition",
  metadata: { name: "Api", module: "test-http" },
  capability: "Telo.Mount",
  schema: {
    type: "object",
    properties: {
      returns: {
        type: "array",
        items: {
          type: "object",
          properties: {
            mode: { type: "string", enum: ["buffer", "stream"] },
            status: { type: "integer", examples: [200, 404] },
            content: {
              type: "object",
              propertyNames: {
                type: "string",
                examples: ["application/json", "text/plain"],
              },
              additionalProperties: { type: "object", properties: { body: {} } },
            },
          },
        },
      },
    },
  },
} as unknown as ResourceDefinition;

function registry(): AnalysisRegistry {
  const r = new AnalysisRegistry();
  r.registerModuleIdentity("std", "test-http");
  r.registerImport("Http", "test-http", ["Api"]);
  r.registerDefinition(DEF);
  return r;
}

const HEAD = ["kind: Http.Api", "metadata:", "  name: api", "returns:", "  - content:"];

describe("suggested keys and values", () => {
  it("suggests a name-keyed map's known keys", async () => {
    const text = [...HEAD, "      "].join("\n");
    const results = await buildCompletions(text, 5, 6, registry());
    expect(results.map((r) => r.label)).toEqual(["application/json", "text/plain"]);
  });

  it("drops a key the author already wrote", async () => {
    const text = [...HEAD, "      application/json:", "        body: x", "      "].join("\n");
    const results = await buildCompletions(text, 7, 6, registry());
    expect(results.map((r) => r.label)).toEqual(["text/plain"]);
  });

  it("suggests a closed enum at a value slot", async () => {
    const text = ["kind: Http.Api", "metadata:", "  name: api", "returns:", "  - mode: "].join("\n");
    const results = await buildCompletions(text, 4, 10, registry());
    expect(results.map((r) => r.label)).toEqual(["buffer", "stream"]);
    expect(results[0].detail).toBe("allowed value");
  });

  it("suggests open examples at a value slot", async () => {
    const text = ["kind: Http.Api", "metadata:", "  name: api", "returns:", "  - status: "].join("\n");
    const results = await buildCompletions(text, 4, 12, registry());
    expect(results.map((r) => r.label)).toEqual(["200", "404"]);
    expect(results[0].detail).toBe("known value");
  });

  it("offers nothing at a value slot declaring neither", async () => {
    const text = ["kind: Http.Api", "metadata:", "  name: api", "returns:", "  - content:", "      application/json:", "        body: "].join("\n");
    expect(await buildCompletions(text, 6, 14, registry())).toEqual([]);
  });
});
