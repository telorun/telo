import type { ResourceManifest } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { StaticAnalyzer } from "../src/analyzer.js";
import { AnalysisRegistry } from "../src/analysis-registry.js";
import { effectiveAuthorSchema } from "../src/extends-resolution.js";
import { withSyntheticPositions } from "../src/with-synthetic-positions.js";

/**
 * `extends` aliases are lexically scoped to the DECLARING module: a library
 * writes `extends: Cache.Store` against its own import map, and `Self.Host`
 * against its own module name. The global alias table knows neither.
 *
 * `resolverForDefinition` exists so callers outside the analyzer — the kernel's
 * build-time validator warm — can resolve a definition's parent the same way
 * the runtime does. Resolving through one global scope instead silently yields
 * the UN-merged schema, and the warm then bakes a schema the runtime never asks
 * for (observed as `CacheMemory.Store` and `Shell.LocalHost` recompiling their
 * validators on every boot).
 */

const CACHE_LIB: ResourceManifest[] = [
  {
    kind: "Telo.Library",
    metadata: { name: "cache", namespace: "std", version: "0.1.0" },
    exports: { kinds: ["Store"] },
  },
  {
    kind: "Telo.Abstract",
    metadata: { name: "Store", module: "cache" },
    capability: "Telo.Provider",
    schema: { type: "object", properties: { ttl: { type: "integer" } } },
  },
] as unknown as ResourceManifest[];

// Extends an imported kind through ITS OWN alias (`Cache`), which the importing
// root never declares. The alias lands in `aliasesByModule` keyed by the
// IMPORTING module (`metadata.module`), which is what makes it module-scoped.
const CACHE_MEMORY_LIB: ResourceManifest[] = [
  {
    kind: "Telo.Library",
    metadata: { name: "cache-memory", namespace: "std", version: "0.1.0" },
    exports: { kinds: ["Store"] },
  },
  {
    kind: "Telo.Import",
    metadata: {
      name: "Cache",
      module: "cache-memory",
      resolvedModuleName: "cache",
      resolvedNamespace: "std",
    },
    source: "../cache",
  },
  {
    kind: "Telo.Definition",
    metadata: { name: "Store", module: "cache-memory" },
    capability: "Telo.Provider",
    extends: "Cache.Store",
    controllers: ["pkg:npm/x@0.0.0#store"],
    schema: {
      type: "object",
      additionalProperties: false,
      properties: { maxEntries: { type: "integer" } },
    },
  },
] as unknown as ResourceManifest[];

// Extends a same-library kind via the auto-registered `Self` alias.
const SHELL_LIB: ResourceManifest[] = [
  {
    kind: "Telo.Library",
    metadata: { name: "shell", namespace: "std", version: "0.1.0" },
    exports: { kinds: ["Host", "LocalHost"] },
  },
  {
    kind: "Telo.Abstract",
    metadata: { name: "Host", module: "shell" },
    capability: "Telo.Provider",
    schema: { type: "object", properties: { shell: { type: "string" } } },
  },
  {
    kind: "Telo.Definition",
    metadata: { name: "LocalHost", module: "shell" },
    capability: "Telo.Provider",
    extends: "Self.Host",
    controllers: ["pkg:npm/x@0.0.0#local"],
    schema: {
      type: "object",
      additionalProperties: false,
      properties: { cwd: { type: "string" } },
    },
  },
] as unknown as ResourceManifest[];

// The root imports cache-memory and shell — but NOT `cache`, so the alias
// `Cache` exists only inside cache-memory's own scope. Root-owned imports carry
// no `metadata.module`, which is what puts them in the global alias table.
const ROOT: ResourceManifest[] = [
  {
    kind: "Telo.Application",
    metadata: { name: "app", version: "1.0.0" },
  },
  {
    kind: "Telo.Import",
    metadata: {
      name: "CacheMemory",
      resolvedModuleName: "cache-memory",
      resolvedNamespace: "std",
    },
    source: "../cache-memory",
  },
  {
    kind: "Telo.Import",
    metadata: { name: "Shell", resolvedModuleName: "shell", resolvedNamespace: "std" },
    source: "../shell",
  },
] as unknown as ResourceManifest[];

function analyzed(): AnalysisRegistry {
  const registry = new AnalysisRegistry();
  const manifests = withSyntheticPositions([
    ...ROOT,
    ...CACHE_LIB,
    ...CACHE_MEMORY_LIB,
    ...SHELL_LIB,
  ] as ResourceManifest[]);
  new StaticAnalyzer().analyzeErrors(manifests, {}, registry);
  return registry;
}

const defFor = (module: string, name: string) =>
  ({ metadata: { module, name } }) as never;

describe("AnalysisRegistry.resolverForDefinition", () => {
  it("resolves a cross-module alias declared only in the defining library", () => {
    const registry = analyzed();
    const child = registry.resolveDefinition("cache-memory.Store");
    expect(child).toBeDefined();

    const resolve = registry.resolverForDefinition(child as never);
    expect(resolve("Cache.Store")).toBeDefined();
  });

  it("resolves the auto-registered Self alias against the declaring module", () => {
    const registry = analyzed();
    const child = registry.resolveDefinition("shell.LocalHost");
    const resolve = registry.resolverForDefinition(child as never);
    expect(resolve("Self.Host")).toBeDefined();
  });

  it("merges the parent's properties into the child's author schema", () => {
    const registry = analyzed();
    const child = registry.resolveDefinition("cache-memory.Store");
    const merged = effectiveAuthorSchema(
      child as never,
      registry.resolverForDefinition(child as never),
    );
    // Own field plus the inherited one — the shape the runtime validates against.
    expect(Object.keys(merged.properties ?? {}).sort()).toEqual(["maxEntries", "ttl"]);
  });

  it("still resolves canonical kinds when the definition carries no module", () => {
    const registry = analyzed();
    const resolve = registry.resolverForDefinition({ metadata: {} });
    expect(resolve("cache.Store")).toBeDefined();
  });

  it("returns undefined for an unknown kind rather than throwing", () => {
    const registry = analyzed();
    const resolve = registry.resolverForDefinition(defFor("nope", "Whatever"));
    expect(resolve("Nope.Missing")).toBeUndefined();
  });
});
