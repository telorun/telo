import type { ManifestSource } from "@telorun/analyzer";
import { DEFAULT_MANIFEST_FILENAME } from "@telorun/analyzer";
import type { ResourceManifest } from "@telorun/sdk";
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
import {
  collectPartialDocuments,
  createChainedManifestSource,
  createEditorLoader,
  createInMemoryManifestSource,
  populateModuleDocument,
  resolveDepPath,
} from "./loader/subgraph";

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
  getAvailableKinds,
  hasApplicationImporter,
  isWorkspaceModule,
} from "./loader/queries";

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

  // Phase 0: pre-populate documents for every scanned owner file. One disk
  // read per file; the in-memory adapter below serves subsequent reads of the
  // same file (including from inside the analyzer Loader) from this cache.
  for (const filePath of modulePaths) {
    await populateModuleDocument(filePath, documents, manifestAdapter);
  }

  // Fresh Loader per loadWorkspace call, backed by an in-memory adapter that
  // reads from `documents` and falls through to disk for files not yet
  // tracked (partial include targets, external imports). See the plan's
  // "Analyzer Loader is instantiated fresh per call" decision.
  const loader = createEditorLoader(
    createInMemoryManifestSource(documents, manifestAdapter),
    extraAdapters,
  );

  // Phase 1: parse every discovered module (includes expand during loadModule).
  // After each load, walk the returned manifests for any partial-file source
  // paths (from `include:` expansion) and populate their ModuleDocument too.
  for (const filePath of modulePaths) {
    try {
      const docs = (await loader.loadModule(filePath)) as ResourceManifest[];
      modules.set(filePath, buildParsedManifest(filePath, docs));
      await collectPartialDocuments(docs, filePath, documents, manifestAdapter);
    } catch (err) {
      console.error(`Failed to load workspace module ${filePath}:`, err);
      // Register a placeholder so the module still appears in the workspace
      // tree and the user can open its source to fix the parse issue.
      modules.set(filePath, await buildFailureManifest(filePath, err, workspaceAdapter));
    }
  }

  // Phase 2a: load external (registry/remote) import targets into the modules
  // map so Phase 2b can resolve every edge without recursive sub-graph calls.
  // Populate a ModuleDocument for each imported owner so `analyzeWorkspace`
  // (which routes through `documents`) sees their Telo.Definition docs — the
  // bare `manifestAdapter` can't read registry URLs, so chain in extras.
  const chainedAdapter = createChainedManifestSource(manifestAdapter, extraAdapters);
  for (const parsed of modules.values()) {
    for (const imp of parsed.imports) {
      if (imp.importKind === "local") continue;
      const depPath = resolveDepPath(manifestAdapter, parsed.filePath, imp.source);
      if (modules.has(depPath)) continue;
      try {
        const subGraph = await loader.loadModuleGraph(depPath, (url, err) => {
          console.error(`Failed to load imported module ${url}:`, err);
        });
        for (const [subPath, subDocs] of subGraph) {
          if (modules.has(subPath)) continue;
          modules.set(subPath, buildParsedManifest(subPath, subDocs));
          if (!documents.has(normalizePath(subPath))) {
            await populateModuleDocument(subPath, documents, chainedAdapter);
          }
          await collectPartialDocuments(subDocs, subPath, documents, chainedAdapter);
        }
      } catch (err) {
        console.error(`Failed to resolve import ${imp.source} in ${parsed.filePath}:`, err);
      }
    }
  }

  // Phase 2b: rebuild each module's imports with resolvedPath set, and wire
  // up graph edges. Imports are produced as new ParsedImport objects; the
  // originals from Phase 1 parsing are discarded to keep the returned workspace
  // fully owned by this call (no shared mutable references with any caller).
  //
  // Iterate over a snapshot so this stays safe if a future edit ever inserts
  // new keys mid-loop — today's re-sets to existing keys are fine per Map
  // semantics, but snapshotting removes that implicit invariant.
  for (const [filePath, parsed] of [...modules.entries()]) {
    const deps = new Set<string>();
    const resolvedImports = parsed.imports.map((imp) => {
      const depPath = resolveDepPath(manifestAdapter, filePath, imp.source);
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

