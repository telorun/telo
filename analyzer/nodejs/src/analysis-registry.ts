import type { ResourceDefinition, ResourceManifest } from "@telorun/sdk";
import { AliasResolver } from "./alias-resolver.js";
import { KERNEL_BUILTINS } from "./builtins.js";
import { DefinitionRegistry } from "./definition-registry.js";
import { isRefEntry, isScopeEntry } from "./reference-field-map.js";
import type { AnalysisContext } from "./types.js";

/**
 * Accumulates type and alias knowledge for a running kernel or analysis session.
 * Wraps AliasResolver and DefinitionRegistry into a single domain-level interface
 * so callers never touch the raw registries directly.
 */
export class AnalysisRegistry {
  private readonly defs = new DefinitionRegistry();
  private readonly aliases = new AliasResolver();

  registerDefinition(def: ResourceDefinition): void {
    this.defs.register(def);
  }

  registerModuleIdentity(namespace: string | null, name: string): void {
    this.defs.registerModuleIdentity(namespace, name);
  }

  registerImport(alias: string, target: string, kinds: string[]): void {
    this.aliases.registerImport(alias, target, kinds);
  }

  resolveKind(kind: string): string | undefined {
    return this.aliases.resolveKind(kind);
  }

  /**
   * Iterates a resource's reference and scope fields as declared by its definition.
   * Calls onRef for each plain reference field and onScope for each scope field.
   */
  iterateFieldEntries(
    resource: ResourceManifest,
    onRef: (fieldPath: string) => void,
    onScope: (fieldPath: string) => void,
  ): void {
    const fieldMap = this.defs.getFieldMapForKind(resource.kind, this.aliases);
    if (!fieldMap) return;
    for (const [fieldPath, entry] of fieldMap) {
      if (isScopeEntry(entry)) {
        onScope(fieldPath);
        continue;
      }
      if (isRefEntry(entry)) {
        onRef(fieldPath);
      }
    }
  }

  /**
   * Returns the built-in kernel definitions. The underlying DefinitionRegistry already
   * seeds these on construction; this method exposes them so callers (e.g. the kernel's
   * controller registry) can iterate them without importing KERNEL_BUILTINS directly.
   */
  builtinDefinitions(): ResourceDefinition[] {
    return KERNEL_BUILTINS;
  }

  resolveDefinition(kind: string): ResourceDefinition | undefined {
    const ctx = this._context();
    const resolved = ctx.aliases?.resolveKind(kind);
    return ctx.definitions?.resolve(kind) ?? (resolved ? ctx.definitions?.resolve(resolved) : undefined);
  }

  allKinds(): string[] {
    return this._context().definitions?.kinds() ?? [];
  }

  /** @internal Bridge for StaticAnalyzer — do not use outside the analyzer package. */
  _context(): AnalysisContext {
    return { aliases: this.aliases, definitions: this.defs };
  }
}
