import { stampRefIdentity, type ResourceContext } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { create } from "../src/drafted-store.js";

/**
 * A drafted store records database time, so it needs a schema instance that
 * renders the current instant. One that only addresses tables — an engine
 * module from before the member — is refused by name when the store is
 * created, never given a clock of the store's own.
 */
describe("a drafted store over a schema that cannot render the current instant", () => {
  const declared: Record<string, Record<string, unknown>> = {
    team: {
      schema: { kind: "Old.Schema", name: "appSchema" },
      connection: { kind: "Old.Connection", name: "db" },
      layers: { kind: "Old.Table", name: "graphLayers" },
      drafts: { kind: "Old.Table", name: "graphDrafts" },
      nodes: [],
    },
    appSchema: {
      connection: { kind: "Old.Connection", name: "db" },
      tables: [
        { kind: "Old.Table", name: "graphLayers" },
        { kind: "Old.Table", name: "graphDrafts" },
      ],
    },
  };
  const ctx = {
    resolveRef: (value: unknown, guard: (candidate: unknown) => boolean, describeSlot: () => string) => {
      if (!guard(value)) throw new Error(`${describeSlot()} does not resolve`);
      return value;
    },
    resolveDeclaredManifest: (name: string) => declared[name],
  } as unknown as ResourceContext;

  const resource = (schema: object) => ({
    kind: "Layers.Store",
    metadata: { name: "team" },
    connection: { execute: async () => ({ rows: [] }), dialect: { quoteIdentifier: (n: string) => n } },
    schema,
    layer: "team",
    nodes: [],
    layers: {},
    drafts: {},
  });

  it("is refused at creation, naming the schema and its kind", async () => {
    const schema = { qualifiedTableName: () => "t" };
    stampRefIdentity(schema, "Old.Schema", "appSchema", { module: "file:///elsewhere" });
    await expect(create(resource(schema), ctx)).rejects.toThrow(
      /'schema' references 'appSchema' of kind 'Old\.Schema', whose engine module predates instant rendering/,
    );
  });
});
