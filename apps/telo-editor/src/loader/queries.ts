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
        capability: resolveCapability(workspace, mod, r.fields),
        topology: typeof r.fields.topology === "string" ? (r.fields.topology as string) : undefined,
        schema: (r.fields.schema ?? {}) as Record<string, unknown>,
        categories: r.categories ?? mod.metadata.categories ?? [],
        contract: resolveContract(workspace, mod, r.fields.extends),
      });
    }
  }
  return result;
}

/** `extends: <Alias>.<Kind>` → the module that owns the target and the kind
 *  name, resolved in the DECLARING module's own alias table (`Self` being that
 *  module). Undefined when the prefix resolves to nothing — a `Telo.*` built-in
 *  owns no module, and neither does an import the workspace could not load. */
function resolveExtendsTarget(
  workspace: Workspace,
  declaring: ParsedManifest,
  extendsField: unknown,
): { module: ParsedManifest; kindName: string } | undefined {
  if (typeof extendsField !== "string") return undefined;
  const dot = extendsField.indexOf(".");
  if (dot === -1) return undefined;
  const alias = extendsField.slice(0, dot);
  const kindName = extendsField.slice(dot + 1);

  if (alias === "Self") return { module: declaring, kindName };

  const target = declaring.imports.find((i) => i.name === alias)?.resolvedPath;
  const targetModule = target ? workspace.modules.get(target) : undefined;
  return targetModule ? { module: targetModule, kindName } : undefined;
}

/** `extends: <Alias>.<Kind>` → `<owning module name>.<Kind>`.
 *
 *  The alias belongs to `declaring`, not to whoever is reading the kind, so the
 *  lookup has to run in the declaring library's own import table — `Self` being
 *  the library itself. Returns undefined when the prefix resolves to nothing:
 *  the `Telo.*` built-in abstracts have no owning module, and an unresolved
 *  import would otherwise key a group on a name that means nothing. */
export function resolveContract(
  workspace: Workspace,
  declaring: ParsedManifest,
  extendsField: unknown,
): string | undefined {
  const target = resolveExtendsTarget(workspace, declaring, extendsField);
  return target ? `${target.module.metadata.name}.${target.kindName}` : undefined;
}

/** A kind's capability — its own when it declares one, else the one it inherits
 *  along `extends`.
 *
 *  Omitting `capability:` to inherit the ancestor's is the sanctioned spelling,
 *  so reading the field alone leaves every implementation kind without one.
 *  Each hop resolves in its own declaring module's aliases, so a chain crossing
 *  library boundaries walks correctly. A `Telo.Abstract` parent counts: a
 *  contract declares the capability its implementations inherit.
 *
 *  Empty when nothing in reach declares one — a built-in `Telo.*` parent owns no
 *  module the workspace can read. Empty rather than undefined so a caller cannot
 *  be handed a value its type says it will never see: this used to be cast from
 *  the raw field, and an inherited-capability kind blanked the editor the moment
 *  it was imported. */
export function resolveCapability(
  workspace: Workspace,
  declaring: ParsedManifest,
  fields: Record<string, unknown>,
): string {
  let module = declaring;
  let current = fields;
  // A cycle is a manifest error the analyzer reports on its own line; here it
  // only has to terminate.
  const seen = new Set<string>();
  for (;;) {
    if (typeof current.capability === "string") return current.capability;
    const target = resolveExtendsTarget(workspace, module, current.extends);
    if (!target) return "";
    const key = `${target.module.filePath}#${target.kindName}`;
    if (seen.has(key)) return "";
    seen.add(key);
    const parent = target.module.resources.find(
      (r) =>
        (r.kind === "Telo.Definition" || r.kind === "Telo.Abstract") && r.name === target.kindName,
    );
    if (!parent) return "";
    module = target.module;
    current = parent.fields;
  }
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
