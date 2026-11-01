import type { ResourceDefinition } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { DefinitionRegistry } from "../src/definition-registry.js";

function definition(module: string, name: string, extra: Record<string, unknown>): ResourceDefinition {
  return {
    kind: "Telo.Definition",
    metadata: { name, module },
    schema: { type: "object" },
    ...extra,
  } as unknown as ResourceDefinition;
}

describe("DefinitionRegistry.getByExtends", () => {
  it("returns a kind once when it is reached through its parent and through the role it plays", () => {
    const registry = new DefinitionRegistry();
    registry.register(definition("Sql", "Schema", { capability: "Telo.Runnable" }));
    registry.register(
      definition("SQLite", "Schema", { capability: "Telo.Runnable", extends: "Sql.Schema" }),
    );

    const names = registry.getByExtends("Telo.Runnable").map((d) => `${d.metadata.module}.${d.metadata.name}`);

    expect(names.sort()).toEqual(["SQLite.Schema", "Sql.Schema"]);
  });
});
