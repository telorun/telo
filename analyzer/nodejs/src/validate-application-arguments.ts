import type { ResourceManifest } from "@telorun/sdk";
import { readApplicationArguments } from "./application-arguments.js";
import { DiagnosticSeverity, type AnalysisDiagnostic } from "./types.js";

const SOURCE = "telo-analyzer";

/**
 * The strict half of `readApplicationArguments`: every `arg:` binding on a root
 * Application that the kernel would refuse to parse argv against —
 * `ARG_BINDING_INVALID` for a malformed or conflicting binding,
 * `ARG_BINDING_ON_SECRET` for a secret bound to the command line.
 *
 * Only the ENTRY application binds the host, so only a root module is checked.
 */
export function validateApplicationArguments(
  manifests: readonly ResourceManifest[],
  rootModules: ReadonlySet<string>,
): AnalysisDiagnostic[] {
  const out: AnalysisDiagnostic[] = [];
  for (const manifest of manifests) {
    if (manifest.kind !== "Telo.Application") continue;
    const metadata = (manifest.metadata ?? {}) as Record<string, unknown>;
    const name = typeof metadata.name === "string" ? metadata.name : "";
    if (!rootModules.has(name)) continue;
    for (const issue of readApplicationArguments(manifest).issues) {
      out.push({
        severity: DiagnosticSeverity.Error,
        code: issue.code,
        source: SOURCE,
        message: `Telo.Application ${issue.message}`,
        data: {
          resource: { kind: manifest.kind, name },
          filePath: typeof metadata.source === "string" ? metadata.source : undefined,
          path: issue.path,
        },
      });
    }
  }
  return out;
}
