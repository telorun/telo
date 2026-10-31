import type { ResourceManifest } from "@telorun/sdk";
import { scopeAddress, scopeSiteKey, type ScopeAddress, type ScopeSite } from "./scope-address.js";
import { keysUnder, scopeEncloses, type DeclaredScope } from "./scope-declarations.js";
import { declarationAddress, declaringScopeOf, scopesDeclaredBy } from "./scope-members.js";

/** How a resolver reads a declaration's name and the module that declared it. */
export interface DeclarationReading<T> {
  nameOf(declaration: T): string | undefined;
  moduleOf(declaration: T): string | undefined;
  /** The scope `declaration` is a member of; undefined at module level. */
  scopeOf?(declaration: T): ScopeSite | undefined;
  /** The import path of the module instance a dependency's declaration was
   *  forwarded as; undefined for the analysed modules' own. */
  importPathOf?(declaration: T): readonly string[] | undefined;
}

/** How a manifest names itself and the module that declared it. */
export const MANIFEST_READING: DeclarationReading<ResourceManifest> = {
  nameOf: (m) => {
    const name = (m?.metadata as { name?: unknown } | undefined)?.name;
    return typeof name === "string" ? name : undefined;
  },
  moduleOf: (m) => (m?.metadata as { module?: string } | undefined)?.module,
  scopeOf: (m) => declaringScopeOf(m),
  importPathOf: (m) => importPathOf(m),
};

/** The import path a dependency's declaration was forwarded under — one copy
 *  per instance of an isolated library — or undefined. */
export function importPathOf(declaration: unknown): readonly string[] | undefined {
  const path = (declaration as { metadata?: { importPath?: unknown } } | undefined)?.metadata?.importPath;
  return Array.isArray(path) ? (path as string[]) : undefined;
}

/** The import path a reference through `alias`, written in `writer`, reaches:
 *  the writer's own instance path (none for the analysed modules) and the alias. */
export function importPathThrough(writer: unknown, alias: string): readonly string[] {
  return [...(importPathOf(writer) ?? []), alias];
}

/** A declaration a name resolved to, and the address it was found at. */
export interface ScopedResolution<T> {
  declaration: T;
  address: ScopeAddress;
}

/**
 * The one answer to "what does this bare name mean, read from here".
 *
 * **Scope first, innermost out, then the module** — the order the kernel binds
 * a name in (`createScopeHandle`: a scope run's own resources, then the
 * enclosing context's, at any depth of nested scopes). A name a scope declares
 * resolves to that scope's member and to nothing else, so a member shadows a
 * module-level resource of the same name inside the scope and nowhere outside
 * it. A reader at module level asks with no scope, and a scope member is then
 * out of reach.
 *
 * At module level a name follows {@link resolveScopedName}: same module first,
 * a name declared in exactly one module from anywhere, and one declared in
 * several other modules resolves to nothing.
 *
 * What a scope declares is recorded by whoever walked to it
 * ({@link ScopedNameResolver.declareScope}); the rule of reading it is here
 * alone.
 *
 * Browser-safe.
 */
export class ScopedNameResolver<T> {
  private readonly moduleLevel = new Map<string, T[]>();
  private readonly scopes = new Map<string, Map<string, T>>();

  constructor(
    declarations: Iterable<T>,
    private readonly reading: DeclarationReading<T>,
    /** A resolver over declarations beside these, read as if one set: a name's
     *  module-level declarations are both layers' in `order`, and a scope is
     *  the layer's declaring it. */
    private readonly base?: { readonly resolver: ScopedNameResolver<T>; readonly order: (a: T, b: T) => number },
  ) {
    for (const declaration of declarations) {
      const name = reading.nameOf(declaration);
      if (name === undefined) continue;
      const site = reading.scopeOf?.(declaration);
      if (site) {
        this.declareScope(site, [declaration]);
        continue;
      }
      const list = this.moduleLevel.get(name);
      if (list) list.push(declaration);
      else this.moduleLevel.set(name, [declaration]);
    }
  }

  /** Record what `site` declares. A name declared twice keeps its first. */
  declareScope(site: ScopeSite, members: Iterable<T>): void {
    const key = scopeSiteKey(site);
    let declared = this.scopes.get(key);
    if (!declared) this.scopes.set(key, (declared = new Map()));
    for (const member of members) {
      const name = this.reading.nameOf(member);
      if (name !== undefined && !declared.has(name)) declared.set(name, member);
    }
  }

  /**
   * What `name` means read in `fromModule`, inside `within` when given.
   *
   * `accept` narrows what the reader can take (a kind a resolved reference
   * names): a scope member it refuses still shadows, so the name resolves to
   * nothing rather than to the declaration it shadows.
   */
  resolve(
    name: string,
    fromModule: string | undefined,
    within?: ScopeSite,
    accept?: (declaration: T) => boolean,
  ): T | undefined {
    return this.locate(name, fromModule, within, accept)?.declaration;
  }

  /** {@link resolve}, with the address the name was found at. */
  locate(
    name: string,
    fromModule: string | undefined,
    within?: ScopeSite,
    accept?: (declaration: T) => boolean,
  ): ScopedResolution<T> | undefined {
    for (let site = within; site; site = site.holder.scope) {
      const member = this.memberAt(site, name);
      if (member === undefined) continue;
      return accept && !accept(member)
        ? undefined
        : { declaration: member, address: scopeAddress(site, name) };
    }
    const candidates = this.declarationsOf(name);
    const declaration = resolveScopedName(
      accept ? candidates?.filter(accept) : candidates,
      (d) => this.reading.moduleOf(d),
      fromModule,
    );
    return declaration === undefined
      ? undefined
      : { declaration, address: scopeAddress(this.reading.moduleOf(declaration), name) };
  }

  /** The scope member `name` resolves to inside `within`, or undefined when no
   *  scope of the chain declares it — where a reader keeping its own
   *  module-level rule applies that rule. */
  scopeMember(name: string, within: ScopeSite | undefined): T | undefined {
    for (let site = within; site; site = site.holder.scope) {
      const member = this.memberAt(site, name);
      if (member !== undefined) return member;
    }
    return undefined;
  }

  private memberAt(site: ScopeSite, name: string): T | undefined {
    return this.scopes.get(scopeSiteKey(site))?.get(name) ?? this.base?.resolver.memberAt(site, name);
  }

  /** Every module-level declaration of `name`, in declaration order — for a
   *  reader that identifies a declaration by more than its name. */
  declarationsOf(name: string): readonly T[] {
    const own = this.moduleLevel.get(name) ?? [];
    if (!this.base) return own;
    const below = this.base.resolver.declarationsOf(name);
    if (below.length === 0) return own;
    if (own.length === 0) return below;
    const seen = new Set<T>(own);
    return [...own, ...below.filter((d) => !seen.has(d))].sort(this.base.order);
  }

  /** The module-level declaration of `name` by `module` itself — a name read
   *  through an import alias or the module's own name, never a scope's. A module
   *  imported as several instances holds one declaration per instance: given
   *  the import path a reference reaches (`importPathThrough`), the one of that
   *  instance, and nothing where none is. */
  inModule(name: string, module: string | undefined, importPath?: readonly string[]): T | undefined {
    const declared = this.declarationsOf(name).filter((d) => this.reading.moduleOf(d) === module);
    if (declared.length <= 1 || importPath === undefined || !this.reading.importPathOf) return declared[0];
    return declared.find((d) => samePath(this.reading.importPathOf!(d), importPath));
  }
}

const manifestResolvers = new WeakMap<
  readonly ResourceManifest[],
  { size: number; resolver: ScopedNameResolver<ResourceManifest> }
>();

/** A resolver over every named manifest of a set, built once per set — and
 *  again when the set has grown since. Shared by every reader of the set, so
 *  none declares a scope on it: it answers at module level. */
export function manifestNames(
  manifests: readonly ResourceManifest[],
): ScopedNameResolver<ResourceManifest> {
  const known = manifestResolvers.get(manifests);
  if (known && known.size === manifests.length) return known.resolver;
  const resolver = new ScopedNameResolver(manifests, MANIFEST_READING);
  manifestResolvers.set(manifests, { size: manifests.length, resolver });
  return resolver;
}

/**
 * A bare `<name>` read from `fromModule`, among the module-level declarations
 * of that name.
 *
 * **Same module first**, because that is what a bare name MEANS: it is resolved
 * in the scope it was written in, and a cross-module reference is written with
 * an alias. A name declared in exactly one module resolves to it whatever the
 * reader's scope — which is what keeps an unstamped manifest set (every
 * fixture, every single-module load) behaving as it did. A name declared in
 * SEVERAL other modules and none of the reader's resolves to NOTHING: guessing
 * between them attributes a reference to a resource the author never named, and
 * some other pass reports the dangling name honestly.
 */
export function resolveScopedName<T>(
  candidates: readonly T[] | undefined,
  moduleOf: (item: T) => string | undefined,
  fromModule: string | undefined,
): T | undefined {
  if (!candidates || candidates.length === 0) return undefined;
  if (candidates.length === 1) return candidates[0];
  return candidates.find((candidate) => moduleOf(candidate) === fromModule);
}

/**
 * What a `{ name, alias? }` reference written in `fromModule` (inside `within`
 * when given) names. A bare name, or one through `Self`, is the resolver's
 * scoped read; a name through an import alias is the module-level declaration
 * of the module that alias reaches in `fromModule`'s own alias table, as the
 * kernel resolves it — never another module's resource that shares the name.
 */
export function resolveReference<T>(
  resolver: Pick<ScopedNameResolver<T>, "resolve" | "inModule">,
  ref: { readonly name: string; readonly alias?: string },
  fromModule: string | undefined,
  moduleForAlias: (alias: string) => string | undefined,
  within?: ScopeSite,
  /** The declaration the reference is written in — whose module instance an
   *  alias is an import of. */
  writer?: unknown,
): T | undefined {
  if (ref.alias === undefined || ref.alias === "Self") {
    return resolver.resolve(ref.name, fromModule, within);
  }
  const target = moduleForAlias(ref.alias);
  return target === undefined
    ? undefined
    : resolver.inModule(ref.name, target, importPathThrough(writer, ref.alias));
}

/** Of a module's declarations of one name, the one of the instance at
 *  `importPath` when the module is imported as several. */
export function ofInstance<T>(declared: readonly T[], importPath: readonly string[] | undefined): T[] {
  if (declared.length <= 1 || importPath === undefined) return [...declared];
  return declared.filter((d) => samePath(importPathOf(d), importPath));
}

function samePath(a: readonly string[] | undefined, b: readonly string[]): boolean {
  return a !== undefined && a.length === b.length && a.every((segment, i) => segment === b[i]);
}

/**
 * The scope a place inside `holder` reads names in: the first of the holder's
 * scopes whose regions enclose `keys`, or whose array holds the member `keys`
 * lies inside — a member reads its siblings — or, anywhere else on the holder,
 * the scope the holder itself is declared in.
 */
export function scopeSiteAt(
  holder: ScopeAddress,
  scopes: readonly DeclaredScope[],
  keys: readonly (string | number)[],
): ScopeSite | undefined {
  const enclosing = scopes.find(
    (scope) =>
      scopeEncloses(scope, keys) ||
      (keys.length > scope.keys.length + 1 && keysUnder(keys, scope.keys)),
  );
  return enclosing ? { holder, field: enclosing.path } : holder.scope;
}

/** {@link scopeSiteAt} for a dotted concrete path (`steps[0].invoke`). */
export function scopeSiteAtPath(
  holder: ScopeAddress,
  scopes: readonly DeclaredScope[],
  path: string,
): ScopeSite | undefined {
  return scopeSiteAt(holder, scopes, path.split(/[.[\]]/).filter((key) => key !== ""));
}

/** A manifest's own address: a scope member's, or its module-level one. */
export const addressOf = declarationAddress;

/**
 * The scope a name written in `declaration` reads in: inside a region of a
 * scope it declares (`path` given), that scope; anywhere else on it, the scope
 * it is itself declared in. Undefined at module level.
 */
export function scopeReadAt(declaration: unknown, path?: string): ScopeSite | undefined {
  if (!declaration || typeof declaration !== "object") return undefined;
  const scopes = path === undefined ? [] : scopesDeclaredBy(declaration);
  if (scopes.length === 0) return declaringScopeOf(declaration);
  const address = declarationAddress(declaration as ResourceManifest);
  return address ? scopeSiteAtPath(address, scopes, path!) : declaringScopeOf(declaration);
}
