import { StaticAnalyzer, type AnalysisDiagnostic } from "@telorun/analyzer";
import type { ResourceManifest } from "@telorun/sdk";
import { normalizePath } from "./loader";
import type { ModuleDocument, Workspace } from "./model";
import { toAnalysisManifest } from "./yaml-document";

interface EnrichedMetadata {
  name: string;
  source?: string;
  resolvedModuleName?: string;
  resolvedNamespace?: string | null;
  module?: string;
  [key: string]: unknown;
}

/**
 * Converts all modules in the Workspace to ResourceManifest[], enriching
 * Telo.Import documents with resolvedModuleName/resolvedNamespace so the
 * analyzer can correctly register import aliases and module identities.
 *
 * Iterates `workspace.modules` (not `workspace.documents` directly) so
 * analysis preserves the per-module grouping the analyzer expects — each
 * module's owner + partial docs are flattened into a single module-scoped
 * batch, mirroring what the analyzer Loader produces on its own path.
 *
 * Partial-file discovery reads `manifest.resources[].sourceFile` to rebuild
 * the set of files that belong to the module; no re-expansion of
 * `include:` patterns is required because Phase 1 already populated
 * `workspace.documents` for every tracked partial.
 */
function toAnalysisManifests(app: Workspace): ResourceManifest[] {
  const result: ResourceManifest[] = [];

  for (const [ownerPath, manifest] of app.modules) {
    const ownerKey = normalizePath(ownerPath);
    const ownerDoc = app.documents.get(ownerKey);
    if (!ownerDoc) continue;

    // Owner module name — used to stamp `metadata.module` on resources
    // declared in partial files, mirroring the analyzer Loader's
    // loadPartialFile behavior.
    const ownerModuleName = manifest.metadata.name;

    // Collect partials this module spans from resources[].sourceFile. The
    // same partial may be referenced by many resources; dedupe.
    const partialKeys = new Set<string>();
    for (const r of manifest.resources) {
      if (r.sourceFile) {
        const key = normalizePath(r.sourceFile);
        if (key !== ownerKey) partialKeys.add(key);
      }
    }

    emitDocsFor(ownerDoc, ownerPath, undefined, result);
    for (const partialKey of partialKeys) {
      const partialDoc = app.documents.get(partialKey);
      if (!partialDoc) continue;
      emitDocsFor(partialDoc, partialDoc.filePath, ownerModuleName, result);
    }
  }

  return result;
}

function emitDocsFor(
  modDoc: ModuleDocument,
  filePath: string,
  ownerModuleName: string | undefined,
  out: ResourceManifest[],
): void {
  for (const d of modDoc.docs) {
    const projected = toAnalysisManifest(d);
    if (!projected) continue;

    const existingMeta = projected.metadata as EnrichedMetadata | undefined;
    const meta: EnrichedMetadata = {
      ...(existingMeta ?? {}),
      name: existingMeta?.name ?? "",
      source: filePath,
    };

    // Partial-file resources inherit the owner's module name when they
    // don't already declare one — matches the analyzer Loader's
    // loadPartialFile stamping.
    if (ownerModuleName && !meta.module && projected.kind !== "Telo.Library") {
      meta.module = ownerModuleName;
    }

    out.push({ ...projected, metadata: meta } as ResourceManifest);
  }
}

/**
 * Runs static analysis on the entire Workspace and returns diagnostics
 * organized as `Map<filePath, Map<resourceName, AnalysisDiagnostic[]>>`.
 *
 * Groups diagnostics using the `source` filePath stamped on each manifest's
 * metadata during conversion, avoiding a reverse lookup that could collide
 * when two modules define resources with the same kind+name.
 */
export function analyzeWorkspace(
  app: Workspace,
): Map<string, Map<string, AnalysisDiagnostic[]>> {
  const manifests = toAnalysisManifests(app);

  // Enrich Telo.Import metadata with resolved module identity from the
  // cross-module projection (workspace.modules). Done post-emission so we
  // have the whole workspace's import-target names at hand.
  for (const m of manifests) {
    if (m.kind !== "Telo.Import") continue;
    const meta = m.metadata as EnrichedMetadata;
    const ownerSource = meta.source;
    if (!ownerSource) continue;
    const ownerManifest = app.modules.get(ownerSource);
    const imp = ownerManifest?.imports.find((i) => i.name === meta.name);
    const resolvedPath = imp?.resolvedPath;
    if (!resolvedPath) continue;
    const importedModule = app.modules.get(resolvedPath);
    if (!importedModule) continue;
    meta.resolvedModuleName = importedModule.metadata.name;
    meta.resolvedNamespace = importedModule.metadata.namespace ?? null;
  }

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
