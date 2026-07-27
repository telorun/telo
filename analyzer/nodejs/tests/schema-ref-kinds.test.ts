import type { ResourceManifest } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { AliasResolver } from "../src/alias-resolver.js";
import { StaticAnalyzer } from "../src/analyzer.js";
import { resolveSchemaRefKinds } from "../src/resolve-schema-ref-kinds.js";
import { withSyntheticPositions } from "../src/with-synthetic-positions.js";

describe("resolveSchemaRefKinds", () => {
  function scope(): AliasResolver {
    const r = new AliasResolver();
    r.registerImport("KvStore", "kv-store");
    r.registerUngatedAlias("Self", "record-stream");
    r.registerImport("Gated", "gated-lib", ["Other"]);
    return r;
  }

  it("canonicalizes alias-form constraints anywhere in the doc", () => {
    const def = {
      kind: "Telo.Definition",
      metadata: { name: "Once", module: "idempotency" },
      schema: {
        properties: { store: { "x-telo-ref": "KvStore.Store" } },
        $defs: { Nested: { "x-telo-ref": "Self.Journal" } },
      },
      inputType: { properties: { sink: { "x-telo-ref": "Self.Journal" } } },
    } as unknown as ResourceManifest;

    expect(resolveSchemaRefKinds(def, scope())).toEqual([]);
    const d = def as unknown as Record<string, any>;
    expect(d.schema.properties.store["x-telo-ref"]).toBe("kv-store.Store");
    expect(d.schema.$defs.Nested["x-telo-ref"]).toBe("record-stream.Journal");
    expect(d.inputType.properties.sink["x-telo-ref"]).toBe("record-stream.Journal");
  });

  it("reports an unresolvable prefix with the slot path", () => {
    const def = {
      kind: "Telo.Definition",
      metadata: { name: "Once", module: "idempotency" },
      schema: { properties: { store: { "x-telo-ref": "KvStroe.Store" } } },
    } as unknown as ResourceManifest;

    const issues = resolveSchemaRefKinds(def, scope());
    expect(issues).toHaveLength(1);
    expect(issues[0].reason).toBe("unknown");
    expect(issues[0].path).toBe("schema.properties.store");
    expect(issues[0].knownAliases).toContain("KvStore");
    // Left as authored, so the diagnostic quotes what the author wrote.
    expect((def as unknown as Record<string, any>).schema.properties.store["x-telo-ref"]).toBe(
      "KvStroe.Store",
    );
  });

  it("distinguishes a gated kind from an unknown alias", () => {
    const def = {
      kind: "Telo.Definition",
      metadata: { name: "Once", module: "idempotency" },
      schema: { properties: { store: { "x-telo-ref": "Gated.Store" } } },
    } as unknown as ResourceManifest;

    const issues = resolveSchemaRefKinds(def, scope());
    expect(issues).toHaveLength(1);
    expect(issues[0].reason).toBe("gated");
    expect(issues[0].gate).toEqual({ module: "gated-lib", exported: ["Other"] });
  });

  it("reports the legacy identity form and leaves it intact for the identity table", () => {
    const def = {
      kind: "Telo.Definition",
      metadata: { name: "Once", module: "idempotency" },
      schema: { properties: { store: { "x-telo-ref": "std/kv-store#Store" } } },
    } as unknown as ResourceManifest;

    const issues = resolveSchemaRefKinds(def, scope());
    expect(issues).toHaveLength(1);
    expect(issues[0].reason).toBe("legacy");
    expect(issues[0].path).toBe("schema.properties.store");
    expect((def as unknown as Record<string, any>).schema.properties.store["x-telo-ref"]).toBe(
      "std/kv-store#Store",
    );
  });
});

/** A library declaring an abstract plus a definition whose ref slot pins it,
 *  named through the alias the DECLARING file itself uses. */
function libraryManifests(refConstraint: string, namespace?: string): ResourceManifest[] {
  return [
    {
      kind: "Telo.Application",
      metadata: { name: "App", version: "1.0.0" },
    },
    {
      kind: "Telo.Import",
      metadata: { name: "Store", resolvedModuleName: "kv-store", module: "App" },
      source: "./kv-store",
    },
    {
      kind: "Telo.Library",
      metadata: { name: "kv-store", ...(namespace ? { namespace } : {}) },
      exports: { kinds: ["Store"] },
    },
    {
      kind: "Telo.Abstract",
      metadata: { name: "Store", module: "kv-store" },
      capability: "Telo.Provider",
    },
    {
      kind: "Telo.Definition",
      metadata: { name: "Once", module: "App" },
      capability: "Telo.Invocable",
      schema: {
        type: "object",
        properties: { store: { "x-telo-ref": refConstraint } },
      },
    },
  ] as unknown as ResourceManifest[];
}

describe("x-telo-ref forms through analyze()", () => {
  it("accepts the alias form without diagnostics", () => {
    const diagnostics = new StaticAnalyzer().analyze(
      withSyntheticPositions(libraryManifests("Store.Store")),
    );
    expect(diagnostics.filter((d) => d.code.startsWith("X_TELO_REF"))).toEqual([]);
  });

  it("is idempotent — re-analyzing rewritten manifests reports nothing new", () => {
    const manifests = withSyntheticPositions(libraryManifests("Store.Store"));
    new StaticAnalyzer().analyze(manifests);
    // Second pass sees the canonical `kv-store.Store`, whose prefix is a module
    // name rather than an alias. The registry check is what keeps that quiet.
    const diagnostics = new StaticAnalyzer().analyze(manifests);
    expect(diagnostics.filter((d) => d.code.startsWith("X_TELO_REF"))).toEqual([]);
  });

  it("rejects a typo'd alias instead of silently un-checking the slot", () => {
    const diagnostics = new StaticAnalyzer().analyze(
      withSyntheticPositions(libraryManifests("Stroe.Store")),
    );
    const unresolved = diagnostics.filter((d) => d.code === "X_TELO_REF_UNRESOLVED");
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0].severity).toBe(1); // Error
    expect(unresolved[0].message).toContain("Stroe.Store");
    expect(unresolved[0].message).toContain("schema.properties.store");
  });

  it("warns on the legacy identity form but still resolves it", () => {
    const diagnostics = new StaticAnalyzer().analyze(
      withSyntheticPositions(libraryManifests("std/kv-store#Store", "std")),
    );
    const legacy = diagnostics.filter((d) => d.code === "X_TELO_REF_LEGACY_IDENTITY");
    expect(legacy).toHaveLength(1);
    expect(legacy[0].message).toContain("std/kv-store#Store");
    expect(legacy[0].data?.path).toBe("schema.properties.store");
    // Resolution still succeeds, so no reference diagnostic piles on top.
    expect(diagnostics.filter((d) => d.code === "REFERENCE_KIND_MISMATCH")).toEqual([]);
  });

  it("stays silent about a legacy constraint inside an imported library", () => {
    // The consumer cannot edit a published dependency's manifest, so warning
    // about its ref form would be pure noise on every `telo check`.
    const manifests = libraryManifests("Store.Store", "std");
    (manifests[4].metadata as { module?: string }).module = "kv-store";
    (manifests[4] as unknown as Record<string, any>).schema.properties.store["x-telo-ref"] =
      "std/kv-store#Store";
    // `flattenForAnalyzer` forwards an imported library's definitions but not its
    // module doc, so `kv-store` is not one of the entry's own modules.
    const forwarded = manifests.filter((m) => m.kind !== "Telo.Library");

    const diagnostics = new StaticAnalyzer().analyze(withSyntheticPositions(forwarded));
    expect(diagnostics.filter((d) => d.code === "X_TELO_REF_LEGACY_IDENTITY")).toEqual([]);
  });
});
