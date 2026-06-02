import {
  AnalysisRegistry,
  StaticAnalyzer,
  buildDocumentPositions,
  inlineImportManifests,
  isModuleKind,
  selectModuleManifestsForAnalysis,
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
  root: string,
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

    // Emit each module's docs into its own batch, then apply the import-boundary
    // rule shared with the CLI's `flattenForAnalyzer`: the closure root stays
    // fully local; every imported module forwards only its definitions/abstracts/
    // imports plus `exports.resources` instances (flagged `forwardedExport`).
    // Positions are recorded for every emitted doc — dropped manifests simply
    // leave unused lookup entries.
    const moduleManifests: ResourceManifest[] = [];
    emitDocsFor(ownerDoc, ownerPath, ownerModuleName, moduleManifests, positions);
    for (const partialKey of partialKeys) {
      const partialDoc = app.documents.get(partialKey);
      if (!partialDoc) continue;
      emitDocsFor(partialDoc, partialDoc.filePath, ownerModuleName, moduleManifests, positions);
    }

    result.push(...selectModuleManifestsForAnalysis(moduleManifests, ownerPath === root));
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
 *  workspace-local module — every Application AND every Library, regardless of
 *  whether an Application imports it. Each anchors a closure in which it is the
 *  local root (its internals fully validated) and its imports are forwarded
 *  foreign — exactly the local/foreign split `telo check <module>` produces per
 *  file. A library imported by an app is therefore validated in its OWN closure,
 *  never against the consumer's scope (where `Self.` would mis-resolve).
 *
 *  External (registry/remote) modules are never roots — like the CLI, they are
 *  only ever forwarded as cross-module targets, never re-validated. Sorted for
 *  deterministic ordering. */
function computeClosureRoots(app: Workspace): string[] {
  return [...app.modules.keys()].filter((p) => isWorkspaceModule(app, p)).sort();
}

interface MergeAccumulators {
  byResource: Map<string, Map<string, NormalizedDiagnostic[]>>;
  byFile: Map<string, NormalizedDiagnostic[]>;
  registryByFile: Map<string, AnalysisRegistry>;
  /** Dedup key set for diagnostics that route to no file at all. */
  unknownSeen: Set<string>;
  /** External (registry/remote) files already claimed by an earlier closure.
   *  Such files never anchor their own closure, so the first closure that
   *  surfaces them owns their diagnostics (first-closure-wins). */
  externalFilesClaimed: Set<string>;
}

/** Analyzes a single closure — rooted at `root` — with its own registry and
 *  merges the results into the shared accumulators.
 *
 *  Diagnostics for a WORKSPACE file are emitted only by the closure where that
 *  file is the root (its owner + `include:` partials), never by a consumer
 *  closure where the same file appears as a forwarded foreign dependency — its
 *  own closure already validates the full module. Every workspace file is the
 *  local root of exactly one closure, so this needs no cross-closure dedup.
 *
 *  EXTERNAL (registry/remote) files never anchor a closure, yet `telo check`
 *  validates and reports forwarded imported definitions against their source
 *  file. To match that — and to avoid silently swallowing those errors — an
 *  external file's diagnostics are emitted by the first closure that surfaces
 *  them (`externalFilesClaimed` enforces first-closure-wins). */
function analyzeClosure(
  app: Workspace,
  root: string,
  closurePaths: Set<string>,
  acc: MergeAccumulators,
): void {
  const { manifests, positions } = toAnalysisManifests(app, root, closurePaths);

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

  // Files local to this closure's root (owner + partials), keyed by the same
  // `metadata.source` values `toAnalysisManifests` stamps (owner → root path,
  // partial → its document filePath).
  const rootLocalFiles = new Set<string>();
  const rootManifest = app.modules.get(root);
  if (rootManifest) {
    rootLocalFiles.add(root);
    const rootKey = normalizePath(root);
    for (const r of rootManifest.resources) {
      if (!r.sourceFile) continue;
      const key = normalizePath(r.sourceFile);
      if (key === rootKey) continue;
      const partialDoc = app.documents.get(key);
      if (partialDoc) rootLocalFiles.add(partialDoc.filePath);
    }
  }

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

  // Whether this closure is the one that emits diagnostics for `file`. A
  // workspace file is owned by the closure where it is the root (its own
  // module); an external (registry/remote) file — which never anchors a
  // closure — is owned by the first closure that surfaces it.
  const claimsFile = (file: string): boolean => {
    if (rootLocalFiles.has(file)) return true;
    if (isWorkspaceModule(app, file)) return false;
    return !acc.externalFilesClaimed.has(file);
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
      if (!claimsFile(filePath)) continue;
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

    // Fall through: no resource identity — route by data.filePath when this
    // closure claims it, otherwise the unknown-file bucket (deduped across
    // closures). A filePath this closure does not claim belongs to another.
    if (stampedFilePath) {
      if (!claimsFile(stampedFilePath)) continue;
      appendByFile(stampedFilePath, normalized);
      continue;
    }
    const dedupKey = `${normalized.code}::${normalized.message}`;
    if (acc.unknownSeen.has(dedupKey)) continue;
    acc.unknownSeen.add(dedupKey);
    appendByFile(UNKNOWN_FILE_KEY, normalized);
  }

  // Registry routing: a root-local file resolves completions against THIS
  // closure's registry (its own definitions + forwarded imports) — authoritative,
  // so it wins regardless of closure order. Other closure files (forwarded
  // foreign deps, including read-only external modules that never anchor a
  // closure) take the first registry that references them as a fallback.
  for (const f of rootLocalFiles) acc.registryByFile.set(f, registry);
  for (const f of closureFiles) {
    // External files surfaced here are now owned by this closure; later
    // closures importing the same dependency defer to it (first-closure-wins).
    if (!rootLocalFiles.has(f) && !isWorkspaceModule(app, f)) acc.externalFilesClaimed.add(f);
    if (!acc.registryByFile.has(f)) acc.registryByFile.set(f, registry);
  }
}

export function analyzeWorkspace(app: Workspace): WorkspaceDiagnostics {
  const acc: MergeAccumulators = {
    byResource: new Map(),
    byFile: new Map(),
    registryByFile: new Map(),
    unknownSeen: new Set(),
    externalFilesClaimed: new Set(),
  };

  for (const root of computeClosureRoots(app)) {
    analyzeClosure(app, root, computeClosure(root, app.importGraph), acc);
  }

  return {
    byResource: acc.byResource,
    byFile: acc.byFile,
    registryByFile: acc.registryByFile,
  };
}
