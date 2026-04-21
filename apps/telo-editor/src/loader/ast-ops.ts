import { isModuleKind } from "@telorun/analyzer";
import type { ResourceManifest } from "@telorun/sdk";
import type { ModuleDocument, ParsedManifest, Workspace } from "../model";
import {
  addResourceDocument,
  applyEdit,
  diffFields,
  findDocForResource,
  type EditOp,
} from "../yaml-document";
import { normalizePath } from "./paths";
import { buildParsedManifest } from "./parse";

/** Rebuilds the per-module `${kind}::${name}` → `{filePath, docIndex}` side
 *  table from scratch. Outer key is the owner module's canonicalized filePath;
 *  inner key scopes resource identity to a single module so resources with the
 *  same kind/name in different modules don't collide.
 *
 *  Incremental patching would be fragile under resource renames (a
 *  `metadata.name` change shifts the key) and doc-index shifts (add / remove
 *  shifts everything after it). A full rebuild on every `documents` change is
 *  one pass over the docs array per module; cheap at workspace sizes of up
 *  to thousands of modules. */
export function buildResourceDocIndex(
  modules: Map<string, ParsedManifest>,
  documents: Map<string, ModuleDocument>,
): Map<string, Map<string, { filePath: string; docIndex: number }>> {
  const index = new Map<string, Map<string, { filePath: string; docIndex: number }>>();
  for (const [modulePath, manifest] of modules) {
    const ownerKey = normalizePath(modulePath);
    const inner = new Map<string, { filePath: string; docIndex: number }>();

    // Imports are not indexed: `addImportViaAst` / `removeImportViaAst`
    // locate the owner doc via `documents.get(modulePath)` and look up
    // Telo.Import docs directly with `findDocForResource`. Adding them to
    // this side-table would be dead state.

    for (const r of manifest.resources) {
      const sourceKey = normalizePath(r.sourceFile ?? modulePath);
      const modDoc = documents.get(sourceKey);
      if (!modDoc) continue;
      const docIndex = findDocForResource(modDoc.docs, r.kind, r.name);
      if (docIndex === undefined) continue;
      inner.set(`${r.kind}::${r.name}`, { filePath: sourceKey, docIndex });
    }

    index.set(ownerKey, inner);
  }
  return index;
}

/** Re-derives the `ParsedManifest` for a module from its AST (`workspace.documents`).
 *  Used after every form-driven AST mutation (Phase 3) and after source-view
 *  edits (Phase 4) so views see the new state without directly mutating
 *  `ParsedManifest`. Also rebuilds `resourceDocIndex` because resource
 *  add/remove shifts the inner map.
 *
 *  Graph-derived fields are preserved across the re-projection:
 *   - For imports unchanged in `name` + `source`, `resolvedPath` is copied
 *     forward from the previous projection.
 *   - For imports whose `source` changed (or new imports), `resolvedPath`
 *     is left `undefined` so the caller can decide whether to trigger
 *     `reconcileImports` to load the new target graph.
 *
 *  Partial-file discovery is taken from `prev.resources[].sourceFile` — we
 *  don't re-run `include:` glob expansion here. Source-view edits that
 *  change the module's `include:` list must explicitly re-resolve via a
 *  full workspace reload or a targeted re-include pass (out of scope). */
export function rebuildManifestFromDocuments(
  workspace: Workspace,
  modulePath: string,
): Workspace {
  const prev = workspace.modules.get(modulePath);
  if (!prev) return workspace;

  const partialPaths = new Set<string>();
  for (const r of prev.resources) {
    if (r.sourceFile && normalizePath(r.sourceFile) !== normalizePath(modulePath)) {
      partialPaths.add(r.sourceFile);
    }
  }

  const synthetic = astToResourceManifests(
    modulePath,
    workspace.documents,
    [...partialPaths],
  );
  const fresh = buildParsedManifest(modulePath, synthetic);

  const prevImportByName = new Map(prev.imports.map((imp) => [imp.name, imp]));
  const importsWithResolved = fresh.imports.map((imp) => {
    const p = prevImportByName.get(imp.name);
    if (p && p.source === imp.source) {
      return { ...imp, resolvedPath: p.resolvedPath };
    }
    return { ...imp, resolvedPath: undefined };
  });

  const modules = new Map(workspace.modules);
  modules.set(modulePath, { ...fresh, imports: importsWithResolved });
  const resourceDocIndex = buildResourceDocIndex(modules, workspace.documents);
  return { ...workspace, modules, resourceDocIndex };
}

/** True when at least one import in the module has `resolvedPath === undefined`
 *  — signals to the caller that `reconcileImports` should be run to load the
 *  new import target's sub-graph. */
export function hasUnresolvedImports(workspace: Workspace, modulePath: string): boolean {
  const manifest = workspace.modules.get(modulePath);
  if (!manifest) return false;
  return manifest.imports.some((imp) => !imp.resolvedPath);
}

/** Replaces a single `ModuleDocument` entry in the workspace. Produces a
 *  fresh `documents` Map so React consumers that key off Map identity see
 *  the change. Does NOT rebuild `modules` or `resourceDocIndex` — call
 *  `rebuildManifestFromDocuments` afterwards when the mutation changed
 *  resource/import structure, or skip the rebuild for field-only edits
 *  where the ParsedManifest structure is stable. */
export function withModuleDocument(
  workspace: Workspace,
  filePath: string,
  modDoc: ModuleDocument,
): Workspace {
  const documents = new Map(workspace.documents);
  documents.set(normalizePath(filePath), modDoc);
  return { ...workspace, documents };
}

/** Applies a sequence of EditOps to one document inside the workspace's AST
 *  layer. The ops mutate `docs[docIndex]` in place (preserving comments on
 *  unchanged nodes); the result is bundled into a fresh `ModuleDocument` +
 *  fresh `documents` Map so React consumers see a new reference. The
 *  returned workspace has updated `documents` only — callers that also need
 *  a refreshed `ParsedManifest` / `resourceDocIndex` should follow up with
 *  `rebuildManifestFromDocuments`. */
export function applyOpsToDocument(
  workspace: Workspace,
  filePath: string,
  docIndex: number,
  ops: EditOp[],
): Workspace {
  if (ops.length === 0) return workspace;
  const key = normalizePath(filePath);
  const modDoc = workspace.documents.get(key);
  if (!modDoc) return workspace;

  let docs = modDoc.docs;
  for (const op of ops) {
    docs = applyEdit(docs, docIndex, op);
  }
  return withModuleDocument(workspace, filePath, { ...modDoc, docs });
}

/** Updates a resource's body fields in the AST. Diffs `oldFields` against
 *  `newFields` (convention: `undefined` → delete, `null` → explicit null,
 *  `""` → empty string, other → set), translates to EditOps rooted at the
 *  resource's document, applies them, and re-derives the ParsedManifest.
 *  Returns the original workspace when the resource has no AST entry
 *  (stale resourceDocIndex after a rename, parse error on the file, etc.). */
export function setResourceFields(
  workspace: Workspace,
  modulePath: string,
  kind: string,
  name: string,
  oldFields: Record<string, unknown>,
  newFields: Record<string, unknown>,
): Workspace {
  const indexEntry = workspace.resourceDocIndex
    .get(normalizePath(modulePath))
    ?.get(`${kind}::${name}`);
  if (!indexEntry) return workspace;

  const ops = diffFields(oldFields, newFields, "");
  if (ops.length === 0) return workspace;

  const updated = applyOpsToDocument(workspace, indexEntry.filePath, indexEntry.docIndex, ops);
  return rebuildManifestFromDocuments(updated, modulePath);
}

/** Appends a new resource document to the owner module's AST and re-derives
 *  the ParsedManifest. New resources always land in the owner file (not in
 *  a partial) — matches the current `handleCreateResource` behavior and
 *  keeps "moving resources between files" out of this path. */
export function createResourceViaAst(
  workspace: Workspace,
  modulePath: string,
  kind: string,
  name: string,
  fields: Record<string, unknown>,
): Workspace {
  const key = normalizePath(modulePath);
  const modDoc = workspace.documents.get(key);
  if (!modDoc) return workspace;

  const docs = addResourceDocument(modDoc.docs, kind, name, fields);
  const updated = withModuleDocument(workspace, modulePath, { ...modDoc, docs });
  return rebuildManifestFromDocuments(updated, modulePath);
}

/** Walks `workspace.documents` for the module's owner + listed partials and
 *  emits `ResourceManifest[]` enriched with `metadata.source` (canonical
 *  per-file path) and `metadata.module` (owner module name, stamped on
 *  resources declared in partials — mirrors what the analyzer Loader does in
 *  `loadPartialFile`). The output feeds straight into `buildParsedManifest`.
 */
export function astToResourceManifests(
  ownerPath: string,
  documents: Map<string, ModuleDocument>,
  partialPaths: string[],
): ResourceManifest[] {
  const out: ResourceManifest[] = [];
  const ownerDoc = documents.get(normalizePath(ownerPath));
  if (!ownerDoc) return out;

  let ownerModuleName: string | undefined;
  for (const d of ownerDoc.docs) {
    const json = d.toJSON() as Record<string, unknown> | null;
    if (!json) continue;
    const kind = json.kind;
    if (typeof kind === "string" && isModuleKind(kind)) {
      const meta = json.metadata as Record<string, unknown> | undefined;
      if (meta && typeof meta.name === "string") ownerModuleName = meta.name;
    }
    const meta: Record<string, unknown> = {
      ...(json.metadata as Record<string, unknown> | undefined),
      source: ownerPath,
    };
    out.push({ ...json, metadata: meta } as ResourceManifest);
  }

  for (const partial of partialPaths) {
    const partialDoc = documents.get(normalizePath(partial));
    if (!partialDoc) continue;
    for (const d of partialDoc.docs) {
      const json = d.toJSON() as Record<string, unknown> | null;
      if (!json) continue;
      const meta: Record<string, unknown> = {
        ...(json.metadata as Record<string, unknown> | undefined),
        source: partial,
      };
      if (ownerModuleName && meta.module === undefined) meta.module = ownerModuleName;
      out.push({ ...json, metadata: meta } as ResourceManifest);
    }
  }
  return out;
}
