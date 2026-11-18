import type { ResourceManifest } from "@telorun/sdk";
import { DiagnosticSeverity, type AnalysisDiagnostic } from "./types.js";

const SOURCE = "telo-analyzer";

/**
 * What a `Telo.Library` document refuses in its own blocks: `env:` and `arg:`
 * on a `variables` / `secrets` entry (only an Application's entries bind the
 * host), and a non-string `exports.resources` entry (the `!ref` tag parses to
 * a sentinel the schema's CEL exemption would silently pass).
 */
export function libraryBlockDiagnostics(manifests: readonly ResourceManifest[]): AnalysisDiagnostic[] {
  const out: AnalysisDiagnostic[] = [];
  for (const m of manifests) {
    if (m.kind !== "Telo.Library") continue;
    const filePath = (m.metadata as { source?: string } | undefined)?.source;
    const moduleName = m.metadata?.name as string | undefined;
    const resource = moduleName ? { kind: m.kind, name: moduleName } : undefined;
    for (const block of ["variables", "secrets"] as const) {
      const entries = (m as Record<string, any>)[block];
      if (!entries || typeof entries !== "object" || Array.isArray(entries)) continue;
      for (const [entryName, entry] of Object.entries(entries)) {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
        if ("env" in (entry as Record<string, unknown>)) {
          out.push({
            severity: DiagnosticSeverity.Error,
            code: "LIBRARY_ENV_KEY_REJECTED",
            source: SOURCE,
            message:
              `Telo.Library ${block}/${entryName}: 'env:' is only permitted on Telo.Application entries. ` +
              `Libraries must receive values from importers via the parent manifest's variables / secrets block.`,
            data: { resource, filePath, path: `${block}.${entryName}.env` },
          });
        }
        if ("arg" in (entry as Record<string, unknown>)) {
          out.push({
            severity: DiagnosticSeverity.Error,
            code: "LIBRARY_ARG_KEY_REJECTED",
            source: SOURCE,
            message:
              `Telo.Library ${block}/${entryName}: 'arg:' is only permitted on Telo.Application entries — ` +
              `only the application being run reads the command line. ` +
              `Libraries must receive values from importers via the parent manifest's variables / secrets block.`,
            data: { resource, filePath, path: `${block}.${entryName}.arg` },
          });
        }
      }
    }
    const exportsResources = (m as Record<string, any>).exports?.resources;
    if (!Array.isArray(exportsResources)) continue;
    for (let i = 0; i < exportsResources.length; i++) {
      if (typeof exportsResources[i] === "string") continue;
      out.push({
        severity: DiagnosticSeverity.Error,
        code: "INVALID_EXPORT",
        source: SOURCE,
        message:
          `Telo.Library exports.resources[${i}]: write the exported name as a plain string — ` +
          `'Name' to export a local instance, or 'Alias.Name' to re-export an imported one. ` +
          `The '!ref' tag is not allowed in exports.resources.`,
        data: { resource, filePath, path: `exports.resources.${i}` },
      });
    }
  }
  return out;
}
