import type { ResourceManifest } from "@telorun/sdk";
import { DiagnosticSeverity, type AnalysisDiagnostic } from "./types.js";

const SOURCE = "telo-analyzer";

/**
 * Warns when a library exports a kind (via `exports.kinds`) whose local
 * `Telo.Definition` carries no `metadata.description`.
 *
 * The description is the primary human text the federated-discovery hub embeds
 * for semantic search (`search_resources`), so an exported kind without one is
 * undiscoverable by meaning. A warning (not an error) so the stdlib backfill is
 * incremental and CI isn't blocked mid-migration.
 *
 * Scope: only kinds a library *exports* and *defines locally* are checked.
 * Re-exported kinds (`exports.kinds: [Alias.Kind]`) belong to their owning
 * module and are skipped; an exported name that isn't a local Telo.Definition
 * (e.g. a Telo.Abstract) is skipped too. The check keys off the root library's
 * own module doc, which is only present when that library is analyzed directly
 * — so importing an under-described library never leaks warnings to its consumer.
 */
export function validateKindDescriptions(manifests: ResourceManifest[]): AnalysisDiagnostic[] {
  const diagnostics: AnalysisDiagnostic[] = [];

  // Local Telo.Definition docs keyed by `<module>/<name>`.
  const definitions = new Map<string, ResourceManifest>();
  for (const m of manifests) {
    if (m.kind !== "Telo.Definition") continue;
    const name = m.metadata?.name as string | undefined;
    const mod = (m.metadata as { module?: string } | undefined)?.module;
    if (name && mod) definitions.set(`${mod}/${name}`, m);
  }

  for (const m of manifests) {
    if (m.kind !== "Telo.Library") continue;
    const moduleName = m.metadata?.name as string | undefined;
    if (!moduleName) continue;
    const exportedKinds = (m as { exports?: { kinds?: unknown } }).exports?.kinds;
    if (!Array.isArray(exportedKinds)) continue;

    for (const entry of exportedKinds) {
      // Re-export (`Alias.Kind`) — the owning module owns its description.
      if (typeof entry !== "string" || entry.includes(".")) continue;
      const def = definitions.get(`${moduleName}/${entry}`);
      if (!def) continue; // not a local Telo.Definition (e.g. an abstract)
      const description = (def.metadata as { description?: unknown } | undefined)?.description;
      if (typeof description === "string" && description.trim() !== "") continue;
      diagnostics.push({
        severity: DiagnosticSeverity.Warning,
        code: "KIND_MISSING_DESCRIPTION",
        source: SOURCE,
        message:
          `${moduleName}.${entry}: exported kind has no 'metadata.description'. Add a one-line ` +
          `description — it is the primary text indexed for semantic discovery (search_resources).`,
        data: {
          resource: { kind: "Telo.Definition", name: entry },
          filePath: (def.metadata as { source?: string } | undefined)?.source,
          path: "metadata.description",
        },
      });
    }
  }

  return diagnostics;
}
