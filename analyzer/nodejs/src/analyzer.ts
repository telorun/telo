import type { ResourceDefinition, ResourceManifest } from "@telorun/sdk";
import { canonicalTypeSchemaId, OBSERVED_STATE_KEY } from "@telorun/sdk";
import type { Environment } from "@marcbachmann/cel-js";
import {
  defaultRegistry,
  isRefSentinel,
  isTaggedSentinel,
  plainChainOf,
  type CelSurface,
} from "@telorun/templating";
import type { DiagnosticData, DiagnosticFix } from "./types.js";
import {
  AliasResolver,
  moduleScopedDefResolver,
  type ModuleScopes,
  scopeResolverForModule,
} from "./alias-resolver.js";
import { AnalysisRegistry } from "./analysis-registry.js";
import {
  buildCelEnvironment,
  buildImportInputCelEnvironment,
  buildTypedCelEnvironment,
  type CelHandlers,
} from "./cel-environment.js";
import { DefinitionRegistry } from "./definition-registry.js";
import { type ContractDirection, effectiveAuthorSchema } from "./extends-resolution.js";
import {
  analyzerContractScope,
  type ContractScope,
  PERMISSIVE_CONTRACT,
  resolveContract,
} from "./invocation-contract.js";
import { buildCallGraph } from "./call-graph.js";
import { buildDependencyGraph, formatCycle } from "./dependency-graph.js";
import {
  buildKernelGlobalsIndex,
  KERNEL_GLOBAL_NAMES,
  mergeKernelGlobalsIntoContext,
} from "./kernel-globals.js";
import {
  buildObservedStateIndex,
  buildObservedStateResourcesSchema,
  collectRunReachableNames,
  observedStateRead,
  validateObservedStateDeclarations,
} from "./validate-observed-state.js";
import { computeSuggestKind } from "./kind-suggest.js";
import { visitManifest } from "./manifest-visitor.js";
import { isModuleKind } from "./module-kinds.js";
import { normalizeInlineResources } from "./normalize-inline-resources.js";
import { REF_VALIDATION_SKIP_KINDS } from "./system-kinds.js";
import { resolveRefSentinels } from "./resolve-ref-sentinels.js";
import { resolveSchemaRefKinds, type RefConstraintIssue } from "./resolve-schema-ref-kinds.js";
import { runZoneAnalysis, type ZoneExportCache } from "./resolve-zone-requirements.js";
import { validateDurableRegions } from "./validate-durable-regions.js";
import { validateZoneViolations } from "./validate-zone-violations.js";
import { ManifestRootSchema } from "./manifest-schemas.js";
import { gatherPropertySchemas, resolveLocalRef, walkStepArray } from "./schema-walk.js";
import { buildStepContextSchema, CelScopeResolver, manifestRootForResolver } from "./cel-scope.js";

// The structural walks and the CEL scope rule moved out of this file — the
// first so both halves can reach them, the second so the IDE can ask what a
// cursor sees without pulling the analysis pass in behind it. Re-exported here
// because they were part of this module's surface before the split.
export { gatherPropertySchemas, resolveLocalRef, walkStepArray } from "./schema-walk.js";
export { analyzerContractScope } from "./invocation-contract.js";
import { validateZoneSlotDeclarations, type ZoneSlotIssue } from "./validate-zone-slots.js";
import {
  validateSchemaProjection,
  type SchemaProjectionIssue,
} from "./validate-schema-projection.js";
import {
  evaluateResourceRules,
  reportResourceRules,
  reportUnexercisedRule,
  ruleExercised,
  validateResourceRuleDeclarations,
  type ResourceRuleDiagnostic,
  type ResourceRuleIssue,
} from "./validate-resource-rules.js";
import { readResourceRules, type ResourceRule } from "./resource-rule.js";
import { readReferrerRules, type ReferrerRule } from "./referrer-rule.js";
import {
  evaluateReferrerRules,
  referrerRuleExercised,
  reportReferrerRules,
  reportUnexercisedReferrerRule,
  validateReferrerRuleDeclarations,
  type Referrer,
  type ReferrerRuleDiagnostic,
  type ReferrerRuleIssue,
} from "./validate-referrer-rules.js";
import {
  describeProjectionFailure,
  type ProjectionFailure,
} from "./schema-projection.js";
import {
  validateDynamicSelectors,
  validateRefSlotDeclarations,
  type RefSlotIssue,
} from "./validate-ref-slots.js";
import {
  validateValueTypeSlots,
  type ValueTypeSlotIssue,
} from "./validate-value-type-slots.js";
import { resolveSchemaTypeRefs } from "./resolve-schema-type-refs.js";
import { validateSchemaTypeRefs } from "./validate-schema-type-refs.js";
import { rewriteSyntheticOrigins } from "./rewrite-synthetic-origins.js";
import {
  celTypeSatisfiesJsonSchema,
  checkSchemaCompatibility,
  navigateSchemaToExprPath,
  substituteCelFields,
  validateAgainstSchema,
  type SchemaIssue,
} from "./schema-compat.js";
import { collectValueSchemaIssues } from "./validate-value-schema.js";
import { DiagnosticSeverity, type AnalysisDiagnostic, type AnalysisOptions } from "./types.js";
import {
  extractAccessChains,
  extractCelRegionScopes,
  extractContextsFromSchema,
  getManifestItem,
  pathMatchesScope,
  resolveContextAnnotations,
  resolveTypeFieldToSchema,
} from "./validate-cel-context.js";
import { buildEvalPaths, evalPathsCover } from "./eval-paths.js";
import {
  BINDINGS_ANNOTATION,
  bindingContextProperties,
  bindingPathChain,
  findBindingSites,
  resolveBindingOrder,
  schemaAtChain,
  type BindingSites,
} from "./cel-bindings.js";
import { CEL_RESERVED_WORDS, checkName } from "./identifier-name.js";
import { validateIdentifierNames } from "./validate-identifier-names.js";
import { validateExtends } from "./validate-extends.js";
import { validateLogging } from "./validate-logging.js";
import { validateModuleArtifact } from "./validate-module-artifact.js";
import { validateIncludePlacement } from "./validate-include-placement.js";
import { validateModuleMetadata } from "./validate-module-metadata.js";
import { validateRequires } from "./validate-requires.js";
import { validateBaseMapping } from "./validate-base-mapping.js";
import { validateInvocationContract } from "./validate-invocation-contract.js";
import { collectRefInputIssues, collectStepInputIssues } from "./validate-step-inputs.js";
import { validateNestedInlineResources } from "./validate-nested-inline.js";
import { validateProviderCoherence } from "./validate-provider-coherence.js";
import { validateReferences } from "./validate-references.js";
import { validateReferenceForms } from "./validate-reference-forms.js";
import { validateUnusedDeclarations } from "./validate-unused-declarations.js";
import { validateThrowsCoverage } from "./validate-throws-coverage.js";
import { readStepSlot } from "./step-slot.js";

const SELF_PREFIX = "Self.";

/**
 * `StaticAnalyzer.analyze()` requires `metadata.source` (non-empty) and
 * `metadata.sourceLine` (number) on every non-system manifest — see the
 * JSDoc on `analyze()`. Production callers stamp these via the `Loader` /
 * `flattenForAnalyzer` / `emitDocsFor` paths; programmatic callers (tests,
 * scripts) should pre-process inputs with `withSyntheticPositions(...)`.
 * Surfacing the violation here turns silent dedup misbehaviour into a
 * loud, actionable error.
 */
function assertManifestPositions(manifests: ResourceManifest[]): void {
  for (let i = 0; i < manifests.length; i++) {
    const m = manifests[i];
    if (REF_VALIDATION_SKIP_KINDS.has(m.kind)) continue;
    const meta = m.metadata as { source?: string; sourceLine?: number } | undefined;
    const okSource = typeof meta?.source === "string" && meta.source.length > 0;
    const okLine = typeof meta?.sourceLine === "number";
    if (okSource && okLine) continue;
    const label = `${m.kind}/${m.metadata?.name ?? "(unnamed)"}`;
    const missing = [
      !okSource ? "metadata.source" : null,
      !okLine ? "metadata.sourceLine" : null,
    ]
      .filter(Boolean)
      .join(" and ");
    throw new Error(
      `StaticAnalyzer.analyze(): manifest #${i} (${label}) is missing ${missing}. ` +
        `Real callers stamp positions automatically; programmatic callers ` +
        `(tests, ad-hoc scripts) should pass inputs through ` +
        `\`withSyntheticPositions(manifests)\` before calling analyze().`,
    );
  }
}

/** Resolve an alias-prefixed kind value (e.g. `Self.Encoder` or `Ai.Model`)
 *  to its canonical form. `Self.<Name>` resolves to `<ownModule>.<Name>` —
 *  the magic alias for "this library's own module" — and other prefixes
 *  resolve through the declaring file's Telo.Import aliases. */
function resolveSelfOrAlias(
  value: string,
  ownModule: string | undefined,
  scopeResolver: AliasResolver,
): string | undefined {
  if (value.startsWith(SELF_PREFIX) && ownModule) {
    return `${ownModule}.${value.slice(SELF_PREFIX.length)}`;
  }
  return scopeResolver.resolveKind(value);
}

const SOURCE = "telo-analyzer";

/** True when an issue reports a property that is absent — its path points at a
 *  node the manifest does not contain. */
export const missingRequired = (issue: { message: string }): boolean =>
  /is missing required property/.test(issue.message);

/** The path minus its last segment: the node that should have contained the
 *  missing property. Empty for a top-level miss, which anchors on the map. */
export function containerOf(path: string): string {
  const dot = path.lastIndexOf(".");
  return dot === -1 ? "" : path.slice(0, dot);
}

/** How to name the owner of a resolved contract in a diagnostic. When the
 *  contract came from the definition's direct parent, echo the author's own
 *  spelling (`extends: Mcp.SessionProvider`) — that is the text they can find in
 *  their file. A contract inherited from further up the chain isn't written
 *  anywhere in this file, so the canonical `module.Kind` is what locates it. */
function contractOwnerLabel(
  definition: Record<string, any>,
  contract: { declaredBy?: ResourceDefinition },
): string {
  const declaredBy = contract.declaredBy;
  if (!declaredBy || declaredBy === (definition as unknown as ResourceDefinition)) {
    return String(definition.metadata?.name ?? definition.kind);
  }
  const parentSpelling = definition.extends as string | undefined;
  const canonical = `${declaredBy.metadata.module}.${declaredBy.metadata.name}`;
  if (typeof parentSpelling === "string" && parentSpelling.endsWith(`.${declaredBy.metadata.name}`)) {
    return parentSpelling;
  }
  return canonical;
}

/** The built-in namespace: globally resolvable, crossing no import boundary. */
const TELO_BUILTIN_MODULE = "Telo";

/** One mapping from a ref-slot issue to a diagnostic — the shape is identical
 *  for the schema-level and the manifest-level (dynamic selector) checks. */
function refSlotIssueDiagnostic(issue: RefSlotIssue): AnalysisDiagnostic {
  return {
    severity: DiagnosticSeverity.Error,
    code: issue.code,
    source: SOURCE,
    message: issue.message,
    data: {
      resource: { kind: issue.manifest.kind, name: issue.manifest.metadata?.name as string },
      filePath: (issue.manifest.metadata as { source?: string } | undefined)?.source,
      path: issue.path,
    },
  };
}

/**
 * Is this kind acceptable in a slot that transfers control?
 *
 * The executable side is a POSITIVE test against the `Telo.Executable`
 * hierarchy: a capability that is, or `extends`, `Telo.Executable` is
 * executable, so a future executable capability opts in with one `extends:`
 * edge — no name list here to keep in step. This replaced
 * `NON_INVOKABLE_CAPABILITIES`, a maintained set of capabilities the analyzer
 * believed could never be invoked, which was unsound in the direction that
 * rejects working manifests: it listed `Telo.Provider`, and `Ai.Model` is a
 * Provider the agent controller invokes directly — the divergence being
 * structural versus nominal, since the kernel tests method presence at dispatch
 * while any static test can only read a declared capability.
 *
 * Outside the hierarchy nothing is guessed: `Telo.Provider` (entry points by
 * convention) and `Telo.Service` (some services are invocable) pass, an unknown
 * capability passes (rejecting it would be the wrong polarity for third-party
 * extensions), and only the kernel-owned capabilities whose CONTRACT has no
 * entry point — `Telo.Type`, `Telo.Mount`, `Telo.Template`, `Telo.Sink` (a sink
 * is written to through a direct contract on the controller instance, never
 * dispatched) — are rejected. That last set is the capabilities' own
 * definition, not a belief about controllers.
 */
function isExecutableKind(kind: string, defs: DefinitionRegistry, aliases: AliasResolver): boolean {
  const canonical = aliases.resolveKind(kind) ?? kind;
  const def = defs.resolve(canonical);
  if (!def) return true;
  const capability = def.capability as string | undefined;
  if (!capability) return true;
  if (capabilityExtendsExecutable(capability, defs)) return true;
  return !NO_ENTRY_POINT_CAPABILITIES.has(capability);
}

/** Does this capability name `Telo.Executable` or extend it, transitively?
 *  Derived from the abstract hierarchy at call time, never from a name list. */
function capabilityExtendsExecutable(capability: string, defs: DefinitionRegistry): boolean {
  let current: string | undefined = capability;
  const seen = new Set<string>();
  while (current && !seen.has(current)) {
    if (current === "Telo.Executable") return true;
    seen.add(current);
    current = defs.resolve(current)?.extends as string | undefined;
  }
  return false;
}

/** Kernel-owned capabilities whose contract declares no entry point. */
const NO_ENTRY_POINT_CAPABILITIES = new Set([
  "Telo.Mount",
  "Telo.Type",
  "Telo.Template",
  "Telo.Sink",
]);

/**
 * Validate step `invoke` references (e.g. `Run.Sequence`
 * steps).
 *
 * The reference field map deliberately does NOT descend into step `invoke`
 * slots — they sit behind a local `$ref` to the shared step definition, and
 * turning the descent on would make Phase 5 inject live instances there,
 * breaking the invoke dispatch path (see `reference-field-map.ts`). A
 * consequence is that `validateReferences` never sees these slots, so a bad
 * step invoke passes `telo check` and only fails at runtime. This pass covers
 * exactly those slots, in two dimensions:
 *   - Existence: an `invoke: !ref <name>` that names a missing instance — or a
 *     *kind* instead of an exported instance (`!ref Stream.Of`) — is a still-a-
 *     sentinel after Phase 2.5 resolution → `UNRESOLVED_REFERENCE` (runtime
 *     `ERR_RESOURCE_NOT_FOUND`).
 *   - Invokability: a resolved instance whose kind fails `isExecutableKind` —
 *     outside the `Telo.Executable` hierarchy AND declaring a capability whose
 *     contract has no entry point → `REFERENCE_KIND_MISMATCH` (runtime
 *     `ERR_RESOURCE_NOT_INVOKABLE`).
 *
 * Generic and topology-driven — it walks steps via the same step-slot
 * / `x-telo-topology-role` annotations `buildStepContextSchema` uses (through the
 * shared `walkStepArray`), so nested branches (then/else/do/catch/cases) are
 * covered and no `Run.Sequence` field name is hardcoded. The cross-module
 * partial-analysis guard mirrors `validateReferences`, so a reference into an
 * unloaded import is skipped rather than false-flagged.
 */
function validateStepInvokeReferences(
  allManifests: Record<string, any>[],
  defs: DefinitionRegistry,
  aliases: AliasResolver,
): AnalysisDiagnostic[] {
  const diagnostics: AnalysisDiagnostic[] = [];

  // Local instance names + loaded-module set — same construction as
  // validateReferences, so the cross-module guard behaves identically.
  const localNames = new Set<string>();
  const loadedModules = new Set<string>();

  // Also collect names of resources nested inside a manifest tree — notably
  // `with:`-scoped resources (an `x-telo-scope` region the field map does not
  // extract to a top-level manifest). A step can invoke one by bare name, so
  // omitting them would false-flag a valid `!ref`. Conservative: any nested
  // object carrying both a `kind` and a `metadata.name` is a resource
  // definition; scope visibility is left to the runtime.
  const collectNestedNames = (value: unknown): void => {
    if (!value || typeof value !== "object" || isTaggedSentinel(value)) return;
    if (Array.isArray(value)) {
      for (const item of value) collectNestedNames(item);
      return;
    }
    const obj = value as Record<string, unknown>;
    const name = (obj.metadata as { name?: unknown } | undefined)?.name;
    if (typeof obj.kind === "string" && typeof name === "string") localNames.add(name);
    for (const v of Object.values(obj)) collectNestedNames(v);
  };

  for (const r of allManifests) {
    if (r.kind === "Telo.Import") {
      const m = (r.metadata as { resolvedModuleName?: unknown } | undefined)?.resolvedModuleName;
      if (typeof m === "string") loadedModules.add(m);
      continue;
    }
    const meta = r.metadata as { name?: unknown; module?: unknown; forwardedExport?: unknown };
    if (typeof meta?.name !== "string" || REF_VALIDATION_SKIP_KINDS.has(r.kind)) continue;
    if (meta.forwardedExport === true) {
      if (typeof meta.module === "string") loadedModules.add(meta.module);
      continue;
    }
    localNames.add(meta.name);
    collectNestedNames(r);
  }

  const validateInvoke = (
    value: unknown,
    resource: { kind: string; name: string },
    filePath: string | undefined,
    path: string,
  ): void => {
    if (isRefSentinel(value)) {
      // An unresolved `!ref` is a miss: a real instance would have resolved to
      // `{kind, name}` in Phase 2.5.
      const refName = value.source;
      const dot = refName.indexOf(".");
      const aliasPrefix = dot > 0 ? refName.slice(0, dot) : undefined;

      if (aliasPrefix && aliasPrefix !== "Self" && aliases.hasAlias(aliasPrefix)) {
        const module = aliases.moduleForAlias(aliasPrefix);
        // Partial single-file analysis (import not loaded) — skip to avoid a false miss.
        if (module && !loadedModules.has(module)) return;
        diagnostics.push({
          severity: DiagnosticSeverity.Error,
          code: "UNRESOLVED_REFERENCE",
          source: SOURCE,
          message: `${resource.kind}/${resource.name}: step invoke at '${path}' → '${refName}' is not an exported instance of module '${module ?? aliasPrefix}' (reference a declared instance, not a kind)`,
          data: { resource, filePath, path },
        });
        return;
      }

      const localName = aliasPrefix === "Self" ? refName.slice(dot + 1) : refName;
      if (localNames.has(localName)) return;
      diagnostics.push({
        severity: DiagnosticSeverity.Error,
        code: "UNRESOLVED_REFERENCE",
        source: SOURCE,
        message: `${resource.kind}/${resource.name}: step invoke at '${path}' → resource '${localName}' not found`,
        data: { resource, filePath, path },
      });
      return;
    }

    // Resolved `{kind, name}` (or an inline `{kind, …}` definition) — the
    // instance exists. Mirror the kernel's ERR_RESOURCE_NOT_INVOKABLE, which
    // fires when the instance has neither an `invoke` nor a `run` method
    // (evaluation-context.ts). That is a per-instance property, so the static
    // test only rejects a kind whose declared capability names no entry point.
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const kind = (value as Record<string, unknown>).kind;
    if (typeof kind !== "string") return;
    if (!isExecutableKind(kind, defs, aliases)) {
      const capability = defs.resolve(aliases.resolveKind(kind) ?? kind)?.capability;
      diagnostics.push({
        severity: DiagnosticSeverity.Error,
        code: "REFERENCE_KIND_MISMATCH",
        source: SOURCE,
        message: `${resource.kind}/${resource.name}: step invoke at '${path}' → '${kind}' is a ${capability} and cannot be invoked in a step — it has no invoke or run method (runtime ERR_RESOURCE_NOT_INVOKABLE)`,
        data: { resource, filePath, path },
      });
    }
  };

  for (const m of allManifests) {
    const meta = m.metadata as { name?: unknown; source?: unknown; forwardedExport?: unknown };
    if (
      typeof meta?.name !== "string" ||
      REF_VALIDATION_SKIP_KINDS.has(m.kind) ||
      meta.forwardedExport === true
    )
      continue;
    const def = defs.resolve(aliases.resolveKind(m.kind) ?? m.kind);
    const defSchema = def?.schema as Record<string, any> | undefined;
    if (!defSchema?.properties) continue;
    const resource = { kind: m.kind, name: meta.name };
    const filePath = typeof meta.source === "string" ? meta.source : undefined;

    for (const [fieldName, fieldSchema] of Object.entries(
      defSchema.properties as Record<string, any>,
    )) {
      const invokeField = readStepSlot(fieldSchema)?.invoke;
      if (!invokeField) continue;
      const steps = m[fieldName];
      if (!Array.isArray(steps)) continue;
      const stepItemSchema = resolveLocalRef(
        fieldSchema.items as Record<string, any> | undefined,
        defSchema,
      );

      walkStepArray(steps, stepItemSchema, defSchema, fieldName, (s, stepPath) => {
        const invoke = s[invokeField];
        if (invoke === undefined || invoke === null) return;
        validateInvoke(invoke, resource, filePath, `${stepPath}.${invokeField}`);
      });
    }
  }

  return diagnostics;
}

/**
 * Collect every field annotated with `x-telo-error-context` anywhere in a
 * definition schema (resolving local `$ref`s into `$defs`, cycle-safe), mapping
 * the annotated field name to its declared error-shape schema. The field name
 * is matched against CEL paths so the context applies at any nesting depth under
 * that field — e.g. `error` inside a `catch:` nested inside another `try:`. No
 * specific field name (or `Run.Sequence`) is hardcoded; any composer that tags
 * its error-bearing branch fields opts in the same way.
 */
/**
 * True when a `walkCelExpressions` path (`with[0].handler.inputs.x`) crosses an
 * inline nested resource — an `{ kind: … }` object below the host root — before
 * reaching the leaf. Such CEL belongs to the nested resource's kind (validated
 * when that resource is analyzed), not the host's schema, so the
 * non-eval-field check must not attribute it to the host.
 */
function pathCrossesNestedResource(root: unknown, path: string): boolean {
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
 *  Best-effort: a syntax error is reported by the engine pass, not here. */
function celAccessChains(env: Environment, expr: string): string[][] {
  try {
    return extractAccessChains(env.parse(expr).ast);
  } catch {
    return [];
  }
}

const CEL_PURE_RE = /^\s*\$\{\{[^}]*\}\}\s*$/;
const CEL_EXPR_RE = /\$\{\{\s*([^}]+?)\s*\}\}/;

/** Restore the delimiters an engine's fix was computed without, so the
 *  replacement is the whole scalar rather than a bare expression that would be
 *  read back as literal text. A tagged scalar carries no wrapper and passes
 *  through untouched. */
function rewrapFix(
  fix: DiagnosticFix | undefined,
  wrapper: CelSurface["wrapper"],
): DiagnosticFix | undefined {
  if (!fix || !wrapper) return fix;
  return { replacement: wrapper.prefix + fix.replacement + wrapper.suffix };
}

/** A pure-CEL leaf and the schema of the field it sits in. */
export interface CelValueSlot {
  readonly path: string;
  readonly schema: Record<string, any>;
}

/** Recursively walk `data`+`schema` together, collecting every pure CEL leaf
 *  with the schema of the field holding it.
 *
 *  Type *checking* is deliberately not done here. It belongs to the templating
 *  engine, which owns the expression's syntax and now runs it once against the
 *  environment typed for that path; checking again here would mean two verdicts
 *  from two environments about one expression — which is exactly how an opaque
 *  "no matching overload" used to survive next to the diagnostic that explained
 *  it. What this walk supplies is the half the engine cannot know: the declared
 *  type of the slot the value flows into. The comparison happens once both are
 *  in hand (`reportCelReturnMismatches`). */
function collectCelValueSlots(
  data: unknown,
  schema: Record<string, any>,
  path: string,
): CelValueSlot[] {
  const slots: CelValueSlot[] = [];

  // A pure CEL value behaves the same regardless of surface form: a
  // `${{ … }}` string and a `!cel`-tagged sentinel are the same expression.
  let celExpr: string | undefined;
  if (isTaggedSentinel(data)) {
    // Non-CEL engines (e.g. `!literal`) are analyzed by their own engine pass.
    if (data.engine !== "cel") return slots;
    celExpr = data.source;
  } else if (typeof data === "string" && CEL_PURE_RE.test(data)) {
    celExpr = data.match(CEL_EXPR_RE)?.[1]?.trim();
  }

  if (celExpr !== undefined) {
    if (schema) slots.push({ path, schema });
    return slots;
  }

  if (Array.isArray(data)) {
    const itemSchema = (schema.items ?? {}) as Record<string, any>;
    for (let i = 0; i < data.length; i++) {
      slots.push(...collectCelValueSlots(data[i], itemSchema, `${path}[${i}]`));
    }
  } else if (data !== null && typeof data === "object") {
    const props = (schema.properties ?? {}) as Record<string, any>;
    const mapValueSchema =
      schema.additionalProperties && typeof schema.additionalProperties === "object"
        ? (schema.additionalProperties as Record<string, any>)
        : {};
    for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
      slots.push(
        ...collectCelValueSlots(
          v,
          (props[k] ?? mapValueSchema) as Record<string, any>,
          path ? `${path}.${k}` : k,
        ),
      );
    }
  }

  return slots;
}

export interface StaticAnalyzerOptions {
  celHandlers?: CelHandlers;
}

/**
 * Files belonging to a module this runtime declared itself unable to read.
 *
 * Attribution is by FILE rather than by resource identity, the same choice
 * `remapMigratedPaths` makes and for the same reason: a diagnostic carries at
 * most two routing facts and routinely only one, so indexing by resource would
 * leave every diagnostic without `data.resource` unreachable.
 *
 * **A module NAME is not a graph-unique key.** Names are module-scoped, so two
 * libraries may both be called `Store` — CLAUDE.md names this exact hazard for
 * migration provenance ("two libraries declaring a Store would share one
 * bucket"), where the answer is to narrow or not remap at all. Same answer here:
 * the gated doc's own `metadata.source` is always suppressed, and a name is used
 * to reach its `include:` partials only when that name identifies exactly ONE
 * module doc in the set. Where it does not, the partials keep their diagnostics
 * rather than risk silencing an unrelated library's — a stray extra diagnostic is
 * a far cheaper failure than a hidden one.
 *
 * A module doc with no `source` contributes nothing — suppressing on a guess
 * would hide diagnostics belonging to files nobody named.
 */
function filesOfUnreadableModules(
  manifests: ResourceManifest[],
  requiresDiagnostics: AnalysisDiagnostic[],
): ReadonlySet<string> {
  const files = new Set<string>();
  const gatedNames = new Set<string>();

  for (const d of requiresDiagnostics) {
    if (d.code !== "MODULE_REQUIRES_NEWER_RUNTIME") continue;
    const data = d.data as DiagnosticData | undefined;
    // The gated document itself, addressed by the file it was declared in.
    if (typeof data?.filePath === "string" && data.filePath) files.add(data.filePath);
    const name = data?.resource?.name;
    if (typeof name === "string") gatedNames.add(name);
  }
  if (files.size === 0 && gatedNames.size === 0) return files;

  // How many module docs answer to each gated name — the ambiguity test.
  const docsPerName = new Map<string, number>();
  for (const m of manifests) {
    if (m.kind !== "Telo.Application" && m.kind !== "Telo.Library") continue;
    const name = (m.metadata as { name?: string } | undefined)?.name;
    if (typeof name === "string" && gatedNames.has(name)) {
      docsPerName.set(name, (docsPerName.get(name) ?? 0) + 1);
    }
  }

  for (const m of manifests) {
    const metadata = (m.metadata ?? {}) as Record<string, unknown>;
    const owner = metadata.module;
    if (typeof owner !== "string" || !gatedNames.has(owner)) continue;
    if (docsPerName.get(owner) !== 1) continue; // ambiguous — do not guess
    if (typeof metadata.source === "string" && metadata.source) files.add(metadata.source);
  }
  return files;
}

/**
 * Drop every diagnostic anchored in a file whose module this runtime cannot
 * read, except the gate diagnostic itself.
 *
 * A filter rather than a guard on each validator: threading "skip this module"
 * through thirty validators would make each one responsible for a rule none of
 * them owns, and a validator added later would silently opt out of it. A
 * diagnostic with no `filePath` is KEPT — suppression must never be the default
 * for something it cannot attribute.
 */
function suppressUnreadableModuleDiagnostics(
  diagnostics: AnalysisDiagnostic[],
  unreadableFiles: ReadonlySet<string>,
): AnalysisDiagnostic[] {
  if (unreadableFiles.size === 0) return diagnostics;
  return diagnostics.filter((d) => {
    if (d.code === "MODULE_REQUIRES_NEWER_RUNTIME") return true;
    const filePath = (d.data as DiagnosticData | undefined)?.filePath;
    return typeof filePath !== "string" || !unreadableFiles.has(filePath);
  });
}

export class StaticAnalyzer {
  private readonly celEnv: Environment;

  constructor(options: StaticAnalyzerOptions = {}) {
    this.celEnv = buildCelEnvironment(options.celHandlers);
  }

  /**
   * Run static analysis over a flattened manifest list.
   *
   * **Contract**: every non-system manifest (anything outside `Telo.Definition`,
   * `Telo.Abstract`) must carry `metadata.source` (non-empty string) and
   * `metadata.sourceLine` (number). The dedup that backs
   * `DUPLICATE_RESOURCE_NAME` reads those fields to tell a pipeline echo
   * apart from a genuine collision, and downstream diagnostic positioning
   * depends on them too. Real callers stamp positions already (the `Loader`,
   * `flattenForAnalyzer`, the telo-editor's `emitDocsFor`, the VSCode
   * extension). Programmatic callers — tests, ad-hoc scripts — should pass
   * their inputs through `withSyntheticPositions(...)` before calling
   * `analyze()`. A missing position throws a clear error rather than
   * silently producing wrong diagnostics.
   */
  analyze(
    manifests: ResourceManifest[],
    options?: AnalysisOptions,
    registry?: AnalysisRegistry,
    zoneExportCache?: ZoneExportCache,
  ): AnalysisDiagnostic[] {
    assertManifestPositions(manifests);
    const diagnostics: AnalysisDiagnostic[] = [];

    // Use pre-seeded registries from the provided AnalysisRegistry, or create fresh ones.
    // New aliases/definitions found in the manifests are accumulated into the provided instance
    // so state builds up across successive calls (e.g. incremental editor validation).
    const ctx = registry?._context();
    const aliases = ctx?.aliases ?? new AliasResolver();
    // `Telo` crosses no import boundary — the kernel built-ins are globally
    // resolvable, which is what lets `kind: Telo.ConsoleSink` and
    // `extends: Telo.LogSink` work with no `imports:` entry (§10.2). The kernel
    // registers the same ungated alias at boot; registering it here keeps the
    // static and runtime halves agreeing.
    aliases.registerUngatedAlias(TELO_BUILTIN_MODULE, TELO_BUILTIN_MODULE);
    const defs = ctx?.definitions ?? new DefinitionRegistry();

    // Register module identities and aliases.
    // The root module doc (Telo.Application or Telo.Library) provides its own
    // identity; imported modules surface their identity via resolvedModuleName/
    // resolvedNamespace stamped onto the Telo.Import by the loader.
    //
    // Two alias scopes are tracked:
    //  - `aliases` — the consumer's aliases, populated from Telo.Imports declared in
    //    the entry manifest (its own module).
    //  - `aliasesByModule` — per-imported-library aliases, populated from Telo.Imports
    //    forwarded by the loader from inside imported libraries. A library may use
    //    different alias names than the consumer for the same dependency; resolving
    //    a forwarded def's `extends` / `capability` against the consumer's scope
    //    would either fail or pick the wrong target. Each forwarded def is normalized
    //    in its own library's scope.
    const rootModules = new Set<string>();
    for (const m of manifests) {
      if (isModuleKind(m.kind) && m.metadata?.name) {
        rootModules.add(m.metadata.name as string);
      }
    }
    const aliasesByModule = ctx?.aliasesByModule ?? new Map<string, AliasResolver>();
    // Per-module-scope seen aliases for DUPLICATE_IMPORT_ALIAS. Authored
    // Telo.Import docs and synthetic-from-inline-`imports:` share one alias
    // namespace per module, so a repeat — across either form — is an error
    // rather than the silent last-writer-wins the resolver would otherwise do.
    const seenAliasByScope = new Map<string, Set<string>>();
    for (const m of manifests) {
      if (isModuleKind(m.kind)) {
        const namespace = ((m.metadata as any).namespace as string | undefined) ?? null;
        const moduleName = m.metadata.name as string;
        if (moduleName) defs.registerModuleIdentity(namespace, moduleName);
        // Auto-register `Self` as an alias for this library's own module name.
        // Lets same-library `extends:` work (e.g. `extends: Self.Encoder` for a
        // concrete kind whose abstract lives in the same Telo.Library) without
        // requiring a self-import (which would loop the loader). Resolves
        // through the same alias machinery as user-declared Telo.Imports.
        if (moduleName) {
          // `Self` resolves the library's own kinds UNGATED — a library may reference
          // its own kinds regardless of `exports.kinds`, which gates importers, not
          // internal use. This is what lets a library declare an instance of a kind it
          // does not export (e.g. console's `writeLine`) to enforce a singleton.
          if (rootModules.has(moduleName)) {
            aliases.registerUngatedAlias("Self", moduleName);
          } else {
            let libResolver = aliasesByModule.get(moduleName);
            if (!libResolver) {
              libResolver = new AliasResolver();
              libResolver.registerUngatedAlias(TELO_BUILTIN_MODULE, TELO_BUILTIN_MODULE);
              aliasesByModule.set(moduleName, libResolver);
            }
            libResolver.registerUngatedAlias("Self", moduleName);
          }
        }
      }
      if (m.kind === "Telo.Import") {
        const alias = m.metadata.name as string;
        const source = (m as any).source as string | undefined;
        // The target's `exports.kinds` gate, stamped onto this import by
        // `stampExportedKinds` (the `Telo.Import` doc has no `exports` field of its own —
        // the target `Telo.Library` doc it comes from is dropped for non-root modules).
        // Undefined means the target declares no gate, i.e. unrestricted.
        const exportedKinds = (m.metadata as { exportedKinds?: string[] } | undefined)
          ?.exportedKinds;
        const resolvedModuleName = (m.metadata as any).resolvedModuleName as string | undefined;
        const resolvedNamespace = (m.metadata as any).resolvedNamespace as
          | string
          | null
          | undefined;
        const ownModule = (m.metadata as { module?: string } | undefined)?.module;
        if (alias) {
          const scopeKey = ownModule ?? "";
          let seen = seenAliasByScope.get(scopeKey);
          if (!seen) {
            seen = new Set<string>();
            seenAliasByScope.set(scopeKey, seen);
          }
          if (seen.has(alias)) {
            diagnostics.push({
              severity: DiagnosticSeverity.Error,
              code: "DUPLICATE_IMPORT_ALIAS",
              source: SOURCE,
              message:
                `Duplicate import alias '${alias}'. An alias may be declared once per module — ` +
                `across both inline 'imports:' entries and 'Telo.Import' documents. ` +
                `Rename or remove the duplicate.`,
              data: {
                resource: { kind: "Telo.Import", name: alias },
                filePath: (m.metadata as { source?: string } | undefined)?.source,
                path: "metadata.name",
              },
            });
            // Keep the first alias→target mapping intact; don't re-register the
            // duplicate (last-writer-wins would shadow the original and cascade
            // misleading follow-on diagnostics).
            continue;
          }
          seen.add(alias);
        }
        // An import whose target identity was never established registers NO
        // alias. The name is never guessed from the source string: a guess that
        // is usually right is what turned "this import did not resolve" into an
        // assertion that a published dependency was malformed, naming a module
        // no registry could ever hold. With no alias, every use degrades to
        // "cannot resolve alias '<X>'" — which points at the import the author
        // has to fix, and which the loader has already reported on its own line.
        if (alias && source && resolvedModuleName) {
          const targetModule = resolvedModuleName;
          // Module identity is registered globally so x-telo-ref resolution sees
          // transitively-imported modules regardless of which scope brought them in.
          defs.registerModuleIdentity(resolvedNamespace ?? null, resolvedModuleName);
          // `metadata.reExportedKinds` (stamped by flattenForAnalyzer / the editor projection)
          // maps an exported suffix to the true owning module's canonical kind for kinds this
          // import transitively re-exports (`exports.kinds: [Alias.Kind]`).
          const reExportedKinds = ((m.metadata as any)?.reExportedKinds ?? {}) as Record<
            string,
            string
          >;
          // Alias registration is scoped: consumer imports vs. imported-library imports.
          const resolver =
            !ownModule || rootModules.has(ownModule)
              ? aliases
              : (aliasesByModule.get(ownModule) ??
                aliasesByModule.set(ownModule, new AliasResolver()).get(ownModule)!);
          resolver.registerImport(alias, targetModule, exportedKinds);
          for (const [suffix, canonical] of Object.entries(reExportedKinds)) {
            resolver.registerKindReExport(alias, suffix, canonical);
          }
        }
      }
    }

    // Seed `Self` for every module that contributes definitions but whose own
    // Telo.Library doc isn't in this manifest set. `flattenForAnalyzer` forwards an
    // imported library's definitions/abstracts/imports but NOT its module doc, so the
    // module-doc loop above can't register `Self` for imported modules. Without this, a
    // definition's `extends: Self.X` (a kind defined in the same library as the abstract)
    // can't resolve and its `extendedBy` edge mis-keys under the literal "Self.X" — which
    // stays invisible until another module also implements that abstract and flips the
    // reference check from lenient to strict. `Self` always maps a module to its own name.
    for (const m of manifests) {
      if (m.kind !== "Telo.Definition" && m.kind !== "Telo.Abstract") continue;
      const ownModule = (m.metadata as { module?: string } | undefined)?.module;
      if (!ownModule || rootModules.has(ownModule)) continue;
      let libResolver = aliasesByModule.get(ownModule);
      if (!libResolver) {
        libResolver = new AliasResolver();
        libResolver.registerUngatedAlias(TELO_BUILTIN_MODULE, TELO_BUILTIN_MODULE);
        aliasesByModule.set(ownModule, libResolver);
      }
      if (!libResolver.hasAlias("Self")) {
        libResolver.registerUngatedAlias("Self", ownModule);
      }
    }

    // Register definitions from Telo.Definition AND Telo.Abstract resources.
    // Abstracts declare contracts that implementations target via `extends` (canonical)
    // or `capability: <AbstractKind>` (legacy). Until they're registered, validateReferences
    // can't resolve x-telo-ref entries pointing at library-declared abstracts — so abstracts
    // must go through register() too, not just the kernel builtins in the constructor.
    //
    // Normalize alias-prefixed `capability` and `extends` to canonical form using the
    // declaring scope's resolver, so `extendedBy` is keyed by canonical kind regardless
    // of alias choices. `capability` covers the legacy implements-this-abstract overload;
    // `extends` is the canonical first-class form.
    const refConstraintIssues: RefConstraintIssue[] = [];
    const refSlotIssues: RefSlotIssue[] = [];
    const zoneSlotIssues: ZoneSlotIssue[] = [];
    // One place a rule report becomes a diagnostic. The pass decided WHAT and
    // WHERE; this only carries it across to the diagnostic shape.
    const SEVERITY = {
      error: DiagnosticSeverity.Error,
      warning: DiagnosticSeverity.Warning,
      information: DiagnosticSeverity.Information,
    } as const;
    const resourceRuleDiagnostic = (report: ResourceRuleDiagnostic): AnalysisDiagnostic => ({
      severity: SEVERITY[report.severity],
      code: report.code,
      source: SOURCE,
      message: report.message,
      data: {
        resource: {
          kind: report.manifest.kind,
          name: report.manifest.metadata?.name as string,
        },
        filePath: (report.manifest.metadata as { source?: string } | undefined)?.source,
        path: report.path,
        rule: report.rule,
      },
    });
    const referrerRuleDiagnostic = (report: ReferrerRuleDiagnostic): AnalysisDiagnostic => ({
      severity: SEVERITY[report.severity],
      code: report.code,
      source: SOURCE,
      message: report.message,
      data: {
        resource: {
          kind: report.manifest.kind,
          name: report.manifest.metadata?.name as string,
        },
        filePath: (report.manifest.metadata as { source?: string } | undefined)?.source,
        path: report.path,
        rule: report.rule,
      },
    });
    const projectionIssues: SchemaProjectionIssue[] = [];
    const resourceRuleIssues: ResourceRuleIssue[] = [];
    const referrerRuleIssues: ReferrerRuleIssue[] = [];
    // A rule that never had anything to iterate is never proven — the second way
    // coverage varies invisibly, beside the dynamic-leaf skip. Tracked across the
    // whole run and reported once, since "empty on every resource" is not a fact
    // any single resource can establish.
    const ruleExercise = new Map<
      string,
      { manifest: ResourceManifest; rule: ResourceRule; exercised: boolean; seen: boolean }
    >();
    // Same for a referrer rule, where "never exercised" means nothing the
    // `referrer:` filter matches ever referenced a resource of the kind — which
    // is exactly what a typo in that filter looks like from the outside.
    const referrerRuleExercise = new Map<
      string,
      { manifest: ResourceManifest; rule: ReferrerRule; exercised: boolean; seen: boolean }
    >();
    // `x-telo-type` is checked on EVERY manifest, not only on definition docs: a
    // schema fragment is written wherever a kind declares a schema-valued field,
    // so an inline `inputType:` on an ordinary resource carries one just as a
    // definition's `schema:` does. Same scoping as every other schema issue —
    // the entry's own modules, since a dependency is not the consumer's to fix.
    const valueTypeSlotIssues: ValueTypeSlotIssue[] = [];
    for (const m of manifests) {
      const declaringModule = (m.metadata as { module?: string } | undefined)?.module;
      if (!declaringModule || rootModules.has(declaringModule)) {
        valueTypeSlotIssues.push(...validateValueTypeSlots(m as unknown as ResourceManifest));
      }
    }
    for (const m of manifests) {
      if (m.kind !== "Telo.Definition" && m.kind !== "Telo.Abstract") continue;
      const def = m as unknown as ResourceDefinition;
      const ownModule = (def.metadata as { module?: string } | undefined)?.module;
      const scopeResolver =
        ownModule && !rootModules.has(ownModule)
          ? (aliasesByModule.get(ownModule) ?? new AliasResolver())
          : aliases;
      // Canonicalize alias-form `x-telo-ref` constraints in the DECLARING module's
      // scope, before the schema reaches `register()` and the lazily-built field
      // maps. Same pre-resolution `capability` / `extends` get below.
      const issues = resolveSchemaRefKinds(m, scopeResolver);
      // Report only for definitions the author can edit. A published dependency
      // still on the deprecated form — or with a constraint that no longer
      // resolves — is not the consumer's to fix, and every import would
      // otherwise flood `telo check` with unactionable noise.
      if (!ownModule || rootModules.has(ownModule)) {
        refConstraintIssues.push(...issues);
        refSlotIssues.push(...validateRefSlotDeclarations(m as unknown as ResourceManifest));
        zoneSlotIssues.push(...validateZoneSlotDeclarations(m as unknown as ResourceManifest));
        projectionIssues.push(...validateSchemaProjection(m as unknown as ResourceManifest));
        // Checked against the MERGED schema, so an `in:` pointer naming an
        // inherited field resolves — which is what lets a rule shared by every
        // backend be declared once on the abstract they extend.
        resourceRuleIssues.push(
          ...validateResourceRuleDeclarations(
            m as unknown as ResourceManifest,
            effectiveAuthorSchema(m as any, (k) => defs.resolve(aliases.resolveKind(k) ?? k) ?? defs.resolve(k)),
          ),
        );
        referrerRuleIssues.push(
          ...validateReferrerRuleDeclarations(m as unknown as ResourceManifest),
        );
        for (const rule of readReferrerRules((m as Record<string, unknown>).schema)) {
          referrerRuleExercise.set(`${m.metadata?.module}.${m.metadata?.name}#${rule.code}`, {
            manifest: m as unknown as ResourceManifest,
            rule,
            exercised: false,
            seen: false,
          });
        }
        for (const rule of readResourceRules((m as Record<string, unknown>).schema)) {
          ruleExercise.set(`${m.metadata?.module}.${m.metadata?.name}#${rule.code}`, {
            manifest: m as unknown as ResourceManifest,
            rule,
            exercised: false,
            seen: false,
          });
        }
      }
      const resolvedCapability = def.capability
        ? (scopeResolver.resolveKind(def.capability) ?? def.capability)
        : def.capability;
      // `Telo.Executable` is a slot constraint — the x-telo-ref parent of
      // Invocable and Runnable — and names no lifecycle role. The kernel
      // rejects it at load; without this the analyzer would report "no issues"
      // on a manifest that cannot boot.
      if (
        resolvedCapability === "Telo.Executable" &&
        (!ownModule || rootModules.has(ownModule))
      ) {
        diagnostics.push({
          severity: DiagnosticSeverity.Error,
          code: "CAPABILITY_NOT_DECLARABLE",
          source: SOURCE,
          message:
            `'${def.metadata?.name}' declares capability: Telo.Executable, which is an ` +
            `x-telo-ref slot constraint (the parent Telo.Invocable and Telo.Runnable extend), ` +
            `not a declarable lifecycle role. Declare 'Telo.Invocable' (invoke) or ` +
            `'Telo.Runnable' (run) instead.`,
          data: {
            resource: { kind: m.kind, name: m.metadata?.name as string },
            filePath: (m.metadata as { source?: string } | undefined)?.source,
            path: "capability",
          },
        });
      }
      const resolvedExtends = def.extends
        ? (scopeResolver.resolveKind(def.extends) ?? def.extends)
        : def.extends;
      const needsPatch =
        resolvedCapability !== def.capability || resolvedExtends !== def.extends;
      const normalized = needsPatch
        ? { ...def, capability: resolvedCapability, extends: resolvedExtends }
        : def;
      defs.register(normalized);
    }

    // Reference-form validation — enforce `!ref` as the only reference shape.
    // Runs on the RAW manifests, BEFORE inline extraction and sentinel
    // resolution, while an author-written `{kind, name}` is still
    // distinguishable from the resolver's own substitution (after Phase 2/2.5
    // they are the same object).
    if (!options?.skipValidation) {
      for (const issue of refConstraintIssues) {
        // An `unknown` prefix is also what an ALREADY-CANONICAL value looks like
        // (`kv-store.Store` names a module, not an alias). Now that every kind is
        // registered, the registry separates the two — anything it resolves was
        // canonical, anything it doesn't names nothing at all.
        if (issue.reason === "unknown" && defs.resolve(issue.ref)) continue;
        const resource = {
          kind: issue.manifest.kind,
          name: issue.manifest.metadata?.name as string,
        };
        const filePath = (issue.manifest.metadata as { source?: string } | undefined)?.source;
        const data = { resource, filePath, path: issue.path };
        if (issue.annotation === "referrer") {
          // Mirrors ZONE_PROVIDER_UNRESOLVED: a filter naming no kind matches no
          // referrer, so the rule would pass on every manifest while checking
          // nothing — reported at the kind that wrote it, since the consumer
          // cannot see that the check is inert.
          diagnostics.push({
            severity: DiagnosticSeverity.Error,
            code: "REFERRER_RULE_INVALID",
            source: SOURCE,
            message:
              `x-telo-referrer-rules 'referrer: ${issue.ref}' at '${issue.path}' names no kind. ` +
              `The prefix must be an import alias declared in this file's 'imports:' map, ` +
              `'Self' for a kind in this library, or 'Telo' for a built-in. A filter that ` +
              `matches nothing leaves the rule inert. Known aliases: ` +
              `${issue.knownAliases?.join(", ") || "(none)"}.`,
            data,
          });
          continue;
        }
        if (issue.annotation === "zone") {
          // Mirrors X_TELO_REF_UNRESOLVED: an unresolvable provider kind would
          // leave the requirement silently unenforced — no provider ever
          // matches a kind that does not exist.
          diagnostics.push({
            severity: DiagnosticSeverity.Error,
            code: "ZONE_PROVIDER_UNRESOLVED",
            source: SOURCE,
            message:
              `x-telo-requires-zone '${issue.ref}' at '${issue.path}' names no kind. The prefix ` +
              `must be an import alias declared in this file's 'imports:' map, 'Self' for a kind ` +
              `in this library, or 'Telo' for a built-in. An unresolvable zone would leave the ` +
              `requirement silently unenforced. Known aliases: ` +
              `${issue.knownAliases?.join(", ") || "(none)"}.`,
            data,
          });
          continue;
        }
        if (issue.reason === "legacy") {
          diagnostics.push({
            severity: DiagnosticSeverity.Warning,
            code: "X_TELO_REF_LEGACY_IDENTITY",
            source: SOURCE,
            message:
              `x-telo-ref '${issue.ref}' at '${issue.path}' uses the deprecated ` +
              `'<namespace>/<module>#<Kind>' form. Write the target as an alias-qualified kind ` +
              `instead — '<Alias>.<Kind>' for a module declared in this file's 'imports:' map, ` +
              `'Self.<Kind>' for a kind in this library, or 'Telo.<Kind>' for a built-in capability.`,
            data,
          });
        } else if (issue.reason === "gated") {
          diagnostics.push({
            severity: DiagnosticSeverity.Error,
            code: "KIND_NOT_EXPORTED",
            source: SOURCE,
            message:
              `x-telo-ref '${issue.ref}' at '${issue.path}' targets a kind module ` +
              `'${issue.gate?.module}' does not export. Add ` +
              `'${issue.ref.slice(issue.ref.indexOf(".") + 1)}' to that module's exports.kinds. ` +
              `Exported kinds: ${issue.gate?.exported.join(", ") || "(none)"}.`,
            data,
          });
        } else {
          diagnostics.push({
            severity: DiagnosticSeverity.Error,
            code: "X_TELO_REF_UNRESOLVED",
            source: SOURCE,
            message:
              `x-telo-ref '${issue.ref}' at '${issue.path}' names no kind. The prefix must be an ` +
              `import alias declared in this file's 'imports:' map, 'Self' for a kind in this ` +
              `library, or 'Telo' for a built-in capability. An unresolvable constraint would ` +
              `leave the slot accepting any resource. Known aliases: ` +
              `${issue.knownAliases?.join(", ") || "(none)"}.`,
            data,
          });
        }
      }
      diagnostics.push(...validateReferenceForms(manifests, defs, aliases, aliasesByModule));
      // The x-telo-ref annotation's own validity — the strict half of the
      // accessor split; `readRefSlot` stays lenient so surfaces keep working
      // mid-migration, and this reports what leniency would silently absorb.
      for (const issue of refSlotIssues) diagnostics.push(refSlotIssueDiagnostic(issue));
      // The same split for `x-telo-type`. Its reader returns a slot with no
      // entry for a name it does not know, which is what an unrecognized brand
      // used to do SILENTLY — the slot simply lost its identity.
      for (const issue of valueTypeSlotIssues) {
        diagnostics.push({
          severity: DiagnosticSeverity.Error,
          code: issue.code,
          source: SOURCE,
          message: issue.message,
          data: {
            resource: {
              kind: issue.manifest.kind,
              name: issue.manifest.metadata?.name as string,
            },
            filePath: (issue.manifest.metadata as { source?: string } | undefined)?.source,
            path: issue.path,
            ...(issue.fix ? { fix: issue.fix } : {}),
          },
        });
      }
      // Same split for the two zone annotations. Unreadable ones fail in
      // OPPOSITE directions — a dropped requirement is silently unenforced, a
      // dropped provision invents failures — so neither can be left to
      // leniency.
      // A projection nothing can read does not fail — it stops typing the
      // consumers counting on it, which puts a misspelled field back where the
      // projection exists to catch it earlier.
      for (const issue of resourceRuleIssues) {
        diagnostics.push({
          severity: DiagnosticSeverity.Error,
          code: issue.code,
          source: SOURCE,
          message: issue.message,
          data: {
            resource: {
              kind: issue.manifest.kind,
              name: issue.manifest.metadata?.name as string,
            },
            filePath: (issue.manifest.metadata as { source?: string } | undefined)?.source,
            path: issue.path,
          },
        });
      }
      for (const issue of referrerRuleIssues) {
        diagnostics.push({
          severity: DiagnosticSeverity.Error,
          code: issue.code,
          source: SOURCE,
          message: issue.message,
          data: {
            resource: {
              kind: issue.manifest.kind,
              name: issue.manifest.metadata?.name as string,
            },
            filePath: (issue.manifest.metadata as { source?: string } | undefined)?.source,
            path: issue.path,
          },
        });
      }
      for (const issue of projectionIssues) {
        diagnostics.push({
          severity: DiagnosticSeverity.Error,
          code: issue.code,
          source: SOURCE,
          message: issue.message,
          data: {
            resource: {
              kind: issue.manifest.kind,
              name: issue.manifest.metadata?.name as string,
            },
            filePath: (issue.manifest.metadata as { source?: string } | undefined)?.source,
            path: issue.path,
          },
        });
      }
      for (const issue of zoneSlotIssues) {
        diagnostics.push({
          severity: DiagnosticSeverity.Error,
          code: issue.code,
          source: SOURCE,
          message: issue.message,
          data: {
            resource: {
              kind: issue.manifest.kind,
              name: issue.manifest.metadata?.name as string,
            },
            filePath: (issue.manifest.metadata as { source?: string } | undefined)?.source,
            path: issue.path,
          },
        });
      }
    }

    // Phase 2: extract inline resources from x-telo-ref slots into first-class manifests
    const allManifests = normalizeInlineResources(manifests, defs, aliases, aliasesByModule);

    // Phase 2.5: resolve `!ref <name>` sentinels at every ref slot to canonical
    // {kind, name} objects so downstream phases (validation, dependency graph,
    // kernel controllers) see a uniform shape. Runs after normalize so both
    // original and inline-extracted manifests have their sentinels resolved.
    resolveRefSentinels(allManifests, aliases, aliasesByModule, [], defs);

    // ONE typed reference graph per analysis. Both graph consumers in this
    // pass (the dynamic-selector check and run-reachability) read the same
    // build — constructing it per consumer is strictly more work than the
    // walks it replaced, and performance is a core goal. Lazy, so a
    // skipValidation pass with no observed state builds nothing.
    let callGraphMemo: ReturnType<typeof buildCallGraph> | undefined;
    const getCallGraph = () =>
      (callGraphMemo ??= buildCallGraph(allManifests as unknown as ResourceManifest[], defs, {
        aliases,
        aliasesByModule,
      }));

    /**
     * Whether a referrer of `kind` satisfies a referrer rule's `referrer:`
     * filter, which is canonical by the time it gets here (`resolveSchemaRefKinds`
     * rewrote it in the DECLARING module's scope). The referring manifest's own
     * `kind:` is not — it is whatever alias its author imported the kind under —
     * so it is resolved the same way every other kind comparison in this pass
     * resolves one. Liskov-substitutable, matching `checkKind`: a child of the
     * named kind is one.
     */
    const kindMatches = (filter: string, kind: string): boolean => {
      const resolved = aliases.resolveKind(kind) ?? kind;
      if (resolved === filter) return true;
      return defs
        .getByExtends(filter)
        .some((d) => `${d.metadata.module}.${d.metadata.name}` === resolved);
    };

    /**
     * The resources that reach `manifest`, with the slot each one reaches it
     * through. A step's edge is attributed to the resource whose body declares
     * it: a step is not a manifest, and the requirement is about the resource
     * that has to declare something.
     *
     * Deduplication is the evaluation's, not this function's — a referrer
     * reaching one resource through two slots is two sites, and which one anchors
     * the diagnostic is a reporting decision.
     */
    const referrersOf = (
      manifest: ResourceManifest,
      graph: ReturnType<typeof buildCallGraph>,
    ): Referrer[] => {
      const name = manifest.metadata?.name as string | undefined;
      if (!name) return [];
      const node = graph.resource(manifest.kind, name) ?? graph.resourceByName(name);
      if (!node) return [];
      const out: Referrer[] = [];
      for (const edge of graph.edgesTo(node.id)) {
        const from = graph.nodes.get(edge.from);
        if (!from) continue;
        const owner = from.type === "step" ? graph.nodes.get(from.owner) : from;
        if (!owner || owner.type !== "resource") continue;
        out.push({
          manifest: owner.manifest,
          kind: owner.kind,
          name: owner.name,
          path: edge.path,
        });
      }
      return out;
    };

    // A `use` case map's selector written in CEL is a hard diagnostic — a call
    // graph known only at runtime is not statically analyzable, and no fallback
    // is conservative for every consumer. Scoped to the entry's own modules:
    // a published dependency's manifest is not the consumer's to fix.
    if (!options?.skipValidation) {
      for (const issue of validateDynamicSelectors(
        allManifests as unknown as ResourceManifest[],
        defs,
        aliases,
        aliasesByModule,
        getCallGraph(),
      )) {
        const ownModule = (issue.manifest.metadata as { module?: string } | undefined)?.module;
        if (ownModule && !rootModules.has(ownModule)) continue;
        diagnostics.push(refSlotIssueDiagnostic(issue));
      }

      // Zone requirements — a projection over the same graph: propagate along
      // `call` edges, discharge at providing slots under correlation, fire at
      // terminating edges and boot. Imported libraries' export contracts are
      // derived over their full documents (options.moduleDocuments — the
      // flattened view no longer holds their internal dispatch chains), cached
      // per library in the host-lifetime `zoneExportCache`.
      diagnostics.push(
        ...runZoneAnalysis({
          manifests: allManifests as unknown as ResourceManifest[],
          graph: getCallGraph(),
          defs,
          aliases,
          aliasesByModule,
          rootModules,
          moduleDocuments: options?.moduleDocuments,
          cache: zoneExportCache,
        }),
      );

      // Durable regions — the SAME graph again, walked DOWNWARD this time.
      // Every rule here keys off a zone attribute rather than off any kind, so
      // a backend that ships its own workflow kind is covered without the
      // analyzer knowing it exists: going native costs a module, not a change
      // here.
      const resolveRegionDef = (kind: string, module?: string) => {
        const scope = (module ? aliasesByModule.get(module) : undefined) ?? aliases;
        const canonical = scope.resolveKind(kind);
        return defs.resolve(kind) ?? (canonical ? defs.resolve(canonical) : undefined);
      };
      diagnostics.push(
        ...validateDurableRegions({
          graph: getCallGraph(),
          resolveDef: resolveRegionDef,
          reportModules: rootModules,
        }),
        // The same walk once more, over EVERY attribute rather than the two
        // durability names — a region must not contain a resource that declares
        // it cannot honour what the region promises.
        ...validateZoneViolations({
          graph: getCallGraph(),
          resolveDef: resolveRegionDef,
          reportModules: rootModules,
        }),
      );
    }

    // Phase 2.6: register each named `Telo.Type` resource's schema under its
    // canonical module-scoped id (`telo://<module>/<name>`), validate
    // `telo://Self|Alias/Type` schema refs resolve to one, then rewrite those
    // refs to the canonical id so AJV resolves them at compile time. Register
    // and validate BEFORE the rewrite, while the authored authority is intact.
    for (const m of allManifests) {
      const ownModule = (m.metadata as { module?: string } | undefined)?.module;
      if (!ownModule || !m.metadata?.name || typeof m.schema !== "object" || m.schema === null) {
        continue;
      }
      const scopeResolver =
        rootModules.has(ownModule) ? aliases : (aliasesByModule.get(ownModule) ?? new AliasResolver());
      const canonicalKind = scopeResolver.resolveKind(m.kind as string) ?? (m.kind as string);
      if (defs.resolve(canonicalKind)?.capability !== "Telo.Type") continue;
      const typeName = m.metadata.name as string;
      const registered = defs.registerNamedTypeSchema(
        canonicalTypeSchemaId(ownModule, typeName),
        m.schema as Record<string, any>,
      );
      // Kinds and named types share one `telo://<module>/<Name>` id space. A
      // collision would leave every `$ref` to that id resolving to the kind's
      // schema — validating the wrong shape, silently — so it is an error, not
      // a last-writer-wins.
      if (!registered && !options?.skipValidation) {
        diagnostics.push({
          severity: DiagnosticSeverity.Error,
          code: "DUPLICATE_SCHEMA_ID",
          source: SOURCE,
          message:
            `Type '${typeName}' collides with the kind '${ownModule}.${typeName}': both claim the ` +
            `schema id '${canonicalTypeSchemaId(ownModule, typeName)}'. A '$ref' to it would ` +
            `resolve to the kind's schema. Rename one of them.`,
          data: {
            resource: { kind: m.kind, name: typeName },
            filePath: (m.metadata as { source?: string } | undefined)?.source,
            path: "metadata.name",
          },
        });
      }
    }
    // Declared runtime requirements, FIRST among the validators and suppressing
    // the rest for any module this runtime cannot read. A module that adopted
    // newer syntax also produces the vocabulary errors that syntax causes here —
    // an unknown `use` token, an object where a zone annotation expects a
    // pointer, an `additionalProperties` violation against a kernel-owned
    // schema — every one of which is true and blames the module's author for a
    // version skew. Reporting them beside the gate would bury the one message
    // that names the actual cause and the actual fix.
    const requiresDiagnostics = validateRequires(allManifests as unknown as ResourceManifest[], {
      teloVersion: options?.teloVersion,
      hostVersions: options?.hostVersions,
      entryModules: rootModules,
    });
    const unreadableFiles = filesOfUnreadableModules(
      allManifests as unknown as ResourceManifest[],
      requiresDiagnostics,
    );
    diagnostics.push(...requiresDiagnostics);

    if (!options?.skipValidation) {
      diagnostics.push(
        ...validateSchemaTypeRefs(allManifests, defs, aliases, aliasesByModule, rootModules),
      );
      // §14.1 / §10.3: redaction paths and `on_full: block` are statically
      // detectable, so they fail `telo check` rather than only at boot.
      diagnostics.push(...validateLogging(allManifests, defs, aliases, aliasesByModule));
      // Module-artifact surface: bundled-controller selector qualifiers and the
      // published `layers:` index. Every case is decidable from the manifest and
      // would otherwise fail on a consumer's machine — or, for a mistyped platform
      // axis, silently offer one platform's binary to every host.
      diagnostics.push(...validateModuleArtifact(allManifests));
      // The descriptive `metadata:` surface. Nothing in the kernel branches on
      // these fields, which is precisely why they need a check: a mistyped one
      // has no runtime failure mode that would ever surface it.
      diagnostics.push(...validateModuleMetadata(allManifests, defs, aliases));
      // Every author-written name. Telo has no lexer, so a name's shape is
      // unchecked where it is declared and its consequences land at whichever
      // CEL site reads it — for a hyphen, sometimes as silent arithmetic. Takes
      // the call graph for step names rather than re-walking the step arrays.
      diagnostics.push(
        ...validateIdentifierNames(
          allManifests as unknown as ResourceManifest[],
          defs,
          aliases,
          rootModules,
          getCallGraph(),
        ),
      );
      // A file embed resolves at resource creation, so one written on a doc that
      // is never instantiated is read by nothing and would ship silently.
      diagnostics.push(...validateIncludePlacement(allManifests));
    }
    resolveSchemaTypeRefs(allManifests, aliases, aliasesByModule);
    // ...and over the manifests the DEFINITION REGISTRY holds, which are not
    // these. `normalizeInlineResources` deep-clones — that clone is the
    // analyzer's immutability boundary — while `defs.register` ran before it, on
    // the originals. So a kind whose `schema:` references a named shape kept the
    // authored `telo://Self/<Type>` spelling everywhere the registry is read,
    // which is where a resource's configuration is validated: the schema failed
    // to compile, the failure was swallowed, and `telo check` reported nothing
    // about a resource the kernel then rejected at boot. The pass is idempotent
    // — a canonical id parses as no authority and is left alone — so running it
    // over both is the whole repair.
    resolveSchemaTypeRefs(manifests, aliases, aliasesByModule);

    // Trusted-input fast path: when the caller has already attested that
    // this exact manifest set passes analysis (e.g. via the kernel's
    // hash-stamped `.validated.json` cache), skip the validation walk.
    // Registration of identities / aliases / definitions and inline-resource
    // normalisation have already run above; that's all downstream
    // consumers (prepare, init loop) require.
    if (options?.skipValidation) {
      return suppressUnreadableModuleDiagnostics(diagnostics, unreadableFiles);
    }

    // Build a name→manifest map for looking up referenced resources
    const byName = new Map<string, ResourceManifest>();
    for (const m of allManifests) {
      if (m.metadata?.name) {
        byName.set(m.metadata.name as string, m);
      }
    }

    // Fail loud on definition schemas AJV cannot compile. `validateAgainstSchema`
    // and `validateWithRefs` swallow compile failures (returning no issues),
    // which would silently skip schema validation for every resource of that
    // kind — surface the broken schema once, anchored on the definition itself.
    for (const m of allManifests) {
      if (m.kind !== "Telo.Definition" && m.kind !== "Telo.Abstract") continue;
      const schema = (m as Record<string, any>).schema;
      if (!schema || typeof schema !== "object") continue;
      const name = m.metadata?.name as string | undefined;
      if (!name) continue;
      const compileError = defs.schemaCompileError(schema as Record<string, any>);
      if (compileError) {
        diagnostics.push({
          severity: DiagnosticSeverity.Error,
          code: "SCHEMA_COMPILE_ERROR",
          source: SOURCE,
          message: `${m.kind}/${name}: definition schema failed to compile: ${compileError}`,
          data: {
            resource: { kind: m.kind, name },
            filePath: (m.metadata as { source?: string } | undefined)?.source,
            path: "schema",
          },
        });
      }
    }

    // Library env: rejection — `env:` on a Library `variables` / `secrets`
    // entry is forbidden. The Library entry schema is otherwise open so that
    // any JSON Schema property schema is valid; this targeted check produces
    // a clear diagnostic instead of a generic "additional property" error.
    for (const m of allManifests) {
      if (m.kind !== "Telo.Library") continue;
      const filePath = (m.metadata as { source?: string } | undefined)?.source;
      const moduleName = m.metadata?.name as string | undefined;
      const resource = moduleName ? { kind: m.kind, name: moduleName } : undefined;
      for (const block of ["variables", "secrets"] as const) {
        const entries = (m as Record<string, any>)[block];
        if (!entries || typeof entries !== "object" || Array.isArray(entries)) continue;
        for (const [entryName, entry] of Object.entries(entries)) {
          if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
          if ("env" in (entry as Record<string, unknown>)) {
            diagnostics.push({
              severity: DiagnosticSeverity.Error,
              code: "LIBRARY_ENV_KEY_REJECTED",
              source: SOURCE,
              message:
                `Telo.Library ${block}/${entryName}: 'env:' is only permitted on Telo.Application entries. ` +
                `Libraries must receive values from importers via the parent manifest's variables / secrets block.`,
              data: { resource, filePath, path: `${block}.${entryName}.env` },
            });
          }
        }
      }
      // `exports.resources` entries are plain names: `Db` (local) or `Alias.Name` (re-export),
      // mirroring `exports.kinds`. The `!ref` tag is not accepted here — a `!ref` parses to a
      // sentinel object that the schema's CEL/ref exemption would silently pass, so reject any
      // non-string entry with an actionable message instead.
      const exportsResources = (m as Record<string, any>).exports?.resources;
      if (Array.isArray(exportsResources)) {
        for (let i = 0; i < exportsResources.length; i++) {
          if (typeof exportsResources[i] === "string") continue;
          diagnostics.push({
            severity: DiagnosticSeverity.Error,
            code: "INVALID_EXPORT",
            source: SOURCE,
            message:
              `Telo.Library exports.resources[${i}]: write the exported name as a plain string — ` +
              `'Name' to export a local instance, or 'Alias.Name' to re-export an imported one. ` +
              `The '!ref' tag is not allowed in exports.resources.`,
            data: { resource, filePath, path: `exports.resources.${i}` },
          });
        }
      }
    }

    // What each resource reports while running (`status:`), and which resources
    // some slot can actually start. Both feed the observed-state checks below.
    // A RESOURCE's kind is written in the module that declares it and is never
    // canonicalized (unlike a definition's `extends`, normalized at registration
    // above), so an exported instance's `kind: Self.X` only resolves in its own
    // library's scope.
    const moduleScopes = { aliasesByModule, rootModules };

    const observedState = buildObservedStateIndex(allManifests, defs, aliases, moduleScopes);
    const reportsObservedState = [...observedState.values()].some((r) => r.status);
    const runReachable = reportsObservedState
      ? collectRunReachableNames(getCallGraph())
      : new Set<string>();

    // Build typed kernel globals schema so x-telo-context chain validation
    // recognises variables, secrets, resources, env automatically
    const kernelGlobals = buildKernelGlobalsIndex(allManifests, observedState);

    // Fallback context for CEL in a slot with no `x-telo-context` annotation:
    // everything stays open except the typed `.status` nodes, so unknown-field
    // checking reaches observed state everywhere without newly rejecting any
    // read that passes today.
    const observedStateContext: Record<string, any> | null =
      reportsObservedState
        ? {
            type: "object",
            additionalProperties: true,
            properties: {
              resources: buildObservedStateResourcesSchema(observedState, true),
            },
          }
        : null;

    // The module doc (Application/Library) carries the Application-only `ports`
    // namespace; threaded into per-resource CEL typing so `${{ ports.X }}`
    // resolves its nominal brand cross-doc. A flattened set holds exactly one —
    // the entry's; see `buildKernelGlobalsSchema`.
    const moduleManifest =
      allManifests.find((mm) => mm.kind === "Telo.Application") ??
      allManifests.find((mm) => mm.kind === "Telo.Library");

    // Every pure-CEL leaf, with the slot it flows into. Compared against the
    // type the engine walk resolves, once both halves exist — see
    // `collectCelValueSlots`.
    const celReturnSlots: (CelValueSlot & {
      manifest: ResourceManifest;
      resource: { kind: string; name: string };
      filePath?: string;
    })[] = [];
    const celTypeByPath = new Map<ResourceManifest, Map<string, string>>();
    // The schema an expression RESOLVES TO, beside the CEL type it carries. Both
    // are needed and neither replaces the other: the CEL type answers "does this
    // fit the slot at all", the schema answers "do their type arguments agree",
    // which cel-js cannot express because it types by constructor identity.
    const celSourceSchemaByPath = new Map<ResourceManifest, Map<string, Record<string, any>>>();
    // What every CEL expression in this set is typed against. The rule lives in
    // `cel-scope.ts` so the IDE asks the same question the pass does — a
    // completion list is a claim that the name it offers will pass this check,
    // and two implementations of it could not be held in agreement.
    const celScope = new CelScopeResolver({
      celEnv: this.celEnv,
      defs,
      aliases,
      scopes: { aliasesByModule, rootModules },
      allManifests,
      kernelGlobals,
      moduleManifest,
      observedStateContext,
    });

    // Validate each non-definition, non-system resource
    for (const m of allManifests) {
      const filePath = (m.metadata as { source?: string } | undefined)?.source;
      if (!m.kind || !m.metadata?.name) {
        diagnostics.push({
          severity: DiagnosticSeverity.Error,
          code: "MISSING_KIND_OR_NAME",
          source: SOURCE,
          message: "Resource is missing required 'kind' or 'metadata.name' field.",
          data: { filePath, path: !m.kind ? "kind" : "metadata.name" },
        });
        continue;
      }
      // Abstracts carry only inputType / outputType schema fields and no template
      // body — nothing for the per-resource walk to validate. Definitions are now
      // walked: their template bodies (`resources` / `invoke` / `run` / `provide`)
      // contain CEL that must be checked against `self` / `inputs` / `result`.
      if (m.kind === "Telo.Abstract") {
        continue;
      }

      // Forwarded exports (flagged by flattenForAnalyzer) are an imported library's exported
      // instances, already validated in their own module's standalone analysis; their
      // `kind`/CEL are authored in that module's scope (e.g. `Self.X` → that module, not the
      // consumer). Re-validating against the consumer's scope yields false UNDEFINED_KIND /
      // scope-mismatch errors, so skip — they participate here only as resolution targets.
      if ((m.metadata as { forwardedExport?: boolean } | undefined)?.forwardedExport === true) {
        continue;
      }

      const resource = { kind: m.kind, name: m.metadata?.name as string };

      // Resolve kind through alias if needed; direct lookup takes priority so that
      // aliases whose name matches the module name (the common case) work without
      // path-derived name mangling. A resource that originated in an imported library
      // (its `metadata.module` names a non-root module — e.g. an inline route handler
      // extracted from an imported Http.Api) must resolve its kind alias against THAT
      // library's import map, not the consumer's; an anonymous child inherits the
      // lexical scope of the document that declares it. Mirrors the nested-inline and
      // reference-resolution paths: own-module scope first, root/consumer aliases last.
      const ownModule = (m.metadata as { module?: string } | undefined)?.module;
      const scopeResolver = scopeResolverForModule(ownModule, rootModules, aliasesByModule);
      // Either scope resolving it wins; otherwise a gate rejection is more specific than
      // "unknown alias", so surface that.
      const scoped = scopeResolver?.resolveKindResult(m.kind);
      const rooted = aliases.resolveKindResult(m.kind);
      const kindResult =
        scoped?.status === "ok"
          ? scoped
          : rooted.status === "ok"
            ? rooted
            : scoped?.status === "gated"
              ? scoped
              : rooted;

      // The gate is checked BEFORE any definition lookup. `defs` is keyed
      // `<metadata.module>.<Kind>`, so a library whose `metadata.name` equals the alias it
      // is imported under (e.g. module `Foo` imported as `Foo`) makes the raw `defs.resolve(m.kind)`
      // below hit directly — which would accept a kind the module does not export, leaving
      // the analyzer more permissive than the kernel.
      if (kindResult.status === "gated") {
        diagnostics.push({
          severity: DiagnosticSeverity.Error,
          code: "KIND_NOT_EXPORTED",
          source: SOURCE,
          message:
            `Kind '${m.kind}' is not exported by module '${kindResult.module}'. ` +
            `Add '${m.kind.slice(m.kind.indexOf(".") + 1)}' to that module's exports.kinds ` +
            `to make it importable. Exported kinds: ${kindResult.exported.join(", ") || "(none)"}.`,
          data: { resource, filePath, path: "kind" },
        });
        continue;
      }
      const resolvedKind = kindResult.status === "ok" ? kindResult.kind : undefined;
      const definition =
        defs.resolve(m.kind) ?? (resolvedKind ? defs.resolve(resolvedKind) : undefined);
      if (!definition) {
        const suggestedKind = computeSuggestKind(m.kind, aliases, defs);
        const hint = suggestedKind ? ` Did you mean '${suggestedKind}'?` : "";
        diagnostics.push({
          severity: DiagnosticSeverity.Error,
          code: "UNDEFINED_KIND",
          source: SOURCE,
          message: `No Telo.Definition found for kind '${m.kind}'.${hint}`,
          // `suggestedKind` is kept beside the generic `fix` because it names
          // what the replacement IS; the fix is how to apply it.
          data: {
            resource,
            filePath,
            path: "kind",
            suggestedKind,
            ...(suggestedKind ? { fix: { replacement: suggestedKind } } : {}),
          },
        });
        continue;
      }

      // Validate resource config against the definition's AUTHOR-FACING schema —
      // inheritance-resolved: with `base:` the child's own schema (parent config
      // is internal), else `merge(parent, own)` so a `base:`-less `extends` child
      // is validated against the inherited fields it may set. For a definition
      // that neither extends nor uses `base:` this is exactly its own schema.
      // `kind` and `metadata` are implicit on every resource — inject them so module
      // authors don't have to repeat them when using additionalProperties: false.
      const authorSchema = effectiveAuthorSchema(definition, (k) =>
        defs.resolve(aliases.resolveKind(k) ?? k) ?? defs.resolve(k),
      );
      if (authorSchema && Object.keys(authorSchema).length > 0) {
        const schema =
          authorSchema.additionalProperties === false
            ? {
                ...authorSchema,
                properties: {
                  kind: { type: "string" },
                  metadata: { type: "object" },
                  ...authorSchema.properties,
                },
              }
            : authorSchema;
        // Phase 1: collect the pure-CEL leaves and the schema of the slot each
        // flows into. The expression's own type is resolved later, by the
        // engine walk that owns type-checking; this half only knows the target.
        for (const slot of collectCelValueSlots(m, schema, "")) {
          celReturnSlots.push({ manifest: m, resource, filePath, ...slot });
        }
        // Phase 2+3: AJV on substituted data — CEL fields replaced with typed
        // placeholders. Through the REGISTRY, so a kind whose schema references
        // a shape declared elsewhere is checked on the instance that holds it.
        const ajvIssues = defs.validateResourceConfig(
          substituteCelFields(m, schema, undefined, { external: (ref) => defs.schemaForId(ref) }),
          schema,
        );
        // Phase 4: value slots that must satisfy a type declared elsewhere on
        // the resource (`x-telo-value-schema-from`) — e.g. every row of a
        // decision table against its declared `outputType`, so a mistyped branch
        // is caught here rather than on the one input that selects it.
        const valueSchemaIssues = collectValueSchemaIssues(
          m as Record<string, any>,
          schema,
          allManifests as Record<string, any>[],
        );
        const issues = [...ajvIssues, ...valueSchemaIssues];
        for (const issue of issues) {
          diagnostics.push({
            severity: DiagnosticSeverity.Error,
            code: "SCHEMA_VIOLATION",
            source: SOURCE,
            message: `${m.kind}/${resource.name}: ${issue.message}`,
            data: { resource, filePath, path: issue.path },
          });
        }
      }

      // Resource rules — relationships between this resource's own fields that
      // JSON Schema cannot state, declared by the kind as CEL over `self` and
      // `this`. Read off the AUTHOR-FACING schema, so an `extends` child without
      // `base:` inherits its parent's rules and one that declares its own
      // replaces them, exactly as the rest of the config contract merges.
      // The finding→diagnostic mapping lives with the finding vocabulary in
      // `validate-resource-rules.ts`, the shape every neighbouring pass uses:
      // issues out, one emit here.
      const ruleDeclarer = (definition.metadata as { module?: string } | undefined)?.module;
      for (const report of reportResourceRules(
        m as unknown as ResourceManifest,
        definition as unknown as ResourceManifest,
        evaluateResourceRules(m as unknown as ResourceManifest, authorSchema),
        !ruleDeclarer || rootModules.has(ruleDeclarer),
      )) {
        diagnostics.push(resourceRuleDiagnostic(report));
      }
      for (const rule of readResourceRules(authorSchema)) {
        const key = `${definition.metadata?.module}.${definition.metadata?.name}#${rule.code}`;
        const tracked = ruleExercise.get(key);
        if (!tracked) continue;
        tracked.seen = true;
        if (ruleExercised(m as unknown as ResourceManifest, rule)) tracked.exercised = true;
      }

      // Referrer rules — what must be true of whoever REFERENCES this resource,
      // declared by the kind that has the requirement rather than by the kind
      // that must satisfy it. The subject is chosen by the EDGE, so no kind
      // literal appears on the referring side, where the spelling would be the
      // consumer's import alias rather than anything the rule's author controls.
      // A consumer of the shared call graph, never a second traversal.
      const referrerRules = readReferrerRules(authorSchema);
      if (referrerRules.length > 0) {
        const referrers = referrersOf(m as unknown as ResourceManifest, getCallGraph());
        for (const report of reportReferrerRules(
          m as unknown as ResourceManifest,
          definition as unknown as ResourceManifest,
          evaluateReferrerRules(
            m as unknown as ResourceManifest,
            authorSchema,
            referrers,
            kindMatches,
          ),
          !ruleDeclarer || rootModules.has(ruleDeclarer),
        )) {
          // A VIOLATION is the referrer's data, so it is reported only when that
          // manifest is the entry's own — the same direction a resource-rule
          // violation takes, one hop further out.
          const owner = (report.manifest.metadata as { module?: string } | undefined)?.module;
          if (report.code === "REFERRER_RULE_VIOLATED" && owner && !rootModules.has(owner)) {
            continue;
          }
          diagnostics.push(referrerRuleDiagnostic(report));
        }
        for (const rule of referrerRules) {
          const key = `${definition.metadata?.module}.${definition.metadata?.name}#${rule.code}`;
          const tracked = referrerRuleExercise.get(key);
          if (!tracked) continue;
          tracked.seen = true;
          if (referrerRuleExercised(rule, referrers, kindMatches)) tracked.exercised = true;
        }
      }

      // Validate inline resources nested inside this resource's body (e.g. a
      // Run.Sequence step's `invoke: { kind, ...config }`). These sit at
      // x-telo-ref slots reached only through local `$ref`s, which the
      // reference field map intentionally does not follow, so they escape both
      // inline-extraction and the per-resource schema check above.
      if (definition.schema) {
        // Resolve inline kinds in the parent resource's scope: direct kind
        // first, then the parent module's own aliases (for resources declared
        // inside an imported module), then the root aliases. Mirrors how the
        // analyzer resolves kinds elsewhere so module-scoped aliases don't
        // produce false UNDEFINED_KIND diagnostics. `scopeResolver` is the
        // owning module's resolver computed above.
        diagnostics.push(
          ...validateNestedInlineResources(
            m,
            definition.schema as Record<string, any>,
            (kind: string) => {
              const direct = defs.resolve(kind);
              if (direct) return direct;
              const viaScope = scopeResolver?.resolveKind(kind);
              if (viaScope) {
                const scoped = defs.resolve(viaScope);
                if (scoped) return scoped;
              }
              const viaRoot = aliases.resolveKind(kind);
              return viaRoot ? defs.resolve(viaRoot) : undefined;
            },
            allManifests as Record<string, any>[],
            {
              validate: (data, target) => defs.validateResourceConfig(data, target),
              external: (ref) => defs.schemaForId(ref),
            },
          ),
        );
      }

      // (Invocation context compatibility check is handled via x-telo-context in the CEL pass below)
    }

    // A rule whose collection was empty on every resource of its kind is a rule
    // nothing proved. `check()` types `self` only shallowly (cel-js takes a flat
    // field map, so `columns` is `map`), which means a typo below the first level
    // survives declaration validation and is caught only by evaluation — so a
    // rule that never evaluated has been verified by nothing at all. Reported
    // only when the kind HAS resources here: a kind nobody instantiated in this
    // workspace says nothing about the rule.
    for (const tracked of ruleExercise.values()) {
      if (!tracked.seen || tracked.exercised) continue;
      diagnostics.push(resourceRuleDiagnostic(reportUnexercisedRule(tracked.manifest, tracked.rule)));
    }
    for (const tracked of referrerRuleExercise.values()) {
      if (!tracked.seen || tracked.exercised) continue;
      diagnostics.push(
        referrerRuleDiagnostic(reportUnexercisedReferrerRule(tracked.manifest, tracked.rule)),
      );
    }

    // Template-body structural validations: check that template entry-points produce
    // values matching the contract of their dispatch target and (for `provide:`)
    // the abstract this definition `extends`. CEL fields inside the templated
    // values are replaced with type-appropriate placeholders before AJV runs —
    // same pattern as the per-resource schema validation above.
    const contractScope = analyzerContractScope(
      defs,
      aliases,
      { aliasesByModule, rootModules },
      allManifests as Record<string, any>[],
    );

    for (const m of allManifests) {
      if (m.kind !== "Telo.Definition") continue;
      const filePath = (m.metadata as { source?: string } | undefined)?.source;
      const name = (m.metadata as any)?.name as string | undefined;
      if (!name) continue;
      const resource = { kind: m.kind, name };
      const md = m as Record<string, any>;

      const emitTargetMismatch = (
        targetKind: string,
        valueSchema: Record<string, any>,
        value: unknown,
        path: string,
      ) => {
        const substituted = substituteCelFields(value, valueSchema);
        const issues = validateAgainstSchema(substituted, valueSchema);
        for (const issue of issues) {
          diagnostics.push({
            severity: DiagnosticSeverity.Error,
            code: "TEMPLATE_TARGET_MISMATCH",
            source: SOURCE,
            message: `${m.kind}/${name}: ${path} does not satisfy ${targetKind}'s contract: ${issue.message}`,
            data: { resource, filePath, path: issue.path ? `${path}.${issue.path}` : path },
          });
        }
      };

      // Resolve the dispatch target's kind, if statically known. Object-form
      // `invoke: { kind, name }` and `provide: { kind, name }` carry it; the
      // string-form `invoke: "name"` does not (the matching resource entry would
      // need to be located by expanded name — out of scope here).
      const invoke = md.invoke;
      const provide = md.provide;
      let dispatchKind: string | undefined;
      if (invoke && typeof invoke === "object" && !Array.isArray(invoke) && typeof invoke.kind === "string") {
        dispatchKind = invoke.kind;
      } else if (
        provide &&
        typeof provide === "object" &&
        !Array.isArray(provide) &&
        typeof provide.kind === "string"
      ) {
        dispatchKind = provide.kind;
      }

      // Top-level `inputs:` (sibling of `invoke:` / `provide:`) carries the
      // values passed to the dispatch target's invoke(). Validate against the
      // target's declared `inputType` when both sides have one.
      if (dispatchKind && md.inputs && typeof md.inputs === "object") {
        const targetSchema = resolveContract(
          "inputType",
          undefined,
          contractScope.resolveIn(dispatchKind, (md.metadata as any)?.module),
          contractScope,
        )?.schema;
        if (targetSchema) {
          emitTargetMismatch(dispatchKind, targetSchema, md.inputs, "inputs");
        }
      }

      // Top-level `result:` is a post-call mapping that must satisfy THIS
      // definition's output contract — its own `outputType` when it declares
      // one, otherwise the nearest ancestor's. It's a sibling of whichever
      // dispatch entry-point declared a kind-typed target (`provide:` or
      // `invoke:`). The target's outputType lives on the dispatcher's `kind`
      // and is what `result` is typed against *inside* CEL — separate role.
      const hasDispatchObject =
        (provide && typeof provide === "object" && !Array.isArray(provide)) ||
        (invoke && typeof invoke === "object" && !Array.isArray(invoke));
      if (hasDispatchObject && md.result && typeof md.result === "object") {
        const contract = resolveContract(
          "outputType",
          undefined,
          md as unknown as ResourceDefinition,
          contractScope,
        );
        if (contract) {
          emitTargetMismatch(contractOwnerLabel(md, contract), contract.schema, md.result, "result");
        }
      }
    }

    // A consumer's slot typed from a referenced declaration
    // (`x-telo-schema-projection-from`) fails in the direction that is hardest
    // to notice: the contract silently reopens, so a misspelled field passes
    // `telo check` exactly as it did before the projection existed. That is the
    // failure the projection exists to move earlier, so it is reported here
    // rather than left to degrade. Entry-module-scoped, like
    // `X_TELO_REF_UNRESOLVED` — a published dependency's slot is not the
    // consumer's to fix.
    for (const m of allManifests) {
      const md = m as Record<string, any>;
      if (typeof md.kind !== "string" || md.kind.startsWith("Telo.")) continue;
      const ownModule = (md.metadata as { module?: string } | undefined)?.module;
      if (ownModule && !rootModules.has(ownModule)) continue;
      const definition = contractScope.resolveIn(md.kind, ownModule);
      if (!definition) continue;
      const failures: ProjectionFailure[] = [];
      for (const direction of ["inputType", "outputType"] as const) {
        resolveContract(direction, md, definition, contractScope, failures);
      }
      for (const failure of failures) {
        diagnostics.push({
          severity: DiagnosticSeverity.Error,
          code: "SCHEMA_PROJECTION_FROM_UNRESOLVED",
          source: SOURCE,
          message: `${md.kind}: ${describeProjectionFailure(failure)}`,
          data: {
            resource: { kind: md.kind, name: (md.metadata as any)?.name as string },
            filePath: (md.metadata as { source?: string } | undefined)?.source,
            path: failure.pointer.replace(/^\//, ""),
          },
        });
      }
    }

    // Validate CEL syntax and context variable access in all manifests. The
    // walker discovers every compiled CEL node by scanning the value tree and
    // hands back the `x-telo-context` schema matched at the enclosing path; the
    // per-path resolution (step context, kernel-globals merge, x-telo-context-*
    // annotation resolution) stays here because it depends on analyzer-internal
    // state (definitions, aliases, the typed CEL env).
    // Per-resource state computed at enter and read by that resource's CEL
    // sites. The manifest / resource / filePath come straight off each CelSite's
    // `source` (no need to capture them); the derived step / invocation / error
    // context is the scope resolver's, read back from it where a CHECK needs the
    // same schema an expression is typed against.
    let celStepContextSchema: Record<string, any> | undefined;
    let celErrorScopes: ReadonlyMap<string, Record<string, any>> = new Map();
    // Region coverage for the "CEL in a non-eval field" check: the union of
    // `x-telo-eval` paths (own + capability) and `x-telo-context` /
    // `x-telo-step-context` / `x-telo-error-context` scopes. A `!cel` outside
    // every region is read as a literal — the runtime never evaluates it.
    let celEvalPaths: string[] = [];
    // The bindings field this kind declares (if any), read by the CEL sites that
    // see the names it introduces.
    let celBindingSites: BindingSites | undefined;
    // The compile half alone: a field that resolves at startup, where observed
    // state cannot exist yet.
    let celCompilePaths: string[] = [];
    let celRegionScopes: string[] = [];
    let celRuleApplies = false;

    visitManifest(
      allManifests,
      defs,
      {
        onResourceEnter: (e) => {
          const m = e.source;
          celScope.enterResource(m, e.definition);
          // Read back rather than recomputed: the step-inputs check has to see
          // the same `steps` schema this resource's expressions are typed
          // against, and a second computation is how the two come to disagree.
          celStepContextSchema = celScope.stepContextSchema;
          celErrorScopes = celScope.errorContextScopes;
          if (e.definition?.schema) {
            const stepName = (m.metadata as any)?.name as string | undefined;
            const stepFile = (m.metadata as { source?: string } | undefined)?.source;
            // Both drivers of the SAME check: a step's `inputs:` found through
            // the step grammar, and a reference slot's found through the
            // `x-telo-ref` `inputs:` pointer. A call site the editor can
            // complete is a call site `telo check` validates.
            const inputIssues = [
              ...collectRefInputIssues(
                m as Record<string, any>,
                defs.expandedFieldMapForResource(m, aliases, aliasesByModule),
                allManifests as Record<string, any>[],
                defs,
                aliases,
                { aliasesByModule, rootModules },
              ),
              ...collectStepInputIssues(
              m as Record<string, any>,
              e.definition.schema as Record<string, any>,
              allManifests as Record<string, any>[],
              defs,
              aliases,
              { aliasesByModule, rootModules },
              celStepContextSchema,
              ),
            ];
            for (const issue of inputIssues) {
              diagnostics.push({
                severity: DiagnosticSeverity.Error,
                code: issue.code ?? "CONTRACT_INPUTS_MISMATCH",
                source: SOURCE,
                message:
                  issue.code === "LIVE_VALUE_RETRIED"
                    ? `${m.kind}/${stepName}: at '${issue.path}', ${issue.message}`
                    : issue.code
                      ? `${m.kind}/${stepName}: inputs at '${issue.path}' flow into ${issue.targetLabel} with disagreeing type arguments: ${issue.message}`
                      : `${m.kind}/${stepName}: inputs at '${issue.path}' do not satisfy ${issue.targetLabel}'s declared inputType: ${issue.message}`,
                data: {
                  resource: { kind: m.kind, name: stepName ?? "" },
                  filePath: stepFile,
                  path: issue.path,
                },
              });
            }
          }
          celBindingSites = findBindingSites(e.definition?.schema as Record<string, any>);
          if (celBindingSites) {
            const declared = (m as Record<string, any>)[celBindingSites.field];
            const bindingsName = (m.metadata as any)?.name as string | undefined;
            const bindingsFile = (m.metadata as { source?: string } | undefined)?.source;
            const resourceRef = { kind: m.kind, name: bindingsName ?? "" };

            // Which field holds the bindings would otherwise be decided by
            // schema walk order, silently.
            if (celBindingSites.fields.length > 1) {
              diagnostics.push({
                severity: DiagnosticSeverity.Error,
                code: "BINDING_FIELD_AMBIGUOUS",
                source: SOURCE,
                message: `${m.kind}/${bindingsName}: the kind's schema points '${BINDINGS_ANNOTATION}' at more than one field (${celBindingSites.fields.join(", ")}). Every annotated context must name the same bindings field.`,
                data: { resource: resourceRef, filePath: bindingsFile, path: celBindingSites.field },
              });
            }

            if (declared !== null && typeof declared === "object" && !Array.isArray(declared)) {

              for (const cycle of resolveBindingOrder(declared).cycles) {
                diagnostics.push({
                  severity: DiagnosticSeverity.Error,
                  code: "BINDING_CYCLE",
                  source: SOURCE,
                  message: `${m.kind}/${bindingsName}: '${celBindingSites.field}' has a cycle — ${cycle.join(" → ")}. A binding is resolved from the ones it references, so it cannot reference itself, directly or through others.`,
                  data: {
                    resource: resourceRef,
                    filePath: bindingsFile,
                    path: `${celBindingSites.field}.${cycle[0]}`,
                  },
                });
              }

              // Every name the CEL environment already binds at this site: the
              // kernel globals (registered straight onto the environment, not
              // contributed by any annotation), the scope the annotated contexts
              // declare, and the two the analyzer merges per site. Shadowing one
              // would leave the binding silently unreachable there — as would
              // naming it after a CEL keyword, which never lexes as a reference.
              const inScope = new Set<string>([
                ...KERNEL_GLOBAL_NAMES,
                ...celBindingSites.scopeNames,
              ]);
              if (celStepContextSchema) inScope.add("steps");
              if (celErrorScopes.size > 0) inScope.add("error");
              const keywords = new Set<string>(CEL_RESERVED_WORDS);

              for (const name of Object.keys(declared)) {
                const shadows = inScope.has(name);
                if (shadows || keywords.has(name)) {
                  diagnostics.push({
                    severity: DiagnosticSeverity.Error,
                    code: "BINDING_NAME_RESERVED",
                    source: SOURCE,
                    message: shadows
                      ? `${m.kind}/${bindingsName}: binding '${name}' shadows a variable already in scope here (${[...inScope].sort().join(", ")}). Rename the binding — a scope variable always wins, so this one would never be read.`
                      : `${m.kind}/${bindingsName}: binding '${name}' is a CEL keyword, so no expression can read it as a reference. Rename the binding.`,
                    data: {
                      resource: resourceRef,
                      filePath: bindingsFile,
                      path: `${celBindingSites.field}.${name}`,
                    },
                  });
                  continue;
                }
                // A binding is read by bare name, so it lives in the same
                // identifier space as a resource or step name and breaks the
                // same way. The keyword tier is unreachable here — the check
                // above owns it, and can also say what is being shadowed.
                const violation = checkName(name, "value", "binding name");
                if (!violation) continue;
                diagnostics.push({
                  severity: violation.severity,
                  code: violation.code,
                  source: SOURCE,
                  message: `${m.kind}/${bindingsName}: ${violation.message}`,
                  data: {
                    resource: resourceRef,
                    filePath: bindingsFile,
                    path: `${celBindingSites.field}.${name}`,
                  },
                });
              }
            }
          }

          // The non-eval-field check only applies to runtime resource instances:
          // structural / templating kinds (capability `Telo.Template`, or no
          // definition) carry CEL the kernel evaluates by other rules.
          const capability = e.definition?.capability;
          celRuleApplies =
            !!e.definition?.schema && capability !== undefined && capability !== "Telo.Template";
          if (celRuleApplies) {
            const ownSchema = e.definition!.schema as Record<string, any>;
            const own = buildEvalPaths(ownSchema);
            const capabilityDef = capability ? defs.resolve(capability) : undefined;
            const parent = capabilityDef?.schema
              ? buildEvalPaths(capabilityDef.schema as Record<string, any>)
              : { compile: [], runtime: [] };
            celEvalPaths = [...own.compile, ...own.runtime, ...parent.compile, ...parent.runtime];
            // A `Telo.Provider`'s fields are implicitly compile-eval — the
            // capability abstract carries the root annotation — so its reads are
            // covered here without the provider restating anything.
            celCompilePaths = [...own.compile, ...parent.compile];
            celRegionScopes = extractCelRegionScopes(ownSchema);
          } else {
            celEvalPaths = [];
            celCompilePaths = [];
            celRegionScopes = [];
          }
        },
        onCel: (e) => {
          const m = e.source;
          const resource = { kind: m.kind, name: m.metadata?.name as string };
          const filePath = (m.metadata as { source?: string } | undefined)?.source;
          const { expr, path, engineName, matchedScope } = e;

          // A `!cel` (or `${{ }}`) in a field with no `x-telo-eval` / `x-telo-context`
          // is never evaluated — the runtime reads it as a literal (e.g. a
          // `concurrency` `!cel` that silently degraded to a sparse `[null, …]`).
          // Flag it rather than letting it pass as valid CEL. Inline resources
          // (resource-wide invocation context) carry CEL the kernel evaluates.
          if (
            celRuleApplies &&
            engineName === "cel" &&
            celScope.invocationContextSchema === undefined &&
            !evalPathsCover(celEvalPaths, path) &&
            !celRegionScopes.some((scope) => pathMatchesScope(path, scope)) &&
            !pathCrossesNestedResource(m, path)
          ) {
            diagnostics.push({
              severity: DiagnosticSeverity.Error,
              code: "CEL_IN_NON_EVAL_FIELD",
              source: SOURCE,
              message: `${m.kind}/${resource.name}: CEL at '${path}' is never evaluated — the field has no x-telo-eval / x-telo-context annotation, so its value is read as a literal. Annotate the field as a CEL slot or remove the !cel tag.`,
              data: { resource, filePath, path },
            });
            return;
          }

          // Observed state exists only while the application runs, so a path
          // through `.status` is illegal in a field that resolves at startup —
          // and a resource nothing can start reports nothing, ever. Both are
          // decided from the expression and the manifest alone.
          if (reportsObservedState && engineName === "cel" && expr.includes(OBSERVED_STATE_KEY)) {
            for (const chain of celAccessChains(this.celEnv, expr)) {
              const read = observedStateRead(chain);
              if (!read) continue;
              // An import's exported instance is indexed under `<Alias>.<name>`,
              // the two-level shape it publishes under, so a cross-module read
              // is checked exactly like a local one.
              const reported = observedState.get(
                read.alias ? `${read.alias}.${read.name}` : read.name,
              );

              if (celRuleApplies && evalPathsCover(celCompilePaths, path)) {
                diagnostics.push({
                  severity: DiagnosticSeverity.Error,
                  code: "OBSERVED_STATE_IN_STARTUP_FIELD",
                  source: SOURCE,
                  message: `${m.kind}/${resource.name}: '${path}' is resolved once at startup, so '${chain.join(".")}' does not exist yet — '${read.name}' reports it only while the application is running. Read reported values where the call happens: a step's inputs:, a request's url, a route handler, or a returns: expression.`,
                  data: { resource, filePath, path },
                });
                continue;
              }

              if (reported && !runReachable.has(read.name)) {
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

          const engine = defaultRegistry().get(engineName);
          if (!engine) {
            // No registered engine owns this tag — the expression would go
            // entirely unanalyzed. Surface it rather than skipping silently.
            diagnostics.push({
              severity: DiagnosticSeverity.Error,
              code: "UNKNOWN_ENGINE",
              source: SOURCE,
              message: `${m.kind}/${resource.name}: no templating engine registered for '!${engineName}' at '${path}'.`,
              data: { resource, filePath, path },
            });
            return;
          }
          // The engine type-checks, so it gets the environment typed for THIS
          // path — not the bare base one. Both halves come from the one scope
          // rule, which is what makes the IDE's answer and this check the same
          // answer rather than two that agree today.
          const { env: typedEnv, contextSchema: effectiveContext } = celScope.scopeFor({
            source: m,
            path,
            contextSchema: e.contextSchema,
            matchedScope,
          });

          const result = engine.analyze(expr, { celEnv: typedEnv, contextSchema: effectiveContext });

          if (result.type !== undefined) {
            let byPath = celTypeByPath.get(m);
            if (!byPath) celTypeByPath.set(m, (byPath = new Map()));
            byPath.set(path, result.type);
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
          const chain = effectiveContext ? plainChainOf(`\${{${expr}}}`) : undefined;
          if (chain) {
            const produced = navigateSchemaToExprPath(effectiveContext!, chain);
            if (produced) {
              let byPath = celSourceSchemaByPath.get(m);
              if (!byPath) celSourceSchemaByPath.set(m, (byPath = new Map()));
              byPath.set(path, produced);
            }
          }

          // A non-deterministic call in a compile-eval field is baked once at
          // load: `nowIso()` there freezes at boot. Sometimes that is the
          // intent (a boot timestamp, a run id), so it warns rather than
          // blocking. The engine reports which calls re-evaluate; the eval mode
          // is manifest policy and stays here.
          if (celRuleApplies && evalPathsCover(celCompilePaths, path)) {
            const volatile = [
              ...new Set(result.calls.filter((c) => c.deterministic === false).map((c) => c.name)),
            ].sort();
            if (volatile.length > 0) {
              diagnostics.push({
                severity: DiagnosticSeverity.Warning,
                code: "CEL_NONDETERMINISTIC_IN_COMPILE_FIELD",
                source: SOURCE,
                message: `${m.kind}/${resource.name}: '${path}' is evaluated once at startup, so ${volatile.map((n) => `\`${n}()\``).join(", ")} ${volatile.length === 1 ? "is" : "are"} baked in at load and never re-evaluated. Move the expression to a field evaluated per call (x-telo-eval: runtime) if it should change over time.`,
                data: { resource, filePath, path },
              });
            }
          }

          for (const f of result.diagnostics) {
            // A repair is applicable only when the analyzed expression covers
            // the whole scalar. For one `${{ }}` among literal text, replacing
            // the node would drop the text around it, so the correction stays
            // in the message and no fix is stamped.
            const fix = e.surface.whole ? rewrapFix(f.fix, e.surface.wrapper) : undefined;
            const data = { resource, filePath, path, ...(fix ? { fix } : {}) };
            if (f.code === "CEL_SYNTAX_ERROR") {
              diagnostics.push({
                severity: DiagnosticSeverity.Error,
                code: "CEL_SYNTAX_ERROR",
                source: SOURCE,
                message: `CEL syntax error at ${path}: ${f.message}`,
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
                message: `${m.kind}/${resource.name}: !${engineName} at '${path}': ${f.message}`,
                data,
              });
            } else {
              // Named by ENGINE, not hardcoded to CEL: the seam exists so a
              // second engine can produce coded findings, and labelling them
              // `CEL` would misattribute the first one that does.
              diagnostics.push({
                severity: DiagnosticSeverity.Error,
                code: f.code,
                source: SOURCE,
                message: `${m.kind}/${resource.name}: !${engineName} at '${path}': ${f.message}`,
                data,
              });
            }
          }
        },
      },
      { aliases },
    );

    // The two halves of "does this expression fit the slot it flows into" meet
    // here: the engine resolved the expression's type during the walk above,
    // and the schema walk recorded the slot. An expression that failed to check
    // recorded no type and is already reported by its own diagnostic.
    for (const slot of celReturnSlots) {
      const type = celTypeByPath.get(slot.manifest)?.get(slot.path);
      if (type === undefined) continue;
      if (!celTypeSatisfiesJsonSchema(type.split("<")[0]!, slot.schema)) {
        const expected = slot.schema["x-telo-type"] ?? slot.schema.type ?? "unknown";
        diagnostics.push({
          severity: DiagnosticSeverity.Error,
          code: "CEL_TYPE_ERROR",
          source: SOURCE,
          message: `${slot.resource.kind}/${slot.resource.name}: CEL at '${slot.path}' returns '${type}' but the field expects '${expected}'.`,
          data: { resource: slot.resource, filePath: slot.filePath, path: slot.path },
        });
        continue;
      }
      // The type fits; do its ARGUMENTS agree? Covariant and gradual — an
      // omitted argument is *any* in both directions, so an unmigrated producer
      // or consumer is never reported, and only a definite conflict is.
      const produced = celSourceSchemaByPath.get(slot.manifest)?.get(slot.path);
      if (!produced) continue;
      const { compatible, issues } = checkSchemaCompatibility(
        produced,
        slot.schema,
        (ref: string) => defs.schemaForId(ref),
      );
      if (compatible) continue;
      diagnostics.push({
        severity: DiagnosticSeverity.Error,
        code: "CEL_TYPE_ARGUMENT_MISMATCH",
        source: SOURCE,
        message:
          `${slot.resource.kind}/${slot.resource.name}: CEL at '${slot.path}' produces a value ` +
          `whose type arguments disagree with the field's: ${issues.join("; ")}.`,
        data: { resource: slot.resource, filePath: slot.filePath, path: slot.path },
      });
    }

    // Validate resource references (Phase 3)
    diagnostics.push(
      ...validateReferences(allManifests, { aliases, definitions: defs, aliasesByModule }),
    );

    // Validate step `invoke` references — the slots the reference field map
    // deliberately skips (behind the step `$ref`), so a missing instance or a
    // kind-instead-of-instance ref there is caught statically, not at runtime.
    diagnostics.push(...validateStepInvokeReferences(allManifests, defs, aliases));

    // `required:` inside a `status:` block — reported here rather than by the
    // AJV shape, which could only say "must NOT be valid" without naming the
    // rule or the fix.
    for (const issue of validateObservedStateDeclarations(allManifests)) {
      diagnostics.push({
        severity: DiagnosticSeverity.Error,
        code: "OBSERVED_STATE_REQUIRED_FORBIDDEN",
        source: SOURCE,
        message: issue.message,
        data: {
          resource: { kind: issue.kind, name: issue.name },
          filePath: issue.filePath,
          path: "status.required",
        },
      });
    }

    // Validate `extends` fields and flag legacy `capability: <UserAbstract>` overload.
    diagnostics.push(...validateExtends(allManifests, defs, aliases));

    diagnostics.push(...validateBaseMapping(allManifests, defs, aliases));
    diagnostics.push(
      ...validateInvocationContract(allManifests, defs, aliases, aliasesByModule),
    );

    // Validate provider coherence rules for `provide:` template-target definitions.
    diagnostics.push(...validateProviderCoherence(allManifests, defs, aliases));

    // Validate throws: declarations and catches: coverage (rules 1, 2, 4, 7)
    diagnostics.push(
      ...validateThrowsCoverage(allManifests, defs, aliases, this.celEnv, aliasesByModule, rootModules),
    );

    // Warn about declared variables / secrets / ports that no CEL references.
    diagnostics.push(...validateUnusedDeclarations(allManifests, this.celEnv));

    // Reroute diagnostics on synthetic (inline-extracted) resources back to
    // the chain root so position-index lookups land on the parent doc.
    return rewriteSyntheticOrigins(
      suppressUnreadableModuleDiagnostics(diagnostics, unreadableFiles),
      allManifests,
    );
  }

  analyzeErrors(
    manifests: ResourceManifest[],
    options?: AnalysisOptions,
    registry?: AnalysisRegistry,
    zoneExportCache?: ZoneExportCache,
  ): AnalysisDiagnostic[] {
    return this.analyze(manifests, options, registry, zoneExportCache).filter(
      (d) => d.severity === DiagnosticSeverity.Error,
    );
  }

  normalize(
    manifests: ResourceManifest[],
    registry: AnalysisRegistry,
    // Forwarded foreign exports used only as cross-module resolution targets (see
    // resolveRefSentinels). The kernel passes its analyzer-flattened set so the
    // entry-only runtime pass can still resolve `!ref Alias.name`.
    crossModuleTargets?: ResourceManifest[],
  ): ResourceManifest[] {
    const ctx = registry._context();
    const normalized = normalizeInlineResources(
      manifests,
      ctx.definitions!,
      ctx.aliases,
      ctx.aliasesByModule,
    );
    // Resolve !ref sentinels after normalize so both the original and
    // inline-extracted manifests get their refs canonicalized to
    // {kind, name} for the kernel that consumes this output.
    resolveRefSentinels(
      normalized,
      ctx.aliases,
      ctx.aliasesByModule,
      crossModuleTargets ?? [],
      ctx.definitions!,
    );
    // Canonicalize import-scoped schema `$ref`s (`telo://Self|Alias/Type`) so the
    // kernel that executes this output compiles inputs/outputs against the same
    // ids the type controllers register their schemas under.
    resolveSchemaTypeRefs(normalized, ctx.aliases, ctx.aliasesByModule);
    return normalized;
  }

  prepare(
    manifests: ResourceManifest[],
    registry: AnalysisRegistry,
  ): { diagnostics: AnalysisDiagnostic[]; order: string[] | null; cycleError: string | null } {
    const ctx = registry._context();
    const diagnostics = validateReferences(manifests, ctx);
    const errors = diagnostics.filter((d) => d.severity === DiagnosticSeverity.Error);
    if (errors.length > 0) {
      return { diagnostics: errors, order: null, cycleError: null };
    }
    const graph = buildDependencyGraph(
      manifests,
      ctx.definitions!,
      ctx.aliases,
      ctx.aliasesByModule,
    );
    if (graph.cycle) {
      return { diagnostics: [], order: null, cycleError: formatCycle(graph.cycle) };
    }
    return {
      diagnostics: [],
      order: graph.order ? graph.order.map((n) => n.name) : null,
      cycleError: null,
    };
  }
}
