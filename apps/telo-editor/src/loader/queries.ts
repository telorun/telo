import { isRefSlot, readRefSlot, rewriteRefSlotKinds } from "@telorun/analyzer";
import type {
  AvailableKind,
  ImportedModuleConfig,
  ParsedManifest,
  Workspace,
} from "../model";
import { toPascalCase, toRelativeSource } from "./paths";

/**
 * Rewrites the `x-telo-ref` constraints inside a kind's schema from the DECLARING
 * module's alias scope into the canonical `<module>.<Kind>` form.
 *
 * An alias is private to the manifest that wrote it, so a constraint like
 * `Self.Connection` on `Postgres.Schema` means nothing to a consumer: `Self` is
 * postgres, not the app reading it. Carried through raw, every such slot in every
 * imported kind resolved to nothing — the picker offered no candidates, reported
 * "No resolved resources match Self.Connection" naming a scope the reader does
 * not have, and could not offer to create one either, because the kinds that
 * satisfy an unresolvable constraint are unknowable. The kernel and the analyzer
 * canonicalize at registration for exactly this reason; the editor's kind
 * projection took the schema straight off the parsed manifest and skipped it.
 *
 * The same alias rule `resolveExtendsTarget` already applies, which is why both
 * go through it: `Self` is the declaring module, anything else is one of its
 * imports. A prefix that resolves to nothing is LEFT ALONE — a `Telo.*` built-in
 * is already canonical, and an unresolvable alias should keep reporting the text
 * its author wrote rather than a guess.
 *
 * Structurally shared: a schema with no alias-scoped constraint is returned as
 * it came in, and only the nodes that change are rebuilt. This runs for every
 * kind of every module on every render, and the overwhelming majority of schema
 * nodes are not ref slots.
 */
export function canonicalizeSchemaRefs(
  workspace: Workspace,
  declaring: ParsedManifest,
  schema: Record<string, unknown>,
): Record<string, unknown> {
  const canonical = (kind: string): string | undefined => {
    const target = resolveExtendsTarget(workspace, declaring, kind);
    if (!target) return undefined;
    const next = `${target.module.metadata.name}.${target.kindName}`;
    return next === kind ? undefined : next;
  };
  return rewriteRefs(schema, canonical) as Record<string, unknown>;
}

function rewriteRefs(node: unknown, map: (kind: string) => string | undefined): unknown {
  if (Array.isArray(node)) {
    let changed = false;
    const next = node.map((item) => {
      const rewritten = rewriteRefs(item, map);
      if (rewritten !== item) changed = true;
      return rewritten;
    });
    return changed ? next : node;
  }
  if (!node || typeof node !== "object") return node;

  const record = node as Record<string, unknown>;
  let next: Record<string, unknown> | null = null;
  if (isRefSlot(record) && readRefSlot(record)?.kinds.some((k) => map(k) !== undefined)) {
    // Asked first, cloned only when an answer came back: a clone plus two
    // serializations per ref slot is real cost on a walk that runs for every
    // kind of every module, and the overwhelming majority of constraints are
    // already canonical. Copied rather than rewritten in place because the
    // parsed manifest is shared with every other consumer, and through the
    // accessor because the annotation's shapes are its to know, not this walk's.
    next = { ...record, "x-telo-ref": structuredClone(record["x-telo-ref"]) };
    rewriteRefSlotKinds(next, map);
  }
  for (const [key, value] of Object.entries(record)) {
    if (key === "x-telo-ref") continue;
    const rewritten = rewriteRefs(value, map);
    if (rewritten === value) continue;
    next = next ?? { ...record };
    next[key] = rewritten;
  }
  return next ?? node;
}

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
        schema: canonicalizeSchemaRefs(workspace, mod, (r.fields.schema ?? {}) as Record<string, unknown>),
        categories: r.categories ?? mod.metadata.categories ?? [],
        contract: resolveContract(workspace, mod, r.fields.extends),
      });
    }
  }
  return result;
}

/** Per import alias, the declared `variables:` / `secrets:` contract of the
 *  library it resolves to.
 *
 *  An alias is PRESENT whenever its library was read, even when that library
 *  declares nothing — "accepts no variables" and "we could not find out" are
 *  different answers, and only the first one closes the set of names an importer
 *  may write. An alias the workspace could not load is absent; the editor never
 *  guesses a contract it has not read. */
export function getImportedConfig(
  workspace: Workspace,
  manifest: ParsedManifest,
): Map<string, ImportedModuleConfig> {
  const out = new Map<string, ImportedModuleConfig>();
  for (const imp of manifest.imports) {
    if (!imp.resolvedPath) continue;
    const mod = workspace.modules.get(imp.resolvedPath);
    if (!mod) continue;
    out.set(imp.name, {
      ...(mod.variables ? { variables: mod.variables } : {}),
      ...(mod.secrets ? { secrets: mod.secrets } : {}),
    });
  }
  return out;
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
