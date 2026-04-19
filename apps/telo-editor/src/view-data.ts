import type { AnalysisDiagnostic } from "@telorun/analyzer";
import { getAvailableKinds, normalizePath } from "./loader";
import type {
  AvailableKind,
  ModuleSourceFile,
  ModuleViewData,
  ParsedManifest,
  Workspace,
} from "./model";

/**
 * Builds the stable view data contract from application state.
 *
 * Merges imported kinds (from `getAvailableKinds`) and locally-defined kinds
 * (from `Telo.Definition` resources in the manifest) into a single map.
 *
 * @param moduleDiagnostics — the inner map from
 *   `EditorState.diagnosticsByResource.get(activeModulePath)`, or undefined if
 *   no diagnostics are available. The caller unwraps by module path.
 */
export function buildModuleViewData(
  workspace: Workspace,
  manifest: ParsedManifest,
  moduleDiagnostics: Map<string, AnalysisDiagnostic[]> | undefined,
): ModuleViewData {
  const kinds = new Map<string, AvailableKind>();

  // Imported kinds
  for (const kind of getAvailableKinds(workspace, manifest)) {
    kinds.set(kind.fullKind, kind);
  }

  // Locally-defined kinds (Telo.Definition resources in the same module)
  for (const resource of manifest.resources) {
    if (resource.kind !== "Telo.Definition") continue;
    const fullKind = `${resource.module ?? manifest.metadata.name}.${resource.name}`;
    kinds.set(fullKind, {
      fullKind,
      alias: resource.module ?? manifest.metadata.name,
      kindName: resource.name,
      capability: typeof resource.fields.capability === "string" ? resource.fields.capability : "",
      topology: typeof resource.fields.topology === "string" ? resource.fields.topology : undefined,
      schema: (resource.fields.schema ?? {}) as Record<string, unknown>,
    });
  }

  return {
    manifest,
    kinds,
    diagnostics: moduleDiagnostics ?? new Map(),
    sourceFiles: collectSourceFiles(workspace, manifest),
  };
}

/** Collects the per-file source text for every file the module spans. Owner
 *  first, then partials in deterministic (alphabetical) order. Skips files
 *  that aren't tracked in `workspace.documents` (shouldn't happen under
 *  normal load, but defensively so we don't crash the source view). */
function collectSourceFiles(workspace: Workspace, manifest: ParsedManifest): ModuleSourceFile[] {
  const ownerKey = normalizePath(manifest.filePath);
  const partialKeys = new Set<string>();
  for (const r of manifest.resources) {
    if (r.sourceFile) {
      const key = normalizePath(r.sourceFile);
      if (key !== ownerKey) partialKeys.add(key);
    }
  }

  const out: ModuleSourceFile[] = [];
  const ownerDoc = workspace.documents.get(ownerKey);
  if (ownerDoc) {
    out.push({
      filePath: ownerDoc.filePath,
      text: ownerDoc.text,
      ...(ownerDoc.parseError ? { parseError: ownerDoc.parseError } : {}),
    });
  }

  for (const key of [...partialKeys].sort()) {
    const doc = workspace.documents.get(key);
    if (!doc) continue;
    out.push({
      filePath: doc.filePath,
      text: doc.text,
      ...(doc.parseError ? { parseError: doc.parseError } : {}),
    });
  }

  return out;
}
