import type { ResourceManifest } from "@telorun/sdk";
import { canonicalTypeSchemaId, parseTeloTypeRef } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { AliasResolver } from "../src/alias-resolver.js";
import { DefinitionRegistry } from "../src/definition-registry.js";
import { resolveSchemaTypeRefs } from "../src/resolve-schema-type-refs.js";
import { validateSchemaTypeRefs } from "../src/validate-schema-type-refs.js";

describe("parseTeloTypeRef", () => {
  it("parses authority/type form", () => {
    expect(parseTeloTypeRef("telo://Self/MetadataFilter")).toEqual({
      authority: "Self",
      typeName: "MetadataFilter",
    });
    expect(parseTeloTypeRef("telo://vector-store/MetadataFilter")).toEqual({
      authority: "vector-store",
      typeName: "MetadataFilter",
    });
  });

  it("ignores fragment-bearing built-ins and non-telo refs", () => {
    expect(parseTeloTypeRef("telo://manifest#/$defs/ResourceRef")).toBeNull();
    expect(parseTeloTypeRef("#/$defs/Filter")).toBeNull();
    expect(parseTeloTypeRef("Entity")).toBeNull();
    expect(parseTeloTypeRef(42)).toBeNull();
  });
});

describe("resolveSchemaTypeRefs", () => {
  function defWithFilterRef(module: string, ref: string): ResourceManifest {
    return {
      kind: "Match",
      metadata: { name: "Search", module },
      inputType: {
        kind: "Type.JsonSchema",
        schema: { properties: { metadataFilter: { $ref: ref } } },
      },
    } as unknown as ResourceManifest;
  }

  const refOf = (m: ResourceManifest): unknown =>
    ((m as any).inputType.schema.properties.metadataFilter as { $ref: unknown }).$ref;

  it("rewrites Self to the owning module's canonical id", () => {
    const m = defWithFilterRef("vector-store", "telo://Self/MetadataFilter");
    resolveSchemaTypeRefs([m]);
    expect(refOf(m)).toBe(canonicalTypeSchemaId("vector-store", "MetadataFilter"));
  });

  it("rewrites an import alias to the imported module's canonical id", () => {
    const aliases = new AliasResolver();
    aliases.registerImport("VectorStore", "vector-store", []);
    const m = defWithFilterRef("consumer", "telo://VectorStore/MetadataFilter");
    resolveSchemaTypeRefs([m], undefined, new Map([["consumer", aliases]]));
    expect(refOf(m)).toBe(canonicalTypeSchemaId("vector-store", "MetadataFilter"));
  });

  it("leaves an unresolvable authority and non-type refs untouched", () => {
    const unknown = defWithFilterRef("vector-store", "telo://Nope/MetadataFilter");
    const builtin = defWithFilterRef("vector-store", "telo://manifest#/$defs/ResourceRef");
    resolveSchemaTypeRefs([unknown, builtin]);
    expect(refOf(unknown)).toBe("telo://Nope/MetadataFilter");
    expect(refOf(builtin)).toBe("telo://manifest#/$defs/ResourceRef");
  });
});

describe("validateSchemaTypeRefs", () => {
  function setup(ref: string, opts?: { module?: string; rootModules?: string[] }) {
    const ownModule = opts?.module ?? "app";
    const registry = new DefinitionRegistry();
    // A locally-declared type and one reachable through an import alias.
    registry.registerNamedTypeSchema(canonicalTypeSchemaId(ownModule, "Filter"), { type: "object" });
    registry.registerNamedTypeSchema(canonicalTypeSchemaId("other", "Filter"), { type: "object" });
    const aliases = new AliasResolver();
    aliases.registerImport("Other", "other", []);
    const m = {
      kind: "Match",
      metadata: { name: "Search", module: ownModule },
      inputType: { schema: { properties: { f: { $ref: ref } } } },
    } as unknown as ResourceManifest;
    return validateSchemaTypeRefs(
      [m],
      registry,
      aliases,
      new Map([[ownModule, aliases]]),
      new Set(opts?.rootModules ?? [ownModule]),
    );
  }

  it("accepts a Self ref to a declared type", () => {
    expect(setup("telo://Self/Filter")).toHaveLength(0);
  });

  it("accepts an alias ref to an imported type", () => {
    expect(setup("telo://Other/Filter")).toHaveLength(0);
  });

  it("flags an unknown type with SCHEMA_TYPE_REF_UNRESOLVED", () => {
    const diags = setup("telo://Self/Missing");
    expect(diags).toHaveLength(1);
    expect(diags[0].code).toBe("SCHEMA_TYPE_REF_UNRESOLVED");
    expect(diags[0].data?.path).toBe("inputType/schema/properties/f/$ref");
  });

  it("flags an undeclared authority with SCHEMA_TYPE_REF_UNKNOWN_ALIAS", () => {
    const diags = setup("telo://Nope/Filter");
    expect(diags).toHaveLength(1);
    expect(diags[0].code).toBe("SCHEMA_TYPE_REF_UNKNOWN_ALIAS");
  });

  it("skips refs in imported (non-root) modules", () => {
    // Validated against their own library, not the consuming root.
    expect(setup("telo://Self/Missing", { rootModules: ["root"] })).toHaveLength(0);
  });
});
