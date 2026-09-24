import { MODULE_PATH_ENGINE, normalizeModulePath, walkCelExpressions } from "@telorun/templating";
import type { LoadedModule } from "./loaded-types.js";
import { isModuleKind } from "./module-kinds.js";
import { pathsAtOrBeneath, readAssetPatterns, stagedModuleFiles } from "./module-named-files.js";
import { readNativeEntries } from "./native-entries.js";
import { readModuleSources } from "./source-entries.js";
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
 * A path at or above a module file the module's own `sources:` block stages is
 * present: the kernel stages it on first use, so a fresh checkout has no copy yet.
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
  let staged: readonly string[] | undefined;
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
      staged ??= stagedFilesOf(entry.owner.manifests.find((m) => m && isModuleKind(m.kind)));
      if (pathsAtOrBeneath(staged, relative).length > 0) continue;
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

/** None while the `sources:` block does not read, since the kernel then resolves nothing either. */
function stagedFilesOf(owner: unknown): string[] {
  const { sources, problems } = readModuleSources(owner);
  if (problems.length > 0) return [];
  return stagedModuleFiles(readNativeEntries(owner).entries, {
    patterns: readAssetPatterns(owner),
    sources,
  });
}
