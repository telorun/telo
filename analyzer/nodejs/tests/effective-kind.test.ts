import { canonicalTypeSchemaId, type ResourceDefinition } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { BUILTIN_DOCUMENT_FILES } from "../src/builtin-entries/index.js";
import { builtinDefinitions } from "../src/builtins.js";
import { DefinitionRegistry } from "../src/definition-registry.js";

/** What a kind means along `extends` is the registry's answer; a definition
 *  stays as its author wrote it. */
function definition(name: string, extra: Record<string, unknown>): ResourceDefinition {
  return { kind: "Telo.Definition", metadata: { name, module: "Lib" }, ...extra } as unknown as ResourceDefinition;
}

const PARENT = definition("Server", {
  capability: "Telo.Service",
  schema: {
    type: "object",
    required: ["port"],
    properties: { port: { type: "integer" } },
  },
});

describe("the effective kind", () => {
  it("is the same object until a registration changes what it is built from", () => {
    const registry = new DefinitionRegistry();
    registry.register(PARENT);
    registry.register(definition("Alias", { extends: "Lib.Server" }));
    const first = registry.effectiveKind("Lib.Alias")!;
    expect(first.schema?.properties).toEqual({ port: { type: "integer" } });
    expect(first.capability).toBe("Telo.Service");
    expect(registry.effectiveKind("Lib.Alias")).toBe(first);

    registry.register(
      definition("Server", {
        capability: "Telo.Service",
        schema: { type: "object", properties: { host: { type: "string" } } },
      }),
    );
    const second = registry.effectiveKind("Lib.Alias")!;
    expect(second).not.toBe(first);
    expect(second.schema?.properties).toEqual({ host: { type: "string" } });
  });

  it("is what a `$ref` to the child's id validates against, the parent's `required` included", () => {
    const registry = new DefinitionRegistry();
    // The child registers before its parent: its id is registered on lookup.
    registry.register(definition("Alias", { extends: "Lib.Server" }));
    registry.register(PARENT);
    const holder = { $ref: canonicalTypeSchemaId("Lib", "Alias") };
    expect(registry.validateWithRefs({}, holder)).not.toEqual([]);
    expect(registry.validateWithRefs({ port: 80 }, holder)).toEqual([]);
    // A replaced parent changes what the id addresses.
    registry.register(definition("Server", { capability: "Telo.Service", schema: { type: "object" } }));
    expect(registry.validateWithRefs({}, { $ref: canonicalTypeSchemaId("Lib", "Alias") })).toEqual([]);
  });
});

describe("the built-in definitions", () => {
  it("keep each child's schema as its own document holds it", () => {
    const all = builtinDefinitions(BUILTIN_DOCUMENT_FILES);
    const children = all.filter((def) => typeof def.extends === "string" && def.kind === "Telo.Definition");
    expect(children.length).toBeGreaterThan(0);
    for (const child of children) {
      const entry = BUILTIN_DOCUMENT_FILES.find(
        ([, data]) => (data as { metadata: { name: string } }).metadata.name === child.metadata.name,
      )!;
      expect(child.schema).toEqual(builtinDefinitions([entry])[0]!.schema);
    }
  });
});
