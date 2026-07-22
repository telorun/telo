import type { ResourceDefinition } from "@telorun/sdk";
import { AnalysisRegistry } from "@telorun/analyzer";
import { describe, expect, it } from "vitest";
import { buildSemanticTokens } from "../src/semantic-tokens/build-semantic-tokens.js";

function buildRegistry(): AnalysisRegistry {
  const registry = new AnalysisRegistry();
  registry.registerModuleIdentity("std", "test-module");
  registry.registerImport("Test", "test-module", ["Sequence"]);
  registry.registerDefinition({
    kind: "Telo.Definition",
    metadata: { name: "Sequence", module: "test-module" },
    capability: "Telo.Runnable",
    schema: { type: "object" },
  } as unknown as ResourceDefinition);
  return registry;
}

describe("buildSemanticTokens", () => {
  const registry = buildRegistry();

  it("marks a resolved kind value as a type token", () => {
    const text = ["kind: Test.Sequence", "metadata:", "  name: seq"].join("\n");
    const tokens = buildSemanticTokens(text, registry);
    const type = tokens.find((t) => t.type === "type");
    expect(type).toBeDefined();
    // Value begins after "kind: " on line 0.
    expect(type).toMatchObject({ line: 0, character: 6, length: "Test.Sequence".length });
  });

  it("marks a capability value as an interface token", () => {
    const text = ["kind: Telo.Definition", "metadata:", "  name: Thing", "capability: Telo.Service"].join("\n");
    const tokens = buildSemanticTokens(text, registry);
    expect(tokens.some((t) => t.type === "interface")).toBe(true);
  });

  it("emits no token for an unresolved kind", () => {
    const text = ["kind: Nope.Missing", "metadata:", "  name: x"].join("\n");
    const tokens = buildSemanticTokens(text, registry);
    expect(tokens).toHaveLength(0);
  });

  it("marks !ref targets as variable tokens, in map slots and seq items", () => {
    const text = ["kind: Test.Sequence", "connection: !ref Db", "targets:", "  - !ref A.b"].join("\n");
    const tokens = buildSemanticTokens(text, registry);
    const refs = tokens.filter((t) => t.type === "variable");
    expect(refs).toHaveLength(2);
    // `Db` starts at column 17 on line 1; `A.b` at column 9 on line 3 (after `  - !ref `).
    expect(refs).toContainEqual({ line: 1, character: 17, length: 2, type: "variable" });
    expect(refs).toContainEqual({ line: 3, character: 9, length: 3, type: "variable" });
  });
});
