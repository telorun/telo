/** Pure alias → real module name resolver.
 *  Ported from ModuleContext.resolveKind() without any lifecycle dependency. */
export class AliasResolver {
  private readonly importAliases = new Map<string, string>();
  private readonly importedKinds = new Map<string, Set<string>>();

  registerImport(alias: string, targetModule: string, exportedKinds: string[]): void {
    this.importAliases.set(alias, targetModule);
    if (exportedKinds.length > 0) {
      this.importedKinds.set(alias, new Set(exportedKinds));
    }
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
}
