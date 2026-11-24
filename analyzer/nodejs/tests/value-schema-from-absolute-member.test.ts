import type { ResourceDefinition, ResourceManifest } from "@telorun/sdk";
import { makeTaggedSentinel } from "@telorun/templating";
import { describe, expect, it } from "vitest";
import { AnalysisRegistry } from "../src/analysis-registry.js";
import { StaticAnalyzer } from "../src/analyzer.js";
import type { AnalysisDiagnostic } from "../src/types.js";
import { resolveContractValueSchemas, type ValueSchemaHost } from "../src/value-schema-slot.js";
import { withSyntheticPositions } from "../src/with-synthetic-positions.js";

/**
 * `x-telo-value-schema-from: { from, member: "/<pointer>" }` — the member is
 * read from the declaration holding each type `from` reaches, so a value is held
 * to the property of a record type that a field of the same declaration names.
 */

const TYPE_FIELD = { "x-telo-ref": { kind: "Telo.Type", use: "schema" } };

/** A record set: its model, and the property identifying a record. */
const COLLECTION = {
  kind: "Telo.Definition",
  metadata: { name: "Collection", module: "test-fx" },
  capability: "Telo.Provider",
  schema: {
    type: "object",
    properties: { model: TYPE_FIELD, key: { type: "string", default: "id" } },
  },
} as unknown as ResourceDefinition;

const KEYED = { from: "/collection/model", member: "/key" };

/** Holds one record's key, typed by its collection's key property. */
const EDITOR = {
  kind: "Telo.Definition",
  metadata: { name: "Editor", module: "test-fx" },
  capability: "Telo.Provider",
  schema: {
    type: "object",
    properties: {
      collection: { "x-telo-ref": { kind: "test-fx.Collection", use: "schema" } },
      recordKey: { "x-telo-value-schema-from": KEYED },
    },
  },
} as unknown as ResourceDefinition;

/** Holds a key every collection it lists identifies records by. */
const MERGER = {
  kind: "Telo.Definition",
  metadata: { name: "Merger", module: "test-fx" },
  capability: "Telo.Provider",
  schema: {
    type: "object",
    properties: {
      collections: {
        type: "array",
        items: { "x-telo-ref": { kind: "test-fx.Collection", use: "schema" } },
      },
      recordKey: { "x-telo-value-schema-from": { from: "/collections/*/model", member: "/key" } },
    },
  },
} as unknown as ResourceDefinition;

const model = (properties: Record<string, unknown>) => ({
  kind: "Telo.JsonSchema",
  schema: { type: "object", properties },
});

const app = (name: string, kind: string, body: Record<string, unknown>): ResourceManifest =>
  ({ kind, metadata: { name, module: "app" }, ...body }) as unknown as ResourceManifest;

const ref = (name: string) => makeTaggedSentinel("ref", name);

function analyze(
  resources: ResourceManifest[],
  definitions: ResourceDefinition[] = [COLLECTION, EDITOR, MERGER],
): AnalysisDiagnostic[] {
  const registry = new AnalysisRegistry();
  registry.registerModuleIdentity("std", "test-fx");
  registry.registerModuleIdentity("std", "app");
  registry.registerImport("Fx", "test-fx", definitions.map((d) => d.metadata.name as string));
  for (const definition of definitions) registry.registerDefinition(definition);
  const root = { kind: "Telo.Application", metadata: { name: "App" } } as unknown as ResourceManifest;
  return new StaticAnalyzer().analyze(withSyntheticPositions([root, ...resources]), undefined, registry);
}

const paths = (diagnostics: AnalysisDiagnostic[], code: string) =>
  diagnostics.filter((d) => d.code === code).map((d) => d.data?.path);

const tasks = (key?: string) =>
  app("tasks", "Fx.Collection", {
    model: model({ id: { type: "integer" }, slug: { type: "string" } }),
    ...(key !== undefined ? { key } : {}),
  });

describe("an absolute member", () => {
  it("holds a literal to the property the holder's field names", () => {
    const editor = (recordKey: unknown) => app("edit", "Fx.Editor", { collection: ref("tasks"), recordKey });
    expect(paths(analyze([tasks("slug"), editor(7)]), "SCHEMA_VIOLATION")).toEqual(["recordKey"]);
    expect(paths(analyze([tasks("slug"), editor("seven")]), "SCHEMA_VIOLATION")).toEqual([]);
  });

  it("reads the default the holder's kind declares where the field is absent", () => {
    const editor = (recordKey: unknown) => app("edit", "Fx.Editor", { collection: ref("tasks"), recordKey });
    expect(paths(analyze([tasks(), editor("seven")]), "SCHEMA_VIOLATION")).toEqual(["recordKey"]);
    expect(paths(analyze([tasks(), editor(7)]), "SCHEMA_VIOLATION")).toEqual([]);
  });

  it("pairs each type a `*` reaches with the member its own holder names", () => {
    // Paired, both collections' keys are integers; crossed, each other's key
    // property is a boolean and no number would fit.
    const byId = app("byId", "Fx.Collection", {
      model: model({ id: { type: "integer" }, slug: { type: "boolean" } }),
    });
    const bySlug = app("bySlug", "Fx.Collection", {
      model: model({ id: { type: "boolean" }, slug: { type: "integer" } }),
      key: "slug",
    });
    const merger = (recordKey: unknown) =>
      app("merge", "Fx.Merger", { collections: [ref("byId"), ref("bySlug")], recordKey });
    expect(paths(analyze([byId, bySlug, merger(7)]), "SCHEMA_VIOLATION")).toEqual([]);
    // One finding per reached type, each refusing its own key's type.
    expect(paths(analyze([byId, bySlug, merger("seven")]), "SCHEMA_VIOLATION")).toEqual(["recordKey", "recordKey"]);
  });

  it("is refused at the kind where the kind a crossed slot names declares no string there", () => {
    const objectKeyed = {
      ...COLLECTION,
      metadata: { name: "Collection", module: "test-fx" },
      schema: { type: "object", properties: { model: TYPE_FIELD, key: { type: "object" } } },
    } as unknown as ResourceDefinition;
    const editor = { ...EDITOR, metadata: { name: "Editor", module: "App" } } as unknown as ResourceDefinition;
    const found = analyze([editor as unknown as ResourceManifest], [objectKeyed]).filter(
      (d) => d.code === "VALUE_SCHEMA_FROM_INVALID",
    );
    expect(found.map((d) => d.data?.path)).toEqual(["schema.properties.recordKey.x-telo-value-schema-from"]);
    expect(found[0]!.message).toContain("not declared a string in the schema of 'test-fx.Collection'");
    expect(
      analyze([editor as unknown as ResourceManifest], [COLLECTION]).filter((d) => d.code === "VALUE_SCHEMA_FROM_INVALID"),
    ).toEqual([]);
  });
});

describe("an absolute member inside a contract", () => {
  it("types the node as the property its holder names, carried with the type's document", () => {
    const host: ValueSchemaHost = {
      scope: { resolveDefinition: () => undefined, resolveManifest: () => undefined, referenceSlots: () => [] },
      typeSchemaOf: (value) => (value as { schema?: Record<string, any> }).schema,
    };
    const declaration = {
      key: "turnId",
      contextType: { kind: "Telo.JsonSchema", schema: { type: "object", properties: { turnId: { type: "string" } } } },
    };
    const contract = {
      type: "object",
      properties: { id: { "x-telo-value-schema-from": { from: "contextType", member: "/key" } } },
    };
    const resolved = resolveContractValueSchemas(contract, declaration, host) as Record<string, any>;
    expect(resolved.properties.id).toEqual({ allOf: [{ $ref: "#/$defs/telo:value-schema-from:0/properties/turnId" }] });
  });
});
