import {
  AnalysisRegistry,
  StaticAnalyzer,
  buildDocumentPositions,
  inlineImportManifests,
  isModuleKind,
  type DocumentPosition,
} from "@telorun/analyzer";
import type { ResourceManifest } from "@telorun/sdk";
import { normalizeDiagnostic, type NormalizedDiagnostic } from "@telorun/ide-support";
import { isWorkspaceModule, normalizePath } from "./loader";
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
  includeOwners?: Set<string>,
): { manifests: ResourceManifest[]; positions: PositionMap } {
  const result: ResourceManifest[] = [];
  const positions: PositionMap = new Map();

  for (const [ownerPath, manifest] of app.modules) {
    if (includeOwners && !includeOwners.has(ownerPath)) continue;
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

    // Desugar the module doc's inline `imports:` map into synthetic Telo.Import
    // manifests so the analyzer resolves inline imports exactly like authored
    // docs. The editor's round-trip view never sees these — they exist only in
    // this analysis projection. Mirrors the kernel/analyzer Loader's
    // `desugarImports`, which the editor's document-based path bypasses.
    if (isModuleKind(projectedKind)) {
      for (const synth of inlineImportManifests(stamped, positionList[i])) {
        const synthName = synth.manifest.metadata.name as string;
        out.push({
          ...synth.manifest,
          // `module` scopes alias resolution and the DUPLICATE_IMPORT_ALIAS check
          // to the declaring module — without it a library's inline imports would
          // look like root-scope imports (the kernel path gets this from stampFile).
          metadata: {
            ...synth.manifest.metadata,
            source: filePath,
            sourceLine: synth.position.sourceLine,
            ...(ownerModuleName ? { module: ownerModuleName } : {}),
          },
        } as ResourceManifest);
        positionsOut.set(`${filePath}::Telo.Import::${synthName}`, synth.position);
      }
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
  /** filePath → the AnalysisRegistry of the closure that owns that file.
   *  Each Application (and each orphan library) is analyzed against its own
   *  registry so two apps importing different versions of the same library
   *  never share — and thus never overwrite — each other's definitions. The
   *  Monaco completion provider selects the registry for the active module. */
  registryByFile: Map<string, AnalysisRegistry>;
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
/** Transitive import closure of `root` over the workspace import graph,
 *  including `root` itself. Each closure is a self-consistent version set:
 *  an Application picks specific library versions, so its closure can never
 *  contain two versions of the same module — which is exactly what keeps the
 *  per-closure AnalysisRegistry free of name collisions. */
function computeClosure(root: string, importGraph: Map<string, Set<string>>): Set<string> {
  const out = new Set<string>();
  const queue = [root];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (out.has(current)) continue;
    out.add(current);
    const deps = importGraph.get(current);
    if (deps) for (const d of deps) if (!out.has(d)) queue.push(d);
  }
  return out;
}

/** The set of modules that anchor an independent analysis context: every
 *  Application, plus any workspace-local module not reachable from one (orphan
 *  libraries being edited on their own). Sorted for deterministic closure
 *  ordering — the first closure to contain a file owns its diagnostics. */
function computeClosureRoots(app: Workspace): string[] {
  const roots: string[] = [];
  const covered = new Set<string>();

  const appPaths = [...app.modules.keys()]
    .filter((p) => app.modules.get(p)!.kind === "Application")
    .sort();
  for (const p of appPaths) {
    roots.push(p);
    for (const f of computeClosure(p, app.importGraph)) covered.add(f);
  }

  const localPaths = [...app.modules.keys()].filter((p) => isWorkspaceModule(app, p)).sort();
  for (const p of localPaths) {
    if (covered.has(p)) continue;
    roots.push(p);
    for (const f of computeClosure(p, app.importGraph)) covered.add(f);
  }

  return roots;
}

interface MergeAccumulators {
  byResource: Map<string, Map<string, NormalizedDiagnostic[]>>;
  byFile: Map<string, NormalizedDiagnostic[]>;
  registryByFile: Map<string, AnalysisRegistry>;
  /** Files whose diagnostics were already emitted by an earlier closure.
   *  Shared libraries appear in multiple closures with identical diagnostics;
   *  first-closure-wins keeps a single copy and a single owning registry. */
  coveredFiles: Set<string>;
  /** Dedup key set for diagnostics that route to no file at all. */
  unknownSeen: Set<string>;
}

/** Analyzes a single closure with its own registry and merges the results
 *  into the shared accumulators. */
function analyzeClosure(app: Workspace, closurePaths: Set<string>, acc: MergeAccumulators): void {
  const { manifests, positions } = toAnalysisManifests(app, closurePaths);

  // Enrich Telo.Import metadata with resolved module identity from the
  // cross-module projection (workspace.modules).
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
  const closureFiles = new Set<string>();
  for (const m of manifests) {
    const source = (m.metadata as EnrichedMetadata).source;
    if (source) {
      sourceByManifest.set(`${m.kind}/${m.metadata.name}`, source);
      closureFiles.add(source);
    }
  }

  const appendByFile = (filePath: string, diag: NormalizedDiagnostic) => {
    let bucket = acc.byFile.get(filePath);
    if (!bucket) {
      bucket = [];
      acc.byFile.set(filePath, bucket);
    }
    bucket.push(diag);
  };

  for (const diag of diagnostics) {
    const data = diag.data as
      | { resource?: { kind?: string; name?: string }; filePath?: string }
      | undefined;
    const kind = data?.resource?.kind;
    const name = data?.resource?.name;

    // Resolve the owning file. The analyzer stamps the precise per-resource
    // source on `data.filePath`; prefer it over the `${kind}/${name}`
    // projection, which collapses resources that share a name across modules
    // in the same closure (resource names are module-scoped, so two modules
    // may each declare e.g. `Http.Server/main`). Fall back to the projection
    // only when the diagnostic carries no `filePath`.
    //
    // The position side-table lets the normalizer recover ranges from
    // `positionIndex` / `sourceLine` when the analyzer didn't include an
    // inline `d.range`; it is keyed by the same per-doc source.
    const stampedFilePath = data?.filePath;
    const filePath =
      kind && name ? (stampedFilePath ?? sourceByManifest.get(`${kind}/${name}`)) : undefined;
    const ownerPosition =
      filePath && kind && name ? positions.get(`${filePath}::${kind}::${name}`) : undefined;
    const normalized = normalizeDiagnostic(diag, {
      registry,
      positionIndex: ownerPosition?.positionIndex,
      sourceLine: ownerPosition?.sourceLine,
    });

    if (filePath) {
      if (acc.coveredFiles.has(filePath)) continue;
      let moduleMap = acc.byResource.get(filePath);
      if (!moduleMap) {
        moduleMap = new Map();
        acc.byResource.set(filePath, moduleMap);
      }
      let list = moduleMap.get(name!);
      if (!list) {
        list = [];
        moduleMap.set(name!, list);
      }
      list.push(normalized);
      continue;
    }

    // Fall through: no resource identity — route by data.filePath if the
    // analyzer provided it, otherwise the unknown-file bucket (deduped
    // across closures).
    if (stampedFilePath) {
      if (acc.coveredFiles.has(stampedFilePath)) continue;
      appendByFile(stampedFilePath, normalized);
      continue;
    }
    const dedupKey = `${normalized.code}::${normalized.message}`;
    if (acc.unknownSeen.has(dedupKey)) continue;
    acc.unknownSeen.add(dedupKey);
    appendByFile(UNKNOWN_FILE_KEY, normalized);
  }

  for (const f of closureFiles) {
    if (!acc.registryByFile.has(f)) acc.registryByFile.set(f, registry);
    acc.coveredFiles.add(f);
  }
}

export function analyzeWorkspace(app: Workspace): WorkspaceDiagnostics {
  const acc: MergeAccumulators = {
    byResource: new Map(),
    byFile: new Map(),
    registryByFile: new Map(),
    coveredFiles: new Set(),
    unknownSeen: new Set(),
  };

  for (const root of computeClosureRoots(app)) {
    analyzeClosure(app, computeClosure(root, app.importGraph), acc);
  }

  return {
    byResource: acc.byResource,
    byFile: acc.byFile,
    registryByFile: acc.registryByFile,
  };
}
