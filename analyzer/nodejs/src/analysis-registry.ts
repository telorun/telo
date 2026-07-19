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

  /** `kinds` is the target's `exports.kinds` gate — only listed kinds resolve, and an
   *  empty list exports nothing. Omit it only for a target declaring no `exports.kinds`
   *  (the legacy permissive default); see `AliasResolver.registerImport`. */
  registerImport(alias: string, target: string, kinds?: readonly string[]): void {
    this.aliases.registerImport(alias, target, kinds);
  }

  /** An alias crossing no import boundary, never gated — `Self`, the `Telo` built-ins. */
  registerUngatedAlias(alias: string, target: string): void {
    this.aliases.registerUngatedAlias(alias, target);
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

  /** Resolves the JSON Schema for a kind's `invoke()` / `run()` output, for
   *  editor hosts that render a typed output signature. Mirrors
   *  {@link inputTypeForKind}: the definition's own `outputType`, then the
   *  `extends`-declared abstract's `outputType`. Resolves the inline and
   *  raw-schema forms; a bare named type reference is left unresolved. Undefined
   *  when the kind declares no output contract. */
  outputTypeForKind(kind: string): Record<string, unknown> | undefined {
    const def = this.resolveDefinition(kind);
    if (!def) return undefined;
    const own = resolveTypeFieldToSchema(def.outputType, []);
    if (own) return own;
    if (def.extends) {
      const abstractDef = this.resolveDefinition(def.extends);
      if (abstractDef) {
        const inherited = resolveTypeFieldToSchema(abstractDef.outputType, []);
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

  /** A resolver scoped to `def`'s OWN module, for resolving that definition's
   *  `extends` target.
   *
   *  `extends` aliases are lexically scoped to the declaring library — a library
   *  writes `extends: Cache.Store` against its own import map, and `Self.Host`
   *  against its own module name. The global alias table knows neither, so
   *  {@link resolveDefinition} silently returns undefined for them and callers
   *  fall back to an un-inherited view. Mirrors the module-scope selection in
   *  `expandedFieldMapForResource`. */
  resolverForDefinition(def: {
    metadata?: { module?: string };
  }): (kind: string) => ResourceDefinition | undefined {
    const ownModule = def?.metadata?.module;
    const scope = (ownModule ? this.aliasesByModule.get(ownModule) : undefined) ?? this.aliases;
    return (kind) => {
      const canonical = scope.resolveKind(kind);
      return this.defs.resolve(kind) ?? (canonical ? this.defs.resolve(canonical) : undefined);
    };
  }

  /** Canonical kinds (`module.Name`) of every definition that extends the given
   *  abstract kind — the concrete implementations a caller may instantiate in
   *  its place. Empty when `kind` is not an abstract or has no implementations. */
  implementationsOf(kind: string): string[] {
    const defs = this._context().definitions;
    if (!defs) return [];
    return defs.getByExtends(kind).flatMap((def) => {
      const module = (def.metadata as { module?: string } | undefined)?.module;
      const name = def.metadata?.name as string | undefined;
      return module && name ? [`${module}.${name}`] : [];
    });
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

  /** Returns the **canonical** (`module.Type`) kinds that satisfy an `x-telo-ref`
   *  constraint — an abstract target expands to its implementations (via the
   *  extends / capability index), a concrete target yields just itself.
   *  Resolution mirrors `validateReferences.checkKind`. Unlike
   *  {@link userFacingKindsForRef} this is import-independent: it includes
   *  locally-defined kinds (no alias), so callers can test whether an existing
   *  resource's kind satisfies the ref by canonicalizing it (`resolveKind`) and
   *  membership-checking here. Returns `undefined` when the ref can't be
   *  resolved (e.g. unregistered identity). */
  acceptedKindsForRef(xTeloRef: string): Set<string> | undefined {
    const targetKind = this.defs.resolveRef(xTeloRef);
    if (!targetKind) return undefined;
    const targetDef = this.defs.resolve(targetKind);
    if (!targetDef) return undefined;

    // General single inheritance: the accepted set is the target kind plus every
    // kind that transitively extends it (subtypes are substitutable). A concrete
    // target contributes itself and any specializations; an abstract contributes
    // its implementations. Same transitive index for both.
    const out = new Set<string>();
    if (targetDef.kind !== "Telo.Abstract") out.add(targetKind);
    for (const def of this.defs.getByExtends(targetKind)) {
      const module = (def.metadata as { module?: string } | undefined)?.module;
      if (module && def.metadata?.name) {
        out.add(`${module}.${def.metadata.name as string}`);
      }
    }
    return out;
  }

  /** Returns every user-facing (alias-form) kind that satisfies the given
   *  `x-telo-ref` constraint string (e.g. `"telo#Invocable"`, `"std/sql#Connection"`).
   *  Resolution mirrors `validateReferences.checkKind`: abstract targets expand to
   *  the set of definitions extending them; concrete targets yield just themselves.
   *  Returns `undefined` when the ref can't be resolved (e.g. unregistered identity),
   *  so callers can fall back to the unfiltered kind list. */
  userFacingKindsForRef(xTeloRef: string): string[] | undefined {
    const canonicalKinds = this.acceptedKindsForRef(xTeloRef);
    if (!canonicalKinds) return undefined;

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
