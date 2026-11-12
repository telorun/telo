import type { ResourceDefinition } from "@telorun/sdk";
import { AnalysisRegistry } from "@telorun/analyzer";
import { describe, expect, it } from "vitest";
import { buildCompletions } from "../src/completions/build.js";
import { buildHover } from "../src/hover/build-hover.js";

/** An instance of a kind that extends another without `base:` and declares no
 *  schema of its own is written against its parent's fields. */
function buildRegistry(): AnalysisRegistry {
  const registry = new AnalysisRegistry();
  registry.registerImport("Test", "test-module", ["Server", "Alias"]);
  registry.registerDefinition({
    kind: "Telo.Definition",
    metadata: { name: "Server", module: "test-module" },
    capability: "Telo.Service",
    schema: {
      type: "object",
      properties: { host: { type: "string", description: "Hostname to bind." } },
    },
  } as unknown as ResourceDefinition);
  registry.registerDefinition({
    kind: "Telo.Definition",
    metadata: { name: "Alias", module: "test-module" },
    extends: "test-module.Server",
  } as unknown as ResourceDefinition);
  return registry;
}

describe("an instance of an empty merge-form child", () => {
  it("completes its parent's fields", async () => {
    const text = ["kind: Test.Alias", "metadata:", "  name: alias", ""].join("\n");
    const labels = (await buildCompletions(text, 3, 0, buildRegistry())).map((item) => item.label);
    expect(labels).toContain("host");
  });

  it("hovers its parent's fields", () => {
    const text = ["kind: Test.Alias", "metadata:", "  name: alias", "host: example.com"].join("\n");
    const hover = buildHover(text, 3, 1, buildRegistry());
    expect(hover?.contents).toContain("Hostname to bind.");
  });
});
