import type { ResourceManifest } from "@telorun/sdk";
import { isRefSentinel } from "@telorun/templating";
import { visitManifest } from "./manifest-visitor.js";
import {
  isInlineResource,
  resolveFieldEntries,
  resolveFieldValues,
  satisfiesValueBranch,
  type RefFieldEntry,
} from "./reference-field-map.js";
import { navigateJsonPointer, substituteCelFields } from "./schema-compat.js";
import { REF_VALIDATION_SKIP_KINDS as SYSTEM_KINDS } from "./system-kinds.js";
import { resolveTypeFieldToSchema } from "./validate-cel-context.js";
import { DiagnosticSeverity, type AnalysisDiagnostic, type AnalysisContext } from "./types.js";
import type { AliasResolver } from "./alias-resolver.js";
import type { DefinitionRegistry } from "./definition-registry.js";

const SOURCE = "telo-analyzer";

/**
 * Liskov substitutability at a kind constraint: is `resolved` (a canonical
 * `<module>.<Kind>`) accepted where `targetKind` is required?
 *
 * THE one implementation — `checkKind` below builds a MESSAGE from it and adds
 * nothing to the rule, so a resource input's injection site and an ordinary ref
 * slot cannot come to disagree about what satisfies a constraint.
 *
 * A value satisfies the slot when it transitively extends the target kind, or —
 * for a CONCRETE target — IS that kind; `getByExtends` is the same transitive
 * subtype index for both, and an abstract is satisfied only by an implementer,
 * never by the abstract itself (which is non-instantiable). Accepts a constraint
 * that resolves to nothing, and an abstract with no loaded implementations:
 * partial context, where a rejection would be a guess.
 */
export function kindSatisfies(
  resolved: string,
  targetKind: string,
  registry: DefinitionRegistry,
): boolean {
  const canonical = registry.resolveRef(targetKind) ?? targetKind;
  const targetDef = registry.resolve(canonical);
  if (!targetDef) return true;
  if (targetDef.kind !== "Telo.Abstract" && resolved === canonical) return true;
  const subtypes = registry.getByExtends(canonical);
  if (subtypes.some((d) => `${d.metadata.module}.${d.metadata.name}` === resolved)) return true;
  // Leniency is about the CANDIDATE, not about the population, and it is the
  // same question for an abstract target and a concrete one. Accepting whenever
  // no subtype happened to be loaded silenced the check exactly where it was
  // needed: an app whose imports declare no `Telo.Runnable` is an app whose boot
  // targets are all wrong, and every one of them passed.
  //
  // An UNREGISTERED candidate is not partial context, and the distinction is
  // load-bearing: a kind nobody declared is an unknown kind or an unimported
  // alias prefix (`NotAnAlias.Script`), which is precisely what this check
  // exists to report. Only a kind that IS declared, whose ancestry reaches
  // something this analysis never saw, is undecidable — there the missing hop is
  // where the target it appears not to reach could have been declared.
  // A candidate the registry never saw cannot be judged on what it implements —
  // the analysis simply does not hold it. Whether its NAME is resolvable is a
  // different question, asked of the alias scope by the caller.
  if (!registry.resolve(resolved)) return true;
  return !registry.ancestryResolved(resolved);
}

/** {@link kindSatisfies} at every kind a slot accepts, rendered as messages.
 *  The acceptance rule is not restated here — only what to say when it fails,
 *  which needs the slot's alternatives and the target's flavour. */
function checkKind(
  kind: string,
  entry: RefFieldEntry,
  registry: DefinitionRegistry,
  aliases: AliasResolver,
): string[] {
  const resolved = aliases.resolveKind(kind) ?? kind;
  // A qualified kind whose prefix names no import in this scope is a bad NAME
  // rather than a bad type — `{kind: NotAnAlias.Script}` where only `Lib` is
  // imported — and this check is the only place it surfaces, so it is never
  // waved through as partial context. Asked of the resolver, which reports
  // `unknown` for exactly that case: a kind reached through a DECLARED alias
  // resolves (`ok`) even when the target's definitions are not loaded, and a
  // gated one says so separately.
  const unknownAlias =
    kind.includes(".") &&
    aliases.resolveKindResult(kind).status === "unknown" &&
    // …and the registry does not hold it under the name as written either. A
    // manifest may carry a canonical `<module>.<Kind>`, which no alias resolves
    // and which is nonetheless perfectly identified.
    registry.resolve(resolved) === undefined;
  const errors: string[] = [];
  for (const refStr of entry.refs) {
    const targetKind = registry.resolveRef(refStr);
    if (!targetKind) return [];
    const targetDef = registry.resolve(targetKind);
    if (!targetDef) return [];
    if (!unknownAlias && kindSatisfies(resolved, targetKind, registry)) return [];
    const subtypes = registry.getByExtends(targetKind);
    const subtypeKinds = new Set(subtypes.map((d) => `${d.metadata.module}.${d.metadata.name}`));
    if (targetDef.kind === "Telo.Abstract") {
      // Suggest only what an author can actually wire: with abstract-extends-
      // abstract real (Telo.Executable over Invocable/Runnable), the transitive
      // subtype list contains abstracts, which are non-instantiable and would
      // read as fixes that cannot work.
      const concrete = subtypes
        .filter((d) => d.kind !== "Telo.Abstract")
        .map((d) => `${d.metadata.module}.${d.metadata.name}`);
      const options = concrete.length > 0 ? concrete : [...subtypeKinds];
      // With nothing loaded that implements the target there is no list to
      // offer, so the message says what this kind IS instead — which is the
      // half the author can act on ("it declares 'Telo.Invocable'" points
      // straight at a boot target that should have been an invoke step).
      const declared = registry.resolve(resolved)?.capability;
      errors.push(
        options.length > 0
          ? `'${kind}' does not implement '${targetKind}' (known implementations: ${options.join(", ")})`
          : `'${kind}' does not implement '${targetKind}'${declared ? ` — it declares '${declared}'` : ""}`,
      );
    } else {
      const options = subtypeKinds.size > 0 ? ` or a subtype (${[...subtypeKinds].join(", ")})` : "";
      errors.push(`'${kind}' (resolved: '${resolved}') does not match required '${targetKind}'${options}`);
    }
  }
  return errors;
}

/**
 * Phase 3 — Reference validation.
 *
 * For each x-telo-ref slot in every non-system resource, validates:
 *   1. Structural — the value has string `kind` and `name` fields.
 *   2. Kind — the alias-resolved kind satisfies the x-telo-ref constraint
 *             (abstract: must extend the target; concrete: must equal it exactly).
 *   3. Resolution — a resource with that name exists in the visible manifest set
 *                   (outer manifests + scope manifests for in-scope ref paths).
 *
 * Ref values with keys beyond kind/name/metadata are treated as inline resources
 * pending Phase 2 normalization and are skipped without error.
 *
 * Returns an empty array when `context.aliases` or `context.definitions` is absent.
 */
export function validateReferences(
  resources: ResourceManifest[],
  context: AnalysisContext,
): AnalysisDiagnostic[] {
  const diagnostics: AnalysisDiagnostic[] = [];
  const aliases = context.aliases;
  const registry = context.definitions;
  const aliasesByModule = context.aliasesByModule;
  if (!aliases || !registry) return diagnostics;

  // Build outer resource lookup by name for resolution check, collecting
  // every entry per name so we can surface name collisions as diagnostics
  // (the kernel's resource registry shares one namespace across all
  // non-system kinds — e.g. `Telo.Application HelloApi` and `Http.Api
  // HelloApi` collide at boot with `ERR_DUPLICATE_RESOURCE`. Catching it
  // statically removes a class of "everything analyzes clean, then the
  // kernel refuses to start" surprises.)
  //
  // Telo.Import is excluded from the duplicate check on top of the
  // SYSTEM_KINDS skip: its `metadata.name` is an alias, not a resource
  // identity (aliases live in a separate namespace from resources, and
  // colliding aliases vs. resource names is benign — the alias is only
  // ever read as a kind prefix).
  // Group manifests by name to detect collisions. Two subtleties:
  //
  //   1. Some analyzer hosts emit the SAME physical document twice through
  //      their pipeline — e.g. telo studio's `toAnalysisManifests` walks
  //      each workspace module's documents independently, and a file
  //      reachable from two angles (entry module + `include:` partial)
  //      shows up twice. The fingerprint includes `sourceLine` so identical
  //      docs (same kind, name, source, AND source line) collapse to one,
  //      while two textually-separate documents in the same file (different
  //      source lines) keep separate fingerprints and trip the diagnostic.
  //   2. The diagnostic carries a precomputed `range` pointing at the
  //      duplicate's source line — editor hosts that resolve diagnostic
  //      positions via a `${file}::${kind}::${name}` lookup would otherwise
  //      collide on duplicates (Map.set overwrites) and place the squiggle
  //      ambiguously. The explicit `range` short-circuits that lookup.
  // Dedup pipeline echoes — the same physical document emitted twice
  // through an analyzer host's pipeline. Keyed on (kind, name, source,
  // sourceLine), so two textually-distinct docs in the same file (same
  // source, different sourceLine) keep separate fingerprints and still
  // trip the diagnostic. `analyze()` enforces that every non-system
  // manifest carries both positional fields — no defensive guard needed.
  // Forwarded foreign exports (an imported library's exported instances, carrying a
  // metadata.module that isn't a root module) are resolution TARGETS only: excluded from
  // duplicate detection and local name resolution, and never walked as ref sources.
  const moduleOf = (r: ResourceManifest): string | undefined =>
    (r.metadata as { module?: string } | undefined)?.module;
  // Forwarded exports are flagged by flattenForAnalyzer (`metadata.forwardedExport`); they're
  // cross-module resolution targets only — excluded from duplicate detection and local name
  // resolution, and never walked as ref sources.
  const isForeign = (r: ResourceManifest): boolean =>
    (r.metadata as { forwardedExport?: boolean } | undefined)?.forwardedExport === true;
  // Forwarded exported instances keyed `${module}\0${name}` — the lookup that resolves
  // whether a cross-module `!ref Alias.name` names a real exported instance.
  const byModuleName = new Map<string, ResourceManifest>();
  /** Modules whose import subtree was actually loaded in this analysis. A resolved
   *  `Telo.Import` carries `resolvedModuleName` (stamped only once the edge — and thus the
   *  imported module — resolved); forwarded exports carry `metadata.module`. Either marks
   *  the module loaded independent of how many instances it exports, so a loaded library
   *  that exports nothing still reports invalid cross-module refs, while partial single-file
   *  analysis (neither present) is skipped to avoid false `UNRESOLVED_REFERENCE`. */
  const loadedModules = new Set<string>();
  for (const r of resources) {
    if (r.kind === "Telo.Import") {
      const m = (r.metadata as { resolvedModuleName?: unknown } | undefined)?.resolvedModuleName;
      if (typeof m === "string") loadedModules.add(m);
      continue;
    }
    if (!r.metadata?.name || SYSTEM_KINDS.has(r.kind) || !isForeign(r)) continue;
    const m = moduleOf(r);
    if (!m) continue;
    byModuleName.set(`${m}\0${r.metadata.name as string}`, r);
    loadedModules.add(m);
  }
  const moduleLoaded = (module: string): boolean => loadedModules.has(module);
  const localResources = resources.filter((r) => !isForeign(r));

  const byNameAll = new Map<string, ResourceManifest[]>();
  const seen = new Set<string>();
  for (const r of resources) {
    if (!r.metadata?.name || SYSTEM_KINDS.has(r.kind) || r.kind === "Telo.Import" || isForeign(r))
      continue;
    const name = r.metadata.name as string;
    // `analyze()` guarantees both fields are present on non-system manifests.
    const meta = r.metadata as unknown as { source: string; sourceLine: number };
    const fingerprint = `${r.kind} ${name} ${meta.source} ${meta.sourceLine}`;
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    const existing = byNameAll.get(name);
    if (existing) existing.push(r);
    else byNameAll.set(name, [r]);
  }
  for (const [name, list] of byNameAll) {
    if (list.length <= 1) continue;
    const [first, ...rest] = list;
    const firstLabel = `${first.kind}/${name}`;
    for (const dup of rest) {
      const dupMeta = dup.metadata as { source?: string; sourceLine?: number } | undefined;
      const range =
        typeof dupMeta?.sourceLine === "number"
          ? {
              start: { line: dupMeta.sourceLine, character: 0 },
              end: { line: dupMeta.sourceLine, character: Number.MAX_SAFE_INTEGER },
            }
          : undefined;
      diagnostics.push({
        severity: DiagnosticSeverity.Error,
        code: "DUPLICATE_RESOURCE_NAME",
        source: SOURCE,
        message: `${dup.kind}/${name}: resource name collides with ${firstLabel} declared earlier (kernel runtime would fail with ERR_DUPLICATE_RESOURCE)`,
        ...(range ? { range } : {}),
        data: {
          resource: { kind: dup.kind, name },
          filePath: dupMeta?.source,
          path: "metadata.name",
        },
      });
    }
  }
  // The dot rule that used to live here is now the strictest special case of
  // the identifier grammar in `validate-identifier-names.ts` — a dot is one of
  // several characters that make a name unreferenceable, and checking one of
  // them here while the rest went unchecked is what let a hyphenated name
  // through to silently evaluate as arithmetic.

  // Single-resource map for the resolution / scope lookups below — when a
  // collision exists, falling back to the first occurrence keeps the rest
  // of the pass behaving the same as before the duplicate diagnostic was
  // added (resolution still finds *something*; the duplicate diagnostic
  // is what surfaces the underlying problem to the user).
  const byName = new Map<string, ResourceManifest>();
  for (const [name, list] of byNameAll) byName.set(name, list[0]);

  // Phase 3 — per-ref validation. The walker supplies each ref site already
  // resolved against the schema-from-expanded field map, with its source
  // enclosure (`inScope`) and the scope manifests visible to it — so this
  // handler only validates, it does not re-walk.
  visitManifest(
    localResources,
    registry,
    {
      onRef: (e) => {
        const r = e.source;
        const resourceLabel = `${r.kind}/${r.metadata!.name as string}`;
        const resourceData = { kind: r.kind, name: r.metadata!.name as string };
        const filePath = (r.metadata as { source?: string } | undefined)?.source;
        const { value: val, concretePath, entry, visibleScopeManifests } = e;

        // `!ref <name>` sentinel — bare resource name marked at parse time as a
        // reference. Look it up against the slot's x-telo-ref constraint exactly
        // like the legacy bare-string path; the only difference is the value's
        // shape (a TaggedSentinel rather than a raw string), which removed the
        // string/inline ambiguity at the source.
        if (isRefSentinel(val)) {
          const refName = val.source;
          const dot = refName.indexOf(".");
          const aliasPrefix = dot > 0 ? refName.slice(0, dot) : undefined;

          // Cross-module sentinel left unresolved by Phase 2.5 — it qualifies an import
          // alias. If that module's exports are loaded in this analysis, the miss is real
          // (name not in exports.resources, or a typo); if not (partial single-file
          // analysis), skip rather than emit a false UNRESOLVED_REFERENCE.
          if (aliasPrefix && aliasPrefix !== "Self" && aliases.hasAlias(aliasPrefix)) {
            const module = aliases.moduleForAlias(aliasPrefix);
            if (module && !moduleLoaded(module)) return;
            diagnostics.push({
              severity: DiagnosticSeverity.Error,
              code: "UNRESOLVED_REFERENCE",
              source: SOURCE,
              message: `${resourceLabel}: reference at '${concretePath}' → '${refName}' is not exported by module '${module ?? aliasPrefix}' (add it to exports.resources)`,
              data: { resource: resourceData, filePath, path: concretePath },
            });
            return;
          }

          // Local reference (bare name or explicit `Self.`-qualified).
          const localName = aliasPrefix === "Self" ? refName.slice(dot + 1) : refName;
          // Scope-local FIRST, enclosing module as the fallback — the order the
          // runtime uses at every name-resolution site (`ScopeContext.getInstance`,
          // `ResourceContext.resolveRef`, and the CEL `resources` layering). Module-first
          // here would validate a shadowed name against the resource the kernel will
          // never bind: a false pass when the outer kind fits and the scoped one does
          // not, a false REFERENCE_KIND_MISMATCH when it is the other way round.
          const target =
            visibleScopeManifests.find((m) => m.metadata?.name === localName) ??
            byName.get(localName);
          if (!target) {
            diagnostics.push({
              severity: DiagnosticSeverity.Error,
              code: "UNRESOLVED_REFERENCE",
              source: SOURCE,
              message: `${resourceLabel}: reference at '${concretePath}' → resource '${localName}' not found`,
              data: { resource: resourceData, filePath, path: concretePath },
            });
            return;
          }
          const kindErrors = checkKind(target.kind as string, entry, registry, aliases);
          if (kindErrors.length > 0) {
            diagnostics.push({
              severity: DiagnosticSeverity.Error,
              code: "REFERENCE_KIND_MISMATCH",
              source: SOURCE,
              message: `${resourceLabel}: reference at '${concretePath}' → ${kindErrors.join("; ")}`,
              data: { resource: resourceData, filePath, path: concretePath },
            });
          }
          return;
        }

        // Bare strings are no longer a reference shape — `validateReferenceForms`
        // rejects an author-written string at a ref slot before this pass runs,
        // and a `${{ }}` reference flowed through CEL is resolved/typed
        // elsewhere. Anything still a string here is not a reference to resolve.
        if (typeof val !== "object") return;
        const refVal = val as Record<string, unknown>;

        // A value the slot's own union describes is a value, not a reference —
        // the same narrowing `validateReferenceForms` applies, through the same
        // function, because it has to be applied here too: an OBJECT-shaped value
        // branch would otherwise reach the structural check below and be reported
        // as a reference missing 'kind' and 'name'.
        if (satisfiesValueBranch(val, entry.valueBranches, registry)) return;

        // Skip inline resources — Phase 2 normalization hasn't run yet.
        if (isInlineResource(refVal)) return;

        // Polymorphic ref slots (Application `targets`) accept object forms
        // whose references live in nested slots rather than being a `{kind,
        // name}` ref themselves — inline `{ invoke }` and gated `{ ref }`.
        // Those nested refs are validated via their own field-map entries, so
        // skip the item-level structural check here.
        if (typeof refVal.kind !== "string" && ("invoke" in refVal || "ref" in refVal)) return;

        // 1. Structural check
        if (typeof refVal.kind !== "string" || typeof refVal.name !== "string") {
          diagnostics.push({
            severity: DiagnosticSeverity.Error,
            code: "INVALID_REFERENCE",
            source: SOURCE,
            message: `${resourceLabel}: reference at '${concretePath}' must have string 'kind' and 'name' fields`,
            data: { resource: resourceData, filePath, path: concretePath },
          });
          return;
        }

        // 2. Kind check
        const kindErrors = checkKind(refVal.kind, entry, registry, aliases);
        if (kindErrors.length > 0) {
          diagnostics.push({
            severity: DiagnosticSeverity.Error,
            code: "REFERENCE_KIND_MISMATCH",
            source: SOURCE,
            message: `${resourceLabel}: reference at '${concretePath}' → ${kindErrors.join("; ")}`,
            data: { resource: resourceData, filePath, path: concretePath },
          });
        }

        // 3. Resolution check — resource with this name must exist.
        let exists: boolean;
        if (typeof refVal.alias === "string" && refVal.alias !== "Self") {
          // Cross-module ref resolved by Phase 2.5. Validate against the forwarded
          // exports when loaded; in partial context (module not loaded) assume resolvable.
          const module = aliases.moduleForAlias(refVal.alias);
          exists =
            !module || !moduleLoaded(module) || byModuleName.has(`${module}\0${refVal.name}`);
        } else {
          exists =
            byName.has(refVal.name) ||
            visibleScopeManifests.some((m) => m.metadata?.name === refVal.name);
        }
        if (!exists) {
          diagnostics.push({
            severity: DiagnosticSeverity.Error,
            code: "UNRESOLVED_REFERENCE",
            source: SOURCE,
            message: `${resourceLabel}: reference at '${concretePath}' → resource '${refVal.name}' not found`,
            data: { resource: resourceData, filePath, path: concretePath },
          });
        }
      },
      onScope: (e) => {
        const r = e.source;
        const resourceLabel = `${r.kind}/${r.metadata!.name as string}`;
        const resourceData = { kind: r.kind, name: r.metadata!.name as string };
        const filePath = (r.metadata as { source?: string } | undefined)?.source;
        for (const { path: concretePath, refName } of e.scopeRefEntries) {
          const scopeField = concretePath.split(/[.[]/)[0];
          diagnostics.push({
            severity: DiagnosticSeverity.Error,
            code: "SCOPE_ENTRY_NOT_INLINE",
            source: SOURCE,
            message: `${resourceLabel}: scope entry at '${concretePath}' is a reference (\`!ref ${refName}\`), but a scope declares inline resource definitions (a \`kind:\` with its config). Declare the resource inline under '${scopeField}:', or reference an outer resource from a sibling field such as 'targets:'.`,
            data: { resource: resourceData, filePath, path: concretePath },
          });
        }
      },
    },
    { aliases, aliasesByModule, skipKinds: SYSTEM_KINDS, expand: true },
  );

  // Phase 3b — x-telo-schema-from validation.
  // For each field with a schemaFrom path expression, resolve the anchor ref to get the
  // concrete kind, navigate the JSON Pointer into that kind's definition schema, and
  // validate the field value against the resulting sub-schema. Driven off the base map
  // (un-expanded) so each schema-from slot is seen as its own site.
  visitManifest(
    localResources,
    registry,
    {
      onSchemaFrom: (e) => {
        const r = e.source;
        const fieldPath = e.fieldPath;
        const resourceLabel = `${r.kind}/${r.metadata!.name as string}`;
        const resourceData = { kind: r.kind, name: r.metadata!.name as string };
        const filePath = (r.metadata as { source?: string } | undefined)?.source;

        const { schemaFrom } = e.entry;
        const isAbsolute = schemaFrom.startsWith("/");
        const expr = isAbsolute ? schemaFrom.slice(1) : schemaFrom;
        const slashIdx = expr.indexOf("/");
        if (slashIdx === -1) {
          diagnostics.push({
            severity: DiagnosticSeverity.Error,
            code: "INVALID_SCHEMA_FROM",
            source: SOURCE,
            message: `${resourceLabel}: x-telo-schema-from "${schemaFrom}" must contain at least one "/" to separate anchor from JSON Pointer`,
            data: { resource: resourceData, filePath, path: fieldPath },
          });
          return;
        }

        const anchorName = expr.slice(0, slashIdx);
        const jsonPointer = "/" + expr.slice(slashIdx + 1);

        // Aliased absolute kind path — first segment carries a dot, e.g.
        // "HttpDispatch.Outcomes/$defs/Returns". Resolves the alias through the
        // *kind owner's* scope (not the consumer's), navigates the JSON Pointer
        // into the resolved definition's schema, and validates each field value.
        //
        // Relative anchors are property names that cannot contain a dot
        // (CEL-style identifiers), so a dot in anchorName is unambiguous.
        if (!isAbsolute && anchorName.includes(".")) {
          const resolvedResourceKind = aliases.resolveKind(r.kind) ?? r.kind;
          const resourceDef =
            registry.resolve(r.kind) ?? registry.resolve(resolvedResourceKind);
          const owningModule = (resourceDef?.metadata as { module?: string } | undefined)?.module;
          const ownerScope =
            (owningModule ? aliasesByModule?.get(owningModule) : undefined) ?? aliases;

          const targetKind = ownerScope.resolveKind(anchorName);
          if (!targetKind) {
            // Names the ALIAS, not the whole kind path: the alias is what an
            // author declares, and the usual cause is the import that binds it
            // having failed — which is reported on its own line.
            const aliasName = anchorName.slice(0, anchorName.indexOf("."));
            diagnostics.push({
              severity: DiagnosticSeverity.Error,
              code: "SCHEMA_FROM_MISSING_PATH",
              source: SOURCE,
              message:
                `${resourceLabel}: x-telo-schema-from at '${fieldPath}' → cannot resolve alias ` +
                `'${aliasName}' (in '${anchorName}'). Check the import that declares it.`,
              data: { resource: resourceData, filePath, path: fieldPath },
            });
            return;
          }

          const targetDef = registry.resolve(targetKind);
          if (!targetDef?.schema) {
            diagnostics.push({
              severity: DiagnosticSeverity.Error,
              code: "SCHEMA_FROM_MISSING_PATH",
              source: SOURCE,
              message: `${resourceLabel}: x-telo-schema-from at '${fieldPath}' → kind '${targetKind}' has no schema`,
              data: { resource: resourceData, filePath, path: fieldPath },
            });
            return;
          }

          const subSchema = navigateJsonPointer(targetDef.schema, jsonPointer);
          if (subSchema === undefined) {
            diagnostics.push({
              severity: DiagnosticSeverity.Error,
              code: "SCHEMA_FROM_MISSING_PATH",
              source: SOURCE,
              message: `${resourceLabel}: x-telo-schema-from at '${fieldPath}' → kind '${targetKind}' has no schema path '${jsonPointer}'`,
              data: { resource: resourceData, filePath, path: fieldPath },
            });
            return;
          }

          for (const { value: fieldValue, path: concretePath } of resolveFieldEntries(r, fieldPath)) {
            if (fieldValue == null) continue;
            const issues = registry.validateWithRefs(fieldValue, subSchema as Record<string, any>);
            for (const issue of issues) {
              diagnostics.push({
                severity: DiagnosticSeverity.Error,
                code: "DEPENDENT_SCHEMA_MISMATCH",
                source: SOURCE,
                message: `${resourceLabel}: '${concretePath}' does not match schema from '${anchorName}${jsonPointer}': ${issue}`,
                data: { resource: resourceData, filePath, path: concretePath },
              });
            }
          }
          return;
        }

        // Derive the anchor path in the resource config.
        let anchorPath: string;
        if (isAbsolute) {
          anchorPath = anchorName;
        } else {
          // Relative: replace the last dot-segment of fieldPath with anchorName.
          // e.g. "nodes[].options" → "nodes[].backend"
          const lastDot = fieldPath.lastIndexOf(".");
          anchorPath = lastDot === -1 ? anchorName : fieldPath.slice(0, lastDot + 1) + anchorName;
        }

        const anchorValues = resolveFieldValues(r, anchorPath);
        if (anchorValues.length === 0) return; // anchor field not set — nothing to validate

        const fieldEntries = resolveFieldEntries(r, fieldPath);

        for (let i = 0; i < fieldEntries.length; i++) {
          const { value: fieldValue, path: concretePath } = fieldEntries[i];
          if (fieldValue == null) continue;

          // For absolute paths, the single anchor applies to all field values.
          const anchorVal = isAbsolute ? anchorValues[0] : anchorValues[i];
          if (!anchorVal || typeof anchorVal !== "object") continue;

          const refVal = anchorVal as Record<string, unknown>;
          if (typeof refVal.kind !== "string") continue;

          // THE INSTANCE FIRST, then the kind — the layering
          // `x-telo-context-ref-from` already uses, and for the same reason. A
          // kind that declares one fixed shape declares it on its definition; a
          // kind whose shape is per instance declares it as a FIELD, and reading
          // only the definition would type every instance against nothing. A
          // `Durable.Await`'s `outputType:` is exactly the second: what a
          // delivery carries is a property of that await and of no other, so a
          // delivery naming it must be checked against the instance's own.
          const target =
            typeof refVal.name === "string" ? byName.get(refVal.name) : undefined;
          const perInstance =
            target === undefined
              ? undefined
              : navigateJsonPointer(target as Record<string, unknown>, jsonPointer);
          if (perInstance !== undefined) {
            const instanceSchema = resolveTypeFieldToSchema(
              perInstance,
              resources as Record<string, any>[],
            );
            if (instanceSchema) {
              // CEL leaves become schema-shaped placeholders first. A payload is
              // overwhelmingly written as expressions over the call's inputs, so
              // validating it raw would report every one of them as a type
              // error — the check would fire only on the literal case, which is
              // the case nobody writes. What survives substitution is exactly
              // what is worth reporting: a missing required field, an unknown
              // property, a literal of the wrong type. The same treatment
              // `x-telo-value-schema-from` documents.
              const substituted = substituteCelFields(
                fieldValue,
                instanceSchema as Record<string, any>,
              );
              for (const issue of registry.validateWithRefs(
                substituted,
                instanceSchema as Record<string, any>,
              )) {
                diagnostics.push({
                  severity: DiagnosticSeverity.Error,
                  code: "DEPENDENT_SCHEMA_MISMATCH",
                  source: SOURCE,
                  message: `${resourceLabel}: '${concretePath}' does not match the schema '${refVal.name}' declares at '${jsonPointer}': ${issue}`,
                  data: { resource: resourceData, filePath, path: concretePath },
                });
              }
              continue;
            }
          }

          const refResolvedKind = aliases.resolveKind(refVal.kind) ?? refVal.kind;
          const refDef = registry.resolve(refVal.kind) ?? registry.resolve(refResolvedKind);
          if (!refDef?.schema) {
            diagnostics.push({
              severity: DiagnosticSeverity.Error,
              code: "SCHEMA_FROM_MISSING_PATH",
              source: SOURCE,
              message: `${resourceLabel}: x-telo-schema-from at '${concretePath}' → kind '${refVal.kind}' has no schema`,
              data: { resource: resourceData, filePath, path: concretePath },
            });
            continue;
          }

          const subSchema = navigateJsonPointer(refDef.schema, jsonPointer);
          if (subSchema === undefined) {
            diagnostics.push({
              severity: DiagnosticSeverity.Error,
              code: "SCHEMA_FROM_MISSING_PATH",
              source: SOURCE,
              message: `${resourceLabel}: x-telo-schema-from at '${concretePath}' → kind '${refVal.kind}' has no schema path '${jsonPointer}'`,
              data: { resource: resourceData, filePath, path: concretePath },
            });
            continue;
          }

          const issues = registry.validateWithRefs(fieldValue, subSchema as Record<string, any>);
          for (const issue of issues) {
            diagnostics.push({
              severity: DiagnosticSeverity.Error,
              code: "DEPENDENT_SCHEMA_MISMATCH",
              source: SOURCE,
              message: `${resourceLabel}: '${concretePath}' does not match schema from '${refVal.kind}${jsonPointer}': ${issue}`,
              data: { resource: resourceData, filePath, path: concretePath },
            });
          }
        }
      },
    },
    { aliases, aliasesByModule, skipKinds: SYSTEM_KINDS, expand: false },
  );

  return diagnostics;
}
