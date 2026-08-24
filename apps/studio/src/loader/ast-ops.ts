import { isModuleKind } from "@telorun/analyzer";
import type { ResourceManifest } from "@telorun/sdk";
import type { ModuleDocument, ParsedManifest, Workspace } from "../model";
import {
  addResourceDocument,
  applyEdit,
  diffFields,
  expandInlineImportShorthand,
  findDocForResource,
  removeResourceDocument,
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
      const docIndex = findDocForResource(modDoc.loaded.documents, r.kind, r.name);
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

  let docs = modDoc.loaded.documents;
  for (const op of ops) {
    docs = applyEdit(docs, docIndex, op);
  }
  return withModuleDocument(workspace, filePath, withDocs(modDoc, docs));
}

/** Wrap a `ModuleDocument` with a new documents array, marking it dirty.
 *  Used by every AST mutator so post-edit ModuleDocuments share an
 *  identity-change contract with React consumers. */
export function withDocs(modDoc: ModuleDocument, docs: import("yaml").Document[]): ModuleDocument {
  return {
    ...modDoc,
    loaded: { ...modDoc.loaded, documents: docs },
    dirty: true,
  };
}

/** Where a resource's document lives — the side index when it has an entry,
 *  otherwise a scan of the owner file. Shared by every op that edits one. */
function locateResourceDoc(
  workspace: Workspace,
  modulePath: string,
  kind: string,
  name: string,
): { filePath: string; docIndex: number } | undefined {
  const indexEntry = workspace.resourceDocIndex
    .get(normalizePath(modulePath))
    ?.get(`${kind}::${name}`);
  if (indexEntry) return indexEntry;

  const ownerKey = normalizePath(modulePath);
  const modDoc = workspace.documents.get(ownerKey);
  const found = modDoc ? findDocForResource(modDoc.loaded.documents, kind, name) : undefined;
  return found === undefined ? undefined : { filePath: ownerKey, docIndex: found };
}

/** Updates a resource's body fields in the AST. Diffs `oldFields` against
 *  `newFields` (convention: `undefined` → delete, `null` → explicit null,
 *  `""` → empty string, other → set), translates to EditOps rooted at the
 *  resource's document, applies them, and re-derives the ParsedManifest.
 *
 *  Resolves the target document in two steps so a single generic writer covers
 *  every resource, including the synthesized module root:
 *   1. `resourceDocIndex` — declared resources (owner file or an included
 *      partial).
 *   2. owner-doc fallback — the `Telo.Application` / `Telo.Library` root never
 *      appears in `manifest.resources` (hence not in the index), but it is a
 *      real YAML doc in the owner file, locatable by `kind` + `metadata.name`.
 *      The root always lives in the owner file, never a partial.
 *
 *  Returns the original workspace when neither resolves (stale index after a
 *  rename, parse error on the file, etc.) or when nothing changed. Tagged
 *  `!ref` / `!cel` values are diffed as opaque leaves (see `diffFields`), so a
 *  reference array like `targets` round-trips without losing its tags. */
export function setResourceFields(
  workspace: Workspace,
  modulePath: string,
  kind: string,
  name: string,
  oldFields: Record<string, unknown>,
  newFields: Record<string, unknown>,
): Workspace {
  const located = locateResourceDoc(workspace, modulePath, kind, name);
  if (!located) return workspace;
  const { filePath, docIndex } = located;

  const ops = diffFields(oldFields, newFields, "");
  if (ops.length === 0) return workspace;

  const updated = applyOpsToDocument(workspace, filePath, docIndex, ops);
  return rebuildManifestFromDocuments(updated, modulePath);
}

/** {@link setResourceFields} for the module root, which is the one resource
 *  whose fields carry the inline `imports:` map.
 *
 *  An import entry may be written in the scalar shorthand (`Alias: <source>`),
 *  and a Scalar node has nothing to write a key into — so the first edit adding
 *  a `variables:` / `secrets:` sibling would throw out of the generic op
 *  applier. Widening those entries first is import-shaped knowledge (only
 *  imports know the shorthand's scalar stands for `source`), so it sits here
 *  rather than inside the applier, and it is scoped to the aliases this write
 *  actually touches: an entry nobody edited keeps the shape its author chose.
 */
export function setModuleRootFields(
  workspace: Workspace,
  modulePath: string,
  kind: string,
  name: string,
  oldFields: Record<string, unknown>,
  newFields: Record<string, unknown>,
): Workspace {
  const touched = touchedImportAliases(oldFields, newFields);
  let ws = workspace;
  if (touched.length > 0) {
    const key = normalizePath(modulePath);
    const modDoc = ws.documents.get(key);
    if (modDoc) {
      const docs = expandInlineImportShorthand(modDoc.loaded.documents, touched);
      if (docs !== modDoc.loaded.documents) {
        ws = withModuleDocument(ws, modulePath, withDocs(modDoc, docs));
      }
    }
  }
  return setResourceFields(ws, modulePath, kind, name, oldFields, newFields);
}

/** The import aliases whose entry this write changes. */
function touchedImportAliases(
  oldFields: Record<string, unknown>,
  newFields: Record<string, unknown>,
): string[] {
  const next = newFields.imports;
  if (!next || typeof next !== "object" || Array.isArray(next)) return [];
  const prev = (oldFields.imports ?? {}) as Record<string, unknown>;
  return Object.keys(next as Record<string, unknown>).filter(
    (alias) => diffFields(prev[alias], (next as Record<string, unknown>)[alias], "").length > 0,
  );
}

/**
 * Renames one mapping key inside a resource's fields, preserving its position,
 * its value node and any comments on either.
 *
 * A rename cannot go through {@link setResourceFields}: that diffs old against
 * new, and a re-keyed entry reads as "delete one key, add another", which
 * appends the entry at the end of its block and re-serializes its value from
 * plain data. The key is the entry's identity, so moving it is the one edit that
 * must not look like a rewrite.
 */
export function renameResourceFieldKey(
  workspace: Workspace,
  modulePath: string,
  kind: string,
  name: string,
  /** JSON pointer to the entry being renamed, e.g. `/variables/dbConnection`. */
  pointer: string,
  newKey: string,
): Workspace {
  const located = locateResourceDoc(workspace, modulePath, kind, name);
  if (!located) return workspace;
  return rebuildManifestFromDocuments(
    applyOpsToDocument(workspace, located.filePath, located.docIndex, [
      { op: "rename", pointer, newKey },
    ]),
    modulePath,
  );
}

/**
 * Relocates one item of a sequence field inside a resource, preserving the item
 * node itself.
 *
 * Its own operation for the same reason {@link renameResourceFieldKey} is: a
 * field diff is positional, so a reorder reads as "rewrite every index between
 * here and there" and re-serializes each entry from plain data. What an author
 * attached to an ENTRY rather than to its position — a comment, a `!ref` tag, a
 * quote style — would stay behind while the values slid past it.
 */
export function moveResourceFieldItem(
  workspace: Workspace,
  modulePath: string,
  kind: string,
  name: string,
  /** JSON pointer to the item at its current index, e.g. `/targets/2`. */
  pointer: string,
  toIndex: number,
): Workspace {
  const located = locateResourceDoc(workspace, modulePath, kind, name);
  if (!located) return workspace;
  return rebuildManifestFromDocuments(
    applyOpsToDocument(workspace, located.filePath, located.docIndex, [
      { op: "move", pointer, toIndex },
    ]),
    modulePath,
  );
}

/**
 * Relocates one item of a sequence field into a different sequence of the same
 * resource — a step dragged out of one branch and into another.
 *
 * Its own operation rather than a remove plus an insert, for the reason the
 * whole family exists: the two halves would diff as data, so the step would be
 * re-serialized from plain values at its destination and arrive stripped of its
 * `!ref` tag, its quote style and its comments. {@link moveResourceFieldItem}
 * cannot express it — a `move` stays inside one sequence, which is the honest
 * scope for a reorder and the wrong one for a step changing branches.
 */
export function relocateResourceFieldItem(
  workspace: Workspace,
  modulePath: string,
  kind: string,
  name: string,
  /** JSON pointer to the item at its current index, e.g. `/steps/0/then/1`. */
  pointer: string,
  /** JSON pointer to the destination sequence, e.g. `/steps/0/else`. */
  toPointer: string,
  toIndex: number,
): Workspace {
  const located = locateResourceDoc(workspace, modulePath, kind, name);
  if (!located) return workspace;
  return rebuildManifestFromDocuments(
    applyOpsToDocument(workspace, located.filePath, located.docIndex, [
      { op: "relocate", pointer, toPointer, toIndex },
    ]),
    modulePath,
  );
}

/**
 * Removes one item of a sequence field inside a resource.
 *
 * The third member of the family {@link renameResourceFieldKey} and
 * {@link moveResourceFieldItem} belong to: an in-place structural edit a field
 * diff cannot express. Diffed as data, dropping item 1 of 3 reads as "write
 * item 2's value over item 1, then delete item 2" — so the removed node's
 * comment survives on the wrong entry and the surviving entry's is lost.
 */
export function removeResourceFieldItem(
  workspace: Workspace,
  modulePath: string,
  kind: string,
  name: string,
  /** JSON pointer to the item to remove, e.g. `/targets/2`. */
  pointer: string,
): Workspace {
  const located = locateResourceDoc(workspace, modulePath, kind, name);
  if (!located) return workspace;
  return rebuildManifestFromDocuments(
    applyOpsToDocument(workspace, located.filePath, located.docIndex, [{ op: "delete", pointer }]),
    modulePath,
  );
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

  const docs = addResourceDocument(modDoc.loaded.documents, kind, name, fields);
  const updated = withModuleDocument(workspace, modulePath, withDocs(modDoc, docs));
  return rebuildManifestFromDocuments(updated, modulePath);
}

/** Removes a resource's document from whichever file declares it (owner or a
 *  partial — resolved via `resourceDocIndex`) and re-derives the ParsedManifest.
 *  Returns the original workspace when the resource has no AST entry. */
export function removeResourceViaAst(
  workspace: Workspace,
  modulePath: string,
  kind: string,
  name: string,
): Workspace {
  const indexEntry = workspace.resourceDocIndex
    .get(normalizePath(modulePath))
    ?.get(`${kind}::${name}`);
  if (!indexEntry) return workspace;

  const modDoc = workspace.documents.get(normalizePath(indexEntry.filePath));
  if (!modDoc) return workspace;

  const docs = removeResourceDocument(modDoc.loaded.documents, kind, name);
  if (docs === modDoc.loaded.documents) return workspace;

  const updated = withModuleDocument(workspace, indexEntry.filePath, withDocs(modDoc, docs));
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
  for (const d of ownerDoc.loaded.documents) {
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
    for (const d of partialDoc.loaded.documents) {
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
