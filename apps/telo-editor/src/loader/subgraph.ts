import type { ManifestAdapter } from "@telorun/analyzer";
import { Loader, isModuleKind } from "@telorun/analyzer";
import type { ResourceManifest } from "@telorun/sdk";
import type {
  ModuleDocument,
  ParsedImport,
  ParsedManifest,
  Workspace,
} from "../model";
import {
  addImportDocument,
  parseModuleDocument,
  removeImportDocument,
} from "../yaml-document";
import { normalizePath } from "./paths";
import { isRegistryImportSource } from "./registry";
import { buildParsedManifest, classifyImport } from "./parse";
import {
  buildResourceDocIndex,
  rebuildManifestFromDocuments,
  withModuleDocument,
} from "./ast-ops";

// ---------------------------------------------------------------------------
// Loader wiring
// ---------------------------------------------------------------------------

type LoaderOptionsCompat = {
  extraAdapters?: ManifestAdapter[];
  includeHttpAdapter?: boolean;
  includeRegistryAdapter?: boolean;
  registryUrl?: string;
};

const LoaderCtor = Loader as unknown as new (
  extraAdaptersOrOptions?: ManifestAdapter[] | LoaderOptionsCompat,
) => Loader;

const registryFallbackBlocker: ManifestAdapter = {
  supports(url: string): boolean {
    return isRegistryImportSource(url);
  },
  async read(url: string): Promise<{ text: string; source: string }> {
    throw new Error(
      `No enabled registry server can resolve '${url}'. Configure at least one registry in settings.`,
    );
  },
  resolveRelative(_base: string, relative: string): string {
    return relative;
  },
};

function resolveDepPath(adapter: ManifestAdapter, filePath: string, source: string): string {
  return source.startsWith(".") || source.startsWith("/")
    ? adapter.resolveRelative(filePath, source)
    : source;
}

/** Wraps a disk-backed ManifestAdapter so `read()` first checks a
 *  `ModuleDocument` map and serves the in-memory text when present. Falls
 *  through to disk for files not yet tracked (first load, imports, partials
 *  before Phase-1 post-processing adds them). All other adapter methods
 *  (`resolveRelative`, `expandGlob`, `resolveOwnerOf`) delegate to the disk
 *  adapter because glob expansion and path resolution still require real
 *  filesystem knowledge.
 *
 *  The map is passed by reference, so callers that mutate `documents` after
 *  constructing the adapter see the updates on subsequent `read()` calls —
 *  which is how Phase-1 post-processing populates partial ASTs mid-load. */
export function createInMemoryManifestAdapter(
  documents: Map<string, ModuleDocument>,
  disk: ManifestAdapter,
): ManifestAdapter {
  return {
    supports(url: string): boolean {
      return disk.supports(url);
    },
    async read(url: string): Promise<{ text: string; source: string }> {
      const doc = documents.get(normalizePath(url));
      if (doc) return { text: doc.text, source: url };
      return disk.read(url);
    },
    resolveRelative(base: string, relative: string): string {
      return disk.resolveRelative(base, relative);
    },
    expandGlob: disk.expandGlob ? (base, patterns) => disk.expandGlob!(base, patterns) : undefined,
    resolveOwnerOf: disk.resolveOwnerOf ? (url) => disk.resolveOwnerOf!(url) : undefined,
  };
}

/** Combines a local disk adapter with registry/extra adapters into a single
 *  adapter whose `read()` routes each URL to the first adapter that `supports()`
 *  it (extras first, local last). Used when populating `ModuleDocument`s for
 *  imported modules — the local adapter alone can't read registry URLs, and
 *  `populateModuleDocument` only takes one adapter. */
export function createChainedManifestAdapter(
  localAdapter: ManifestAdapter,
  extraAdapters: ManifestAdapter[],
): ManifestAdapter {
  return {
    supports(url: string): boolean {
      return extraAdapters.some((a) => a.supports(url)) || localAdapter.supports(url);
    },
    async read(url: string): Promise<{ text: string; source: string }> {
      for (const a of extraAdapters) {
        if (a.supports(url)) return a.read(url);
      }
      return localAdapter.read(url);
    },
    resolveRelative(base: string, relative: string): string {
      return localAdapter.resolveRelative(base, relative);
    },
    expandGlob: localAdapter.expandGlob
      ? (base, patterns) => localAdapter.expandGlob!(base, patterns)
      : undefined,
    resolveOwnerOf: localAdapter.resolveOwnerOf
      ? (url) => localAdapter.resolveOwnerOf!(url)
      : undefined,
  };
}

export function createEditorLoader(
  localAdapter: ManifestAdapter,
  registryAdapters: ManifestAdapter[],
): Loader {
  try {
    return new LoaderCtor({
      extraAdapters: [...registryAdapters, localAdapter],
      includeRegistryAdapter: false,
    });
  } catch {
    const legacyAdapters = registryAdapters.length
      ? [...registryAdapters, localAdapter]
      : [registryFallbackBlocker, localAdapter];
    return new LoaderCtor(legacyAdapters);
  }
}

// ---------------------------------------------------------------------------
// Module document population
// ---------------------------------------------------------------------------

/** Reads a file's text and parses it into a ModuleDocument, storing the
 *  result under `normalizePath(filePath)`. Safe to call repeatedly with the
 *  same path; re-parsing replaces the previous entry. On read failure the
 *  ModuleDocument is omitted entirely (not stored as a stub) so downstream
 *  `documents.get(...)` miss-vs-hit semantics stay unambiguous. */
export async function populateModuleDocument(
  filePath: string,
  documents: Map<string, ModuleDocument>,
  adapter: ManifestAdapter,
): Promise<void> {
  const key = normalizePath(filePath);
  try {
    const { text } = await adapter.read(filePath);
    documents.set(key, parseModuleDocument(filePath, text));
  } catch (err) {
    console.error(`Failed to read ${filePath} for ModuleDocument:`, err);
  }
}

/** After loadModule returns, walk the ResourceManifest[] for distinct
 *  `metadata.source` values and populate a ModuleDocument for any source
 *  path not already tracked. This catches partial files expanded from
 *  `include:` patterns — they're not in `modulePaths` (scanWorkspace only
 *  finds telo.yaml files), so without this pass they'd have no AST entry
 *  and post-load edits that target resources in partials would fail. */
export async function collectPartialDocuments(
  docs: ResourceManifest[],
  ownerPath: string,
  documents: Map<string, ModuleDocument>,
  adapter: ManifestAdapter,
): Promise<void> {
  const sources = new Set<string>();
  for (const doc of docs) {
    const src = (doc.metadata as { source?: unknown })?.source;
    if (typeof src === "string" && src !== ownerPath) sources.add(src);
  }
  for (const src of sources) {
    if (documents.has(normalizePath(src))) continue;
    await populateModuleDocument(src, documents, adapter);
  }
}

// ---------------------------------------------------------------------------
// Module-level metadata read
// ---------------------------------------------------------------------------

export async function readModuleMetadata(
  filePath: string,
  adapter: ManifestAdapter,
): Promise<string | null> {
  try {
    const loader = createEditorLoader(adapter, []);
    const docs = (await loader.loadModule(filePath)) as ResourceManifest[];
    const moduleDoc = docs.find((d) => isModuleKind(d.kind));
    return (moduleDoc?.metadata.name as string | undefined) ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Subgraph merging
// ---------------------------------------------------------------------------

/** Loads the sub-graph reachable from `entryPath` into the mutable maps and
 *  returns the actual root URL the entry resolved to (which may differ from
 *  the input — e.g. registry adapters expand to a full URL). All resources
 *  and graph edges in the sub-graph are added; nothing that already exists
 *  in the maps is overwritten. */
async function mergeSubGraph(
  entryPath: string,
  modules: Map<string, ParsedManifest>,
  importGraph: Map<string, Set<string>>,
  importedBy: Map<string, Set<string>>,
  documents: Map<string, ModuleDocument>,
  adapter: ManifestAdapter,
  extraAdapters: ManifestAdapter[],
): Promise<string> {
  const inMemoryAdapter = createInMemoryManifestAdapter(documents, adapter);
  const loader = createEditorLoader(inMemoryAdapter, extraAdapters);
  const subGraph = await loader.loadModuleGraph(entryPath, (url, err) => {
    console.error(`Failed to load module ${url}:`, err);
  });

  // Registry/remote adapters may resolve `entryPath` to a differently-keyed URL.
  let actualRoot = entryPath;
  if (!subGraph.has(entryPath) && subGraph.size > 0) {
    actualRoot = subGraph.keys().next().value as string;
  }

  // Chained adapter so ModuleDocument population can read registry URLs —
  // the bare local adapter only supports disk paths and silently fails for
  // anything served by a registry/remote extra adapter.
  const chainedAdapter = createChainedManifestAdapter(adapter, extraAdapters);

  for (const [filePath, docs] of subGraph) {
    if (modules.has(filePath)) continue;
    const parsed = buildParsedManifest(filePath, docs);
    const subDeps = new Set<string>();
    const resolvedImports = parsed.imports.map((imp) => {
      const depPath = resolveDepPath(adapter, filePath, imp.source);
      if (subGraph.has(depPath)) {
        subDeps.add(depPath);
        if (!importedBy.has(depPath)) importedBy.set(depPath, new Set());
        importedBy.get(depPath)!.add(filePath);
      }
      return { ...imp, resolvedPath: depPath };
    });
    modules.set(filePath, { ...parsed, imports: resolvedImports });
    importGraph.set(filePath, subDeps);

    // Populate ModuleDocument for the newly loaded module (owner file plus
    // any partial files it declared via `include:`).
    if (!documents.has(normalizePath(filePath))) {
      await populateModuleDocument(filePath, documents, chainedAdapter);
    }
    await collectPartialDocuments(docs, filePath, documents, chainedAdapter);
  }

  return actualRoot;
}

// ---------------------------------------------------------------------------
// Import reconciliation
// ---------------------------------------------------------------------------

/**
 * Loads sub-graphs for any imports in the active module that aren't already in
 * the workspace's module map. Call this after replacing a manifest (e.g. from
 * source editing) to resolve newly-added or changed imports.
 */
export async function reconcileImports(
  workspace: Workspace,
  modulePath: string,
  adapter: ManifestAdapter,
  extraAdapters: ManifestAdapter[] = [],
): Promise<Workspace> {
  const manifest = workspace.modules.get(modulePath);
  if (!manifest) return workspace;

  const modules = new Map(workspace.modules);
  const importGraph = new Map(workspace.importGraph);
  const importedBy = new Map(workspace.importedBy);
  const documents = new Map(workspace.documents);
  const prevDeps = new Set(importGraph.get(modulePath) ?? []);
  const deps = new Set<string>();

  const resolvedImports: ParsedImport[] = [];
  for (const imp of manifest.imports) {
    let resolvedPath = imp.resolvedPath ?? resolveDepPath(adapter, modulePath, imp.source);

    if (!modules.has(resolvedPath)) {
      try {
        resolvedPath = await mergeSubGraph(
          resolvedPath,
          modules,
          importGraph,
          importedBy,
          documents,
          adapter,
          extraAdapters,
        );
      } catch {
        // Import loading failed — leave it unresolved at the originally-resolved path.
      }
    }

    resolvedImports.push({ ...imp, resolvedPath });
    deps.add(resolvedPath);

    if (!importedBy.has(resolvedPath)) importedBy.set(resolvedPath, new Set());
    importedBy.get(resolvedPath)!.add(modulePath);
  }

  modules.set(modulePath, { ...manifest, imports: resolvedImports });

  // Prune stale reverse edges for imports that were removed in this edit.
  // Without this, a source-edit deletion would leave the old dep listed in
  // importedBy, so the no-importers badge wouldn't reappear until a full
  // workspace reload.
  for (const stale of prevDeps) {
    if (deps.has(stale)) continue;
    const parents = importedBy.get(stale);
    if (!parents) continue;
    parents.delete(modulePath);
    if (parents.size === 0) importedBy.delete(stale);
  }

  importGraph.set(modulePath, deps);
  const resourceDocIndex = buildResourceDocIndex(modules, documents);
  return { rootDir: workspace.rootDir, modules, importGraph, importedBy, documents, resourceDocIndex };
}

// ---------------------------------------------------------------------------
// Import-via-AST operations (mutate AST, then reload the affected subgraph)
// ---------------------------------------------------------------------------

/** Inserts a `Telo.Import` document into the owner module's AST, re-derives
 *  the ParsedManifest (which projects the new import with
 *  `resolvedPath: undefined`), then reconciles imports to resolve the new
 *  target's sub-graph and wire `importGraph` / `importedBy` edges.
 *
 *  Routing through `reconcileImports` (not the legacy `addImport`) is
 *  deliberate: `rebuildManifestFromDocuments` already places the new
 *  import into `manifest.imports` from the AST, so any helper that
 *  *appends* to that list would produce a duplicate entry.
 *  `reconcileImports` iterates the existing import list, resolves each
 *  one, and updates graph state without appending. */
export async function addImportViaAst(
  workspace: Workspace,
  modulePath: string,
  imp: ParsedImport,
  manifestAdapter: ManifestAdapter,
  extraAdapters: ManifestAdapter[] = [],
): Promise<Workspace> {
  const key = normalizePath(modulePath);
  const modDoc = workspace.documents.get(key);
  if (!modDoc) return workspace;

  const docs = addImportDocument(modDoc.docs, imp.name, imp.source, {
    variables: imp.variables,
    secrets: imp.secrets,
  });
  const astOnly = withModuleDocument(workspace, modulePath, { ...modDoc, docs });
  const rebuilt = rebuildManifestFromDocuments(astOnly, modulePath);
  return reconcileImports(rebuilt, modulePath, manifestAdapter, extraAdapters);
}

/** Removes a `Telo.Import` document from the owner module's AST and
 *  reconciles the import graph (pruning reverse edges for the dropped
 *  target). */
export async function removeImportViaAst(
  workspace: Workspace,
  modulePath: string,
  name: string,
  manifestAdapter: ManifestAdapter,
  extraAdapters: ManifestAdapter[] = [],
): Promise<Workspace> {
  const key = normalizePath(modulePath);
  const modDoc = workspace.documents.get(key);
  if (!modDoc) return workspace;

  const docs = removeImportDocument(modDoc.docs, name);
  if (docs === modDoc.docs) return workspace;

  const astOnly = withModuleDocument(workspace, modulePath, { ...modDoc, docs });
  const rebuilt = rebuildManifestFromDocuments(astOnly, modulePath);
  return reconcileImports(rebuilt, modulePath, manifestAdapter, extraAdapters);
}

/** Removes the old import and inserts a new one with the same alias but a
 *  different source. Resolves the new target's sub-graph via
 *  `addImportViaAst`'s reconcile step. */
export async function upgradeImportViaAst(
  workspace: Workspace,
  modulePath: string,
  name: string,
  newSource: string,
  manifestAdapter: ManifestAdapter,
  extraAdapters: ManifestAdapter[] = [],
): Promise<Workspace> {
  const after = await removeImportViaAst(
    workspace,
    modulePath,
    name,
    manifestAdapter,
    extraAdapters,
  );
  return addImportViaAst(
    after,
    modulePath,
    { name, source: newSource, importKind: classifyImport(newSource) },
    manifestAdapter,
    extraAdapters,
  );
}

/** Exported for `loadWorkspace` orchestration in the parent file; not part
 *  of the public editor API. */
export { resolveDepPath };
