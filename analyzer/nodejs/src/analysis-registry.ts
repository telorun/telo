import type { ResourceDefinition, ResourceManifest } from "@telorun/sdk";
import { AliasResolver } from "./alias-resolver.js";
import { KERNEL_BUILTINS } from "./builtins.js";
import { DefinitionRegistry } from "./definition-registry.js";
import { computeSuggestKind, computeValidUserFacingKinds } from "./kind-suggest.js";
import { visitManifest as runVisitManifest, type ManifestVisitor } from "./manifest-visitor.js";
import { isRefEntry, isScopeEntry } from "./reference-field-map.js";
import type { AnalysisContext } from "./types.js";
import { resolveTypeFieldToSchema } from "./validate-cel-context.js";

/** One reference field declared by a resource's definition, derived purely from
 *  the schema field map (independent of whether the manifest fills it). Editor
 *  hosts render these as ports / adapters on a node. */
export interface RefFieldInfo {
  /** Field-map path with `[]` / `{}` markers (e.g. `targets[]`,
   *  `routes[].handler`, `encoder`). */
  path: string;
  /** True when the path traverses at least one array. */
  isArray: boolean;
  /** Accepted `x-telo-ref` constraint strings (e.g. `telo#Runnable`). */
  refs: string[];
  /** Distinct capabilities the slot may target (`Telo.Runnable`,
   *  `Telo.Service`, `Telo.Provider`, …) — one per resolvable constraint. The
   *  first classifies the port (node-capability → edge, ambient → picker); the
   *  full set validates drag-to-wire endpoints. Empty when none resolve. */
  capabilities: string[];
}

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
   * Returns every reference field a resource's definition declares, with arity
   * and the capability each slot targets — derived purely from the schema field
   * map, so it lists slots even when the manifest leaves them empty. Editor
   * hosts render these as node ports (drag-to-wire for node-capability targets,
   * inline picker for ambient targets).
   */
  refFieldsForResource(resource: ResourceManifest): RefFieldInfo[] {
    const fieldMap = this.defs.expandedFieldMapForResource(
      resource,
      this.aliases,
      this.aliasesByModule,
    );
    if (!fieldMap) return [];
    const out: RefFieldInfo[] = [];
    for (const [path, entry] of fieldMap) {
      if (!isRefEntry(entry)) continue;
      out.push({
        path,
        isArray: entry.isArray,
        refs: entry.refs,
        capabilities: this.capabilitiesForRefs(entry.refs),
      });
    }
    return out;
  }

  /** Base capability an `x-telo-ref` constraint targets. A definition's declared
   *  `capability` is always one of the base capabilities, so it wins — this
   *  resolves user-defined abstracts (e.g. `std/ai#Model`, declared
   *  `capability: Telo.Invocable`) to the capability instances satisfy, not the
   *  abstract kind. Builtin abstracts (`telo#Runnable`) carry no `capability`
   *  field — there the kind itself *is* the capability. Undefined when
   *  unresolvable. */
  capabilityForRef(xTeloRef: string): string | undefined {
    const kind = this.defs.resolveRef(xTeloRef);
    if (!kind) return undefined;
    const def = this.defs.resolve(kind);
    if (!def) return undefined;
    return def.capability ?? kind;
  }

  /** Resolves the JSON Schema for a kind's `invoke()` inputs, for editor hosts
   *  that render a typed inputs form. Two-layer fallback mirroring the analyzer's
   *  template inputs typing: the definition's own `inputType`, then the
   *  `extends`-declared abstract's `inputType`. Resolves the inline
   *  (`{ kind: Type.JsonSchema, schema }`) and raw-schema forms; a bare named
   *  type reference is left unresolved (returns undefined) so the caller can fall
   *  back to a freeform map. Undefined when the kind declares no input contract. */
  inputTypeForKind(kind: string): Record<string, unknown> | undefined {
    const def = this.resolveDefinition(kind);
    if (!def) return undefined;
    const own = resolveTypeFieldToSchema(def.inputType, []);
    if (own) return own;
    if (def.extends) {
      const abstractDef = this.resolveDefinition(def.extends);
      if (abstractDef) {
        const inherited = resolveTypeFieldToSchema(abstractDef.inputType, []);
        if (inherited) return inherited;
      }
    }
    return undefined;
  }

  private capabilitiesForRefs(refs: string[]): string[] {
    const out: string[] = [];
    for (const ref of refs) {
      const cap = this.capabilityForRef(ref);
      if (cap && !out.includes(cap)) out.push(cap);
    }
    return out;
  }

  /**
   * Walks a manifest's annotation sites (refs, scopes, schema-from, CEL) via
   * the shared manifest visitor, bound to this registry's definitions and
   * aliases. The public seam for hosts (editor overview graph, tooling) that
   * need the same site discovery the analyzer's own passes use, without
   * reaching into the internal DefinitionRegistry.
   */
  visitManifest(
    resources: ResourceManifest[],
    visitor: ManifestVisitor,
    opts?: { skipKinds?: ReadonlySet<string>; expand?: boolean; discoverNestedRefs?: boolean },
  ): void {
    runVisitManifest(resources, this.defs, visitor, {
      aliases: this.aliases,
      aliasesByModule: this.aliasesByModule,
      ...opts,
    });
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
