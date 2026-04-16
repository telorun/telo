import { StaticAnalyzer, type AnalysisDiagnostic } from "@telorun/analyzer";
import type { ResourceManifest } from "@telorun/sdk";
import { toManifestDocs } from "./loader";
import type { Application } from "./model";

interface EnrichedMetadata {
  name: string;
  source?: string;
  resolvedModuleName?: string;
  resolvedNamespace?: string | null;
  [key: string]: unknown;
}

/**
 * Converts all modules in the Application to ResourceManifest[], enriching
 * Kernel.Import documents with resolvedModuleName/resolvedNamespace so the
 * analyzer can correctly register import aliases and module identities.
 */
function toAnalysisManifests(app: Application): ResourceManifest[] {
  const result: ResourceManifest[] = [];

  for (const [filePath, manifest] of app.modules) {
    const docs = toManifestDocs(manifest);

    for (const doc of docs) {
      const meta = doc.metadata as EnrichedMetadata;
      meta.source = filePath;

      // Enrich Kernel.Import with resolved module metadata from the imported module
      if (doc.kind === "Kernel.Import") {
        const imp = manifest.imports.find((i) => i.name === meta.name);
        const resolvedPath = imp?.resolvedPath;
        if (resolvedPath) {
          const importedModule = app.modules.get(resolvedPath);
          if (importedModule) {
            meta.resolvedModuleName = importedModule.metadata.name;
            meta.resolvedNamespace = importedModule.metadata.namespace ?? null;
          }
        }
      }

      result.push(doc as ResourceManifest);
    }
  }

  return result;
}

/**
 * Runs static analysis on the entire Application and returns diagnostics
 * organized as `Map<filePath, Map<resourceName, AnalysisDiagnostic[]>>`.
 *
 * Groups diagnostics using the `source` filePath stamped on each manifest's
 * metadata during conversion, avoiding a reverse lookup that could collide
 * when two modules define resources with the same kind+name.
 */
export function analyzeApplication(
  app: Application,
): Map<string, Map<string, AnalysisDiagnostic[]>> {
  const manifests = toAnalysisManifests(app);
  const analyzer = new StaticAnalyzer();
  const diagnostics = analyzer.analyze(manifests);

  // Build a lookup from kind/name → source filePath using the manifests we
  // just created (which carry the source stamp). Each manifest belongs to
  // exactly one file, so even if two modules share a kind/name the lookup
  // stays per-manifest rather than colliding.
  const sourceByManifest = new Map<string, string>();
  for (const m of manifests) {
    const source = (m.metadata as EnrichedMetadata).source;
    if (source) {
      sourceByManifest.set(`${m.kind}/${m.metadata.name}`, source);
    }
  }

  const result = new Map<string, Map<string, AnalysisDiagnostic[]>>();

  for (const diag of diagnostics) {
    const data = diag.data as { resource?: { kind?: string; name?: string } } | undefined;
    const kind = data?.resource?.kind;
    const name = data?.resource?.name;
    if (!kind || !name) continue;

    const filePath = sourceByManifest.get(`${kind}/${name}`);
    if (!filePath) continue;

    if (!result.has(filePath)) result.set(filePath, new Map());
    const moduleMap = result.get(filePath)!;
    if (!moduleMap.has(name)) moduleMap.set(name, []);
    moduleMap.get(name)!.push(diag);
  }

  return result;
}
