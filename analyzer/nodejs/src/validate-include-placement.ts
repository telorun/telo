import type { ResourceManifest } from "@telorun/sdk";
import { INCLUDE_ENGINE_NAMES, walkCelExpressions } from "@telorun/templating";
import { DiagnosticSeverity, type AnalysisDiagnostic } from "./types.js";

const SOURCE = "telo-analyzer";

/**
 * Docs that are never instantiated as resources.
 *
 * `Telo.Application` / `Telo.Library` are module declarations, and `Telo.Import`
 * is a dependency edge — none of the three reaches a controller's `create()`.
 * `Telo.Definition` and `Telo.Abstract` are deliberately absent: a definition's
 * template body (`resources:` / `invoke:` / `run:` / `provide:`) DOES become
 * resources, so an embed there resolves normally.
 */
const NEVER_INSTANTIATED: ReadonlySet<string> = new Set([
  "Telo.Application",
  "Telo.Library",
  "Telo.Import",
]);

/**
 * An `!include-text` / `!include-bytes` in a doc that is never instantiated is
 * never read.
 *
 * The two tags resolve when the resource owning them is created — deferred so
 * that loading a manifest does not pull payload layers, which is the property
 * the artifact spec protects by giving `telo.yaml` a layer of its own. The cost
 * of that choice is this dead spot: a doc with no `create()` has no moment at
 * which the file would be read, so the value stays an unresolved marker and
 * whatever reads it sees a sentinel object instead of the file's contents.
 *
 * Nothing else would report it. There is no controller to validate against a
 * schema and no runtime consumer to fail, so the manifest ships looking correct
 * — exactly the silent-no-op failure mode that makes a descriptive field worth
 * checking. Hence an error at the one place that can see it.
 *
 * Deliberately narrow: it reports only where the argument is complete ("this
 * doc is never instantiated"). A JSON-Schema region *inside* a definition —
 * `schema:`, `inputType:` — is equally unreadable, but that is a general
 * question about tags in schema metadata rather than one about these two, and
 * no pass answers it for any tag today.
 */
export function validateIncludePlacement(manifests: ResourceManifest[]): AnalysisDiagnostic[] {
  const out: AnalysisDiagnostic[] = [];
  for (const manifest of manifests) {
    if (!NEVER_INSTANTIATED.has(manifest.kind)) continue;
    const name = (manifest.metadata as { name?: string } | undefined)?.name;
    const filePath = (manifest.metadata as { source?: string } | undefined)?.source;
    walkCelExpressions(manifest, "", (source, path, engineName) => {
      if (!INCLUDE_ENGINE_NAMES.has(engineName)) return;
      out.push({
        severity: DiagnosticSeverity.Error,
        code: "INCLUDE_OUTSIDE_RESOURCE",
        source: SOURCE,
        message:
          `${manifest.kind}${name ? `/${name}` : ""}: \`!${engineName} ${source}\` at '${path}' is ` +
          `never read — a ${manifest.kind} doc is not instantiated, and a file embed is resolved ` +
          `when the resource holding it is created. Move it onto the resource that needs the ` +
          `file, or read the file at runtime with Fs.File.`,
        data: {
          resource: { kind: manifest.kind, name: name ?? "" },
          filePath,
          path,
        },
      });
    });
  }
  return out;
}
