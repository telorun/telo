import {
  AnalysisRegistry,
  StaticAnalyzer,
  flattenForAnalyzer,
  type DocumentPosition,
  type LoadedGraph,
  type ManifestSource,
} from "@telorun/analyzer";
import { normalizeDiagnostic, type NormalizedDiagnostic } from "@telorun/ide-support";
import { isWorkspaceModule } from "./loader";
import { createEditorLoader } from "./loader/subgraph";
import { createWorkspaceDocumentSource } from "./loader/workspace-source";
import type { Workspace } from "./model";

/** Per-resource position lookup table built from the analysis graph, keyed by
 *  `${source}::${kind}::${name}`. `analyzeClosure` reads positions from this
 *  map to recover diagnostic ranges the analyzer didn't inline. */
type PositionMap = Map<string, DocumentPosition>;

/** Build the position side-table from a loaded graph. Mirrors the keys the
 *  diagnostic router looks up (`${file.source}::${kind}::${name}`). */
function buildPositionMap(graph: LoadedGraph): PositionMap {
  const positions: PositionMap = new Map();
  for (const mod of graph.modules.values()) {
    for (const file of [mod.owner, ...mod.partials]) {
      for (let i = 0; i < file.manifests.length; i++) {
        const m = file.manifests[i];
        if (!m) continue;
        const kind = (m as { kind?: unknown }).kind;
        const name = (m.metadata as { name?: unknown } | undefined)?.name;
        if (typeof kind === "string" && typeof name === "string" && name) {
          positions.set(`${file.source}::${kind}::${name}`, file.positions[i]);
        }
      }
    }
  }
  return positions;
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

/** Analyzes a single closure — the graph rooted at `root` — with its own
 *  registry and merges the results into the shared accumulators.
 *
 *  The manifest list and resolved module identity come straight from the
 *  analyzer's `flattenForAnalyzer(graph)` — the same flatten the CLI's
 *  `telo check` runs — so the editor no longer re-derives forwarding,
 *  re-export, or `resolvedModuleName` stamping on its own.
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
  graph: LoadedGraph,
  acc: MergeAccumulators,
): void {
  const manifests = flattenForAnalyzer(graph);
  const positions = buildPositionMap(graph);

  const analyzer = new StaticAnalyzer();
  const registry = new AnalysisRegistry();
  const diagnostics = analyzer.analyze(manifests, undefined, registry);

  // Files local to this closure's root: the entry module's owner + its
  // `include:` partials, keyed by the same `metadata.source` values
  // `flattenForAnalyzer` stamps (each file's canonical source).
  const rootLocalFiles = new Set<string>();
  rootLocalFiles.add(graph.entry.owner.source);
  for (const p of graph.entry.partials) rootLocalFiles.add(p.source);

  const sourceByManifest = new Map<string, string>();
  const closureFiles = new Set<string>();
  for (const m of manifests) {
    const source = (m.metadata as { source?: string }).source;
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

  // Version-reconciliation diagnostics are a property of the whole graph, not
  // of any single closure's claimed files: a hoist/conflict is only visible
  // from the importer that pulls both versions together (a sub-library analyzed
  // standalone sees no skew). Route them straight to their `data.filePath`,
  // bypassing `claimsFile`, and dedupe across closures by file+code+message so
  // the same skew surfaces exactly once.
  for (const vd of graph.versionDiagnostics) {
    const filePath = (vd.data as { filePath?: string } | undefined)?.filePath;
    if (!filePath) continue;
    const dedupKey = `version::${filePath}::${vd.code}::${vd.message}`;
    if (acc.unknownSeen.has(dedupKey)) continue;
    acc.unknownSeen.add(dedupKey);
    const moduleDocPos = graph.modules.get(filePath)?.owner.positions[0];
    appendByFile(
      filePath,
      normalizeDiagnostic(vd, {
        registry,
        positionIndex: moduleDocPos?.positionIndex,
        sourceLine: moduleDocPos?.sourceLine,
      }),
    );
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

/**
 * Runs static analysis on the entire Workspace and returns diagnostics routed
 * into resource-scoped and file-scoped buckets.
 *
 * Each workspace-local module anchors its own analysis closure. For each, the
 * editor drives the analyzer's own `Loader.loadGraph` + `flattenForAnalyzer`
 * pipeline — the exact one `telo check` uses — over an in-memory source backed
 * by the editor's live `documents` (so unsaved edits are analyzed and inline
 * imports are followed + flattened identically to the CLI). The editor no
 * longer maintains a parallel flatten/forwarding/identity implementation.
 *
 * Async because `loadGraph` reads through the source chain (the in-memory
 * documents, then the manifest + registry adapters for any transitive
 * dependency not yet open in the workspace).
 */
export async function analyzeWorkspace(
  app: Workspace,
  manifestAdapter: ManifestSource,
  registryAdapters: ManifestSource[] = [],
): Promise<WorkspaceDiagnostics> {
  const acc: MergeAccumulators = {
    byResource: new Map(),
    byFile: new Map(),
    registryByFile: new Map(),
    unknownSeen: new Set(),
    externalFilesClaimed: new Set(),
  };

  // One loader for the whole pass: its file cache parses each shared dependency
  // once across closures. A fresh loader per `analyzeWorkspace` call means the
  // next analysis re-reads current content (reflecting edits) from the source.
  const loader = createEditorLoader(manifestAdapter, registryAdapters);
  loader.register(createWorkspaceDocumentSource(app.documents, manifestAdapter));

  for (const root of computeClosureRoots(app)) {
    let graph: LoadedGraph;
    try {
      graph = await loader.loadGraph(root, { desugarImports: true });
    } catch (err) {
      console.error(`Failed to load analysis graph for ${root}:`, err);
      continue;
    }
    analyzeClosure(app, graph, acc);
  }

  return {
    byResource: acc.byResource,
    byFile: acc.byFile,
    registryByFile: acc.registryByFile,
  };
}
