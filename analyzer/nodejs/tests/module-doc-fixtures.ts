import type { ResourceManifest } from "@telorun/sdk";

/** `manifests` with a `Telo.Library` for each module a document is stamped with
 *  that no module document names: a stamped document is the entry's own only
 *  when its module document is in the analysed set. */
export function withModuleDocs(manifests: readonly ResourceManifest[]): ResourceManifest[] {
  const named = new Set(
    manifests.filter((m) => m.kind === "Telo.Library" || m.kind === "Telo.Application").map((m) => m.metadata?.name as string),
  );
  const stamped = new Set(
    manifests.map((m) => (m.metadata as { module?: unknown } | undefined)?.module).filter((m): m is string => typeof m === "string" && !named.has(m)),
  );
  return [...[...stamped].map((name) => ({ kind: "Telo.Library", metadata: { name } }) as unknown as ResourceManifest), ...manifests];
}
