/** Pure alias → real module name resolver.
 *  Ported from ModuleContext.resolveKind() without any lifecycle dependency. */
export class AliasResolver {
  private readonly importAliases = new Map<string, string>();
  private readonly importedKinds = new Map<string, Set<string>>();
  /** `${alias}.${suffix}` → canonical `<owningModule>.<Kind>` for kinds an import
   *  transitively RE-EXPORTS (`exports.kinds: [Alias.Kind]`), which don't live in the
   *  import's own module. Resolved before the normal `<module>.<suffix>` construction. */
  private readonly reExportedKinds = new Map<string, string>();

  registerImport(alias: string, targetModule: string, exportedKinds: string[]): void {
    this.importAliases.set(alias, targetModule);
    if (exportedKinds.length > 0) {
      this.importedKinds.set(alias, new Set(exportedKinds));
    }
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

  /** Resolves "Http.Api" → "http-server.Api". Returns undefined if alias is unknown. */
  resolveKind(kind: string): string | undefined {
    if (!kind) {
      return undefined;
    }
    const dot = kind.indexOf(".");
    if (dot === -1) return undefined;
    const prefix = kind.slice(0, dot);
    const suffix = kind.slice(dot + 1);
    // Re-export takes precedence: a re-exported kind resolves to its true owning module,
    // not `${prefix-target}.${suffix}` (and bypasses the gate — it's explicitly re-exported).
    const reExported = this.reExportedKinds.get(`${prefix}.${suffix}`);
    if (reExported) return reExported;
    const realModule = this.importAliases.get(prefix);
    if (!realModule) return undefined;
    const allowed = this.importedKinds.get(prefix);
    if (allowed !== undefined && !allowed.has(suffix)) return undefined;
    return `${realModule}.${suffix}`;
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
