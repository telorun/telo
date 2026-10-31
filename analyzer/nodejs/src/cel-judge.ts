/**
 * One CEL site judged: what its expressions are typed as and what is refused
 * there, over a {@link CelJudgeWorld}.
 *
 * The world is everything a judgement reads beyond the declaration in hand,
 * built by whoever drives the judging: a configuration's analysis builds it
 * from its whole set; a key's environment from what the key covers. It holds
 * no manifest list — a builder that reads another declaration asks for it by
 * request (`declaration-requests.ts`), so an environment covering less than
 * the whole set can refuse what it does not hold instead of answering a scan
 * over a subset.
 *
 * Browser-safe.
 */
import type { ResourceDefinition, ResourceManifest } from "@telorun/sdk";
import { OBSERVED_STATE_KEY } from "@telorun/sdk";
import {
  CEL_ENGINE,
  celExpressionsOf,
  defaultRegistry,
  extractAccessChains,
  makeTaggedSentinel,
  plainChainOf,
} from "@telorun/templating";
import type { AccessorProblem } from "./accessor-binding.js";
import { accessorFields, accessorProblems } from "./accessor-binding.js";
import type { AliasResolver } from "./alias-resolver.js";
import { renderChain } from "./callable-flags.js";
import { parseCelSource, valueBrandHint } from "./cel-environment.js";
import { producedValueOf, type ProducedValue } from "./cel-produced-value.js";
import { declaredChainSchemaAt, type CelScopeResolver, type CelSiteRef, type ReferrerVariant } from "./cel-scope.js";
import { reportCelSiteJudgement } from "./cel-site-judgements.js";
import type { CelOccurrenceFacts } from "./cel-site-solve.js";
import type { DefinitionRegistry } from "./definition-registry.js";
import {
  accessorSiteAt,
  celEvalModeAt,
  kindCelEvalSites,
  NO_CEL_EVAL_SITES,
  type CelEvalMode,
  type CelEvalSites,
  type NamedShapeLookup,
} from "./eval-paths.js";
import { inheritedCapability, type DefResolver } from "./extends-resolution.js";
import { isForwardedDeclaration } from "./forwarded-declaration.js";
import { isTypeLevelName } from "./identifier-name.js";
import type { KernelGlobalsIndex } from "./kernel-globals.js";
import { isKindDocument } from "./kind-declaration.js";
import { moduleCallNamesOf } from "./module-call-names.js";
import type { ModuleFunctionIndex } from "./module-function-index.js";
import { isModuleKind } from "./module-kinds.js";
import type { CelSiteEvent } from "./manifest-visitor.js";
import type { TemplateBodyResources } from "./template-body-resources.js";
import type { AnalysisDiagnostic } from "./types.js";
import { DiagnosticSeverity } from "./types.js";
import { unboundCallReason } from "./unbound-call-site.js";
import { moduleCallDiagnostics } from "./validate-module-calls.js";
import { quoteData, quotingPath } from "./quoted-place.js";
import {
  observedStateRead,
  reportsFromInit,
  type AnalyzedResource,
  type observedStateNames,
  type ScopedObservedResources,
} from "./validate-observed-state.js";

const SOURCE = "telo-analyzer";

/** What a judgement reads beyond the declaration in hand. It holds no list of
 *  manifests: whatever another declaration contributes reaches it already
 *  built, or by request through the scope rule (`celScope`). */
export interface CelJudgeWorld {
  readonly celScope: CelScopeResolver;
  readonly defs: DefinitionRegistry;
  readonly aliases: AliasResolver;
  readonly rootModules: ReadonlySet<string>;
  /** A named shape by its id. */
  readonly shapes: NamedShapeLookup;
  readonly kernelGlobals: KernelGlobalsIndex;
  /** The names a call's receiver may be, per declaring module. */
  readonly moduleCallNames: ReadonlyMap<string, ReadonlySet<string>>;
  readonly moduleFunctions: ModuleFunctionIndex;
  /** What each resource a `resources.…` read can name reports, by key. */
  readonly observedState: ReadonlyMap<string, AnalyzedResource>;
  readonly observedNames: ReturnType<typeof observedStateNames>;
  readonly scopedResources: ScopedObservedResources;
  readonly bodyResources: TemplateBodyResources;
  /** Every name a scope declares a member under. */
  readonly scopedMemberNames: ReadonlySet<string>;
  /** Whether any declaration reports observed state. */
  readonly reportsObservedState: boolean;
  /** What something starts — read by `OBSERVED_STATE_NEVER_RUN` alone. */
  readonly runReachable: ReadonlySet<string>;
  /** Whether a forwarded expression is checked at its entry's view instead. */
  readonly forwardViews?: { defersCel(manifest: ResourceManifest, path: string): boolean };
  readonly textLanguages: { langOf(manifest: ResourceManifest): string | null };
  /** How the nested kind of a template body's entry evaluates a field. */
  bodyEvalModeAt(host: ResourceManifest, path: string): CelEvalMode | null | undefined;
  /** Whether a template body's entry holds an accessor field at `path`. */
  bodyAccessorAt(host: ResourceManifest, path: string): boolean;
  /** What `CEL_UNKNOWN_FIELD` adds for a `resources.<name>` the record lacks. */
  scopeMemberClause(m: ResourceManifest, path: string, message: string): string;
  /** The schema a resource of this kind is validated against. */
  validationSchemaFor(definition: ResourceDefinition): Record<string, any>;
  /** Whether the judging is a configuration run's (counted). */
  readonly configurationRun: boolean;
}

/** The fields of `T` that could carry a list of manifests. */
export type ManifestListFields<T> = {
  [K in keyof T]-?: T[K] extends readonly ResourceManifest[]
    ? K
    : readonly ResourceManifest[] extends T[K]
      ? K
      : never;
}[keyof T];

/** The judge's input holds no manifest list: adding one fails compilation here. */
const holdsNoManifestList: [ManifestListFields<CelJudgeWorld>] extends [never] ? true : false = true;
void holdsNoManifestList;

/** What one judgement of a CEL site found about its value. */
export interface CelSiteFacts {
  type?: string;
  literal?: string;
  produced?: Record<string, any>;
  /** What a non-chain expression's tree says about its value. */
  composed?: ProducedValue;
}

/** What each expression of a set was typed as, by declaration and path. */
export type CelFactMaps = Pick<
  CelJudge,
  "typeByPath" | "sourceByPath" | "literalByPath" | "sourceSchemaByPath" | "composedByPath" | "variantFacts"
>;

/** No expression's facts yet. */
export function emptyCelFactMaps(): CelFactMaps {
  return {
    typeByPath: new Map(),
    sourceByPath: new Map(),
    literalByPath: new Map(),
    sourceSchemaByPath: new Map(),
    composedByPath: new Map(),
    variantFacts: new Map(),
  };
}

/** Record what a site's key found for the expression at `path` of `m`. */
export function replayCelFacts(
  maps: CelFactMaps,
  m: ResourceManifest,
  path: string,
  facts: CelOccurrenceFacts | undefined,
): void {
  if (!facts) return;
  const put = <V>(byManifest: Map<ResourceManifest, Map<string, V>>, value: V | undefined) => {
    if (value === undefined) return;
    let byPath = byManifest.get(m);
    if (!byPath) byManifest.set(m, (byPath = new Map()));
    byPath.set(path, value);
  };
  put(maps.typeByPath, facts.type);
  put(maps.sourceByPath, facts.type !== undefined ? facts.source : undefined);
  put(maps.literalByPath, facts.literal);
  put(maps.sourceSchemaByPath, facts.produced);
  put(maps.composedByPath, facts.composed as ProducedValue | undefined);
  put(maps.variantFacts, facts.variants as ReadonlyArray<CelSiteFacts & { label: string | undefined }> | undefined);
}

/** The judgement of the CEL sites of one declaration after another: each
 *  declaration entered, then its expressions judged. */
export class CelJudge {
  /** What each judged expression was typed as, by declaration and path. */
  readonly typeByPath = new Map<ResourceManifest, Map<string, string>>();
  /** The expression's source, for what its text alone decides. */
  readonly sourceByPath = new Map<ResourceManifest, Map<string, string>>();
  /** The string an expression is a literal of, as the engine parsed it. */
  readonly literalByPath = new Map<ResourceManifest, Map<string, string>>();
  /** The schema an expression RESOLVES TO, beside the CEL type it carries. */
  readonly sourceSchemaByPath = new Map<ResourceManifest, Map<string, Record<string, any>>>();
  readonly composedByPath = new Map<ResourceManifest, Map<string, ProducedValue>>();
  /** What a site judged under several referrer typings found under each. */
  readonly variantFacts = new Map<
    ResourceManifest,
    Map<string, ReadonlyArray<CelSiteFacts & { label: string | undefined }>>
  >();

  /** The `steps` schema the entered declaration's expressions are typed
   *  against, read back by the step-inputs check. */
  stepContextSchema: Record<string, any> | undefined;
  errorScopes: ReadonlyMap<string, Record<string, any>> = new Map();
  /** Where the entered declaration's kind evaluates its values. */
  sites: CelEvalSites = NO_CEL_EVAL_SITES;
  /** Whether the non-eval-field rule applies to the entered declaration. */
  ruleApplies = false;
  /** The author-facing schema of the entered declaration. */
  unboundSchema: Record<string, any> | undefined;
  /** The entered declaration's accessor fields, by concrete path, each with
   *  why its value cannot stay. */
  accessorsByPath = new Map<string, AccessorProblem[]>();

  constructor(private readonly world: CelJudgeWorld) {}

  /** Establish the per-declaration half of the judgement. */
  enterResource(m: ResourceManifest, definition: ResourceDefinition | undefined): void {
    const w = this.world;
    w.celScope.enterResource(m, definition);
    // Read back rather than recomputed: the step-inputs check has to see the
    // same `steps` schema this resource's expressions are typed against.
    this.stepContextSchema = w.celScope.stepContextSchema;
    this.errorScopes = w.celScope.errorContextScopes;
    this.unboundSchema = definition ? w.validationSchemaFor(definition) : undefined;
    // The non-eval-field check only applies to runtime resource instances:
    // structural / templating kinds (capability `Telo.Template`, or no
    // definition) carry CEL the kernel evaluates by other rules. The
    // capability is INHERITED along `extends` — an inheritance kind writes
    // none of its own.
    const resolveDef: DefResolver = (k) => w.defs.resolve(w.aliases.resolveKind(k) ?? k) ?? w.defs.resolve(k);
    const capability = definition ? inheritedCapability(definition, resolveDef) : undefined;
    this.ruleApplies = !!definition?.schema && capability !== undefined && capability !== "Telo.Template";
    // The INHERITANCE-RESOLVED schema, not the kind's own: without `base:`, an
    // `extends` child is authored against merge(parent, own), so a CEL-bearing
    // field the parent declares is a legal field on the child and the kernel
    // expands it. A `Telo.Provider`'s fields are implicitly compile-eval, and
    // a base-form child's own fields are too (`implicitEvalSites`).
    this.sites = this.ruleApplies ? kindCelEvalSites(definition!, resolveDef, w.shapes) : NO_CEL_EVAL_SITES;
    // An accessor field holds a plain chain or a literal; a chain rooted at a
    // name the field does not bind is left to the expression's own verdict.
    this.accessorsByPath = new Map();
    if (this.ruleApplies) {
      for (const field of accessorFields(m as Record<string, unknown>, this.sites)) {
        this.accessorsByPath.set(field.path, accessorProblems(field));
      }
    }
  }

  /** What a judged occurrence was typed as. */
  factsAt(m: ResourceManifest, path: string, source: string): Omit<CelOccurrenceFacts, "layout"> {
    const variants = this.variantFacts.get(m)?.get(path);
    return {
      source,
      type: this.typeByPath.get(m)?.get(path),
      literal: this.literalByPath.get(m)?.get(path),
      produced: this.sourceSchemaByPath.get(m)?.get(path),
      composed: this.composedByPath.get(m)?.get(path),
      ...(variants ? { variants } : {}),
    };
  }

  /** What a site's key found, read back where the checks over the whole
   *  application look an expression's type up. */
  replay(m: ResourceManifest, path: string, facts: CelOccurrenceFacts | undefined): void {
    replayCelFacts(this, m, path, facts);
  }

  /**
   * Judge one CEL occurrence of the entered declaration into `diagnostics`:
   * `all` of it; in a key's environment (`site`), everything but what reads a
   * fact a configuration run still computes (whether anything starts a
   * resource); at a configuration run, only that. `counted` names the site and
   * key counted.
   */
  judge(
    e: CelSiteEvent,
    part: "all" | "site" | "never-run",
    diagnostics: AnalysisDiagnostic[],
    counted?: { readonly site: string; readonly key: string },
  ): void {
    const w = this.world;
    const m = e.source;
    const resource = { kind: m.kind, name: m.metadata?.name as string };
    const filePath = (m.metadata as { source?: string } | undefined)?.source;
    const { expr, path, engineName, matchedScope } = e;
    const expressions = celExpressionsOf(engineName, expr);

    // A forwarded expression is checked once, where it is evaluated: at the
    // entry's view unless this kind evaluates it at compile time.
    if (w.forwardViews?.defersCel(m, path)) return;

    // An accessor field is typed like any CEL leaf and never evaluated.
    // Only a plain chain written AS the field's value reaches the checker;
    // anything else there is already reported for the resource.
    const evalMode = this.ruleApplies ? celEvalModeAt(this.sites, path) : undefined;
    const accessor = evalMode === "accessor";
    const accessorVerdict = accessor ? this.accessorsByPath.get(path) : undefined;
    if (accessor && (!accessorVerdict || accessorVerdict.some((p) => p.unboundRoot === undefined))) {
      return;
    }

    // A tag holding CEL (`!cel`, `!interpolate`, `!sql`) in a field with no
    // `x-telo-eval` / `x-telo-context` is never evaluated — the runtime
    // reads it as a literal (e.g. a `concurrency` `!cel` that silently
    // degraded to a sparse `[null, …]`). Flag it rather than letting it
    // pass as valid CEL. Inline resources (resource-wide invocation
    // context) carry CEL the kernel evaluates.
    if (
      expressions.length > 0 &&
      w.celScope.invocationContextSchema === undefined &&
      evalMode === null &&
      !pathCrossesNestedResource(m, path)
    ) {
      if (part !== "never-run") diagnostics.push({
        severity: DiagnosticSeverity.Error,
        code: "CEL_IN_NON_EVAL_FIELD",
        source: SOURCE,
        ...quotedAt(
          `${m.kind}/${resource.name}: CEL at '`,
          `' is never evaluated — the field has no x-telo-eval / x-telo-context annotation, so its value is read as a literal. Annotate the field as a CEL slot or remove the !${engineName} tag.`,
          { resource, filePath, path },
        ),
      });
      return;
    }

    // Observed state exists only once its producer has started, so a path
    // through `.status` is illegal in a field that resolves at startup —
    // and a resource nothing can start reports nothing, ever. A Provider
    // is the exception to both: it reports from `init()`.
    const observedReads = expressions
      .filter((x) => x.includes(OBSERVED_STATE_KEY))
      .flatMap((x) => celAccessChains(x, moduleCallNamesOf(w.moduleCallNames, m)))
      .flatMap((chain) => {
        const read = observedStateRead(chain);
        return read ? [{ chain, read }] : [];
      });
    // A template body's entries report observed state of their own.
    if (observedReads.length > 0 && (m.kind === "Telo.Definition" || w.reportsObservedState)) {
      for (const { chain, read } of observedReads) {
        // An import's exported instance is indexed under `<Alias>.<name>`,
        // the two-level shape it publishes under, so a cross-module read
        // is checked exactly like a local one. A bare name is what the CEL
        // `resources` record holds at this path: a member of the one scope
        // whose run evaluates the field, else a module-level resource — a
        // bare name read inside a dependency's own manifest naming that
        // dependency's.
        let reported: ReturnType<CelJudgeWorld["scopedResources"]["member"]>;
        let sibling: ReturnType<CelJudgeWorld["bodyResources"]["entry"]>;
        if (read.alias) {
          reported = w.observedState.get(`${read.alias}.${read.name}`);
        } else {
          const site = w.scopedResources.at(m as unknown as ResourceManifest, path);
          // A sibling of a template body shadows the module's resource of
          // that name.
          sibling = w.bodyResources.entry(m as unknown as ResourceManifest, path, read.name);
          reported =
            sibling ??
            (site ? w.scopedResources.member(site, read.name) : undefined) ??
            (isForwardedDeclaration(m) ? w.observedNames.forwarded : w.observedNames.local).resolve(
              read.name,
              m.metadata?.module as string | undefined,
            )?.resource;
          // A scope member the record does not hold here is
          // `CEL_UNKNOWN_FIELD`'s alone.
          if (!reported && w.scopedMemberNames.has(read.name)) continue;
        }

        // A Provider reports from `init()`, which completes before any
        // reader of it is created — so its status exists at startup and
        // needs nothing to start it. An unresolved target is no Provider.
        if (reportsFromInit(reported?.capability)) continue;

        if ((evalMode ?? w.bodyEvalModeAt(m as unknown as ResourceManifest, path)) === "compile") {
          if (part !== "never-run") diagnostics.push({
            severity: DiagnosticSeverity.Error,
            code: "OBSERVED_STATE_IN_STARTUP_FIELD",
            source: SOURCE,
            ...quotedAt(
              `${m.kind}/${resource.name}: '`,
              `' is resolved once at startup, so '${chain.join(".")}' does not exist yet — '${read.name}' reports it only while the application is running. Read reported values where the call happens: a step's inputs:, a request's url, a route handler, or a returns: expression.`,
              { resource, filePath, path },
            ),
          });
          continue;
        }

        // Nothing in the call graph starts a body's entries.
        if (part !== "site" && reported && !sibling && !w.runReachable.has(read.name)) {
          diagnostics.push({
            severity: DiagnosticSeverity.Error,
            code: "OBSERVED_STATE_NEVER_RUN",
            source: SOURCE,
            message: `${m.kind}/${resource.name}: '${read.name}' reports '${read.field ?? OBSERVED_STATE_KEY}' only while it is running, and nothing starts it. Add '!ref ${read.name}' to a targets: list, or invoke it from a step.`,
            data: { resource, filePath, path },
          });
        }
      }
    }

    if (part === "never-run") return;
    const siteRef: CelSiteRef = {
      source: m,
      path,
      contextSchema: e.contextSchema,
      matchedScope,
      ...(e.contexts ? { contexts: e.contexts } : {}),
      mode: accessor || w.bodyAccessorAt(m as unknown as ResourceManifest, path) ? "accessor" : (evalMode ?? undefined),
    };
    // A binding typed from the resource's referrers may take several
    // types; the site is judged once per distinct one.
    const variants = w.celScope.siteVariants(siteRef);
    const judgeUnder = (
      variant: ReferrerVariant | undefined,
      diagnostics: AnalysisDiagnostic[],
      primary: boolean,
      facts: CelSiteFacts,
    ): void => {
      const engine = defaultRegistry().get(engineName);
      if (!engine) {
        // No registered engine owns this tag — the expression would go
        // entirely unanalyzed. Surface it rather than skipping silently.
        diagnostics.push({
          severity: DiagnosticSeverity.Error,
          code: "UNKNOWN_ENGINE",
          source: SOURCE,
          ...quotedAt(`${m.kind}/${resource.name}: no templating engine registered for '!${engineName}' at '`, `'.`, {
            resource,
            filePath,
            path,
          }),
        });
        return;
      }
      // The engine type-checks, so it gets the environment typed for THIS
      // path — not the bare base one. Both halves come from the one scope
      // rule, which is what makes the IDE's answer and this check the same
      // answer rather than two that agree today.
      const {
        env: typedEnv,
        contextSchema: effectiveContext,
        moduleNames: siteModuleNames,
        moduleCallType,
        moduleCallResult,
        moduleCallFlags,
        explainSchema,
      } = w.celScope.scopeFor({ ...siteRef, ...(variant ? { variant } : {}) });

      reportCelSiteJudgement({
        site: counted?.site,
        key: counted?.key,
        configurationRun: w.configurationRun,
      });
      const result = engine.analyze(expr, {
        celEnv: typedEnv,
        contextSchema: effectiveContext,
        // A call whose receiver is one of these resolves to a module
        // function: it is not classified against the catalog, its
        // determinism is not the catalog's, and its receiver is not a root
        // identifier. It types as its callee's declared result, and member
        // access on it is checked against that result's schema.
        moduleNames: siteModuleNames,
        moduleCallType,
        moduleCallResult,
        // Each module call carries its callee's derived flags, so the
        // policies below read `deterministic === false` for a module call as
        // they do for a catalog one.
        moduleCallFlags,
        explainSchema,
        // `scopeFor` registers every kernel global (none in a parameter scope,
        // which replaces them) and every name the site's context declares,
        // so a root this environment does not know is one
        // nothing puts in scope. Two places where the CEL belongs to another
        // scope, both already recognised by the non-eval-field check: a kind
        // document, whose CEL is written for whoever instantiates the kind,
        // and anything below a nested inline `{ kind }`, whose CEL the
        // nested kind evaluates — and which is analyzed again, in its own
        // scope, as the resource it was extracted into.
        rootsDeclared: !isKindDocument(m) && !pathCrossesNestedResource(m, path),
        // Which bare names could be a module: the naming rule, which the
        // engine does not own. A module name and an import alias are
        // type-level, so a lowercase receiver is a misspelled value and the
        // `imports:` repair would be advice for a different mistake.
        couldNameModule: isTypeLevelName,
      });

      if (result.type !== undefined) facts.type = result.type;
      if (result.type !== undefined && primary) {
        let byPath = this.typeByPath.get(m);
        if (!byPath) this.typeByPath.set(m, (byPath = new Map()));
        byPath.set(path, result.type);
        let sources = this.sourceByPath.get(m);
        if (!sources) this.sourceByPath.set(m, (sources = new Map()));
        sources.set(path, expr);
        if (result.stringLiteral !== undefined) {
          facts.literal = result.stringLiteral;
          let literals = this.literalByPath.get(m);
          if (!literals) this.literalByPath.set(m, (literals = new Map()));
          literals.set(path, result.stringLiteral);
        }
      }

      // The producer half of the type-argument check. A CEL type is a bare
      // name — cel-js types by constructor identity, so a byte stream and a
      // string stream are one CEL type and always will be — so the argument
      // comparison is a parallel pass over the SCHEMAS the analyzer already
      // walks. This is where the producer's schema is in hand: navigating
      // the expression's chain into its context schema is exactly "the
      // producer's outputType at the expression's tail".
      //
      // Only a PLAIN CHAIN is navigated — `steps.encode.result.output`, the
      // shape a wiring site actually takes. An expression that computes
      // rather than names has no schema to read off the context, so it
      // records nothing and no argument check fires: silence where the
      // analyzer knows least is the conservative direction, and the same one
      // `x-telo-step-context`'s pure-`value` typing takes.
      // A site with no context of its own still reads the kernel globals —
      // `variables.dataDir` in a plain config field — whose declared schemas
      // the host-path check needs as much as a step result's.
      const chainContext =
        effectiveContext ?? w.kernelGlobals.forResource(m as unknown as ResourceManifest, path);
      // Read as the shape it names: a reference at a hop or at the tail is
      // followed, so what a producer declares behind one is judged. A step
      // chain is read off the `steps` record the site reads, where each result
      // is the document its target declared or its producer's fact; the
      // context is a copy of it, in which no pointer can be traced to its
      // document.
      const stepsRead = w.celScope.stepsReadAt(path);
      const declaredChainSchema = (chain: string): Record<string, any> | undefined =>
        declaredChainSchemaAt(chain, chainContext, stepsRead, w.shapes);
      const chain = plainChainOf(makeTaggedSentinel(engineName, expr));
      if (chain) {
        const produced = declaredChainSchema(chain);
        if (produced) facts.produced = produced;
        if (produced && primary) {
          let byPath = this.sourceSchemaByPath.get(m);
          if (!byPath) this.sourceSchemaByPath.set(m, (byPath = new Map()));
          byPath.set(path, produced);
        }
      } else if (engineName === CEL_ENGINE) {
        // Not a plain chain: what its tree says about its value, composed
        // from the chains, calls and literals inside it.
        const composed = producedValueOf(expr, {
          chainSchema: declaredChainSchema,
          moduleNames: siteModuleNames,
          callResult: moduleCallResult,
          resolveRef: w.shapes,
        });
        if (composed) facts.composed = composed;
        if (composed && primary) {
          let byPath = this.composedByPath.get(m);
          if (!byPath) this.composedByPath.set(m, (byPath = new Map()));
          byPath.set(path, composed);
        }
      }

      // What each module call reaches, and whether the call fits it — the
      // kernel's binding refusals and the signature checks. A module doc's
      // inline `imports:` map is the same expression its desugared
      // `Telo.Import` carries — the resource the kernel creates — so it is
      // judged there, once. An expression below a nested declaration is
      // that declaration's, evaluated where IT is created, so the enclosing
      // field's unbound-calls annotation does not reach it.
      if (!(isModuleKind(m.kind as string) && path.startsWith("imports."))) {
        const unboundReason = pathCrossesNestedResource(m, path)
          ? undefined
          : unboundCallReason(this.unboundSchema, path);
        diagnostics.push(
          ...moduleCallDiagnostics(
            {
              manifest: m as unknown as ResourceManifest,
              resource,
              filePath,
              path,
              calls: result.calls,
              contextSchema: effectiveContext,
              resolveRef: w.shapes,
              ...(unboundReason !== undefined ? { unboundReason } : {}),
              lang: w.textLanguages.langOf(m as unknown as ResourceManifest),
            },
            w.moduleFunctions,
          ),
        );
      }

      // A non-deterministic call in a compile-eval field is baked once at
      // load: `nowIso()` there freezes at boot. Sometimes that is the
      // intent (a boot timestamp, a run id), so it warns rather than
      // blocking. The engine reports which calls re-evaluate; the eval mode
      // is manifest policy and stays here.
      if (evalMode === "compile") {
        // A module call is named by the chain to the leaf that makes it
        // volatile (`Self.stamp → now()`), so the author sees which call did.
        const volatile = [
          ...new Set(
            result.calls
              .filter((c) => c.deterministic === false)
              .map((c) =>
                c.moduleCall
                  ? renderChain(moduleCallFlags(c.name)?.nondeterministicVia ?? [c.name])
                  : `${c.name}()`,
              ),
          ),
        ].sort();
        if (volatile.length > 0) {
          diagnostics.push({
            severity: DiagnosticSeverity.Warning,
            code: "CEL_NONDETERMINISTIC_IN_COMPILE_FIELD",
            source: SOURCE,
            ...quotedAt(
              `${m.kind}/${resource.name}: '`,
              `' is evaluated once at startup, so ${volatile.map((n) => `\`${n}\``).join(", ")} ${volatile.length === 1 ? "is" : "are"} baked in at load and never re-evaluated. Move the expression to a field evaluated per call (x-telo-eval: runtime) if it should change over time.`,
              { resource, filePath, path },
            ),
          });
        }
      }

      // A chain rooted outside the field's bindings names nothing its
      // consumer can resolve. Where the name is not in scope at all the
      // expression's own verdict says so; a kernel global is in scope, and
      // only this rule refuses it.
      const unbound = accessorVerdict?.find((p) => p.unboundRoot !== undefined);
      if (unbound && !result.diagnostics.some((f) => f.code === "CEL_UNKNOWN_IDENTIFIER")) {
        diagnostics.push({
          severity: DiagnosticSeverity.Error,
          code: "ACCESSOR_NOT_PLAIN_CHAIN",
          source: SOURCE,
          message: `${m.kind}/${resource.name}: ${unbound.message}`,
          data: { resource, filePath, path },
        });
      }

      for (const f of result.diagnostics) {
        // The consumer resolves an accessor by path, null-propagating, so
        // an unguarded read through a nullable value is not a fault there.
        if (accessor && f.code === "CEL_NULLABLE_ACCESS") continue;
        // An engine's fix is always a whole-scalar replacement — a tag with
        // holes re-anchors a hole's repair onto its text itself.
        const fix = f.fix;
        const data = { resource, filePath, path, ...(fix ? { fix } : {}) };
        if (f.code === "CEL_SYNTAX_ERROR") {
          diagnostics.push({
            severity: DiagnosticSeverity.Error,
            code: "CEL_SYNTAX_ERROR",
            source: SOURCE,
            message: `CEL syntax error: ${f.message}`,
            data,
          });
        } else if (f.code === undefined) {
          // No code from a future engine — pass the message through, tagged
          // with a generic ENGINE_DIAGNOSTIC code so downstream filters can
          // still bucket it.
          diagnostics.push({
            severity: DiagnosticSeverity.Error,
            code: "ENGINE_DIAGNOSTIC",
            source: SOURCE,
            message: `${m.kind}/${resource.name}: !${engineName}: ${f.message}`,
            data,
          });
        } else {
          // Named by ENGINE, not hardcoded to CEL: the seam exists so a
          // second engine can produce coded findings, and labelling them
          // `CEL` would misattribute the first one that does. The position is
          // `data.path`, which every host anchors on — quoted in the text it
          // would name a generated path wherever the value was extracted.
          diagnostics.push({
            severity: DiagnosticSeverity.Error,
            code: f.code,
            source: SOURCE,
            message:
              `${m.kind}/${resource.name}: !${engineName}: ${f.message}` +
              (f.code === "CEL_TYPE_ERROR" ? valueBrandHint(result.readTypes) : "") +
              (f.code === "CEL_UNKNOWN_FIELD"
                ? w.scopeMemberClause(m as unknown as ResourceManifest, path, f.message)
                : ""),
            data,
          });
        }
      }
    };
    const judged = variants.map((variant, index) => {
      const sink: AnalysisDiagnostic[] = [];
      const facts: CelSiteFacts = {};
      judgeUnder(variant, sink, index === 0, facts);
      return { variant, sink, facts };
    });
    if (judged.length > 1) {
      let byPath = this.variantFacts.get(m);
      if (!byPath) this.variantFacts.set(m, (byPath = new Map()));
      byPath.set(
        path,
        judged.map(({ variant, facts }) => ({ ...facts, label: referrerLabel(variant) })),
      );
    }
    diagnostics.push(
      ...mergeVariantFindings(judged, (m.metadata as { module?: string } | undefined)?.module, w.rootModules),
    );
  }
}

/** Who gives a variant its typing, as a message names them. */
function referrerLabel(variant: ReferrerVariant | undefined): string | undefined {
  if (!variant || variant.referrers.length === 0) return undefined;
  return [...new Set(variant.referrers.map((r) => r.label))].join(", ");
}

/**
 * The findings of a site judged once per referrer variant: one every variant
 * makes is reported once, one only some make names the referrers it holds
 * under. A site of a resource from another module whose types its referrers
 * gave is reported at each referencing slot the entry's own modules hold.
 */
function mergeVariantFindings(
  judged: ReadonlyArray<{ variant: ReferrerVariant | undefined; sink: AnalysisDiagnostic[] }>,
  module: string | undefined,
  rootModules: ReadonlySet<string>,
): AnalysisDiagnostic[] {
  const keyOf = (d: AnalysisDiagnostic) =>
    `${d.code}\0${d.message}\0${String((d.data as { path?: unknown } | undefined)?.path ?? "")}`;
  const counts = new Map<string, number>();
  for (const { sink } of judged) {
    for (const key of new Set(sink.map(keyOf))) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const foreign = module !== undefined && !rootModules.has(module);
  const out: AnalysisDiagnostic[] = [];
  const emitted = new Set<string>();
  for (const { variant, sink } of judged) {
    const label = referrerLabel(variant);
    for (const d of sink) {
      const shared = counts.get(keyOf(d)) === judged.length;
      const finding =
        shared || label === undefined ? d : { ...d, message: `${d.message} (as ${label} references it)` };
      const anchors = foreign
        ? (variant?.referrers ?? []).filter((r) => {
            const own = (r.manifest.metadata as { module?: string } | undefined)?.module;
            return own === undefined || rootModules.has(own);
          })
        : [];
      const copies =
        anchors.length === 0
          ? [finding]
          : anchors.map((r) => {
              // The finding's own quote is of its place, no longer this copy's.
              const data = { ...(finding.data as Record<string, unknown>) };
              delete data.quotedPlace;
              const quoted = quotingPath(
                `${r.manifest.kind}/${String(r.manifest.metadata?.name ?? "")} at '`,
                r.path,
                `': ${finding.message}`,
                r.path,
              );
              return {
                ...finding,
                message: quoted.message,
                data: {
                  ...data,
                  resource: { kind: r.manifest.kind, name: String(r.manifest.metadata?.name ?? "") },
                  filePath: (r.manifest.metadata as { source?: string } | undefined)?.source,
                  path: r.path,
                  ...quoteData(quoted),
                },
              };
            });
      for (const copy of copies) {
        const key = keyOf(copy);
        if (emitted.has(key)) continue;
        emitted.add(key);
        out.push(copy);
      }
    }
  }
  return out;
}

/** True when `path` crosses a nested inline `{ kind }` resource before
 *  reaching the leaf. Such CEL belongs to the nested resource's kind (validated
 *  when that resource is analyzed), not the host's schema, so the
 *  non-eval-field check must not attribute it to the host. */
export function pathCrossesNestedResource(root: unknown, path: string): boolean {
  const segments = path.match(/[^.[\]]+/g) ?? [];
  let node: unknown = root;
  for (let i = 0; i < segments.length - 1; i++) {
    node = Array.isArray(node)
      ? node[Number(segments[i])]
      : (node as Record<string, unknown> | undefined)?.[segments[i]!];
    if (
      node !== null &&
      typeof node === "object" &&
      !Array.isArray(node) &&
      typeof (node as { kind?: unknown }).kind === "string"
    ) {
      return true;
    }
  }
  return false;
}

/** Member-access chains in a CEL expression, or none when it doesn't parse.
 *  Best-effort: a syntax error is reported by the engine pass, not here.
 *
 *  Read under `moduleNames`: a module call's receiver names a module, so
 *  reading it as a chain root would invent a read of a resource nothing
 *  references. */
function celAccessChains(expr: string, moduleNames?: ReadonlySet<string>): string[][] {
  const parsed = parseCelSource(expr, moduleNames);
  return parsed ? extractAccessChains(parsed.root) : [];
}

/** A diagnostic's `message` quoting its `data.path`, between `before` and
 *  `after`, and its `data` carrying the quote. */
function quotedAt(
  before: string,
  after: string,
  data: { resource: { kind: string; name: string }; filePath: string | undefined; path: string },
): { message: string; data: Record<string, unknown> } {
  const quoted = quotingPath(before, data.path, after, data.path);
  return { message: quoted.message, data: { ...data, ...quoteData(quoted) } };
}
