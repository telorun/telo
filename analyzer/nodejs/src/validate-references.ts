import type { FindingOrder } from "./finding-order.js";
import type { ResourceDefinition, ResourceManifest } from "@telorun/sdk";
import { listRequests } from "./declaration-requests.js";
import { isRefSentinel } from "@telorun/templating";
import { visitManifest, type RefSiteEvent, type SchemaFromSiteEvent } from "./manifest-visitor.js";
import { celEvalModeAt, kindCelEvalSites, NO_CEL_EVAL_SITES } from "./eval-paths.js";
import { computedRefSlots, evaluatedField } from "./ref-slot-computed.js";
import { isSchemaFromSite, schemaFromIsKindDecidable, schemaFromSites, type SchemaFromFailure } from "./schema-from-sites.js";
import type { DerivedSlotContext } from "./derived-slots.js";
import { valueTypeRefusalCode } from "./schema-error-report.js";
import {
  satisfiesSiteValue,
  type RefFieldEntry,
} from "./reference-field-map.js";
import { substituteDecodedCelFields } from "./plain-literal-decoding.js";
import type { StandIns } from "./stand-in-findings.js";
import { isKindDocument } from "./kind-declaration.js";
import { DiagnosticSeverity, type AnalysisDiagnostic, type AnalysisContext } from "./types.js";
import type { AliasResolver } from "./alias-resolver.js";
import type { DefinitionRegistry } from "./definition-registry.js";
import { isModuleKind } from "./module-kinds.js";
import { isInlineDeclaration, isResolvedReference } from "./resolved-reference.js";
import { moduleAliasScope } from "./module-alias-scope.js";
import { acceptsInline } from "./normalize-inline-resources.js";
import { importPathThrough, MANIFEST_READING, scopeReadAt, ScopedNameResolver } from "./scoped-name-resolver.js";
import { isInjectedDeclaration } from "./resource-input.js";
import { injectedNeedOf } from "./need-type.js";
import { scopeSiteKey, type ScopeSite } from "./scope-address.js";
import { scopeMembers } from "./scope-declarations.js";
import { outOfReachNames, scopeMemberOf } from "./scope-members.js";
import { isStandInDeclaration } from "./choice-expansion.js";
import { isForwardedDeclaration, isForwardedExport } from "./forwarded-declaration.js";
import { CallableFlagsIndex } from "./callable-flags.js";
import { callableSlotVerdict, type CallableSlotContext } from "./callable-slot.js";
import { moduleCallNamesByModule } from "./module-call-names.js";
import { ModuleFunctionIndex } from "./module-function-index.js";
import { withQuotedPath } from "./quoted-place.js";

const SOURCE = "telo-analyzer";

/** What a name IS on one side of a collision. The three shapes share the
 *  kernel's one namespace but read as different things to an author — an alias
 *  is not a resource, and a module's own name is not a declaration inside it —
 *  so calling all three "resource name" describes two of them wrongly. */
function describeNamed(m: ResourceManifest, name: string): string {
  if (m.kind === "Telo.Import") return `import alias '${name}'`;
  if (isModuleKind(m.kind)) return `this module's own name (${m.kind} '${name}')`;
  return `resource ${m.kind}/${name}`;
}

/**
 * WHAT SHARES A NAME AT THE KERNEL.
 *
 * `registerManifest` keys on `metadata.name` alone, per module context, for
 * EVERY kind — so an import alias, a kind definition and an ordinary resource
 * are one namespace. This check used to model a narrower one: `Telo.Import` was
 * excluded outright, on the stated grounds that an alias "lives in a separate
 * namespace from resources", and `Telo.Definition` / `Telo.Abstract` fell out
 * through the ref-validation skip set, which answers a different question. All
 * three passed `telo check` and then died at boot with `ERR_DUPLICATE_RESOURCE`
 * — an application named after one of its own imports (`metadata.name: Schedule`
 * beside `Schedule: oci://…/scheduler`) being the shape that reaches an author,
 * since nothing about the two lines looks like one name written twice.
 *
 * Grouped per DECLARING MODULE, which is what makes including imports sound: a
 * library's own `Telo.Import` / `Telo.Definition` docs are forwarded into a
 * consumer's flat set, and two modules sharing an alias (`Console` in an app and
 * again in a library it imports) is ordinary rather than a collision. A module
 * doc carries no `metadata.module` and IS its own scope — that is what puts an
 * application's own name in the same group as its imports.
 *
 * Kept apart from the resolution lookup it used to share a map with: that one
 * must hold resolution targets alone, so the two disagree about membership by
 * design and merging them re-keyed every bare-name reference.
 */
function duplicateNameDiagnostics(
  resources: ResourceManifest[],
  isForeign: (r: ResourceManifest) => boolean,
  moduleOf: (r: ResourceManifest) => string | undefined,
  order: FindingOrder | undefined,
): AnalysisDiagnostic[] {
  const diagnostics: AnalysisDiagnostic[] = [];

  const moduleDocNames = new Set<string>();
  for (const r of resources) {
    if (isModuleKind(r.kind) && typeof r.metadata?.name === "string") {
      moduleDocNames.add(r.metadata.name);
    }
  }
  // A module doc belongs in the scope its OWN resources are in. Flattened, they
  // carry `metadata.module` equal to its name, so it scopes to itself — which is
  // what puts an application's name beside its imports. Unflattened (a hand-built
  // fixture, a single-file editor analysis) nothing is stamped, so its resources
  // sit in the unnamed scope and the doc has to join them there or a collision
  // with one of them splits across two groups and goes unreported.
  const stampedModules = new Set<string>();
  for (const r of resources) {
    const m = moduleOf(r);
    if (m) stampedModules.add(m);
  }

  // scope → name → declarations, so no separator has to be safe against a name.
  const byScope = new Map<string, Map<string, ResourceManifest[]>>();
  const seen = new Set<string>();
  for (const r of resources) {
    if (!r.metadata?.name || isForeign(r)) continue;
    // A declaration a choice makes holds the tag's name, which the choice
    // reading judges once against its namespace.
    if ((r.metadata as { xTeloChoice?: unknown }).xTeloChoice) continue;
    // A need's collision is the need table's, at its `needs:` key.
    if (injectedNeedOf(r)) continue;
    const name = r.metadata.name as string;
    // A scope member shares a namespace with its scope's other members alone:
    // it may shadow a module-level name.
    const member = scopeMemberOf(r);
    const module = isModuleKind(r.kind)
      ? (stampedModules.has(name) ? name : "")
      : (moduleOf(r) ?? "");
    // A scope with no module doc in this set is an imported library's, whose
    // doc `selectModuleManifestsForAnalysis` drops — its internals are its own
    // author's to fix, and its own `telo check` reports them.
    if (module !== "" && moduleDocNames.size > 0 && !moduleDocNames.has(module)) continue;
    const scope = member ? scopeSiteKey(member.site) : module;
    // Dedup pipeline echoes — the same physical document emitted twice through
    // an analyzer host's pipeline (telo studio walks a file reachable as both an
    // entry module and an `include:` partial). Keyed on (kind, name, source,
    // sourceLine), so two textually-distinct docs in one file keep separate
    // fingerprints and still trip the diagnostic.
    const meta = r.metadata as unknown as { source?: string; sourceLine?: number };
    const fingerprint = `${r.kind} ${name} ${meta.source} ${meta.sourceLine}`;
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    let names = byScope.get(scope);
    if (!names) byScope.set(scope, (names = new Map()));
    const existing = names.get(name);
    if (existing) existing.push(r);
    else names.set(name, [r]);
  }

  for (const names of byScope.values()) {
    for (const [name, list] of names) {
      if (list.length <= 1) continue;
      // The earliest as written is the one the others collide with.
      const [first, ...rest] = order ? order.sortBy(list, (a, b) => order.compareDeclarations(a, b)) : list;
      for (const dup of rest) {
        const found = duplicateNameDiagnostic(dup, first, name);
        if (found) diagnostics.push(found);
      }
    }
  }
  return diagnostics;
}

/** `DUPLICATE_RESOURCE_NAME` for `dup` colliding with `first`, declared earlier
 *  in one namespace. */
export function duplicateNameDiagnostic(
  dup: ResourceManifest,
  first: ResourceManifest,
  name: string,
): AnalysisDiagnostic | undefined {
  // Two imports sharing an alias is ONE defect with its own diagnostic
  // (`DUPLICATE_IMPORT_ALIAS`), which says what to do about it; reporting
  // it again here would describe one mistake as two.
  if (dup.kind === "Telo.Import" && first.kind === "Telo.Import") return undefined;
  const dupMeta = dup.metadata as { source?: string; sourceLine?: number } | undefined;
  const dupScope = scopeMemberOf(dup);
  // The precomputed range matters because editor hosts resolve positions
  // via a `${file}::${kind}::${name}` lookup, which collides on duplicates.
  // A scope member is anchored by its path inside its holder instead.
  const range =
    !dupScope && typeof dupMeta?.sourceLine === "number"
      ? {
          start: { line: dupMeta.sourceLine, character: 0 },
          end: { line: dupMeta.sourceLine, character: Number.MAX_SAFE_INTEGER },
        }
      : undefined;
  return {
    severity: DiagnosticSeverity.Error,
    code: "DUPLICATE_RESOURCE_NAME",
    source: SOURCE,
    message:
      `${dup.kind}/${name}: ${describeNamed(dup, name)} collides with ` +
      `${describeNamed(first, name)} declared earlier — ` +
      (dupScope
        ? `the kernel registers both under '${name}' in the '${dupScope.site.field}' scope ` +
          `of ${dupScope.holder.kind}/${dupScope.holder.metadata?.name as string}, so opening ` +
          `that scope fails. `
        : `the kernel registers both under '${name}' in one namespace, so boot fails with ` +
          `ERR_DUPLICATE_RESOURCE. `) +
      `Rename one of them.`,
    ...(range ? { range } : {}),
    data: { resource: { kind: dup.kind, name }, filePath: dupMeta?.source, path: "metadata.name" },
  };
}

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
 * subtype index for both. Accepts a constraint that resolves to nothing, and an
 * abstract with no loaded implementations: partial context, where a rejection
 * would be a guess.
 *
 * An abstract is satisfied only by an implementer, never by the abstract itself,
 * because a resource declared `kind: <some abstract>` is refused at `create()`
 * and reported as `ABSTRACT_KIND_INSTANTIATED` at its declaration — so accepting
 * it here would leave the reference sites silent about a manifest that cannot
 * run. `isDeclaration` is the ONE exception and it is not an instance: a
 * library's `resources:` entry is constrained by kind alone, so its kind-only
 * stand-in routinely IS an abstract (`connection: {kind: Acme.Connection}`), and
 * every use of that name inside the library is a reference to it.
 */
export function kindSatisfies(
  resolved: string,
  targetKind: string,
  registry: DefinitionRegistry,
  /** The referent is a kind-only stand-in for a `resources:` entry rather than a
   *  resource anything instantiates, so identity satisfies an abstract slot. */
  isDeclaration = false,
): boolean {
  const canonical = registry.resolveRef(targetKind) ?? targetKind;
  const targetDef = registry.resolve(canonical);
  if (!targetDef) return true;
  if ((targetDef.kind !== "Telo.Abstract" || isDeclaration) && resolved === canonical) return true;
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

/** A JSON Schema node's type, as a reader names it. */
function valuePhrase(branch: Record<string, any>): string {
  if ("const" in branch) return `the value ${JSON.stringify(branch.const)}`;
  if (Array.isArray(branch.enum)) return `one of ${branch.enum.map((v: unknown) => JSON.stringify(v)).join(", ")}`;
  const names: Record<string, string> = {
    string: "a string",
    integer: "an integer",
    number: "a number",
    boolean: "true or false",
    object: "an object",
    array: "a list",
    null: "null",
  };
  const types = (Array.isArray(branch.type) ? branch.type : [branch.type]).filter(
    (type: unknown): type is string => typeof type === "string",
  );
  return types.length > 0 ? types.map((type: string) => names[type] ?? type).join(" or ") : "a value";
}

/**
 * What a reference slot accepts, read from its own schema: each value branch by
 * its title and type, a `!ref` to a resource of its kinds, and — where the slot
 * takes one — an inline declaration. Kinds are spelled through `scope`, the
 * aliases of the module reading the slot.
 */
function acceptedAtSlot(
  entry: RefFieldEntry,
  inline: boolean,
  registry: DefinitionRegistry,
  scope: AliasResolver,
): string {
  const spell = (canonical: string): string => {
    const dot = canonical.lastIndexOf(".");
    if (dot <= 0) return canonical;
    const aliases = scope.aliasesFor(canonical.slice(0, dot));
    const alias = aliases.find((a) => a !== "Self") ?? aliases[0];
    return alias ? `${alias}${canonical.slice(dot)}` : canonical;
  };
  const kinds = entry.refs.map((ref) => {
    const canonical = registry.resolveRef(ref) ?? ref;
    return { written: spell(canonical), abstract: registry.resolve(canonical)?.kind === "Telo.Abstract" };
  });
  const ofKinds = kinds
    .map((k) => (k.abstract ? `a kind extending ${k.written}` : `kind ${k.written} or one extending it`))
    .join(", or ");
  const parts = new Set<string>();
  for (const branch of entry.valueBranches ?? []) {
    const value = valuePhrase(branch);
    parts.add(typeof branch.title === "string" ? `${branch.title} — ${value}` : value);
  }
  parts.add(`!ref <name> naming a resource of ${ofKinds}`);
  if (inline) parts.add(`an inline declaration { kind: <${ofKinds}>, … }`);
  const list = [...parts];
  return list.length === 1 ? list[0]! : `${list.slice(0, -1).join("; ")}; or ${list[list.length - 1]}`;
}

/** {@link kindSatisfies} at every kind a slot accepts, rendered as messages.
 *  The acceptance rule is not restated here — only what to say when it fails,
 *  which needs the slot's alternatives and the target's flavour. */
function checkKind(
  kind: string,
  entry: RefFieldEntry,
  registry: DefinitionRegistry,
  aliases: AliasResolver,
  /** See {@link kindSatisfies}: the referent is a `resources:` stand-in. */
  isDeclaration = false,
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
    if (!unknownAlias && kindSatisfies(resolved, targetKind, registry, isDeclaration)) return [];
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
 *   1. Structural — the value is a `{kind, name}` reference; anything else that
 *                   is neither an inline declaration nor a value the slot's own
 *                   union accepts is refused, naming what the slot takes.
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
  /** The analysis's own function index and flags, when the caller built them —
   *  one per analysis rather than one per pass. */
  shared?: { readonly functions: ModuleFunctionIndex; readonly flags: CallableFlagsIndex },
  /** The name collisions are judged elsewhere, once over every configuration. */
  duplicatesJudged = false,
  order?: FindingOrder,
): AnalysisDiagnostic[] {
  const diagnostics: AnalysisDiagnostic[] = [];
  const aliases = context.aliases;
  const registry = context.definitions;
  const aliasesByModule = context.aliasesByModule;
  if (!aliases || !registry) return diagnostics;

  // Build the outer resource lookup by name, for the resolution checks below.
  // WHICH NAMES COLLIDE is a different question over a different namespace and
  // is answered by `duplicateNameDiagnostics`; this map answers only "what does
  // a bare `!ref <name>` resolve to", so it holds resolution TARGETS alone — an
  // import alias and a kind definition are neither, and admitting them here
  // would resolve a reference to something no ref slot can accept.
  //
  // The list per name survives because resolution falls back to the FIRST
  // occurrence when a collision exists, which keeps the rest of the pass
  // behaving as it did before duplicates were reported at all.
  // Forwarded foreign exports (an imported library's exported instances, carrying a
  // metadata.module that isn't a root module) are resolution TARGETS only: excluded from
  // duplicate detection and local name resolution, and never walked as ref sources.
  const moduleOf = (r: ResourceManifest): string | undefined =>
    (r.metadata as { module?: string } | undefined)?.module;
  // A dependency's code — a forwarded export, or what extraction pulled out of one — is
  // excluded from duplicate detection and local name resolution, and never walked as a
  // ref source. Only an EXPORT is a cross-module resolution target.
  const isForeign = isForwardedDeclaration;
  // Forwarded exported instances, read by their module — the lookup that resolves
  // whether a cross-module `!ref Alias.name` names a real exported instance.
  const forwardedExports = resources.filter(isExportTarget);
  const loadedModules = loadedModulesOf(resources);
  const moduleLoaded = (module: string): boolean => loadedModules.has(module);
  const exportedBy = new ScopedNameResolver(forwardedExports, MANIFEST_READING);
  const localResources = resources.filter((r) => !isForeign(r));

  const targets: ResourceManifest[] = [];
  const seen = new Set<string>();
  for (const r of resources) {
    if (!r.metadata?.name || isKindDocument(r) || r.kind === "Telo.Import" || isForeign(r))
      continue;
    const name = r.metadata.name as string;
    // `analyze()` guarantees both fields are present on non-system manifests.
    const meta = r.metadata as unknown as { source: string; sourceLine: number };
    const fingerprint = `${r.kind} ${name} ${meta.source} ${meta.sourceLine}`;
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    targets.push(r);
  }
  if (!duplicatesJudged) diagnostics.push(...duplicateNameDiagnostics(resources, isForeign, moduleOf, order));
  // The dot rule that used to live here is now the strictest special case of
  // the identifier grammar in `validate-identifier-names.ts` — a dot is one of
  // several characters that make a name unreferenceable, and checking one of
  // them here while the rest went unchecked is what let a hyphenated name
  // through to silently evaluate as arithmetic.

  // What a bare name resolves to, scope first: a scope member is filed under
  // its scope, never at module level.
  const names = new ScopedNameResolver(targets, MANIFEST_READING);

  // A function in a slot constrained to a callable abstract satisfies it by
  // structure as well as by `extends` (`callable-slot.ts`). Built on first use:
  // most analyses hold no such slot.
  let callableSlots: CallableSlotContext | undefined;
  const callableSlotContext = (): CallableSlotContext => {
    if (!callableSlots) {
      let functions = shared?.functions;
      let flags = shared?.flags;
      if (!functions || !flags) {
        const rootModules = new Set<string>();
        for (const r of resources) {
          if (isModuleKind(r.kind) && typeof r.metadata?.name === "string") {
            rootModules.add(r.metadata.name);
          }
        }
        functions = new ModuleFunctionIndex(
          listRequests(resources),
          registry,
          aliases,
          aliasesByModule ?? new Map(),
          rootModules,
        );
        flags = new CallableFlagsIndex(functions, moduleCallNamesByModule(resources));
      }
      callableSlots = {
        resources,
        registry,
        resolveDef: (kind) => registry.resolve(kind) ?? registry.resolve(aliases.resolveKind(kind) ?? kind),
        functions,
        flags,
      };
    }
    return callableSlots;
  };
  /** The positions `REF_SLOT_COMPUTED` claims for a resource — an expression at
   *  or above a reference slot in a field the kind evaluates — read
   *  from the one reader that owns the rule, so this pass cannot report a
   *  second, shapeless verdict about the same line. Memoized per resource: the
   *  walk below visits every site of it. */
  let computedRefSlotPaths: ReadonlySet<string> = new Set();
  const readComputedRefSlots = (r: ResourceManifest, definition?: ResourceDefinition): void => {
    computedRefSlotPaths = computedReferencePaths(r, definition, registry, aliases, aliasesByModule);
  };

  const siteScope: ReferenceSiteScope = {
    registry,
    aliases,
    aliasesByModule,
    moduleLoaded,
    exportedIn: (name, module, importPath) => exportedBy.inModule(name, module, importPath),
    resolveLocal: (name, module, within) => names.resolve(name, module, within),
    callableSlots: callableSlotContext,
  };

  // Phase 3 — per-ref validation. The walker supplies each ref site already
  // resolved against the schema-from-expanded reference reach, with its source
  // enclosure (`inScope`) and the scope manifests visible to it — so this
  // handler only validates, it does not re-walk.
  visitManifest(
    localResources,
    registry,
    {
      onResourceEnter: (e) => readComputedRefSlots(e.source as ResourceManifest, e.definition),
      onRef: (e) => {
        diagnostics.push(...referenceSiteDiagnostics(e.source, e, computedRefSlotPaths.has(e.concretePath), siteScope));
      },
      onScope: (e) => {
        const r = e.source;
        // A set `telo check` did not prepare (the kernel's `prepare()`, an
        // editor's projection) holds no scope member as a declaration: its
        // scopes are declared here, as the walk reaches them.
        if (e.holder) {
          for (const scope of e.scopes) {
            names.declareScope({ holder: e.holder, field: scope.path }, scopeMembers(scope));
          }
        }
        diagnostics.push(...scopeEntryDiagnostics(r, e.scopeRefEntries));
      },
    },
    { aliases, aliasesByModule, skip: isKindDocument, expand: true },
  );

  // Phase 3b — x-telo-schema-from validation.
  // For each field with a schemaFrom path expression, resolve the anchor ref to get the
  // concrete kind, navigate the JSON Pointer into that kind's definition schema, and
  // validate the field value against the resulting sub-schema. A failure the kind alone
  // decides (a malformed expression, an alias-qualified anchor naming nothing) is
  // reported once per resource at the declared pattern, whatever the resource wrote; a
  // failure that turns on a sibling anchor's value, at each concrete site.
  const reportedSlotFailures = new Set<string>();
  // The slot's schema comes from the shared reader, which the kernel decodes literals
  // through at creation. CEL leaves become schema-shaped placeholders and plain-encoded
  // literals are decoded before AJV runs: a slot anchored at a shared value-shape is
  // overwhelmingly written as expressions, so validating it raw reports every one of them.
  const schemaFromContext = (r: ResourceManifest) => ({
    defs: registry,
    aliases,
    aliasesByModule: aliasesByModule ?? new Map(),
    rootModules: new Set<string>(),
    types: listRequests(resources as ResourceManifest[]),
    // In the reading resource's scope, as the kernel resolves it: a bare
    // name same module first, an alias through that module's import.
    resolveTarget: (ref: Record<string, any>, path?: string) => {
      if (typeof ref.name !== "string") return undefined;
      if (typeof ref.alias === "string" && ref.alias !== "Self") {
        const target = moduleAliasScope(r.metadata, aliases, aliasesByModule).moduleForAlias(
          ref.alias,
        );
        return target === undefined
          ? undefined
          : (exportedBy.inModule(ref.name, target, importPathThrough(r, ref.alias)) as
              | Record<string, any>
              | undefined);
      }
      return names.resolve(ref.name, moduleOf(r), scopeReadAt(r, path)) as
        | Record<string, any>
        | undefined;
    },
  });
  const reportFailure = (r: ResourceManifest, failure: SchemaFromFailure) => {
    const key = `${r.kind}/${r.metadata!.name as string}\0${failure.code}\0${failure.message}`;
    if (reportedSlotFailures.has(key)) return;
    reportedSlotFailures.add(key);
    diagnostics.push(schemaFromFailureDiagnostic(r, failure));
  };
  visitManifest(
    localResources,
    registry,
    {
      onResourceEnter: ({ source: r }) => {
        for (const failure of schemaFromDeclaredFailures(r, registry, aliases, aliasesByModule, schemaFromContext(r))) {
          reportFailure(r, failure);
        }
      },
      onSchemaFrom: (e) => {
        const found = schemaFromSiteDiagnostics(e.source, e, registry, schemaFromContext(e.source));
        for (const failure of found.failures) reportFailure(e.source, failure);
        diagnostics.push(...found.diagnostics);
      },
    },
    { aliases, aliasesByModule, skip: isKindDocument },
  );

  return diagnostics;
}

/** True when `value` carries every required key of one of the slot's own
 *  object value branches — the form the slot declares, whose values (a CEL
 *  guard, a nested reference) are not resolved yet, so matching the whole
 *  branch would be premature. */
function carriesDeclaredBranchKeys(
  value: Record<string, unknown>,
  branches: readonly Record<string, any>[] | undefined,
): boolean {
  return (branches ?? []).some(
    (branch) =>
      branch.type === "object" &&
      Array.isArray(branch.required) &&
      branch.required.length > 0 &&
      branch.required.every((key: unknown) => typeof key === "string" && key in value),
  );
}

/** A forwarded export of an imported library: a cross-module `!ref` target. */
export function isExportTarget(r: ResourceManifest): boolean {
  return !!r.metadata?.name && !isKindDocument(r) && isForwardedExport(r) && moduleOfManifest(r) !== undefined;
}

const moduleOfManifest = (r: ResourceManifest): string | undefined => (r.metadata as { module?: string } | undefined)?.module;

/**
 * Modules whose import subtree was actually loaded in this analysis. A resolved
 * `Telo.Import` carries `resolvedModuleName` (stamped only once the edge — and
 * thus the imported module — resolved); forwarded exports carry
 * `metadata.module`. Either marks the module loaded independent of how many
 * instances it exports, so a loaded library that exports nothing still reports
 * invalid cross-module refs, while partial single-file analysis (neither
 * present) is skipped to avoid false `UNRESOLVED_REFERENCE`.
 */
export function loadedModulesOf(resources: Iterable<ResourceManifest>): Set<string> {
  const loaded = new Set<string>();
  for (const r of resources) {
    if (r.kind === "Telo.Import") {
      const m = (r.metadata as { resolvedModuleName?: unknown } | undefined)?.resolvedModuleName;
      if (typeof m === "string") loaded.add(m);
      continue;
    }
    if (isExportTarget(r)) loaded.add(moduleOfManifest(r)!);
  }
  return loaded;
}

/** What judging one reference site reads beside the site. */
export interface ReferenceSiteScope {
  readonly registry: DefinitionRegistry;
  readonly aliases: AliasResolver;
  readonly aliasesByModule: Map<string, AliasResolver> | undefined;
  moduleLoaded(module: string): boolean;
  /** The forwarded export `name` of `module`'s instance at `importPath`. */
  exportedIn(name: string, module: string, importPath: readonly string[] | undefined): ResourceManifest | undefined;
  /** What a bare name resolves to among the resolution targets, scope first. */
  resolveLocal(name: string, module: string | undefined, within: ScopeSite | undefined): ResourceManifest | undefined;
  callableSlots(): CallableSlotContext;
}

/** One reference site of `r`, as the walk reaches it. */
export type ReferenceSite = Pick<RefSiteEvent, "concretePath" | "value" | "entry" | "refs" | "within">;

/**
 * Phase 3 at one reference site of `r`:
 *   1. Structural — the value is a `{kind, name}` reference; anything else that
 *      is neither an inline declaration nor a value the slot's own union
 *      accepts is refused, naming what the slot takes.
 *   2. Kind — the alias-resolved kind satisfies the x-telo-ref constraint
 *      (abstract: must extend the target; concrete: must equal it exactly).
 *   3. Resolution — a resource with that name exists in the visible set.
 * `computed`: an expression the kernel evaluates sits at the slot, which
 * `REF_SLOT_COMPUTED` reports.
 */
export function referenceSiteDiagnostics(
  r: ResourceManifest,
  site: ReferenceSite,
  computed: boolean,
  scope: ReferenceSiteScope,
): AnalysisDiagnostic[] {
  const { registry, aliases, aliasesByModule } = scope;
  const resourceLabel = `${r.kind}/${r.metadata!.name as string}`;
  const resourceData = { kind: r.kind, name: r.metadata!.name as string };
  const filePath = (r.metadata as { source?: string } | undefined)?.source;
  const { value: val, concretePath, entry, within } = site;
  const found = (code: string, message: string): AnalysisDiagnostic =>
    withQuotedPath(
      { severity: DiagnosticSeverity.Error, code, source: SOURCE, message, data: { resource: resourceData, filePath, path: concretePath } },
      concretePath,
    );

  /** The nominal verdict at a slot, overruled where a function stands in for a
   *  callable abstract by structure — and explained by it where it does not. */
  const kindVerdict = (kindErrors: string[], referent: ResourceManifest | undefined, label: string): string[] => {
    if (kindErrors.length === 0 || !referent) return kindErrors;
    const verdict = callableSlotVerdict(referent, label, entry.refs, scope.callableSlots());
    if (!verdict) return kindErrors;
    return verdict.satisfied ? [] : [...verdict.reasons];
  };

  // `!ref <name>` left unresolved by Phase 2.5.
  if (isRefSentinel(val)) {
    const refName = val.source;
    const dot = refName.indexOf(".");
    const aliasPrefix = dot > 0 ? refName.slice(0, dot) : undefined;

    // Cross-module: if that module's exports are loaded in this analysis, the
    // miss is real (name not in exports.resources, or a typo); if not (partial
    // single-file analysis), skip rather than emit a false UNRESOLVED_REFERENCE.
    if (aliasPrefix && aliasPrefix !== "Self" && aliases.hasAlias(aliasPrefix)) {
      const module = aliases.moduleForAlias(aliasPrefix);
      if (module && !scope.moduleLoaded(module)) return [];
      // A choice nothing decides stands in for the export: it resolves and is
      // judged by kind only once its choice is decided.
      if (module && isStandInDeclaration(scope.exportedIn(refName.slice(dot + 1), module, importPathThrough(r, aliasPrefix)))) {
        return [];
      }
      return [
        found(
          "UNRESOLVED_REFERENCE",
          `${resourceLabel}: reference at '${concretePath}' → '${refName}' is not exported by module '${module ?? aliasPrefix}' (add it to exports.resources)`,
        ),
      ];
    }

    // Local reference (bare name or explicit `Self.`-qualified), read scope
    // first: a shadowed name is validated against the resource the kernel
    // binds, never the one it shadows.
    const localName = aliasPrefix === "Self" ? refName.slice(dot + 1) : refName;
    const target = scope.resolveLocal(localName, moduleOfManifest(r), within);
    if (!target) {
      // A scoped name out of this declaration's reach has its own diagnostic,
      // which says why; this one would say only "not found".
      if (outOfReachNames(r).has(localName)) return [];
      return [found("UNRESOLVED_REFERENCE", `${resourceLabel}: reference at '${concretePath}' → resource '${localName}' not found`)];
    }
    if (isStandInDeclaration(target)) return [];
    const kindErrors = kindVerdict(
      checkKind(target.kind as string, entry, registry, aliases, isInjectedDeclaration(target)),
      target,
      refName,
    );
    return kindErrors.length > 0
      ? [found("REFERENCE_KIND_MISMATCH", `${resourceLabel}: reference at '${concretePath}' → ${kindErrors.join("; ")}`)]
      : [];
  }

  // Bare strings are no longer a reference shape — `validateReferenceForms`
  // rejects an author-written string at a ref slot before this pass runs.
  if (typeof val !== "object") return [];
  const refVal = val as Record<string, unknown>;

  // A value the slot's own union describes is a value, not a reference — the
  // same narrowing `validateReferenceForms` applies, through the same function:
  // an OBJECT-shaped value branch would otherwise reach the structural check
  // below and be refused as a value the slot does not take.
  if (satisfiesSiteValue(val, site.refs, registry)) return [];

  // Inline resources are extracted by Phase 2 normalization.
  if (isInlineDeclaration(refVal)) return [];

  // Polymorphic ref slots accept object forms whose references live in nested
  // slots — Application `targets`' inline `{ invoke }` and gated `{ ref }`, and
  // any object a slot's own value branch declares by its required keys (the
  // sink lists' `{ sink, when }`). Those nested refs are validated via their own
  // sites, and the object's own shape by the schema.
  if (
    typeof refVal.kind !== "string" &&
    ("invoke" in refVal || "ref" in refVal || carriesDeclaredBranchKeys(refVal, entry.valueBranches))
  ) {
    return [];
  }

  // An EXPRESSION at the slot has its own verdict (`REF_SLOT_COMPUTED`), which
  // says why a reference cannot come out of CEL; a list of what the slot takes
  // is no repair for an expression.
  if (computed) return [];

  // 1. Neither a reference, an inline declaration nor a value: say what the
  //    slot takes, from its own schema.
  if (!isResolvedReference(refVal)) {
    return [
      found(
        "INVALID_REFERENCE",
        `${resourceLabel}: the value at '${concretePath}' is not one this slot accepts. It takes ` +
          acceptedAtSlot(entry, acceptsInline(r.kind, entry), registry, moduleAliasScope(r.metadata, aliases, aliasesByModule)) +
          ".",
      ),
    ];
  }

  const out: AnalysisDiagnostic[] = [];
  // 2. Kind check
  const objectTarget = scope.resolveLocal(refVal.name, moduleOfManifest(r), within);
  const crossModule = typeof refVal.alias === "string" && refVal.alias !== "Self";
  const referentModule = crossModule ? aliases.moduleForAlias(refVal.alias as string) : undefined;
  const kindErrors = kindVerdict(
    checkKind(refVal.kind, entry, registry, aliases, isInjectedDeclaration(objectTarget)),
    crossModule
      ? referentModule
        ? scope.exportedIn(refVal.name, referentModule, importPathThrough(r, refVal.alias as string))
        : undefined
      : objectTarget,
    crossModule ? `${refVal.alias}.${refVal.name}` : refVal.name,
  );
  if (kindErrors.length > 0) {
    out.push(found("REFERENCE_KIND_MISMATCH", `${resourceLabel}: reference at '${concretePath}' → ${kindErrors.join("; ")}`));
  }

  // 3. Resolution check — resource with this name must exist.
  let exists: boolean;
  if (crossModule) {
    // Cross-module ref resolved by Phase 2.5: validated against the forwarded
    // exports when loaded; in partial context (module not loaded) resolvable.
    const module = aliases.moduleForAlias(refVal.alias as string);
    exists =
      !module ||
      !scope.moduleLoaded(module) ||
      scope.exportedIn(refVal.name, module, importPathThrough(r, refVal.alias as string)) !== undefined;
  } else {
    exists = objectTarget !== undefined;
  }
  if (!exists) {
    out.push(found("UNRESOLVED_REFERENCE", `${resourceLabel}: reference at '${concretePath}' → resource '${refVal.name}' not found`));
  }
  return out;
}

/** `SCOPE_ENTRY_NOT_INLINE` at each scope entry of `r` written as a reference. */
export function scopeEntryDiagnostics(
  r: ResourceManifest,
  entries: readonly { readonly path: string; readonly refName: string }[],
): AnalysisDiagnostic[] {
  const resourceLabel = `${r.kind}/${r.metadata!.name as string}`;
  const resourceData = { kind: r.kind, name: r.metadata!.name as string };
  const filePath = (r.metadata as { source?: string } | undefined)?.source;
  return entries.map(({ path: concretePath, refName }) => {
    const scopeField = concretePath.split(/[.[]/)[0];
    return withQuotedPath(
      {
        severity: DiagnosticSeverity.Error,
        code: "SCOPE_ENTRY_NOT_INLINE",
        source: SOURCE,
        message: `${resourceLabel}: scope entry at '${concretePath}' is a reference (\`!ref ${refName}\`), but a scope declares inline resource definitions (a \`kind:\` with its config). Declare the resource inline under '${scopeField}:', or reference an outer resource from a sibling field such as 'targets:'.`,
        data: { resource: resourceData, filePath, path: concretePath },
      },
      concretePath,
    );
  });
}

/** A failure an `x-telo-schema-from` slot of `r` raises, as reported. */
export function schemaFromFailureDiagnostic(r: ResourceManifest, failure: SchemaFromFailure): AnalysisDiagnostic {
  return withQuotedPath(
    {
      severity: DiagnosticSeverity.Error,
      code: failure.code,
      source: SOURCE,
      message: failure.message,
      data: {
        resource: { kind: r.kind, name: r.metadata!.name as string },
        filePath: (r.metadata as { source?: string } | undefined)?.source,
        path: failure.path,
      },
    },
    failure.path,
  );
}

/**
 * The failures `r`'s kind alone decides at its `x-telo-schema-from` slots — a
 * malformed expression, an alias-qualified anchor naming nothing — each once,
 * at the declared pattern, whatever `r` wrote.
 */
export function schemaFromDeclaredFailures(
  r: ResourceManifest,
  registry: DefinitionRegistry,
  aliases: AliasResolver,
  aliasesByModule: Map<string, AliasResolver> | undefined,
  ctx: DerivedSlotContext,
): SchemaFromFailure[] {
  const out: SchemaFromFailure[] = [];
  const seen = new Set<string>();
  const declared = registry.declaredReachOf(r, aliases, aliasesByModule);
  for (const stop of declared?.stops ?? []) {
    if (stop.viaAnchor) continue;
    for (const { schemaFrom } of stop.schemaFrom) {
      if (!schemaFromIsKindDecidable(schemaFrom)) continue;
      const slot = { fieldPath: stop.path, path: stop.path, value: undefined };
      for (const site of schemaFromSites(r as Record<string, any>, slot, schemaFrom, ctx)) {
        if (isSchemaFromSite(site)) continue;
        const key = `${site.code}\0${site.message}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(site);
      }
    }
  }
  return out;
}

/**
 * One concrete `x-telo-schema-from` site of `r`: the anchor ref resolved to the
 * concrete kind, the JSON Pointer navigated into that kind's (or instance's)
 * schema, and the value validated against it — a failure that turns on the
 * sibling anchor's value, and each mismatch.
 */
export function schemaFromSiteDiagnostics(
  r: ResourceManifest,
  e: Pick<SchemaFromSiteEvent, "fieldPath" | "concretePath" | "value" | "holder" | "entry">,
  registry: DefinitionRegistry,
  ctx: DerivedSlotContext,
): { failures: SchemaFromFailure[]; diagnostics: AnalysisDiagnostic[] } {
  const resourceLabel = `${r.kind}/${r.metadata!.name as string}`;
  const resourceData = { kind: r.kind, name: r.metadata!.name as string };
  const filePath = (r.metadata as { source?: string } | undefined)?.source;
  const kindDecidable = schemaFromIsKindDecidable(e.entry.schemaFrom);
  const failures: SchemaFromFailure[] = [];
  const diagnostics: AnalysisDiagnostic[] = [];
  const sites = schemaFromSites(
    r as Record<string, any>,
    { fieldPath: e.fieldPath, path: e.concretePath, value: e.value, holder: e.holder },
    e.entry.schemaFrom,
    ctx,
  );
  for (const site of sites) {
    if (!isSchemaFromSite(site)) {
      // A kind-decided failure is the declared half's.
      if (!kindDecidable) failures.push(site);
      continue;
    }
    // An enumerated derived slot: the kernel decodes it at creation.
    const standIns: StandIns = new Map();
    const substituted = substituteDecodedCelFields(site.value, site.schema, undefined, {
      standIns,
      external: (ref) => registry.schemaForId(ref),
    });
    if (site.form !== "anchored") {
      const against = site.form === "instance" ? site.source : `schema from '${site.source}'`;
      for (const issue of registry.validateResourceConfig(substituted, site.schema, standIns)) {
        diagnostics.push(
          withQuotedPath(
            {
              severity: DiagnosticSeverity.Error,
              code: valueTypeRefusalCode(issue) ?? "DEPENDENT_SCHEMA_MISMATCH",
              source: SOURCE,
              message: `${resourceLabel}: '${site.path}' does not match ${against}: ${issue.message}`,
              data: { resource: resourceData, filePath, path: site.path },
            },
            site.path,
          ),
        );
      }
      continue;
    }
    // Anchored at the offending node INSIDE the value, not at the slot: a
    // `returns:` list is an array of entries, and reporting every issue on the
    // `returns:` line puts them all on one line and none on the entry.
    for (const issue of registry.validateResourceConfig(substituted, site.schema, standIns)) {
      diagnostics.push(
        withQuotedPath(
          {
            severity: DiagnosticSeverity.Error,
            code: valueTypeRefusalCode(issue) ?? "DEPENDENT_SCHEMA_MISMATCH",
            source: SOURCE,
            message: `${resourceLabel}: '${site.path}' does not match schema from '${site.source}': ${issue.message}`,
            data: {
              resource: resourceData,
              filePath,
              // An index-first sub-path (`[0].content`) joins with no dot.
              path: !issue.path
                ? site.path
                : issue.path.startsWith("[")
                  ? `${site.path}${issue.path}`
                  : `${site.path}.${issue.path}`,
            },
          },
          site.path,
        ),
      );
    }
  }
  return { failures, diagnostics };
}

/** The positions `REF_SLOT_COMPUTED` claims in `r` — an expression at or above
 *  a reference slot in a field the kind evaluates — read from the one reader
 *  that owns the rule, so the reference checks report no second verdict there. */
export function computedReferencePaths(
  r: ResourceManifest,
  definition: ResourceDefinition | undefined,
  registry: DefinitionRegistry,
  aliases: AliasResolver,
  aliasesByModule: Map<string, AliasResolver> | undefined,
): ReadonlySet<string> {
  const sites = definition ? kindCelEvalSites(definition, registry, registry.shapeLookup) : NO_CEL_EVAL_SITES;
  return new Set(
    computedRefSlots(registry.referencePositions(r, aliases, aliasesByModule), (path) => evaluatedField(sites, path)).map(
      (slot) => slot.path,
    ),
  );
}
