import type { ResourceDefinition, ResourceManifest } from "@telorun/sdk";
import { AliasResolver } from "./alias-resolver.js";
import { KERNEL_BUILTINS } from "./builtins.js";
import { DefinitionRegistry } from "./definition-registry.js";
import { computeSuggestKind, computeValidUserFacingKinds } from "./kind-suggest.js";
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
  private readonly aliasesByModule = new Map<string, AliasResolver>();

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
   *
   * Uses the expanded field map so x-telo-schema-from entries contribute their
   * nested ref/scope slots — Phase 5 injection sees encoders that live inside a
   * sub-schema (e.g. Server.notFoundHandler.returns[].content[mime].encoder).
   */
  iterateFieldEntries(
    resource: ResourceManifest,
    onRef: (fieldPath: string) => void,
    onScope: (fieldPath: string) => void,
  ): void {
    const fieldMap = this.defs.expandedFieldMapForResource(
      resource,
      this.aliases,
      this.aliasesByModule,
    );
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

  /** Returns every import alias that points at `moduleName` (the canonical, kebab-case
   *  module name). Empty when no import declares that target. */
  aliasesFor(moduleName: string): string[] {
    return this.aliases.aliasesFor(moduleName);
  }

  /** Returns every user-facing kind that is legal in the current scope:
   *  Telo root kinds plus the alias form of each non-abstract imported definition.
   *  Used by editor hosts to drive completion and by the analyzer to produce
   *  "did you mean" hints. */
  validUserFacingKinds(): string[] {
    return computeValidUserFacingKinds(this.aliases, this.defs);
  }

  /** Returns the closest user-facing kind to `badKind`, or undefined when nothing
   *  is close enough (or multiple candidates tie). Case-sensitive. */
  suggestKind(badKind: string): string | undefined {
    return computeSuggestKind(badKind, this.aliases, this.defs);
  }

  /** Returns every user-facing (alias-form) kind that satisfies the given
   *  `x-telo-ref` constraint string (e.g. `"telo#Invocable"`, `"std/sql#Connection"`).
   *  Resolution mirrors `validateReferences.checkKind`: abstract targets expand to
   *  the set of definitions extending them; concrete targets yield just themselves.
   *  Returns `undefined` when the ref can't be resolved (e.g. unregistered identity),
   *  so callers can fall back to the unfiltered kind list. */
  userFacingKindsForRef(xTeloRef: string): string[] | undefined {
    const targetKind = this.defs.resolveRef(xTeloRef);
    if (!targetKind) return undefined;
    const targetDef = this.defs.resolve(targetKind);
    if (!targetDef) return undefined;

    const canonicalKinds: string[] = [];
    if (targetDef.kind === "Telo.Abstract") {
      for (const def of this.defs.getByExtends(targetKind)) {
        const module = (def.metadata as { module?: string } | undefined)?.module;
        if (module && def.metadata?.name) {
          canonicalKinds.push(`${module}.${def.metadata.name as string}`);
        }
      }
    } else {
      canonicalKinds.push(targetKind);
    }

    const out = new Set<string>();
    for (const kind of canonicalKinds) {
      const dot = kind.indexOf(".");
      if (dot === -1) continue;
      const moduleName = kind.slice(0, dot);
      const typeName = kind.slice(dot + 1);
      for (const alias of this.aliases.aliasesFor(moduleName)) {
        out.add(`${alias}.${typeName}`);
      }
    }
    return Array.from(out);
  }

  /** @internal Bridge for StaticAnalyzer — do not use outside the analyzer package. */
  _context(): AnalysisContext {
    return { aliases: this.aliases, definitions: this.defs, aliasesByModule: this.aliasesByModule };
  }
}
