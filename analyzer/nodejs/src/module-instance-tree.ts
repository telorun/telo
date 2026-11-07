/**
 * THE MODULE-INSTANCE TREE of an application: the root module instance, then
 * the instances its imports reach, depth-first in `imports:` order. A `shared`
 * library is one instance, reached once at its first reach (a later import of
 * it adds nothing); an `isolated` one is an instance per import. Each instance
 * is identified by its need path — `[]` for the root, the aliases from the root
 * down for an isolated library — a `Telo.Import` declared as a scope member
 * adding one segment per holder before its own name (`[seq, Inner]`) —
 * `[<LibraryName>]` for a shared one and the libraries beneath it — the identity the need table names needs by, the
 * flattened set stamps as `metadata.importPath` and the kernel's module contexts
 * carry.
 *
 * The one reader of that tree: the need table walks it, and so does the
 * co-referrer search the call graph's fan-out edges come from. A module already
 * on the path to an instance is reached (it is an instance) but not walked
 * again, so an import cycle ends.
 *
 * Browser-safe.
 */

import { scopedImportMembers, scopedImportPlace, scopeHoldersOf } from "./scoped-import-identity.js";

/** How the tree reads a module and its imports. */
export interface ModuleInstanceSource<I> {
  /** The module's imports, in `imports:` order. */
  importsOf(module: string): readonly I[];
  /** The key of the module an import reaches, or undefined when it reaches
   *  none this source knows. */
  targetOf(imp: I): string | undefined;
  aliasOf(imp: I): string;
  /** The holders a `Telo.Import` declared as a scope member sits under, from
   *  its module's top level down; empty for an `imports:` entry. */
  holdersOf?(imp: I): readonly string[];
  /** Whether a module is a `lifecycle: shared` library. */
  isShared(module: string): boolean;
  /** The module's name, a shared library's instance path. */
  nameOf(module: string): string;
}

export interface ModuleInstance<I> {
  readonly module: string;
  readonly path: readonly string[];
  /** The instance whose import reached this one; absent for the root. */
  readonly importer?: ModuleInstance<I>;
  /** The import that reached it. */
  readonly via?: I;
  /** The root's import through which it is first reached. */
  readonly reachedVia?: I;
  /** The holders of the scope its import is declared in; empty for an
   *  `imports:` entry. Such an instance lives as long as its scope run. */
  readonly holders: readonly string[];
  /** The instances its imports reach, in `imports:` order. */
  readonly imports: ModuleInstance<I>[];
}

export function moduleInstanceTree<I>(root: string, source: ModuleInstanceSource<I>): ModuleInstance<I> {
  const sharedReached = new Set<string>();
  const top: ModuleInstance<I> = { module: root, path: [], holders: [], imports: [] };
  const walk = (instance: ModuleInstance<I>, stack: ReadonlySet<string>): void => {
    if (stack.has(instance.module)) return;
    const inner = new Set(stack).add(instance.module);
    for (const imp of source.importsOf(instance.module)) {
      const target = source.targetOf(imp);
      if (target === undefined) continue;
      const shared = source.isShared(target);
      if (shared) {
        if (sharedReached.has(target)) continue;
        sharedReached.add(target);
      }
      const holders = source.holdersOf?.(imp) ?? [];
      const child: ModuleInstance<I> = {
        module: target,
        path: shared ? [source.nameOf(target)] : [...instance.path, ...holders, source.aliasOf(imp)],
        importer: instance,
        via: imp,
        reachedVia: instance.reachedVia ?? imp,
        holders,
        imports: [],
      };
      instance.imports.push(child);
      walk(child, inner);
    }
  };
  walk(top, new Set());
  return top;
}

/** Every instance of the tree under `root`, in load order. */
export function instancesOf<I>(root: ModuleInstance<I>): ModuleInstance<I>[] {
  const out: ModuleInstance<I>[] = [];
  const visit = (instance: ModuleInstance<I>): void => {
    out.push(instance);
    for (const child of instance.imports) visit(child);
  };
  visit(root);
  return out;
}

/** The key of the root instance in a tree read off a manifest set. */
export const ROOT_INSTANCE = "";

/**
 * The tree of a flattened set, read off its `Telo.Import` documents — every
 * module's, each stamped with the module it reached (`resolvedModuleName`) and
 * whether that is a shared library (`sharedLibrary`). The root is the set's own
 * module documents ({@link ROOT_INSTANCE}); a library is keyed by its name.
 */
export function moduleInstanceTreeOfSet(
  manifests: readonly { kind?: unknown; metadata?: Record<string, unknown> }[],
): { tree: ModuleInstance<ImportDocument>; rootModules: ReadonlySet<string> } {
  const rootModules = new Set<string>();
  for (const m of manifests) {
    if ((m.kind === "Telo.Application" || m.kind === "Telo.Library") && typeof m.metadata?.name === "string") {
      rootModules.add(m.metadata.name);
    }
  }
  const ownerOf = (module: unknown): string =>
    typeof module !== "string" || rootModules.has(module) ? ROOT_INSTANCE : module;
  const importsBy = new Map<string, ImportDocument[]>();
  const shared = new Set<string>();
  const add = (meta: Record<string, unknown>, module: unknown, holders?: readonly string[], field?: string): void => {
    if (typeof meta.name !== "string" || typeof meta.resolvedModuleName !== "string") return;
    const imp: ImportDocument = {
      alias: meta.name,
      target: meta.resolvedModuleName,
      ...(holders ? { holders } : {}),
      ...(meta.sharedLibrary === true ? { shared: true } : {}),
      ...(field !== undefined ? { field } : {}),
    };
    if (meta.sharedLibrary === true) shared.add(imp.target);
    const owner = ownerOf(module);
    const list = importsBy.get(owner);
    if (list) list.push(imp);
    else importsBy.set(owner, [imp]);
  };
  for (const m of manifests) {
    if (m.kind === "Telo.Import") add(m.metadata ?? {}, m.metadata?.module);
  }
  // The entry's imports declared as scope members, each beneath its holders.
  for (const { member, top } of scopedImportMembers(manifests as never)) {
    add(
      member.metadata as Record<string, unknown>,
      (top.metadata as { module?: unknown }).module,
      scopeHoldersOf(member),
      scopedImportPlace(member)?.field,
    );
  }
  const tree = moduleInstanceTree<ImportDocument>(ROOT_INSTANCE, {
    importsOf: (module) => importsBy.get(module) ?? [],
    targetOf: (imp) => (rootModules.has(imp.target) ? undefined : imp.target),
    aliasOf: (imp) => imp.alias,
    holdersOf: (imp) => imp.holders ?? [],
    isShared: (module) => shared.has(module),
    nameOf: (module) => module,
  });
  return { tree, rootModules };
}

/** One `Telo.Import` of a set, as the tree reads it. */
export interface ImportDocument {
  readonly alias: string;
  readonly target: string;
  /** A scope member's holders; absent for an `imports:` entry. */
  readonly holders?: readonly string[];
  /** Whether it reaches a `lifecycle: shared` library. */
  readonly shared?: boolean;
  /** A scope member's scope field (`with`). */
  readonly field?: string;
}
