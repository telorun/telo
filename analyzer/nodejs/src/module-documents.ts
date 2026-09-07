import type { ResourceManifest } from "@telorun/sdk";

/**
 * One imported library's FULL document set — what the flattened analysis view
 * no longer holds, since it forwards only each library's export surface and
 * never its internal dispatch chain.
 *
 * Named for what it CARRIES rather than for who asked first: the zone stage's
 * per-library export derivation was the original consumer, and the throws walk
 * is the second — a third should not have to import "zone" to ask about
 * something else again.
 *
 * Plain data in a module of its own, deliberately. It is produced by the
 * loading side (`collectModuleDocuments`), named in `AnalysisOptions`, and
 * consumed by the projection; putting it in any of the three would make the
 * other two import that one, and `types.ts` ↔ the projection is a genuine
 * cycle. A leaf module with no imports of its own breaks it without an inline
 * `import(...)` type expression standing in for the dependency nobody wanted.
 */
export interface ModuleDocuments {
  /** The library's module name (its `Telo.Library` doc's `metadata.name`). */
  module: string;
  /** Stable source identity of the library's owner file — the cache key. */
  sourceId: string;
  /** Owner + partial manifests, stamped with `metadata.source` / `.module`. */
  manifests: ResourceManifest[];
  /** Precomputed content signature; derived from the documents when absent. */
  signature?: string;
  /** The library's declared `exports.resources` entries (bare names). */
  exportedNames: readonly string[];
}
