import type { ResourceDefinition } from "@telorun/sdk";
import { AnalysisRegistry } from "@telorun/analyzer";
import { describe, expect, it } from "vitest";
import { buildHover } from "../src/hover/build-hover.js";

/** Drives `buildHover` end-to-end: kind values render module/capability/desc,
 *  field keys render the schema field's description, and structural root keys
 *  fall back to built-in docs. */

function buildRegistry(): AnalysisRegistry {
  const registry = new AnalysisRegistry();
  registry.registerModuleIdentity("std", "test-module");
  registry.registerImport("Test", "test-module", ["Sequence"]);

  const sequenceDef: ResourceDefinition = {
    kind: "Telo.Definition",
    metadata: { name: "Sequence", module: "test-module" },
    capability: "Telo.Runnable",
    schema: {
      type: "object",
      title: "An ordered run of steps.",
      properties: {
        host: { type: "string", description: "Hostname to bind." },
        mode: { type: "string", enum: ["fast", "safe"], default: "safe" },
      },
    },
  } as unknown as ResourceDefinition;

  registry.registerDefinition(sequenceDef);
  return registry;
}

/** Line/character at the middle of the first occurrence of `needle` — a
 *  realistic hover position (inside the token, not on its boundary). */
function at(text: string, needle: string): { line: number; character: number } {
  const idx = text.indexOf(needle) + Math.floor(needle.length / 2);
  const before = text.slice(0, idx);
  const line = before.split("\n").length - 1;
  const character = idx - (before.lastIndexOf("\n") + 1);
  return { line, character };
}

describe("buildHover", () => {
  const registry = buildRegistry();

  it("renders kind info on a kind value", () => {
    const text = ["kind: Test.Sequence", "metadata:", "  name: seq"].join("\n");
    const pos = at(text, "Test.Sequence");
    const hover = buildHover(text, pos.line, pos.character, registry);
    expect(hover?.contents).toContain("Test.Sequence");
    expect(hover?.contents).toContain("Telo.Runnable");
    expect(hover?.contents).toContain("An ordered run of steps.");
  });

  it("renders a field description on a prop key", () => {
    const text = ["kind: Test.Sequence", "metadata:", "  name: seq", "host: example.com"].join("\n");
    const pos = at(text, "host");
    const hover = buildHover(text, pos.line, pos.character, registry);
    expect(hover?.contents).toContain("Hostname to bind.");
    expect(hover?.contents).toContain("string");
  });

  it("renders enum + default on a field value", () => {
    const text = ["kind: Test.Sequence", "metadata:", "  name: seq", "mode: safe"].join("\n");
    const pos = at(text, "safe");
    const hover = buildHover(text, pos.line, pos.character, registry);
    expect(hover?.contents).toContain("`fast`");
    expect(hover?.contents).toContain("Default:");
  });

  it("falls back to structural docs for a root key with no schema", () => {
    const text = ["kind: Test.Sequence", "imports:", "  Foo: std/foo@1.0.0"].join("\n");
    const pos = at(text, "imports");
    const hover = buildHover(text, pos.line, pos.character, registry);
    expect(hover?.contents).toContain("Dependency map");
  });

  it("renders capability docs on a capability value", () => {
    const text = ["kind: Telo.Definition", "metadata:", "  name: Thing", "capability: Telo.Service"].join("\n");
    const pos = at(text, "Telo.Service");
    const hover = buildHover(text, pos.line, pos.character, registry);
    expect(hover?.contents).toContain("Long-lived");
  });

  it("returns undefined off any known symbol", () => {
    const text = ["kind: Test.Sequence", "metadata:", "  name: seq"].join("\n");
    const pos = at(text, "seq");
    // `name` under metadata has no schema field and isn't a structural root key.
    expect(buildHover(text, pos.line, pos.character, registry)).toBeUndefined();
  });
});
