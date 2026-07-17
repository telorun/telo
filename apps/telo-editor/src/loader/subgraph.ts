import type { ManifestSource } from "@telorun/analyzer";
import {
  HttpSource,
  Loader,
  ManifestCacheSource,
  flattenLoadedModule,
  isModuleKind,
} from "@telorun/analyzer";
import type { ResourceManifest } from "@telorun/sdk";
import type {
  ModuleDocument,
  ParsedImport,
  ParsedManifest,
  Workspace,
} from "../model";
import {
  addImportDocument,
  moduleDocumentFromLoaded,
  removeImportDocument,
  removeInlineImport,
  setInlineImportSource,
} from "../yaml-document";
import { normalizePath } from "./paths";
import { isRegistryImportSource } from "./registry";
import { buildParsedManifest, classifyImport } from "./parse";
import {
  buildResourceDocIndex,
  rebuildManifestFromDocuments,
  withDocs,
  withModuleDocument,
} from "./ast-ops";

// ---------------------------------------------------------------------------
// Loader wiring
// ---------------------------------------------------------------------------

const registryFallbackBlocker: ManifestSource = {
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

function resolveDepPath(adapter: ManifestSource, filePath: string, source: string): string {
  return source.startsWith(".") || source.startsWith("/")
    ? adapter.resolveRelative(filePath, source)
    : source;
}

export function createEditorLoader(
  localAdapter: ManifestSource,
  registryAdapters: ManifestSource[],
): Loader {
  // The editor supplies its own registry adapters, so it takes the built-in
  // HTTP source but not the built-in RegistrySource. The blocker sits right
  // after them unconditionally: an enabled registry server claims its refs
  // first, and a registry ref nothing claims (none configured, or the array
  // holds only a settings-sourced manifest-cache adapter) fails with the
  // actionable "configure a registry" message instead of a local read error.
  // A browser can't speak the OCI protocol, so `oci://` imports resolve
  // against the hub's static manifest cache — a settings-sourced adapter in
  // `registryAdapters` wins over the built-in default, and both come before
  // the local adapter, which would otherwise claim the ref.
  return new Loader([
    ...registryAdapters,
    registryFallbackBlocker,
    new ManifestCacheSource(),
    localAdapter,
    new HttpSource(),
  ]);
}

// ---------------------------------------------------------------------------
// Module-level metadata read
// ---------------------------------------------------------------------------

export async function readModuleMetadata(
  filePath: string,
  adapter: ManifestSource,
): Promise<string | null> {
  try {
    const loader = createEditorLoader(adapter, []);
    const lm = await loader.loadModule(filePath);
    const moduleDoc = lm.owner.manifests.find((m) => m && isModuleKind(m.kind));
    return (moduleDoc?.metadata?.name as string | undefined) ?? null;
  } catch {
    return null;
  }
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
  adapter: ManifestSource,
  extraAdapters: ManifestSource[] = [],
): Promise<Workspace> {
  const manifest = workspace.modules.get(modulePath);
  if (!manifest) return workspace;

  const modules = new Map(workspace.modules);
  const importGraph = new Map(workspace.importGraph);
  const importedBy = new Map(workspace.importedBy);
  const documents = new Map(workspace.documents);
  const prevDeps = new Set(importGraph.get(modulePath) ?? []);
  const deps = new Set<string>();

  const loader = createEditorLoader(adapter, extraAdapters);

  const resolvedImports: ParsedImport[] = [];
  for (const imp of manifest.imports) {
    let resolvedPath = imp.resolvedPath ?? resolveDepPath(adapter, modulePath, imp.source);

    if (!modules.has(resolvedPath)) {
      try {
        const graph = await loader.loadGraph(resolvedPath);
        for (const e of graph.errors) {
          console.error(`Failed to load module ${e.url}:`, e.error);
        }
        // Registry/remote adapters may resolve `resolvedPath` to a different URL.
        resolvedPath = graph.rootSource;
        for (const [canonical, lm] of graph.modules) {
          if (modules.has(canonical)) continue;
          const flat = flattenLoadedModule(lm);
          const parsed = buildParsedManifest(canonical, flat);
          const subDeps = new Set<string>();
          const subResolvedImports = parsed.imports.map((subImp) => {
            const depPath = resolveDepPath(adapter, canonical, subImp.source);
            if (graph.modules.has(depPath)) {
              subDeps.add(depPath);
              if (!importedBy.has(depPath)) importedBy.set(depPath, new Set());
              importedBy.get(depPath)!.add(canonical);
            }
            return { ...subImp, resolvedPath: depPath };
          });
          modules.set(canonical, { ...parsed, imports: subResolvedImports });
          importGraph.set(canonical, subDeps);

          const ownerKey = normalizePath(canonical);
          if (!documents.has(ownerKey)) {
            documents.set(ownerKey, moduleDocumentFromLoaded(canonical, lm.owner));
          }
          for (const partial of lm.partials) {
            const pKey = normalizePath(partial.source);
            if (!documents.has(pKey)) {
              documents.set(pKey, moduleDocumentFromLoaded(partial.source, partial));
            }
          }
        }
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
  manifestAdapter: ManifestSource,
  extraAdapters: ManifestSource[] = [],
): Promise<Workspace> {
  const key = normalizePath(modulePath);
  const modDoc = workspace.documents.get(key);
  if (!modDoc) return workspace;

  const docs = addImportDocument(modDoc.loaded.documents, imp.name, imp.source, {
    variables: imp.variables,
    secrets: imp.secrets,
  });
  const astOnly = withModuleDocument(workspace, modulePath, withDocs(modDoc, docs));
  const rebuilt = rebuildManifestFromDocuments(astOnly, modulePath);
  return reconcileImports(rebuilt, modulePath, manifestAdapter, extraAdapters);
}

/** True when the named import in `modulePath` lives in the inline `imports:`
 *  map (vs. a standalone `Telo.Import` document). Determines which AST
 *  write-back path edits it. */
function isInlineImport(workspace: Workspace, modulePath: string, name: string): boolean {
  const imp = workspace.modules.get(modulePath)?.imports.find((i) => i.name === name);
  return imp?.inline === true;
}

/** Removes an import from the owner module's AST and reconciles the import
 *  graph. Edits the import in whatever form it lives — an inline `imports:`
 *  map entry or a standalone `Telo.Import` document — so removal works for both. */
export async function removeImportViaAst(
  workspace: Workspace,
  modulePath: string,
  name: string,
  manifestAdapter: ManifestSource,
  extraAdapters: ManifestSource[] = [],
): Promise<Workspace> {
  const key = normalizePath(modulePath);
  const modDoc = workspace.documents.get(key);
  if (!modDoc) return workspace;

  const docs = isInlineImport(workspace, modulePath, name)
    ? removeInlineImport(modDoc.loaded.documents, name)
    : removeImportDocument(modDoc.loaded.documents, name);
  if (docs === modDoc.loaded.documents) return workspace;

  const astOnly = withModuleDocument(workspace, modulePath, withDocs(modDoc, docs));
  const rebuilt = rebuildManifestFromDocuments(astOnly, modulePath);
  return reconcileImports(rebuilt, modulePath, manifestAdapter, extraAdapters);
}

/** Points an import at a new source. An inline `imports:` entry is rewritten in
 *  place in the map (preserving its `variables` / `secrets` / `runtime`); a
 *  standalone `Telo.Import` document is removed and re-added. The two paths are
 *  distinct: rewriting an inline import via remove+add would drop the map entry
 *  and add an authored doc with the same alias — a `DUPLICATE_IMPORT_ALIAS`. */
export async function upgradeImportViaAst(
  workspace: Workspace,
  modulePath: string,
  name: string,
  newSource: string,
  manifestAdapter: ManifestSource,
  extraAdapters: ManifestSource[] = [],
): Promise<Workspace> {
  if (isInlineImport(workspace, modulePath, name)) {
    const key = normalizePath(modulePath);
    const modDoc = workspace.documents.get(key);
    if (!modDoc) return workspace;
    const docs = setInlineImportSource(modDoc.loaded.documents, name, newSource);
    if (docs === modDoc.loaded.documents) return workspace;
    const astOnly = withModuleDocument(workspace, modulePath, withDocs(modDoc, docs));
    const rebuilt = rebuildManifestFromDocuments(astOnly, modulePath);
    return reconcileImports(rebuilt, modulePath, manifestAdapter, extraAdapters);
  }

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
