import { describe, expect, it } from "vitest";
import type { ResourceManifest } from "@telorun/sdk";
import { AnalysisRegistry } from "../src/analysis-registry.js";

/**
 * A running configuration's view answers a named shape from the shapes its own
 * expansion declares, and an invariant one from the shared registry; it
 * registers nothing.
 */
const library = { kind: "Telo.Library", metadata: { name: "Lib", module: "Lib" } } as ResourceManifest;

const result = (eval_: "compile" | "accessor"): ResourceManifest =>
  ({
    kind: "Telo.JsonSchema",
    metadata: { name: "Result", module: "Lib" },
    schema: { type: "object", properties: { at: { type: "string", "x-telo-eval": eval_ } } },
  }) as unknown as ResourceManifest;

describe("AnalysisRegistry.forConfiguration", () => {
  const registry = new AnalysisRegistry();
  const lib = registry.forModule("Lib");
  const shared = { type: "string" };
  registry._context().definitions!.registerNamedTypeSchema("telo:Lib/Plain", shared);

  it("reads a varying shape as each configuration's expansion declares it, and never registers it", () => {
    const compile = lib.forConfiguration([library, result("compile")]);
    const accessor = lib.forConfiguration([library, result("accessor")]);
    const at = (view: AnalysisRegistry) =>
      (view.shapeLookup("telo:Lib/Result") as { properties: { at: Record<string, unknown> } }).properties.at["x-telo-eval"];
    expect([at(compile), at(accessor)]).toEqual(["compile", "accessor"]);
    expect(registry.shapeLookup("telo:Lib/Result")).toBeUndefined();
  });

  it("answers an invariant shape from the shared registry", () => {
    const view = lib.forConfiguration([library, result("compile")]);
    expect(view.shapeLookup("telo:Lib/Plain")).toMatchObject(shared);
  });
});
