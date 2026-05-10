import {
  AnalysisRegistry,
  StaticAnalyzer,
  buildDocumentPositions,
  type DocumentPosition,
} from "@telorun/analyzer";
import type { ResourceManifest } from "@telorun/sdk";
import { normalizeDiagnostic, type NormalizedDiagnostic } from "@telorun/ide-support";
import { normalizePath } from "./loader";
import type { ModuleDocument, Workspace } from "./model";

interface EnrichedMetadata {
  name: string;
  source?: string;
  resolvedModuleName?: string;
  resolvedNamespace?: string | null;
  module?: string;
  [key: string]: unknown;
}

/** Per-resource position lookup table built alongside the manifest list.
 *  `analyzeWorkspace` reads positions from this map (keyed by
 *  `${source}::${name}`) instead of the manifest's metadata, so the
 *  non-enumerable `positionIndex` smuggling on metadata is no longer
 *  required for the editor's diagnostic-routing path. */
type PositionMap = Map<string, DocumentPosition>;

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
function toAnalysisManifests(
  app: Workspace,
): { manifests: ResourceManifest[]; positions: PositionMap } {
  const result: ResourceManifest[] = [];
  const positions: PositionMap = new Map();

  for (const [ownerPath, manifest] of app.modules) {
    const ownerKey = normalizePath(ownerPath);
    const ownerDoc = app.documents.get(ownerKey);
    if (!ownerDoc) continue;

    const ownerModuleName = manifest.metadata.name;

    const partialKeys = new Set<string>();
    for (const r of manifest.resources) {
      if (r.sourceFile) {
        const key = normalizePath(r.sourceFile);
        if (key !== ownerKey) partialKeys.add(key);
      }
    }

    emitDocsFor(ownerDoc, ownerPath, ownerModuleName, result, positions);
    for (const partialKey of partialKeys) {
      const partialDoc = app.documents.get(partialKey);
      if (!partialDoc) continue;
      emitDocsFor(partialDoc, partialDoc.filePath, ownerModuleName, result, positions);
    }
  }

  return { manifests: result, positions };
}

function emitDocsFor(
  modDoc: ModuleDocument,
  filePath: string,
  ownerModuleName: string | undefined,
  out: ResourceManifest[],
  positionsOut: PositionMap,
): void {
  // When the file is dirty the AST has been mutated in place, so manifest
  // shapes and positions must be re-derived from the current docs. Otherwise
  // reuse the LoadedFile's cached snapshot.
  const docs = modDoc.loaded.documents;
  const positionList = modDoc.dirty
    ? buildDocumentPositions(modDoc.loaded.text, docs)
    : modDoc.loaded.positions;
  const cachedManifests = modDoc.dirty ? null : modDoc.loaded.manifests;

  for (let i = 0; i < docs.length; i++) {
    const projected =
      cachedManifests?.[i] ??
      (docs[i].toJSON() as Record<string, unknown> | null);
    if (!projected || typeof projected !== "object") continue;

    const existingMeta = (projected as { metadata?: EnrichedMetadata }).metadata;
    const { sourceLine } = positionList[i];
    const meta: EnrichedMetadata = {
      ...(existingMeta ?? {}),
      name: existingMeta?.name ?? "",
      source: filePath,
      sourceLine,
    };

    if (
      ownerModuleName &&
      !meta.module &&
      (projected as { kind?: string }).kind !== "Telo.Library" &&
      (projected as { kind?: string }).kind !== "Telo.Application"
    ) {
      meta.module = ownerModuleName;
    }

    const stamped = { ...projected, metadata: meta } as ResourceManifest;
    out.push(stamped);
    const projectedKind = (projected as { kind?: string }).kind;
    if (typeof meta.name === "string" && meta.name && typeof projectedKind === "string") {
      positionsOut.set(`${filePath}::${projectedKind}::${meta.name}`, positionList[i]);
    }
  }
}

/** Sentinel key used in `WorkspaceDiagnostics.byFile` when the analyzer emits
 *  a diagnostic that cannot be tied to any file (no `data.resource` and no
 *  `data.filePath`). Surfaced only by `summarizeWorkspace`; UI sites that key
 *  on file/resource identity skip it. */
export const UNKNOWN_FILE_KEY = "__unknown__";

export interface WorkspaceDiagnostics {
  /** filePath → resourceName → diagnostics. Only diagnostics with
   *  `data.resource.{kind,name}` that resolves to a known manifest.
   *  Pre-normalized via `normalizeDiagnostic`, so every consumer reads the
   *  same resolved `range` / `severity` / `code` without re-running the
   *  fallback chain. */
  byResource: Map<string, Map<string, NormalizedDiagnostic[]>>;
  /** filePath → diagnostics NOT tied to a named resource. Includes
   *  `UNKNOWN_FILE_KEY` when the analyzer gives us nothing to route on. */
  byFile: Map<string, NormalizedDiagnostic[]>;
  /** Populated AnalysisRegistry from the pass. Needed by the Monaco
   *  completion provider. */
  registry: AnalysisRegistry;
}

/**
 * Runs static analysis on the entire Workspace and returns diagnostics
 * routed into resource-scoped and file-scoped buckets.
 *
 * Routing rules:
 *   1. `data.resource.{kind,name}` resolves via sourceByManifest → byResource.
 *   2. `data.filePath` present → byFile[filePath].
 *   3. Else → byFile[UNKNOWN_FILE_KEY].
 *
 * The file-scoped bucket replaces the pre-`diagnostics-everywhere` behavior
 * of silently dropping unscoped diagnostics — notably MISSING_KIND_OR_NAME
 * on manifests that never reach a resource identity.
 */
export function analyzeWorkspace(app: Workspace): WorkspaceDiagnostics {
  const { manifests, positions } = toAnalysisManifests(app);

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
  const registry = new AnalysisRegistry();
  const diagnostics = analyzer.analyze(manifests, undefined, registry);

  const sourceByManifest = new Map<string, string>();
  for (const m of manifests) {
    const source = (m.metadata as EnrichedMetadata).source;
    if (source) {
      sourceByManifest.set(`${m.kind}/${m.metadata.name}`, source);
    }
  }

  const byResource = new Map<string, Map<string, NormalizedDiagnostic[]>>();
  const byFile = new Map<string, NormalizedDiagnostic[]>();

  const appendByFile = (filePath: string, diag: NormalizedDiagnostic) => {
    let bucket = byFile.get(filePath);
    if (!bucket) {
      bucket = [];
      byFile.set(filePath, bucket);
    }
    bucket.push(diag);
  };

  for (const diag of diagnostics) {
    const data = diag.data as
      | { resource?: { kind?: string; name?: string }; filePath?: string }
      | undefined;
    const kind = data?.resource?.kind;
    const name = data?.resource?.name;

    // Look up the resource's positions so the normalizer can recover ranges
    // from `positionIndex` / `sourceLine` when the analyzer didn't include
    // an inline `d.range`. Positions live in the side-table built during
    // emission instead of being smuggled on manifest metadata.
    const filePath = kind && name ? sourceByManifest.get(`${kind}/${name}`) : undefined;
    const ownerPosition =
      filePath && kind && name
        ? positions.get(`${filePath}::${kind}::${name}`)
        : undefined;
    const normalized = normalizeDiagnostic(diag, {
      registry,
      positionIndex: ownerPosition?.positionIndex,
      sourceLine: ownerPosition?.sourceLine,
    });

    if (filePath) {
      let moduleMap = byResource.get(filePath);
      if (!moduleMap) {
        moduleMap = new Map();
        byResource.set(filePath, moduleMap);
      }
      let list = moduleMap.get(name!);
      if (!list) {
        list = [];
        moduleMap.set(name!, list);
      }
      list.push(normalized);
      continue;
    }

    // Fall through: resource stamp absent or doesn't resolve to a loaded
    // manifest — route by data.filePath if the analyzer provided it,
    // otherwise the unknown-file bucket.
    const stampedPath = data?.filePath;
    appendByFile(stampedPath ?? UNKNOWN_FILE_KEY, normalized);
  }

  return { byResource, byFile, registry };
}
