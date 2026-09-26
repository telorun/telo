import {
  AnalysisRegistry,
  StaticAnalyzer,
  collectModuleDocuments,
  flattenForAnalyzer,
  type ManifestAnalysis,
  type LoadedGraph,
  type ManifestSource,
  type ModuleGraph,
  type ZoneExportCache,
} from "@telorun/analyzer";
import { isWorkspaceModule } from "./loader";
import { createEditorLoader } from "./loader/subgraph";
import { createWorkspaceDocumentSource } from "./loader/workspace-source";
import type { Workspace } from "./model";

/**
 * The in-process model studio's structured views read — the topology and
 * module graph, schema forms and their CEL editor, the template canvas,
 * resource create and edit. It is built by studio's bundled analyzer. It
 * produces NO diagnostics: every diagnostic studio shows is the engine's, for
 * the telo version the module is edited against (`language/`).
 */
export interface WorkspaceAnalysis {
  /** filePath → the AnalysisRegistry of the closure that owns that file.
   *  Each Application (and each orphan library) is analyzed against its own
   *  registry so two apps importing different versions of the same library
   *  never share — and thus never overwrite — each other's definitions. */
  registryByFile: Map<string, AnalysisRegistry>;
  /** filePath → the LoadedGraph of the owning closure. Same first-closure-wins
   *  routing as `registryByFile`. */
  graphByFile: Map<string, LoadedGraph>;
  /** filePath → the analysis of that file's closure, as a thunk so a closure
   *  nobody opens never builds one. Same first-closure-wins routing as
   *  `registryByFile`; it must be the SAME closure's, since a scope resolved
   *  against another closure's manifests would offer names this file's checker
   *  rejects. */
  analysisByFile: Map<string, () => ManifestAnalysis>;
  /** filePath → the module graph of the closure that owns it: the boxes, rows
   *  and classed edges the topology canvas draws. Built from the SAME flattened
   *  manifest set the analysis ran over, so a cross-module reference is an
   *  ordinary edge rather than an opaque leaf. Lazy, per closure, like
   *  `analysisByFile`. */
  moduleGraphByFile: Map<string, () => ModuleGraph>;
}

export function emptyAnalysis(): WorkspaceAnalysis {
  return {
    registryByFile: new Map(),
    graphByFile: new Map(),
    analysisByFile: new Map(),
    moduleGraphByFile: new Map(),
  };
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

/** Analyzes a single closure — the graph rooted at `root` — with its own
 *  registry and records which files it serves.
 *
 *  The manifest list and resolved module identity come straight from the
 *  analyzer's `flattenForAnalyzer(graph)` — the same flatten `telo check`
 *  runs. The analyzer runs to populate the registry (definitions, forwarded
 *  imports, resolved kinds) the structured views read; its verdicts are not
 *  kept. */
function analyzeClosure(graph: LoadedGraph, acc: WorkspaceAnalysis, zoneExportCache?: ZoneExportCache): void {
  const manifests = flattenForAnalyzer(graph);
  const registry = new AnalysisRegistry();
  // `moduleDocuments` carries each imported library's full documents (the
  // flatten above forwards only export surfaces) so the zone stage can derive
  // an export's open requirements. The cache is HOST-lifetime — this registry
  // is fresh per closure per run, so a cache on it would die at the boundary
  // it exists to cross, and the editor re-analyzes on every keystroke.
  new StaticAnalyzer().analyze(
    manifests,
    { moduleDocuments: collectModuleDocuments(graph) },
    registry,
    zoneExportCache,
  );

  // Files local to this closure's root: the entry module's owner + its
  // `include:` partials, keyed by the same `metadata.source` values
  // `flattenForAnalyzer` stamps (each file's canonical source).
  const rootLocalFiles = new Set<string>([graph.entry.owner.source, ...graph.entry.partials.map((p) => p.source)]);
  const closureFiles = new Set<string>();
  for (const m of manifests) {
    const source = (m.metadata as { source?: string }).source;
    if (source) closureFiles.add(source);
  }

  // Built lazily and once per closure, so a closure whose files are never
  // opened costs nothing and one that is opened builds its indices a single
  // time rather than per keystroke.
  let analysis: ManifestAnalysis | undefined;
  const analysisOf = (): ManifestAnalysis => (analysis ??= registry.analysisOf(manifests));

  // The module doc of this closure's own root — the boot root, which is not a
  // resource and which the flatten keeps only for the entry module. Found by
  // source rather than by kind alone: a closure's manifest set may carry an
  // imported library's doc, and the root is the one declared in the file this
  // closure is rooted at.
  let moduleGraph: ModuleGraph | undefined;
  const moduleGraphOf = (): ModuleGraph => {
    if (moduleGraph) return moduleGraph;
    const rootDoc = manifests.find(
      (m) =>
        (m.kind === "Telo.Application" || m.kind === "Telo.Library") &&
        (m.metadata as { source?: string }).source === graph.entry.owner.source,
    );
    const entryModule = rootDoc?.metadata?.name as string | undefined;
    const options = {
      ...(rootDoc ? { root: rootDoc } : {}),
      ...(entryModule ? { entryModule } : {}),
    };
    // Through the ANALYSIS, so the projection shares its call graph rather than
    // building a second one over the same set; the registry supplies the half
    // that is its own — how a kind resolves and what its slots target.
    moduleGraph = analysisOf().moduleGraph(registry.moduleGraphDeps(manifests, options), options);
    return moduleGraph;
  };

  // A root-local file resolves against THIS closure's registry — authoritative,
  // so it wins regardless of closure order. Other closure files (forwarded
  // foreign deps, including read-only external modules that never anchor a
  // closure) take the first registry that references them.
  for (const f of rootLocalFiles) {
    acc.registryByFile.set(f, registry);
    acc.graphByFile.set(f, graph);
    acc.analysisByFile.set(f, analysisOf);
    acc.moduleGraphByFile.set(f, moduleGraphOf);
  }
  for (const f of closureFiles) {
    if (!acc.registryByFile.has(f)) acc.registryByFile.set(f, registry);
    if (!acc.graphByFile.has(f)) acc.graphByFile.set(f, graph);
    if (!acc.analysisByFile.has(f)) acc.analysisByFile.set(f, analysisOf);
    if (!acc.moduleGraphByFile.has(f)) acc.moduleGraphByFile.set(f, moduleGraphOf);
  }
}

/**
 * Builds the structured views' model of the entire Workspace.
 *
 * Each workspace-local module anchors its own analysis closure. For each, the
 * editor drives the analyzer's own `Loader.loadGraph` + `flattenForAnalyzer`
 * pipeline — the exact one `telo check` uses — over an in-memory source backed
 * by the editor's live `documents` (so unsaved edits are reflected and inline
 * imports are followed + flattened identically to the CLI).
 *
 * Async because `loadGraph` reads through the source chain (the in-memory
 * documents, then the manifest + registry adapters for any transitive
 * dependency not yet open in the workspace).
 */
export async function analyzeWorkspace(
  app: Workspace,
  manifestAdapter: ManifestSource,
  registryAdapters: ManifestSource[] = [],
  /** Host-lifetime cache for per-library zone-export derivation, owned by the
   *  caller so it survives across analysis runs (and across the closures of one
   *  run). Keyed `(source identity, content signature)`, so a workspace library
   *  the user is editing invalidates by construction. Omit it and every run
   *  rebuilds each dependency's graph. */
  zoneExportCache?: ZoneExportCache,
): Promise<WorkspaceAnalysis> {
  const acc: WorkspaceAnalysis = emptyAnalysis();

  // One loader for the whole pass: its file cache parses each shared dependency
  // once across closures. A fresh loader per `analyzeWorkspace` call means the
  // next analysis re-reads current content (reflecting edits) from the source.
  const loader = createEditorLoader(manifestAdapter, registryAdapters);
  loader.register(createWorkspaceDocumentSource(app.documents, manifestAdapter));

  for (const root of computeClosureRoots(app)) {
    let graph: LoadedGraph;
    try {
      graph = await loader.loadGraph(root, { desugarImports: true, migrate: true });
    } catch (err) {
      // The engine reports why this module cannot load; the structured views
      // simply have no model for it.
      console.error(`Failed to load the structured-view model for ${root}:`, err);
      continue;
    }
    analyzeClosure(graph, acc, zoneExportCache);
  }

  return acc;
}
