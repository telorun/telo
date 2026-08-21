import type { ResourceManifest } from "@telorun/sdk";

/**
 * The manifest a `(kind, name)` pair addresses.
 *
 * One implementation, because two consumers needed it and a manifest set is
 * exactly the thing `ManifestAnalysis` exists to have one answer over. Undefined
 * when the set holds no such resource — a document the author is still writing.
 */
export function findManifest(
  manifests: readonly ResourceManifest[],
  kind: string | undefined,
  name: string | undefined,
): ResourceManifest | undefined {
  if (!kind || !name) return undefined;
  return manifests.find(
    (m) => m.kind === kind && (m.metadata as { name?: string } | undefined)?.name === name,
  );
}
