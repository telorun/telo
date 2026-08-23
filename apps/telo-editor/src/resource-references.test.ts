import { AnalysisRegistry } from "@telorun/analyzer";
import type { ResourceDefinition } from "@telorun/sdk";
import { makeTaggedSentinel } from "@telorun/templating";
import { describe, expect, it } from "vitest";
import type { ApplicationManifest } from "./model";
import { findResourceReferences } from "./resource-references";

function definition(
  name: string,
  capability: string,
  properties: Record<string, unknown> = {},
): ResourceDefinition {
  return {
    kind: "Telo.Definition",
    metadata: { name, module: "demo" },
    capability,
    schema: { type: "object", properties },
  } as unknown as ResourceDefinition;
}

/** A query holding a `!ref` to a connection, and a handler reading the same
 *  connection through CEL — the two ways a provider is reached. */
function workspace(resources: ApplicationManifest["resources"]): {
  registry: AnalysisRegistry;
  manifest: ApplicationManifest;
} {
  const registry = new AnalysisRegistry();
  registry.registerModuleIdentity("std", "demo");
  registry.registerDefinition(
    definition("Query", "Telo.Invocable", {
      connection: { "x-telo-ref": "std/demo#Conn" },
      sql: { type: "string" },
    }),
  );
  registry.registerDefinition(definition("Conn", "Telo.Provider"));

  const manifest: ApplicationManifest = {
    kind: "Application",
    filePath: "/app/telo.yaml",
    metadata: { name: "app" },
    imports: [],
    targets: [],
    resources,
  };
  return { registry, manifest };
}

const cel = (source: string) => makeTaggedSentinel("cel", source);

describe("findResourceReferences", () => {
  it("finds a reference slot naming the resource", () => {
    const { registry, manifest } = workspace([
      { kind: "demo.Conn", name: "db", fields: {} },
      {
        kind: "demo.Query",
        name: "listUsers",
        fields: { connection: { kind: "demo.Conn", name: "db" } },
      },
    ]);

    expect(findResourceReferences(registry, manifest, "db")).toEqual([
      { via: "ref", source: { kind: "demo.Query", name: "listUsers" }, path: "connection" },
    ]);
  });

  it("finds a CEL read, which is the only way a provider is usually reached", () => {
    const { registry, manifest } = workspace([
      { kind: "demo.Conn", name: "db", fields: {} },
      {
        kind: "demo.Query",
        name: "listUsers",
        fields: { sql: cel("'select from ' + resources.db.schema") },
      },
    ]);

    expect(findResourceReferences(registry, manifest, "db")).toEqual([
      { via: "cel", source: { kind: "demo.Query", name: "listUsers" }, path: "sql" },
    ]);
  });

  it("reports a boot target, since the module root is walked like any resource", () => {
    const { registry, manifest } = workspace([{ kind: "demo.Query", name: "listUsers", fields: {} }]);
    manifest.targets = ["listUsers"];

    expect(findResourceReferences(registry, manifest, "listUsers")).toEqual([
      { via: "ref", source: { kind: "Telo.Application", name: "app" }, path: "targets[0]" },
    ]);
  });

  it("ignores a resource's own references to itself", () => {
    // The field holding it goes away with the resource being deleted, so
    // reporting it would say "delete this before deleting this".
    const { registry, manifest } = workspace([
      {
        kind: "demo.Query",
        name: "loop",
        fields: { sql: cel("resources.loop.sql") },
      },
    ]);

    expect(findResourceReferences(registry, manifest, "loop")).toEqual([]);
  });

  it("does not read a name out of a string literal", () => {
    // Parsed, not matched as text: refusing a delete over a quoted word would
    // be a wall with no way through.
    const { registry, manifest } = workspace([
      { kind: "demo.Conn", name: "db", fields: {} },
      { kind: "demo.Query", name: "listUsers", fields: { sql: cel("'resources.db'") } },
    ]);

    expect(findResourceReferences(registry, manifest, "db")).toEqual([]);
  });

  it("skips an expression that does not parse rather than failing the check", () => {
    const { registry, manifest } = workspace([
      { kind: "demo.Conn", name: "db", fields: {} },
      { kind: "demo.Query", name: "listUsers", fields: { sql: cel("resources.db +") } },
    ]);

    expect(findResourceReferences(registry, manifest, "db")).toEqual([]);
  });

  it("reports nothing for a resource nothing names — the delete goes straight through", () => {
    const { registry, manifest } = workspace([
      { kind: "demo.Conn", name: "db", fields: {} },
      { kind: "demo.Query", name: "listUsers", fields: {} },
    ]);

    expect(findResourceReferences(registry, manifest, "db")).toEqual([]);
  });
});
