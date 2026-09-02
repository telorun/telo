import { DEFAULT_MANIFEST_FILENAME } from "@telorun/analyzer";
import type { ManifestSource } from "@telorun/analyzer";
import type { ModuleKind, Workspace, WorkspaceAdapter } from "../model";
import {
  buildInitialModuleDocument,
  moduleParseError,
  parseModuleDocument,
  removeImportDocument,
  serializeModuleDocument,
} from "../yaml-document";
import { normalizePath, pathDirname, pathJoin } from "./paths";
import { buildResourceDocIndex, withDocs } from "./ast-ops";
import { slugifyModuleName } from "./remote";
import { fetchTemplateFiles, templateManifestUrl } from "./templates";
import type { TemplateDescriptor, TemplateFile } from "./templates";

/** What a new module is seeded from: an empty skeleton, or a starter template. */
export type NewModuleSelection =
  | { type: "blank" }
  | { type: "template"; template: TemplateDescriptor };

/** Thrown by `materializeModule` when the target directory already holds files
 *  and the caller has not opted into overwriting them. Carries the workspace-
 *  relative directory so the UI can name exactly what an overwrite destroys. */
export class ModuleExistsError extends Error {
  constructor(
    readonly moduleName: string,
    readonly relativeDir: string,
  ) {
    super(`A module already exists at "${relativeDir}".`);
    this.name = "ModuleExistsError";
  }
}

export interface MaterializeModuleOptions {
  kind: ModuleKind;
  name: string;
  selection: NewModuleSelection;
  /** Resolved templates base URL (used only for template selections). */
  templatesBaseUrl: string;
  manifestSources: ManifestSource[];
  overwrite?: boolean;
}

export interface MaterializedModule {
  moduleDir: string;
  rootPath: string;
}

/** Writes a new module to disk under `apps/<slug>` / `libs/<slug>` in `root`,
 *  seeded from a blank skeleton or a starter template. The full file set is
 *  built BEFORE any existing directory is deleted, so a template fetch failure
 *  (offline / CORS / 404 / self-containment escape) can never destroy the
 *  target — the operation is atomic enough. Throws `ModuleExistsError` when the
 *  target directory has content and `overwrite` is unset. Does not touch the
 *  in-memory workspace; the caller reloads. */
export async function materializeModule(
  adapter: WorkspaceAdapter,
  root: string,
  options: MaterializeModuleOptions,
): Promise<MaterializedModule> {
  const name = options.name.trim();
  if (!name) throw new Error("Module name cannot be empty");

  const slug = slugifyModuleName(name) || name;
  const subdir = options.kind === "Application" ? "apps" : "libs";
  const relativeDir = `${subdir}/${slug}`;
  const moduleDir = pathJoin(root, subdir, slug);
  const rootPath = pathJoin(moduleDir, DEFAULT_MANIFEST_FILENAME);

  // Probe the directory, not the module map: a folder with assets but no
  // telo.yaml still holds user content an overwrite would destroy.
  const occupied = await directoryHasContent(adapter, moduleDir);
  if (occupied && !options.overwrite) throw new ModuleExistsError(name, relativeDir);

  const files = await buildModuleFiles(name, options);

  if (occupied) await adapter.delete(moduleDir);
  for (const file of files) {
    const dest = pathJoin(moduleDir, file.relPath);
    await adapter.createDir(pathDirname(dest));
    await adapter.writeFile(dest, file.text);
  }
  return { moduleDir, rootPath };
}

/** Builds the file set to write — the blank skeleton, or a template's full
 *  fetched cascade with its `metadata.name` rewritten to `name`. */
async function buildModuleFiles(
  name: string,
  options: MaterializeModuleOptions,
): Promise<TemplateFile[]> {
  if (options.selection.type === "blank") {
    const doc = buildInitialModuleDocument(options.kind, name);
    return [{ relPath: DEFAULT_MANIFEST_FILENAME, text: serializeModuleDocument([doc]), isRoot: true }];
  }
  return fetchTemplateFiles(
    templateManifestUrl(options.templatesBaseUrl, options.selection.template),
    name,
    options.manifestSources,
  );
}

/** True when `dir` exists and is non-empty. A missing directory (listDir throws
 *  or is empty) is treated as free — the caller may create it. */
async function directoryHasContent(adapter: WorkspaceAdapter, dir: string): Promise<boolean> {
  try {
    return (await adapter.listDir(dir)).length > 0;
  } catch {
    return false;
  }
}

/** Writes the module's YAML back to disk by serializing each tracked
 *  `ModuleDocument` via `serializeModuleDocument`. No custom serializer; the
 *  `yaml` library's `Document#toString()` preserves comments, anchors,
 *  quoting, flow vs block style, and multi-document separators.
 *
 *  Discovers the module's files from the same two sources the loader
 *  populates: the owner `modulePath`, plus any `sourceFile` stamped on a
 *  resource by the analyzer (include-expanded partials).
 *
 *  Semantic-equality guard: skips the write for any file whose AST
 *  `.toJSON()` deep-equals the snapshot captured at load time
 *  (`ModuleDocument.loadedJson`). This prevents a no-op save from
 *  reformatting every file — the first save of a non-canonical file still
 *  reformats it once (YAML library normalizes quoting / whitespace on
 *  `String(doc)`), but that is a one-time cost per file.
 *
 *  Returns a new Workspace with updated `ModuleDocument` entries
 *  (`text` + `loadedJson`) for every file actually written, so subsequent
 *  save calls see the new state as canonical. Returns the input workspace
 *  unchanged when nothing was written. */
export async function saveModuleFromDocuments(
  workspace: Workspace,
  modulePath: string,
  adapter: WorkspaceAdapter,
): Promise<Workspace> {
  const manifest = workspace.modules.get(modulePath);
  if (!manifest) return workspace;

  const fileKeys = new Set<string>([normalizePath(modulePath)]);
  for (const r of manifest.resources) {
    if (r.sourceFile) fileKeys.add(normalizePath(r.sourceFile));
  }
  // Also include dirty module documents that no longer host any resource — e.g.
  // a partial whose last resource was just deleted. Such a file drops out of
  // `manifest.resources`, so without this its emptied-out content never reaches
  // disk and the resource reappears on reload. Module files are colocated under
  // the owner directory (same convention as `deleteModule`).
  const dirPrefix = normalizePath(pathDirname(modulePath)) + "/";
  for (const [key, doc] of workspace.documents) {
    if (doc.dirty && key.startsWith(dirPrefix)) fileKeys.add(key);
  }

  const documents = new Map(workspace.documents);
  let anyWritten = false;

  for (const key of fileKeys) {
    const modDoc = documents.get(key);
    if (!modDoc) continue;
    // A file with a parse error has its last-good docs attached; writing
    // them would destroy user edits-in-progress. Skip until the user fixes
    // the file via the source view.
    if (moduleParseError(modDoc)) continue;

    const currentJson = modDoc.loaded.documents.map((d) => d.toJSON());
    if (jsonDeepEqual(currentJson, modDoc.loaded.manifests)) continue;

    const text = serializeModuleDocument(modDoc.loaded.documents);
    await adapter.writeFile(modDoc.filePath, text);
    // Re-parse the just-written text to refresh the load-time snapshot —
    // text, manifests, positions all become consistent with the saved file.
    documents.set(key, parseModuleDocument(modDoc.filePath, text));
    anyWritten = true;
  }

  if (!anyWritten) return workspace;
  return { ...workspace, documents };
}

/** Semantic deep-equality for AST snapshots. `yaml.Document#toJSON()` produces
 *  plain JSON-compatible structures (no Map/Set/Date/function), so stringify
 *  comparison is sound. Key order is preserved by `yaml` across repeated
 *  calls on the same document, so two snapshots of an unmutated document
 *  stringify identically. */
function jsonDeepEqual(a: unknown[], b: unknown[]): boolean {
  if (a.length !== b.length) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Persists a module via the AST-based save path. Thin alias over
 *  `saveModuleFromDocuments` kept for call-site clarity in Editor.tsx —
 *  "persist this workspace's view of this module" reads better than
 *  "save module from documents". Returns the workspace with updated
 *  `documents` entries (new `text` + `loadedJson` for every file actually
 *  written) so the caller's next save sees the advanced state. */
export async function persistWorkspaceModule(
  workspace: Workspace,
  modulePath: string,
  adapter: WorkspaceAdapter,
): Promise<Workspace> {
  return saveModuleFromDocuments(workspace, modulePath, adapter);
}

/** Deletes a module directory from disk and removes any references to it
 *  from importers (drops their Telo.Import entries pointing at the target). */
export async function deleteModule(
  workspace: Workspace,
  filePath: string,
  adapter: WorkspaceAdapter,
): Promise<Workspace> {
  const moduleDir = pathDirname(filePath);
  await adapter.delete(moduleDir);

  const modules = new Map(workspace.modules);
  modules.delete(filePath);

  // Drop ModuleDocument entries that live under the deleted module's
  // directory. Covers the owner telo.yaml plus any partials colocated with
  // it. A future phase that persists importers via the AST can build on
  // this by only pruning keys we no longer own.
  const documents = new Map(workspace.documents);
  const dirPrefix = normalizePath(moduleDir) + "/";
  for (const key of [...documents.keys()]) {
    if (key === normalizePath(filePath) || key.startsWith(dirPrefix)) {
      documents.delete(key);
    }
  }

  // Drop imports in every importer that point at the deleted module —
  // prune both the ParsedManifest projection (for views) and the AST
  // (for the save path). Collect the importer paths here; the actual
  // disk writes happen after the new workspace is fully constructed so
  // `saveModuleFromDocuments` sees the final state.
  const importers = workspace.importedBy.get(filePath);
  const importersToSave: string[] = [];
  if (importers) {
    for (const importerPath of importers) {
      const importer = modules.get(importerPath);
      if (!importer) continue;

      const importsToRemove = importer.imports
        .filter((imp) => imp.resolvedPath === filePath)
        .map((imp) => imp.name);

      const importerKey = normalizePath(importerPath);
      const importerDoc = documents.get(importerKey);
      if (importerDoc) {
        let docs = importerDoc.loaded.documents;
        for (const name of importsToRemove) docs = removeImportDocument(docs, name);
        if (docs !== importerDoc.loaded.documents) {
          documents.set(importerKey, withDocs(importerDoc, docs));
        }
      }

      const updated = {
        ...importer,
        imports: importer.imports.filter((imp) => imp.resolvedPath !== filePath),
      };
      modules.set(importerPath, updated);
      importersToSave.push(importerPath);
    }
  }

  // Rebuild graphs.
  const importGraph = new Map<string, Set<string>>();
  const importedBy = new Map<string, Set<string>>();
  for (const [path, m] of modules) {
    const deps = new Set<string>();
    importGraph.set(path, deps);
    for (const imp of m.imports) {
      if (!imp.resolvedPath) continue;
      deps.add(imp.resolvedPath);
      if (!importedBy.has(imp.resolvedPath)) importedBy.set(imp.resolvedPath, new Set());
      importedBy.get(imp.resolvedPath)!.add(path);
    }
  }

  const resourceDocIndex = buildResourceDocIndex(modules, documents);
  let next: Workspace = {
    rootDir: workspace.rootDir,
    modules,
    importGraph,
    importedBy,
    documents,
    resourceDocIndex,
  };

  // Persist each importer via the AST path. Each save advances that file's
  // `loadedJson`, so threading the returned workspace forward keeps the
  // no-op-write guard accurate for subsequent operations.
  for (const importerPath of importersToSave) {
    try {
      next = await saveModuleFromDocuments(next, importerPath, adapter);
    } catch (err) {
      console.error(`Failed to persist updated importer ${importerPath}:`, err);
    }
  }

  return next;
}
