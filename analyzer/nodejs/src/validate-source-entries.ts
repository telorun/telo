import type { ResourceManifest } from "@telorun/sdk";

import { moduleDocumentClaims } from "./module-file-claims.js";
import {
  crossLayerSourceLinks,
  readAssetPatterns,
  stageableFiles,
  unclaimedSourceEntries,
} from "./module-named-files.js";
import { normalizeNativePath, readNativeEntries } from "./native-entries.js";
import { readModuleSources } from "./source-entries.js";
import { DiagnosticSeverity, type AnalysisDiagnostic } from "./types.js";

const SOURCE = "telo-analyzer";

/**
 * The strict half of `source-entries.ts`: what `telo check` reports about a
 * module doc's `sources:` block.
 *
 * Every rule the block alone decides is a reader problem, reported here under
 * its own code. This adds the rules that need the rest of the module or that
 * only publish enforces: an entry must stage a file the manifest names, a link
 * ships in its target's layer, and every file entry and every build carries its
 * pin. Shape errors are left to the owner doc's JSON Schema.
 *
 * Entry-module-scoped: a dependency's block is not the consumer's to fix.
 */
export function validateSourceEntries(
  manifests: ResourceManifest[],
  entryModules?: ReadonlySet<string>,
): AnalysisDiagnostic[] {
  const out: AnalysisDiagnostic[] = [];
  for (const manifest of manifests) {
    if (manifest.kind !== "Telo.Application" && manifest.kind !== "Telo.Library") continue;
    const metadata = (manifest.metadata ?? {}) as Record<string, unknown>;
    const name = typeof metadata.name === "string" ? metadata.name : undefined;
    const owned =
      entryModules === undefined ||
      (typeof metadata.module === "string"
        ? entryModules.has(metadata.module)
        : name === undefined || entryModules.has(name));
    if (!owned) continue;

    const label = `${manifest.kind}/${name ?? "(unnamed)"}`;
    const report = (code: string, path: string, message: string) =>
      out.push({
        severity: DiagnosticSeverity.Error,
        code,
        source: SOURCE,
        message: `${label}: ${message}`,
        data: {
          resource: { kind: manifest.kind, name },
          filePath: typeof metadata.source === "string" ? metadata.source : undefined,
          path,
        },
      });

    const { sources, problems } = readModuleSources(manifest);
    for (const problem of problems) {
      if (problem.code === "SHAPE") continue;
      report(problem.code, problem.path, problem.message);
    }
    if (sources.length === 0) continue;

    for (const source of sources) {
      if (source.build && source.build.inputs === undefined) {
        report(
          "SOURCE_BUILD_UNPINNED",
          `sources.${source.name}.build`,
          `source '${source.name}' names the crate its files are built from but records no build ` +
            `inputs, so a later edit to that crate cannot be caught — run \`telo release stage ` +
            `--pin\` after building its files. \`telo release check\` and publish refuse it.`,
        );
      }
      for (const entry of source.entries) {
        if (entry.kind !== "file" || entry.pin) continue;
        report(
          "SOURCE_ENTRY_UNPINNED",
          `sources.${source.name}.entries.${entry.key}`,
          `source '${source.name}' entry '${entry.key}' carries no pin (sha256 and executable), so ` +
            `nothing can verify the file it stages: a kernel refuses to read it and publish refuses ` +
            `to ship it — run \`telo release stage --pin\`.`,
        );
      }
    }

    const moduleName = typeof metadata.module === "string" ? metadata.module : name;
    const stageable = stageableFiles(
      readNativeEntries(manifest).entries,
      moduleDocumentClaims(manifests, moduleName),
      { patterns: readAssetPatterns(manifest), sources },
    );
    for (const { source, entry, layer, targetLayer } of crossLayerSourceLinks(sources, stageable)) {
      report(
        "SOURCE_LINK_TARGET_UNRESOLVED",
        `sources.${source.name}.entries.${entry.key}.target`,
        `source '${source.name}' entry '${entry.key}': the link ships in the ${layer} layer, but ` +
          `its target '${entry.resolved}' ships in the ${targetLayer} layer. A runtime extracts ` +
          `only the layers it needs, so the link would dangle — point it at a file of its own layer.`,
      );
    }
    // A `native:` entry with an unrelated problem still names its path; reported
    // once, as that problem, rather than again as an unclaimed source entry.
    const unreadNative = new Set<string>();
    const native = (manifest as { native?: unknown }).native;
    for (const entry of Array.isArray(native) ? native : []) {
      const path = (entry as { path?: unknown } | null)?.path;
      const verdict = typeof path === "string" ? normalizeNativePath(path.trim()) : undefined;
      if (verdict && "path" in verdict) unreadNative.add(verdict.path);
    }
    for (const { source, entry } of unclaimedSourceEntries(sources, stageable, unreadNative)) {
      report(
        "SOURCE_ENTRY_UNCLAIMED",
        `sources.${source.name}.entries.${entry.key}`,
        `source '${source.name}' entry '${entry.key}': nothing in the module names '${entry.path}' ` +
          `— no native: entry's path, no platform-qualified controller candidate's path=, no ` +
          `assets: pattern, and none of the source's notices. Name the file where it is used, ` +
          `or remove the entry.`,
      );
    }
  }
  return out;
}
