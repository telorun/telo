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
 */
export async function loadWorkspace(
  rootDir: string,
  manifestAdapter: ManifestSource,
  workspaceAdapter: WorkspaceAdapter,
  extraAdapters: ManifestSource[] = [],
): Promise<Workspace> {
  const modulePaths = await scanWorkspace(rootDir, workspaceAdapter);

  const modules = new Map<string, ParsedManifest>();
  const importGraph = new Map<string, Set<string>>();
  const importedBy = new Map<string, Set<string>>();
  const documents = new Map<string, ModuleDocument>();

  const loader = createEditorLoader(manifestAdapter, extraAdapters);

  // Phase 1: load each workspace module via the analyzer Loader. Each
  // `LoadedModule` carries the owner file plus every `include:`-expanded
  // partial as fully-parsed `LoadedFile`s — no separate populate pass.
  for (const filePath of modulePaths) {
    try {
      const lm = await loader.loadModule(filePath);
      registerLoadedModule(lm, documents, modules, filePath);
    } catch (err) {
      console.error(`Failed to load workspace module ${filePath}:`, err);
      modules.set(filePath, await buildFailureManifest(filePath, err, workspaceAdapter));
    }
  }

  // Phase 2a: load external (registry/remote) import targets via `loadGraph`.
  // The Loader's source chain handles registry URLs natively; the editor no
  // longer needs an in-memory adapter or chained adapter to bridge between
  // local and remote sources. Failures surface as placeholder
  // ParsedManifests so the importer UI can show the error inline.
  //
  // Registry/remote sources may resolve a raw input ref (`std/foo@1.0.0`) to
  // a different canonical URL (e.g. `registry://std/foo@1.0.0/telo.yaml`).
  // Phase 2b needs that canonical URL to set `resolvedPath` so it matches
  // the `modules` map's key — otherwise `analyzeWorkspace` looks up the
  // imported library's identity by the raw ref and misses, leaving every
  // imported `Telo.Definition` invisible to alias resolution.
  const canonicalByRawInput = new Map<string, string>();
  for (const parsed of modules.values()) {
    for (const imp of parsed.imports) {
      // `local` imports normally point at a scanned `telo.yaml` module (already
      // in `modules`, skipped by the has-check below). A local import that
      // isn't scanned — e.g. a flat sibling file copied in by a remote-open
      // cascade — is loaded here just like an external one, reading the file
      // through the local adapter.
      const depPath = resolveDepPath(manifestAdapter, parsed.filePath, imp.source);
      if (modules.has(depPath)) continue;
      try {
        const graph = await loader.loadGraph(depPath);
        canonicalByRawInput.set(depPath, graph.rootSource);
        for (const [, subModule] of graph.modules) {
          const subOwner = subModule.owner.source;
          if (!modules.has(subOwner)) {
            registerLoadedModule(subModule, documents, modules, subOwner);
          }
        }
        for (const e of graph.errors) {
          if (modules.has(e.url)) continue;
          modules.set(e.url, await buildFailureManifest(e.url, e.error, workspaceAdapter));
        }
      } catch (err) {
        if (!modules.has(depPath)) {
          modules.set(depPath, await buildFailureManifest(depPath, err, workspaceAdapter));
        }
      }
    }
  }

  // Phase 2b: rebuild each module's imports with resolvedPath set, and wire
  // up graph edges. For registry/remote imports use the canonical URL learned
  // in Phase 2a; for everything else `resolveDepPath` is the canonical key.
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
  return { rootDir, modules, importGraph, importedBy, documents, resourceDocIndex };
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

