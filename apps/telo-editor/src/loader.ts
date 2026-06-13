import type { LoadedFile, LoadedModule, ManifestSource } from "@telorun/analyzer";
import { DEFAULT_MANIFEST_FILENAME, flattenLoadedModule } from "@telorun/analyzer";
import type {
  DirEntry,
  ModuleDocument,
  ParsedManifest,
  Workspace,
  WorkspaceAdapter,
} from "./model";
import {
  SCAN_EXCLUDED_NAMES,
  SCAN_EXCLUDED_RELATIVE_PATHS,
  normalizePath,
  pathJoin,
} from "./loader/paths";
import { buildFailureManifest, buildParsedManifest } from "./loader/parse";
import { buildResourceDocIndex } from "./loader/ast-ops";
import { createEditorLoader, resolveDepPath } from "./loader/subgraph";
import { moduleDocumentFromLoaded } from "./yaml-document";

export {
  SCAN_EXCLUDED_NAMES,
  SCAN_EXCLUDED_RELATIVE_PATHS,
  hasGlobChars,
  normalizePath,
  toPascalCase,
  toRelativeSource,
} from "./loader/paths";
export {
  createRegistryAdapters,
  fetchAvailableVersions,
  fetchLatestVersion,
  isRegistryImportSource,
  parseRegistryRef,
} from "./loader/registry";
export type { RegistryVersion } from "./loader/registry";
export {
  buildFailureManifest,
  buildParsedManifest,
  classifyImport,
} from "./loader/parse";
export {
  applyOpsToDocument,
  createResourceViaAst,
  hasUnresolvedImports,
  rebuildManifestFromDocuments,
  removeResourceViaAst,
  setResourceFields,
} from "./loader/ast-ops";
export {
  addImportViaAst,
  reconcileImports,
  readModuleMetadata,
  removeImportViaAst,
  upgradeImportViaAst,
} from "./loader/subgraph";
export {
  createModule,
  deleteModule,
  persistWorkspaceModule,
  saveModuleFromDocuments,
} from "./loader/crud";
export type { CreateModuleOptions } from "./loader/crud";
export {
  isInTauri,
  noopAdapter,
  openWorkspaceDirectory,
  reopenWorkspaceAt,
} from "./loader/open";
export type { OpenedWorkspace } from "./loader/open";
export {
  buildRemoteImportPlan,
  createVirtualWorkspaceAdapter,
  clearManifestUrlParam,
  fetchRemoteManifest,
  manifestExists,
  readManifestUrlParam,
  slugifyModuleName,
  workspacePathFor,
  writeRemoteImportPlan,
  OPEN_PARAM,
  VIRTUAL_WORKSPACE_ROOT,
} from "./loader/remote";
export type { RemoteImportPlan, PlanFile, RemoteManifest } from "./loader/remote";
export {
  getAvailableKinds,
  hasApplicationImporter,
  isWorkspaceModule,
} from "./loader/queries";
export { buildFileTree } from "./loader/file-tree";
export type { FileNode } from "./loader/file-tree";

// ---------------------------------------------------------------------------
// Workspace scan
// ---------------------------------------------------------------------------

/**
 * Walks the workspace root and returns paths of every `telo.yaml` found,
 * skipping SCAN_EXCLUSIONS directories.
 */
export async function scanWorkspace(
  rootDir: string,
  adapter: WorkspaceAdapter,
): Promise<string[]> {
  const found: string[] = [];
  const rootPrefix = rootDir.endsWith("/") ? rootDir : rootDir + "/";

  function isExcluded(fullPath: string, name: string): boolean {
    if (SCAN_EXCLUDED_NAMES.has(name)) return true;
    const rel = fullPath.startsWith(rootPrefix) ? fullPath.slice(rootPrefix.length) : fullPath;
    return SCAN_EXCLUDED_RELATIVE_PATHS.includes(rel);
  }

  async function walk(dir: string): Promise<void> {
    let entries: DirEntry[];
    try {
      entries = await adapter.listDir(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = pathJoin(dir, entry.name);
      if (isExcluded(fullPath, entry.name)) continue;
      if (entry.isDirectory) {
        await walk(fullPath);
      } else if (entry.name === DEFAULT_MANIFEST_FILENAME) {
        found.push(fullPath);
      }
    }
  }

  await walk(rootDir);
  return found;
}

// ---------------------------------------------------------------------------
// Full workspace load
// ---------------------------------------------------------------------------

/**
 * Loads every module in the workspace directory tree, then resolves each
 * module's imports: workspace-local imports are wired to already-loaded
 * modules; registry/remote imports have their sub-graphs loaded.
 *
 * Uses the analyzer Loader's canonical load result (`loadModule` /
 * `loadGraph`) as the single source of truth for parsed text, AST, and
 * positions. The editor never re-parses the same file: every
 * `ModuleDocument` is projected from a `LoadedFile` produced by the Loader.
 *
 * With `opts.deferExternalDeps`, only the workspace's own (local) modules are
 * loaded so the editor can render immediately; external dependency graphs are
 * fetched separately via `loadWorkspaceDependencies` and folded in with
 * `mergeWorkspaceDependencies`. The returned workspace carries
 * `dependenciesPending: true` until that merge happens.
 */
export async function loadWorkspace(
  rootDir: string,
  manifestAdapter: ManifestSource,
  workspaceAdapter: WorkspaceAdapter,
  extraAdapters: ManifestSource[] = [],
  opts: { deferExternalDeps?: boolean } = {},
): Promise<Workspace> {
  const modulePaths = await scanWorkspace(rootDir, workspaceAdapter);

  const modules = new Map<string, ParsedManifest>();
  const documents = new Map<string, ModuleDocument>();

  const loader = createEditorLoader(manifestAdapter, extraAdapters);

  // Phase 1: load each workspace module via the analyzer Loader. Each
  // `LoadedModule` carries the owner file plus every `include:`-expanded
  // partial as fully-parsed `LoadedFile`s — no separate populate pass. The
  // per-file loads run concurrently (disk/parse-bound, independent); results
  // are registered in `modulePaths` order so the shared maps stay
  // deterministic and race-free.
  const loadedModules = await Promise.all(
    modulePaths.map(
      async (
        filePath,
      ): Promise<
        | { filePath: string; lm: LoadedModule }
        | { filePath: string; failure: ParsedManifest }
      > => {
        try {
          return { filePath, lm: await loader.loadModule(filePath) };
        } catch (err) {
          console.error(`Failed to load workspace module ${filePath}:`, err);
          return { filePath, failure: await buildFailureManifest(filePath, err, workspaceAdapter) };
        }
      },
    ),
  );
  for (const entry of loadedModules) {
    if ("lm" in entry) registerLoadedModule(entry.lm, documents, modules, entry.filePath);
    else modules.set(entry.filePath, entry.failure);
  }

  // Phase 2a: load external (registry/remote/library) dependency graphs. When
  // `deferExternalDeps` is set the caller renders the workspace with only its
  // local modules and streams these in later via `loadWorkspaceDependencies` —
  // external fetches dominate (and vary wildly with) load time, so keeping them
  // off the first-paint path is the difference between ~100ms and 1s+.
  const canonicalByRawInput = opts.deferExternalDeps
    ? new Map<string, string>()
    : await loadExternalDeps(modules, loader, manifestAdapter, workspaceAdapter, modules, documents);

  return finalizeWorkspace(
    rootDir,
    modules,
    documents,
    manifestAdapter,
    canonicalByRawInput,
    opts.deferExternalDeps ?? false,
  );
}

/** The external dependency graphs fetched for a workspace, ready to be merged
 *  into the already-rendered local workspace. */
export interface WorkspaceDependencies {
  depModules: Map<string, ParsedManifest>;
  depDocuments: Map<string, ModuleDocument>;
  canonicalByRawInput: Map<string, string>;
}

/** Background companion to `loadWorkspace(..., { deferExternalDeps: true })`:
 *  fetches every external dependency graph the local modules import, into fresh
 *  maps that `mergeWorkspaceDependencies` folds into the live workspace without
 *  disturbing local edits made while the fetch was in flight. */
export async function loadWorkspaceDependencies(
  base: Workspace,
  manifestAdapter: ManifestSource,
  workspaceAdapter: WorkspaceAdapter,
  extraAdapters: ManifestSource[] = [],
): Promise<WorkspaceDependencies> {
  const loader = createEditorLoader(manifestAdapter, extraAdapters);
  const depModules = new Map<string, ParsedManifest>();
  const depDocuments = new Map<string, ModuleDocument>();
  const canonicalByRawInput = await loadExternalDeps(
    base.modules,
    loader,
    manifestAdapter,
    workspaceAdapter,
    depModules,
    depDocuments,
  );
  return { depModules, depDocuments, canonicalByRawInput };
}

/** Folds background-loaded dependency graphs into the current workspace.
 *  Local modules in `current` win (preserving edits made during the fetch);
 *  only dep modules/documents not already present are added, then import wiring
 *  and the resource index are rebuilt with the canonical paths now known. */
export function mergeWorkspaceDependencies(
  current: Workspace,
  deps: WorkspaceDependencies,
  manifestAdapter: ManifestSource,
): Workspace {
  const modules = new Map(current.modules);
  for (const [key, value] of deps.depModules) if (!modules.has(key)) modules.set(key, value);
  const documents = new Map(current.documents);
  for (const [key, value] of deps.depDocuments) if (!documents.has(key)) documents.set(key, value);
  return finalizeWorkspace(current.rootDir, modules, documents, manifestAdapter, deps.canonicalByRawInput, false);
}

/**
 * Fetches every external (registry/remote/library) dependency graph imported by
 * `knownModules`, registering newly-discovered modules into `outModules` /
 * `outDocuments`. `local` imports normally point at a scanned `telo.yaml`
 * module (already in `knownModules`, skipped); a local import that isn't
 * scanned — e.g. a flat sibling file copied in by a remote-open cascade — is
 * loaded here too, read through the local adapter.
 *
 * Registry/remote sources may resolve a raw input ref (`std/foo@1.0.0`) to a
 * different canonical URL (e.g. `registry://std/foo@1.0.0/telo.yaml`). The
 * returned `canonicalByRawInput` map lets `finalizeWorkspace` set each import's
 * `resolvedPath` to the canonical key — otherwise `analyzeWorkspace` looks up
 * the imported library's identity by the raw ref and misses, leaving every
 * imported `Telo.Definition` invisible to alias resolution.
 */
async function loadExternalDeps(
  knownModules: Map<string, ParsedManifest>,
  loader: ReturnType<typeof createEditorLoader>,
  manifestAdapter: ManifestSource,
  workspaceAdapter: WorkspaceAdapter,
  outModules: Map<string, ParsedManifest>,
  outDocuments: Map<string, ModuleDocument>,
): Promise<Map<string, string>> {
  const canonicalByRawInput = new Map<string, string>();
  const has = (path: string) => knownModules.has(path) || outModules.has(path);

  const externalDepPaths: string[] = [];
  const seenDeps = new Set<string>();
  for (const parsed of knownModules.values()) {
    for (const imp of parsed.imports) {
      const depPath = resolveDepPath(manifestAdapter, parsed.filePath, imp.source);
      if (has(depPath) || seenDeps.has(depPath)) continue;
      seenDeps.add(depPath);
      externalDepPaths.push(depPath);
    }
  }
  // Fetch each dep's sub-graph concurrently (network/IO-bound, independent),
  // then register results sequentially so cross-graph overlap is deduped by
  // the `has` check.
  const loadedGraphs = await Promise.all(
    externalDepPaths.map(
      async (
        depPath,
      ): Promise<
        | { depPath: string; graph: Awaited<ReturnType<typeof loader.loadGraph>> }
        | { depPath: string; error: unknown }
      > => {
        try {
          return { depPath, graph: await loader.loadGraph(depPath) };
        } catch (err) {
          return { depPath, error: err };
        }
      },
    ),
  );
  for (const entry of loadedGraphs) {
    if ("graph" in entry) {
      const { depPath, graph } = entry;
      canonicalByRawInput.set(depPath, graph.rootSource);
      for (const [, subModule] of graph.modules) {
        const subOwner = subModule.owner.source;
        if (!has(subOwner)) registerLoadedModule(subModule, outDocuments, outModules, subOwner);
      }
      for (const e of graph.errors) {
        if (has(e.url)) continue;
        outModules.set(e.url, await buildFailureManifest(e.url, e.error, workspaceAdapter));
      }
    } else if (!has(entry.depPath)) {
      outModules.set(
        entry.depPath,
        await buildFailureManifest(entry.depPath, entry.error, workspaceAdapter),
      );
    }
  }
  return canonicalByRawInput;
}

/** Phase 2b + index: rebuild each module's imports with `resolvedPath` set
 *  (using the canonical URLs learned while loading dep graphs) and wire up the
 *  import graph edges, then build the resource→document index. */
function finalizeWorkspace(
  rootDir: string,
  modules: Map<string, ParsedManifest>,
  documents: Map<string, ModuleDocument>,
  manifestAdapter: ManifestSource,
  canonicalByRawInput: Map<string, string>,
  dependenciesPending: boolean,
): Workspace {
  const importGraph = new Map<string, Set<string>>();
  const importedBy = new Map<string, Set<string>>();
  for (const [filePath, parsed] of [...modules.entries()]) {
    const deps = new Set<string>();
    const resolvedImports = parsed.imports.map((imp) => {
      const rawDep = resolveDepPath(manifestAdapter, filePath, imp.source);
      const depPath = canonicalByRawInput.get(rawDep) ?? rawDep;
      deps.add(depPath);
      if (!importedBy.has(depPath)) importedBy.set(depPath, new Set());
      importedBy.get(depPath)!.add(filePath);
      return { ...imp, resolvedPath: depPath };
    });
    modules.set(filePath, { ...parsed, imports: resolvedImports });
    importGraph.set(filePath, deps);
  }

  const resourceDocIndex = buildResourceDocIndex(modules, documents);
  const workspace: Workspace = {
    rootDir,
    modules,
    importGraph,
    importedBy,
    documents,
    resourceDocIndex,
  };
  if (dependenciesPending) workspace.dependenciesPending = true;
  return workspace;
}

/** Project a `LoadedModule` (owner + partials) into the editor's
 *  `documents` map and `modules` map. Each `LoadedFile` becomes a
 *  `ModuleDocument` keyed by canonical path; the owner's manifests feed the
 *  `ParsedManifest` projection for the analyzer-facing view. */
function registerLoadedModule(
  lm: LoadedModule,
  documents: Map<string, ModuleDocument>,
  modules: Map<string, ParsedManifest>,
  ownerFilePath: string,
): void {
  registerLoadedFile(lm.owner, ownerFilePath, documents);
  for (const partial of lm.partials) {
    registerLoadedFile(partial, partial.source, documents);
  }
  modules.set(ownerFilePath, buildParsedManifest(ownerFilePath, flattenLoadedModule(lm)));
}

function registerLoadedFile(
  loaded: LoadedFile,
  filePath: string,
  documents: Map<string, ModuleDocument>,
): void {
  const key = normalizePath(filePath);
  if (documents.has(key)) return;
  documents.set(key, moduleDocumentFromLoaded(filePath, loaded));
}

