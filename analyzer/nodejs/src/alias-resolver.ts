/** Pure alias → real module name resolver.
 *  Ported from ModuleContext.resolveKind() without any lifecycle dependency. */
export class AliasResolver {
  private readonly importAliases = new Map<string, string>();
  private readonly importedKinds = new Map<string, Set<string>>();
  /** `${alias}.${suffix}` → canonical `<owningModule>.<Kind>` for kinds an import
   *  transitively RE-EXPORTS (`exports.kinds: [Alias.Kind]`), which don't live in the
   *  import's own module. Resolved before the normal `<module>.<suffix>` construction. */
  private readonly reExportedKinds = new Map<string, string>();

  /** Register an import alias gated to the target's `exports.kinds`. Only listed kinds
   *  resolve; an empty list exports nothing. `exportedKinds` is `undefined` for exactly one
   *  case — the target declares no `exports.kinds` at all (the legacy permissive default,
   *  kept so already-published module versions stay importable), which is the site to delete
   *  when kinds go private. For an alias crossing no import boundary use
   *  `registerUngatedAlias`. Mirrors `ModuleContext.registerImport`. */
  registerImport(alias: string, targetModule: string, exportedKinds?: readonly string[]): void {
    this.importAliases.set(alias, targetModule);
    if (exportedKinds !== undefined) {
      this.importedKinds.set(alias, new Set(exportedKinds));
    }
  }

  /** Register an alias that crosses no import boundary and is therefore never gated —
   *  `Self`, a library resolving its own kinds. See `ModuleContext.registerUngatedAlias`. */
  registerUngatedAlias(alias: string, targetModule: string): void {
    this.importAliases.set(alias, targetModule);
  }

  /** Register that `<alias>.<suffix>` re-exports the kind canonically named `canonicalKind`
   *  (owned by a module the alias's target imports, possibly several hops away). */
  registerKindReExport(alias: string, suffix: string, canonicalKind: string): void {
    this.reExportedKinds.set(`${alias}.${suffix}`, canonicalKind);
  }

  /** Real module name an alias points at (e.g. "Console" → "console"), or undefined.
   *  Used to resolve an alias-qualified instance reference "Console.writeLine" to the
   *  forwarded resource declared in that module. The `exports.resources` gate is enforced
   *  upstream by `flattenForAnalyzer` (only exported instances are forwarded), so a name
   *  that isn't exported simply won't be found. */
  moduleForAlias(alias: string): string | undefined {
    return this.importAliases.get(alias);
  }

  /** Resolve an alias-qualified kind, reporting WHY it failed. One parse, one gate check —
   *  callers that need the reason and callers that only need the name share this, so they
   *  cannot drift on dot-splitting, re-export precedence, or gate order.
   *
   *  - `ok`      — resolved to a canonical `<module>.<Kind>`.
   *  - `gated`   — the alias is known and the target owns the name, but its `exports.kinds`
   *                does not list it. A distinct outcome so callers can say "not exported"
   *                instead of the misleading "no such kind".
   *  - `unknown` — unqualified kind, or an alias this scope never imported. */
  resolveKindResult(
    kind: string,
  ):
    | { status: "ok"; kind: string }
    | { status: "gated"; module: string; exported: string[] }
    | { status: "unknown" } {
    if (!kind) return { status: "unknown" };
    const dot = kind.indexOf(".");
    if (dot === -1) return { status: "unknown" };
    const prefix = kind.slice(0, dot);
    const suffix = kind.slice(dot + 1);
    // Re-export takes precedence: a re-exported kind resolves to its true owning module,
    // not `${prefix-target}.${suffix}`. It is listed in the re-exporting library's own
    // `exports.kinds` (that is how it got here), so this is not a gate bypass.
    const reExported = this.reExportedKinds.get(`${prefix}.${suffix}`);
    if (reExported) return { status: "ok", kind: reExported };
    const realModule = this.importAliases.get(prefix);
    if (!realModule) return { status: "unknown" };
    const allowed = this.importedKinds.get(prefix);
    if (allowed !== undefined && !allowed.has(suffix)) {
      return { status: "gated", module: realModule, exported: [...allowed] };
    }
    return { status: "ok", kind: `${realModule}.${suffix}` };
  }

  /** Resolves "Http.Api" → "http-server.Api". Undefined if the alias is unknown OR the kind
   *  is gated out — use `resolveKindResult` when the difference matters. */
  resolveKind(kind: string): string | undefined {
    const r = this.resolveKindResult(kind);
    return r.status === "ok" ? r.kind : undefined;
  }

  hasAlias(alias: string): boolean {
    return this.importAliases.has(alias);
  }

  knownAliases(): string[] {
    return Array.from(this.importAliases.keys());
  }

  /** Returns every alias that currently points at `targetModule`.
   *  Used by clients that need to convert a canonical kind key (e.g. "http-server.Server")
   *  back into its user-facing alias form (e.g. "Http.Server"). */
  aliasesFor(targetModule: string): string[] {
    const result: string[] = [];
    for (const [alias, mod] of this.importAliases) {
      if (mod === targetModule) result.push(alias);
    }
    return result;
  }
}

/**
 * The alias resolver for a resource's own lexical scope. A resource that
 * originated in an imported library (its `ownModule` names a non-root module —
 * e.g. an inline handler extracted from an imported Http.Api) resolves its kind
 * aliases against THAT library's import map, so an anonymous child inherits the
 * lexical scope of the document that declares it. Returns undefined for
 * root/consumer-owned resources (and unknown modules), so callers fall back to
 * the root `aliases`.
 */
export function scopeResolverForModule(
  ownModule: string | undefined,
  rootModules: Set<string>,
  aliasesByModule: Map<string, AliasResolver>,
): AliasResolver | undefined {
  return ownModule && !rootModules.has(ownModule)
    ? aliasesByModule.get(ownModule)
    : undefined;
}
