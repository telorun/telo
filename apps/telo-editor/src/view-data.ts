import type { AnalysisDiagnostic } from "@telorun/analyzer";
import { getAvailableKinds } from "./loader";
import type { Application, AvailableKind, ModuleViewData, ParsedManifest } from "./model";

/**
 * Builds the stable view data contract from application state.
 *
 * Merges imported kinds (from `getAvailableKinds`) and locally-defined kinds
 * (from `Kernel.Definition` resources in the manifest) into a single map.
 *
 * @param moduleDiagnostics — the inner map from
 *   `EditorState.diagnosticsByResource.get(activeModulePath)`, or undefined if
 *   no diagnostics are available. The caller unwraps by module path.
 */
export function buildModuleViewData(
  application: Application,
  manifest: ParsedManifest,
  moduleDiagnostics: Map<string, AnalysisDiagnostic[]> | undefined,
): ModuleViewData {
  const kinds = new Map<string, AvailableKind>();

  // Imported kinds
  for (const kind of getAvailableKinds(application, manifest)) {
    kinds.set(kind.fullKind, kind);
  }

  // Locally-defined kinds (Kernel.Definition resources in the same module)
  for (const resource of manifest.resources) {
    if (resource.kind !== "Kernel.Definition") continue;
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
  };
}
