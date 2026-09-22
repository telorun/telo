import { MODULE_PATH_ENGINE, normalizeModulePath, walkCelExpressions } from "@telorun/templating";
import type { LoadedModule } from "./loaded-types.js";
import { DiagnosticSeverity, type AnalysisDiagnostic, type ManifestSource } from "./types.js";

/**
 * `MODULE_PATH_NOT_FOUND` for every `!module-path` in the entry module that
 * names nothing — the static half of the kernel's `ERR_MODULE_PATH_NOT_FOUND`.
 *
 * Existence needs a filesystem, which the analyzer never touches, so the
 * question is put to the entry's own `ManifestSource` — every host that loads
 * from disk answers it, and one that cannot (an in-browser store) reports
 * nothing rather than guessing. Well-formedness is the engine's own diagnostic;
 * a malformed path is skipped here.
 *
 * Entry-module-scoped: a dependency's files are verified when it is published.
 */
export async function collectModulePathDiagnostics(
  entry: LoadedModule,
  source: ManifestSource | undefined,
): Promise<AnalysisDiagnostic[]> {
  if (!source?.exists) return [];
  const out: AnalysisDiagnostic[] = [];
  const ownerSource = entry.owner.source;
  for (const file of [entry.owner, ...entry.partials]) {
    const found: Array<{ index: number; at: string; written: string; relative: string }> = [];
    file.manifests.forEach((manifest, index) => {
      if (!manifest) return;
      walkCelExpressions(manifest, "", (written, at, engine) => {
        if (engine !== MODULE_PATH_ENGINE) return;
        const { path: relative } = normalizeModulePath(written);
        if (relative) found.push({ index, at, written, relative });
      });
    });
    for (const { index, at, written, relative } of found) {
      // Module-root-relative: resolved against the OWNER, never the partial.
      if (await source.exists(ownerSource, relative)) continue;
      const manifest = file.manifests[index]!;
      const name = (manifest.metadata as { name?: string } | undefined)?.name;
      const range = file.positions[index]?.positionIndex?.get(at);
      out.push({
        severity: DiagnosticSeverity.Error,
        code: "MODULE_PATH_NOT_FOUND",
        source: "telo-analyzer",
        message:
          `${manifest.kind}${name ? `/${name}` : ""}: \`!${MODULE_PATH_ENGINE} ${written}\` ` +
          `names '${relative}', and there is nothing there. The path is relative to the ` +
          `module root — the directory holding telo.yaml.`,
        data: { resource: { kind: manifest.kind, name: name ?? "" }, filePath: file.source, path: at },
        ...(range ? { range } : {}),
      });
    }
  }
  return out;
}
