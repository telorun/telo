import { DEFAULT_MANIFEST_FILENAME } from "@telorun/analyzer";
import type {
  ModuleKind,
  ParsedManifest,
  Workspace,
  WorkspaceAdapter,
} from "../model";
import {
  buildInitialModuleDocument,
  parseModuleDocument,
  removeImportDocument,
  serializeModuleDocument,
} from "../yaml-document";
import { normalizePath, pathDirname, pathJoin } from "./paths";
import { buildResourceDocIndex } from "./ast-ops";

export interface CreateModuleOptions {
  kind: ModuleKind;
  relativePath: string;
  name: string;
}

/** Creates a new module directory with a telo.yaml inside the workspace,
 *  persists it via the WorkspaceAdapter, and returns the updated Workspace. */
export async function createModule(
  workspace: Workspace,
  options: CreateModuleOptions,
  adapter: WorkspaceAdapter,
): Promise<Workspace> {
  const { kind, relativePath, name } = options;
  const cleanRelative = relativePath.replace(/^\/+|\/+$/g, "");
  if (!cleanRelative) throw new Error(`Module path cannot be empty`);

  const moduleDir = pathJoin(workspace.rootDir, cleanRelative);
  const filePath = pathJoin(moduleDir, DEFAULT_MANIFEST_FILENAME);

  if (workspace.modules.has(filePath)) {
    throw new Error(`Module already exists at ${filePath}`);
  }

  await adapter.createDir(moduleDir);

  const manifest: ParsedManifest = {
    filePath,
    kind,
    metadata: { name, version: "1.0.0" },
    targets: [],
    imports: [],
    resources: [],
  };
  const initialDoc = buildInitialModuleDocument(kind, name);
  const yaml = serializeModuleDocument([initialDoc]);
  await adapter.writeFile(filePath, yaml);

  const modules = new Map(workspace.modules);
  modules.set(filePath, manifest);
  const importGraph = new Map(workspace.importGraph);
  importGraph.set(filePath, new Set());
  const importedBy = new Map(workspace.importedBy);

  const documents = new Map(workspace.documents);
  documents.set(normalizePath(filePath), parseModuleDocument(filePath, yaml));
  const resourceDocIndex = buildResourceDocIndex(modules, documents);

  return { rootDir: workspace.rootDir, modules, importGraph, importedBy, documents, resourceDocIndex };
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

  const documents = new Map(workspace.documents);
  let anyWritten = false;

  for (const key of fileKeys) {
    const modDoc = documents.get(key);
    if (!modDoc) continue;
    // A file with a parse error has its last-good docs attached; writing
    // them would destroy user edits-in-progress. Skip until the user fixes
    // the file via the source view.
    if (modDoc.parseError) continue;

    const currentJson = modDoc.docs.map((d) => d.toJSON());
    if (jsonDeepEqual(currentJson, modDoc.loadedJson)) continue;

    const text = serializeModuleDocument(modDoc.docs);
    await adapter.writeFile(modDoc.filePath, text);
    documents.set(key, { ...modDoc, text, loadedJson: currentJson });
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
        let docs = importerDoc.docs;
        for (const name of importsToRemove) docs = removeImportDocument(docs, name);
        if (docs !== importerDoc.docs) {
          documents.set(importerKey, { ...importerDoc, docs });
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
