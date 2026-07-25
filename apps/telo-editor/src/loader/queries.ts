import type { AvailableKind, ParsedManifest, Workspace } from "../model";
import { toPascalCase, toRelativeSource } from "./paths";

export function getAvailableKinds(workspace: Workspace, manifest: ParsedManifest): AvailableKind[] {
  const result: AvailableKind[] = [];
  for (const imp of manifest.imports) {
    if (!imp.resolvedPath) continue;
    const mod = workspace.modules.get(imp.resolvedPath);
    if (!mod) continue;
    for (const r of mod.resources) {
      if (r.kind !== "Telo.Definition") continue;
      result.push({
        fullKind: `${imp.name}.${r.name}`,
        alias: imp.name,
        kindName: r.name,
        capability: r.fields.capability as string,
        topology: typeof r.fields.topology === "string" ? (r.fields.topology as string) : undefined,
        schema: (r.fields.schema ?? {}) as Record<string, unknown>,
      });
    }
  }
  return result;
}

/** Returns true if `libraryPath` is transitively imported by any Application
 *  in the workspace. Used to mark "no importers" on unwired libraries. */
export function hasApplicationImporter(workspace: Workspace, libraryPath: string): boolean {
  const visited = new Set<string>();
  const queue: string[] = [libraryPath];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);
    const importers = workspace.importedBy.get(current);
    if (!importers) continue;
    for (const importerPath of importers) {
      const importer = workspace.modules.get(importerPath);
      if (!importer) continue;
      if (importer.kind === "Application") return true;
      queue.push(importerPath);
    }
  }
  return false;
}

/** True when `filePath` belongs to the workspace directory (not an external
 *  import). Used to decide which modules appear in the WorkspaceTree. */
export function isWorkspaceModule(workspace: Workspace, filePath: string): boolean {
  const root = workspace.rootDir.endsWith("/") ? workspace.rootDir : workspace.rootDir + "/";
  return filePath.startsWith(root);
}

/** A workspace-local `Telo.Library` the active module could import directly,
 *  with the relative source and a deduped PascalCase alias ready to write. */
export interface ImportableLibrary {
  filePath: string;
  name: string;
  source: string;
  alias: string;
}

/** Workspace-local libraries the active module can import: excludes the active
 *  module itself and any library it already imports (matched by resolved path).
 *  Sorted by name; aliases are made unique against the module's existing import
 *  aliases so a direct pick never collides. */
export function getImportableLibraries(
  workspace: Workspace,
  activeModulePath: string,
): ImportableLibrary[] {
  const active = workspace.modules.get(activeModulePath);
  const importedPaths = new Set(
    (active?.imports ?? []).map((imp) => imp.resolvedPath).filter((p): p is string => p != null),
  );
  const usedAliases = new Set((active?.imports ?? []).map((imp) => imp.name));

  const libraries: ParsedManifest[] = [];
  for (const [filePath, module] of workspace.modules) {
    if (filePath === activeModulePath) continue;
    if (module.kind !== "Library") continue;
    if (!isWorkspaceModule(workspace, filePath)) continue;
    if (importedPaths.has(filePath)) continue;
    libraries.push(module);
  }
  libraries.sort((a, b) => a.metadata.name.localeCompare(b.metadata.name));

  return libraries.map((module) => ({
    filePath: module.filePath,
    name: module.metadata.name,
    source: toRelativeSource(activeModulePath, module.filePath),
    alias: uniqueAlias(toPascalCase(module.metadata.name) || "Library", usedAliases),
  }));
}

/** Picks the first non-colliding alias (`Alias`, `Alias2`, `Alias3`, …) and
 *  reserves it so later libraries in the same batch stay unique too. */
function uniqueAlias(base: string, used: Set<string>): string {
  let candidate = base;
  let n = 2;
  while (used.has(candidate)) candidate = `${base}${n++}`;
  used.add(candidate);
  return candidate;
}
