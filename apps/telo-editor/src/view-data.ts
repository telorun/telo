import { moduleRootKind, moduleRootResource } from "./application-adapter";
import { getAvailableKinds, normalizePath } from "./loader";
import type {
  AvailableKind,
  ModuleSourceFile,
  ModuleViewData,
  ParsedManifest,
  Workspace,
} from "./model";
import { moduleParseError } from "./yaml-document";

/**
 * Builds the stable view data contract from application state.
 *
 * Merges imported kinds (from `getAvailableKinds`) and locally-defined kinds
 * (from `Telo.Definition` resources in the manifest) into a single map.
 */
export function buildModuleViewData(
  workspace: Workspace,
  manifest: ParsedManifest,
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

  // Surface the module root (Application or Library) as a synthesized kind +
  // resource so every view finds it through the same `kinds` /
  // `manifest.resources` lookups the rest of the resources use. `viewData` is a
  // pure view projection (not the analyzer / persistence manifest), so
  // augmenting its resource list here is local to the views and never leaks
  // into analysis or save.
  const rootKind = moduleRootKind(manifest);
  kinds.set(rootKind.fullKind, rootKind);
  const projectedManifest: ParsedManifest = {
    ...manifest,
    resources: [moduleRootResource(manifest), ...manifest.resources],
  };
  return {
    manifest: projectedManifest,
    kinds,
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
    const err = moduleParseError(ownerDoc);
    out.push({
      filePath: ownerDoc.filePath,
      text: ownerDoc.loaded.text,
      ...(err ? { parseError: err } : {}),
    });
  }

  for (const key of [...partialKeys].sort()) {
    const doc = workspace.documents.get(key);
    if (!doc) continue;
    const err = moduleParseError(doc);
    out.push({
      filePath: doc.filePath,
      text: doc.loaded.text,
      ...(err ? { parseError: err } : {}),
    });
  }

  return out;
}
