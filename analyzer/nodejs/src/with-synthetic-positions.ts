import type { ResourceManifest } from "@telorun/sdk";
import { REF_VALIDATION_SKIP_KINDS } from "./system-kinds.js";

/**
 * Stamp `metadata.source` and `metadata.sourceLine` on every non-system
 * manifest that lacks them, returning a new array with cloned `metadata`
 * objects for the affected entries.
 *
 * `StaticAnalyzer.analyze()` requires position info on every non-system
 * manifest (the dedup that backs `DUPLICATE_RESOURCE_NAME` reads
 * `(source, sourceLine)` to distinguish pipeline echoes from real
 * collisions). Production callers — the `Loader`, `flattenForAnalyzer`,
 * the telo-editor's `emitDocsFor`, the VSCode extension — all stamp
 * positions already. This helper is the escape hatch for **programmatic
 * callers** (tests, ad-hoc scripts) that construct `ResourceManifest`
 * literals without going through a loader: it gives every otherwise-naked
 * manifest a synthetic, deterministic position so the analyzer's
 * invariant holds without each test having to spell positions out.
 *
 * The synthetic source defaults to `"<programmatic>"` — override via
 * `source` when a stable, recognisable label helps diagnostic output.
 * Each unstamped manifest gets a unique `sourceLine` (1-based array
 * index) so two real duplicates supplied without positions retain
 * distinct fingerprints and still trip `DUPLICATE_RESOURCE_NAME`.
 *
 * Manifests that already carry `metadata.source` and `metadata.sourceLine`
 * pass through unchanged.
 */
export function withSyntheticPositions(
  manifests: ResourceManifest[],
  source: string = "<programmatic>",
): ResourceManifest[] {
  return manifests.map((m, i) => {
    if (REF_VALIDATION_SKIP_KINDS.has(m.kind)) return m;
    const meta = m.metadata as { source?: string; sourceLine?: number } | undefined;
    const hasSource = typeof meta?.source === "string" && meta.source.length > 0;
    const hasLine = typeof meta?.sourceLine === "number";
    if (hasSource && hasLine) return m;
    return {
      ...m,
      metadata: {
        ...m.metadata,
        source: hasSource ? meta!.source : source,
        sourceLine: hasLine ? meta!.sourceLine : i,
      },
    } as ResourceManifest;
  });
}
