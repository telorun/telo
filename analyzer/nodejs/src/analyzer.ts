import type { ResourceDefinition, ResourceManifest } from "@telorun/sdk";
import {
  canonicalTypeSchemaId,
  isCompiledValue,
  parseCanonicalTypeSchemaId,
  parseTeloTypeRef,
  readValueTypeSlot,
  VALUE_TYPES,
  X_TELO_TYPE,
} from "@telorun/sdk";
import type { CelEnvironment } from "@telorun/cel";
import { memberSlotSchemas, membersSlotOf } from "./members-value-slot.js";
import { valueTypeRefusalCode } from "./schema-error-report.js";
import { childNodes, type CelNode } from "@telorun/cel";
import {
  CEL_ENGINE,
  celExpressionsOf,
  extractAccessChains,
  INDEX_SEGMENT,
  moduleCallOf,
  expansionTagLabel,
  isExpansionSentinel,
  isRefSentinel,
  REF_ENGINE,
  isTaggedSentinel,
  plainChainOf,
  type ExpansionSentinel,
} from "@telorun/templating";
import type { DiagnosticData, DiagnosticFix } from "./types.js";
import {
  AliasResolver,
  moduleScopedDefResolver,
  type ModuleScopes,
  scopeResolverForModule,
} from "./alias-resolver.js";
import { AnalysisRegistry } from "./analysis-registry.js";
import { BUILTIN_VOCABULARY_KIND, BUILTIN_VOCABULARY_NOT_A_MODULE } from "./builtin-vocabulary.js";
import {
  buildCelEnvironment,
  buildImportInputCelEnvironment,
  buildTypedCelEnvironment,
  parseCelSource,
  type CelHandlers,
} from "./cel-environment.js";
import { DefinitionRegistry } from "./definition-registry.js";
import { readDeprecation } from "./deprecation.js";
import {
  type ContractDirection,
  type DefResolver,
  ancestorChain,
  effectiveAuthorSchema,
  effectiveContractField,
  inheritedCapability,
  inheritedRequiredFields,
} from "./extends-resolution.js";
import {
  analyzerContractScope,
  contractReads,
  derivesFromDeclaration,
  type ContractScope,
  type NamedShapeScope,
  projectionModules,
  resolveContract,
  resolveNamedShape,
  valueSchemaHostOf,
} from "./invocation-contract.js";
import { buildCallGraph, referrerSlotsOf } from "./call-graph.js";
import { contextFillCycles } from "./context-fill-cycle.js";
import { libraryDeclarations, type LibraryDeclarations } from "./library-declarations.js";
import { buildDependencyGraph, formatCycle, scopedCycles } from "./dependency-graph.js";
import {
  buildKernelGlobalsIndex,
  KERNEL_GLOBAL_NAMES,
  mergeKernelGlobalsIntoContext,
  ModuleGlobalsOverlays,
} from "./kernel-globals.js";
import {
  analyzedKind,
  buildObservedStateResourcesSchema,
  collectRunReachableNames,
  observedDeclarations,
  celScopeHolderOf,
  scopedResourcesOf,
  observedStateNames,
  observedStateRequiredDiagnostics,
} from "./validate-observed-state.js";
import { bodyResourcesFor } from "./template-body-resources.js";
import { computeSuggestKind } from "./kind-suggest.js";
import {
  isInstantiableDefinition,
  userFacingImplementationsOf,
} from "./instantiable-kind.js";
import { visitManifest, type ManifestVisitor } from "./manifest-visitor.js";
import { declaringModuleScope, definitionInScope, moduleAliasScope } from "./module-alias-scope.js";
import { isModuleKind } from "./module-kinds.js";
import {
  declaringModuleKey,
  moduleCallNamesByModule,
  moduleCallNamesOf,
  ROOT_MODULE_KEY,
} from "./module-call-names.js";
import { ModuleFunctionIndex } from "./module-function-index.js";
import { CallableFlagsIndex } from "./callable-flags.js";
import { FunctionBodyEvaluators } from "./function-body-evaluator.js";
import { unboundSourceDiagnostics } from "./validate-module-calls.js";
import { unboundCallReason, unboundCallSources } from "./unbound-call-site.js";
import { normalizeInlineResources } from "./normalize-inline-resources.js";
import { isKindDocumentOrImport } from "./system-kinds.js";
import { resolveRefSentinels, resolveShapeRefs } from "./resolve-ref-sentinels.js";
import { resolveSchemaRefKinds, type RefConstraintIssue } from "./resolve-schema-ref-kinds.js";
import { runZoneAnalysis, type ZoneExportCache } from "./resolve-zone-requirements.js";
import { validateDurableRegions } from "./validate-durable-regions.js";
import { validateZoneViolations } from "./validate-zone-violations.js";
import { ManifestRootSchema, manifestFragmentRef } from "./manifest-schemas.js";
import { gatherPropertySchemas, resolveLocalRef, walkStepArray } from "./schema-walk.js";
import {
  buildStepContextSchema,
  CelScopeResolver,
  collectErrorContextScopes,
  manifestRootForResolver,
} from "./cel-scope.js";
import { capabilityExtendsExecutable } from "./executable-capability.js";
import { capabilityProblem, type CapabilityProblem } from "./capability-roster.js";

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
  resourceRuleCallIssues,
  reportResourceRules,
  reportUnexercisedRule,
  ruleExercised,
  rulePointerReaches,
  validateResourceRuleDeclarations,
  type ResourceRuleDiagnostic,
  type ResourceRuleIssue,
} from "./validate-resource-rules.js";
import { pointerToPath, readResourceRules, resourceRuleReads, type ResourceRule } from "./resource-rule.js";
import { readReferrerRules, type ReferrerRule } from "./referrer-rule.js";
import {
  evaluateReferrerRules,
  referrerRuleCallIssues,
  referrerRuleExercised,
  reportReferrerRules,
  reportUnexercisedReferrerRule,
  validateReferrerRuleDeclarations,
  type Referrer,
  type ReferrerRuleContext,
  type ReferrerRuleDiagnostic,
  type ReferrerRuleIssue,
} from "./validate-referrer-rules.js";
import {
  analyzerPeerBinder,
  analyzerPeersTarget,
  analyzerKindSchemas,
  analyzerReferrerDeclares,
  navigatePath,
} from "./peer-binding.js";
import { RuleFailureLedger } from "./rule-condition.js";
import {
  describeProjectionFailure,
  isReportedAtConsumer,
  projectionScopeOf,
  resolveSchemaProjections,
  type ProjectionFailure,
  type ProjectionScope,
} from "./schema-projection.js";
import {
  validateDynamicSelectors,
  validateRefSlotDeclarations,
  type RefSlotIssue,
} from "./validate-ref-slots.js";
import { scopeSlotProblems } from "./validate-scope-slots.js";
import { topologyRoleProblems } from "./validate-topology-roles.js";
import { caughtMemberProblems } from "./validate-caught-members.js";
import { CatchLadder } from "./catch-scope.js";
import {
  validateValueTypeSlots,
  type ValueTypeSlotIssue,
} from "./validate-value-type-slots.js";
import {
  validateSensitiveSlots,
} from "./validate-sensitive-slots.js";
import { validateSinkAttachment } from "./validate-sink-attachment.js";
import {
  duplicateNameFindings,
  observedStateDeclarationFindings,
  sinkAttachmentFindings,
  unusedDeclarationFindings,
  type PassFindings,
  type PassFindingsAt,
  type UnionPassName,
} from "./union-passes.js";
import {
  validateSpanAttributes,
} from "./validate-span-attributes.js";
import {
  producedValueMisfits,
} from "./cel-produced-value.js";
import {
  canonicalShapeSchema,
  resolveSchemaTypeRefs,
  withCanonicalRefSentinels,
} from "./resolve-schema-type-refs.js";
import { configuredNamedShapes, libraryNamedShapes } from "./configured-named-shapes.js";
import { foldedNamedShapeReads, foldedNamedShapes, type NamedShapeDeclaration } from "./named-shape-extends.js";
import { validateSchemaTypeRefs } from "./validate-schema-type-refs.js";
import { rewriteSyntheticOrigins } from "./rewrite-synthetic-origins.js";
import {
  collectScopeMembers,
  isScopeMemberDeclaration,
  outOfReachNames,
  ScopeMembers,
  walkOwnCelExpressions,
} from "./scope-members.js";
import {
  celTypeSatisfiesJsonSchema,
  checkSchemaCompatibility,
  unionBranches,
  navigateSchemaToExprPath,
  resolveRefIn,
  fittingUnionBranches,
  selectUnionBranch,
  substituteCelFields,
  validateAgainstSchema,
  VALUE_BRAND_BASE,
  type ExternalSchemaResolver,
  type SchemaIssue,
} from "./schema-compat.js";
import { shapeNamedBy } from "./referenced-shape.js";
import { declaredResultSchemaAt, RETURNS_FROM_ANNOTATION } from "./callable-signature.js";
import { collectValueSchemaIssues, type ShapeAwareValidator } from "./validate-value-schema.js";
import { valueSchemaFromProblems } from "./validate-value-schema-location.js";
import { annotationDeclarationProblems, matchPlaces, unsatisfiedMatch } from "./validate-match-for.js";
import { substituteDecodedCelFields } from "./plain-literal-decoding.js";
import type { StandIns } from "./stand-in-findings.js";
import { producerAdmitsNull, slotAdmitsNull } from "./schema-nullability.js";
import {
  callSiteAt,
  slotInputsPath,
  stepCallSiteOf,
  stepItemsOf,
  templateCallSite,
  valueSchemaSites,
  type DerivedSlotContext,
  type StepItem,
} from "./derived-slots.js";
import {
  DiagnosticSeverity,
  DiagnosticTag,
  type AnalysisDiagnostic,
  type AnalysisOptions,
} from "./types.js";
import {
  getManifestItem,
  resolveContextAnnotations,
  resolveTypeFieldToSchema,
} from "./validate-cel-context.js";
import {
  accessorFieldAt,
  accessorSiteAt,
  celEvalModeAt,
  governedCelEvalSites,
  kindCelEvalSites,
  NO_CEL_EVAL_SITES,
  type CelEvalSites,
  type NamedShapeLookup,
} from "./eval-paths.js";
import { accessorFields, accessorProblems } from "./accessor-binding.js";
import { computedRefSlots, evaluatedField, refSlotComputedReason } from "./ref-slot-computed.js";
import { RuleDeclarationViews, type ForwardedReference } from "./rule-declaration-view.js";
import type { ModuleCallDispatch } from "@telorun/templating";
import { LazyDispatch, ResourceRuleReports, resourceRuleFindings } from "./resource-rule-relation.js";
import {
  browserExportAnnotationProblems,
  browserExportProblems,
  browserExportSites,
  schemaDeclaresBrowserExport,
} from "./browser-export-slot.js";
import { readBrowserEntries, type BrowserEntry } from "./module-browser.js";
import {
  BINDINGS_ANNOTATION,
  bindingContextProperties,
  bindingPathChain,
  findBindingSites,
  resolveBindingOrder,
  schemaAtChain,
} from "./cel-bindings.js";
import { CEL_RESERVED_WORDS, checkName } from "./identifier-name.js";
import { declarationNameFindings, validateIdentifierNames, writesJudgedNames } from "./validate-identifier-names.js";
import { validateRethrowPlacement } from "./validate-rethrow-placement.js";
import { validateExtends } from "./validate-extends.js";
import { validateLogging } from "./validate-logging.js";
import { validateModuleArtifact } from "./validate-module-artifact.js";
import { validateNativeEntries } from "./validate-native-entries.js";
import { validateSourceEntries } from "./validate-source-entries.js";
import { validateIncludePlacement } from "./validate-include-placement.js";
import { validateApplicationArguments } from "./validate-application-arguments.js";
import { validateHostPathDefaults } from "./validate-host-path-defaults.js";
import { isNullPortDefaultFinding, validateInputDefaults } from "./validate-input-defaults.js";
import { validateUntaggedInterpolation } from "./untagged-interpolation.js";
import {
  alsoAccepts,
  describeHostEntry,
  hostEntryAt,
  HOST_PATH_SOURCES,
  holdsHostPath,
  holdsOnlyConstants,
  hostPathBranchesFor,
  leadingRelativeLiteral,
} from "./host-path-slot.js";
import { validateImportHostPaths } from "./validate-import-host-paths.js";
import { moduleFileEntryMismatches } from "./validate-host-path-entries.js";
import { validateImportInputs } from "./validate-import-inputs.js";
import {
  applicationInputsSlotSchema,
  validateApplicationInputs,
} from "./validate-application-inputs.js";
import { applicationSourceAnnotationProblems, readApplicationSourceSlot } from "./application-source-slot.js";
import { importInputsJoinSchema } from "./import-inputs.js";
import { validateModuleMetadata } from "./validate-module-metadata.js";
import { validateRequires } from "./validate-requires.js";
import { validateBaseMapping } from "./validate-base-mapping.js";
import { validateInvocationContract } from "./validate-invocation-contract.js";
import {
  callSiteContext,
  checkCallSite,
  retryFieldsOf,
  type CallScopes,
  type CallSiteArguments,
  type StepInputIssue,
} from "./validate-step-inputs.js";
import { referenceOutputIssuesAt } from "./validate-reference-output.js";
import { nestedInlineAnchors, validateNestedInline } from "./validate-nested-inline.js";
import { validateProviderCoherence } from "./validate-provider-coherence.js";
import { kindSatisfies, validateReferences } from "./validate-references.js";
import type { ReachSite } from "./reference-reach.js";
import {
  markerFormRefusals,
  validateReferenceForms,
  withoutRefusedFormConsequences,
} from "./validate-reference-forms.js";
import { isResolvedReference, resolvedReference } from "./resolved-reference.js";
import { isInjectedDeclaration, readSuppliedResources } from "./resource-input.js";
import type { ModuleDocuments } from "./module-documents.js";
import { optionalInputReferenceMessage, optionalInputReferences } from "./optional-input-references.js";
import { isKindDocument, kindDeclarationOf } from "./kind-declaration.js";
import { needTableReportsFinding, needTypeOf } from "./need-type.js";
import { importNeedsSlotSchema, needTableDiagnostics, registeredNeedTable } from "./validate-needs.js";
import { observesProblems } from "./observing-slot.js";
import { validateResourceInputs } from "./validate-resource-inputs.js";
import { validateExports } from "./validate-exports.js";
import { validateTemplateBody } from "./validate-template-body.js";
import { dispatchTargetOf, templateBodies } from "./template-body.js";
import {
  declaredScopes,
  outOfReachSentence,
  scopeMembers,
  type DeclaredScope,
} from "./scope-declarations.js";
import type { ScopeAddress, ScopeSite } from "./scope-address.js";
import {
  MANIFEST_READING,
  addressOf,
  importPathOf,
  importPathThrough,
  ofInstance,
  scopeSiteAt,
  scopeSiteAtPath,
  ScopedNameResolver,
} from "./scoped-name-resolver.js";
import {
  buildForwardViews,
  buildTemplateForwardViews,
  formatPath,
  nestedCandidatesOf,
  nestedConsumerManifest,
  nestedDeclarationsOf,
  type NestedCandidate,
  placedViews,
  withoutForwardedDuplicates,
  type BuiltView,
} from "./template-forward.js";
import { refSentinelTarget } from "./ref-sentinel-target.js";
import { declareInScope, declaringScopeOf } from "./scope-members.js";
import { validateTemplateForwards } from "./validate-template-forward.js";
import { validateUnusedDeclarations } from "./validate-unused-declarations.js";
import { validateModuleCallNames } from "./validate-module-call-names.js";
import { validateCallableDeclarations } from "./validate-callable-kinds.js";
import { validateCallableData } from "./validate-callable-data.js";
import { validateScopedNameReach } from "./validate-scope-reach.js";
import { validateLibraryBrowserExports } from "./validate-library-browser-exports.js";
import { validateScopedKindDocuments } from "./validate-scoped-kind-documents.js";
import { importAnchoredDiagnostic, importReach } from "./reaching-import.js";
import { textSlotAccessorProblems } from "./text-slot-accessor.js";
import { textValuesProblems } from "./text-values.js";
import { celTypeValueKind, schemaValueKind } from "./text-judgement.js";
import { isForwardedDeclaration, isForwardedExport } from "./forwarded-declaration.js";
import { validateThrowsCoverage } from "./validate-throws-coverage.js";
import { readStepSlot } from "./step-slot.js";
import { carvedResult } from "./step-result-inference.js";
import { readExpansionSites, withoutRefusedExpansionConsequences, type ExpansionReading } from "./expansion-sites.js";
import { expandChoices, isStandInDeclaration, relocatePath, type ChoiceExpansion } from "./choice-expansion.js";
import { withNarrowedLiterals } from "./narrowed-literals.js";
import {
  pathOf as choicePathOf,
  readChoices,
  type ChoiceReading,
  type ConfigurationDiagnostic,
  type Decisions,
  type UnreachableBranch,
} from "./choice-reading.js";
import {
  EVERYWHERE,
  expandUnion,
  isAlternatives,
  relocatorOf,
  takenAt,
  type ChoiceStep,
  type ConditionedView,
  type ViewCrossing,
  type Holding,
  type ConditionedDeclaration,
  type ConditionedExpansion,
  type Forcing,
  type Projected,
  type Witness,
  viewChainOf,
} from "./conditioned-expansion.js";
import {
  answersName,
  doorCare,
  doorRequests,
  doorResolution,
  DoorRefusal,
  holdsChoice,
  holdsContentOf,
  invariantDeclarations,
  narrowingAt,
  narrowingOfReads,
  standInsAt,
  valueInAt,
  type DoorCare,
  type DoorLayers,
  type DoorScope,
} from "./key-door.js";
import {
  analysisOrder,
  countNodes,
  KeyParts,
  partManifests,
  rankForwardViews,
  templateKeyOf,
  templateVariantsOf,
  type RegionPart,
  type SharedLayer,
  type TemplateVariantOf,
} from "./key-parts.js";
import { TypedEnvironments } from "./typed-environments.js";
import { ConditionedNameIndex } from "./conditioned-name-index.js";
import { declarationOf, listResolution, namesResolution } from "./reference-resolution.js";
import { listRequests, type DeclarationRequests } from "./declaration-requests.js";
import {
  declaredDefinitionOf,
  importersByModuleOf,
  type DeclaredDefinition,
  type DeclaredDefinitionScope,
  type ImportersByModule,
} from "./declared-definition.js";
import { resolveScopeValues, valueSchemaSlots, type ValueSchemaHost } from "./value-schema-slot.js";
import { fieldPlace, pointerReads, READS_IDENTITY, type ReadPlace, type ReferentPlace, type ReferentReads } from "./read-place.js";
import { valueDerivedSlot } from "./value-derived-contract.js";
import type { ProducedValue } from "./cel-produced-value.js";
import { ConditionSpace, FALSE, TRUE, type Condition } from "./presence-condition.js";
import { choiceScopeOf } from "./choice-scope.js";
import {
  holdsTemplateConstructs,
  labelDefinitionFindings,
  representativeSpliceIssues,
  REPRESENTATIVE_KEY,
  readTemplateDefinitions,
  type DefinitionFinding,
  type DefinitionVariant,
  type TemplateDefinitions,
} from "./template-definition-check.js";
import { emittedInlineName, parseKeys, pathText, TEMPLATE_BODY_FIELDS } from "./template-expansion.js";
import { readTemplateConsumers } from "./template-consumers.js";
import {
  ABSENT,
  assignmentKey,
  PRESENT,
  restrictConfigurations,
  type Assignment,
  type Dimension,
} from "./configuration-dimensions.js";
import {
  mergeConditionedDiagnostics,
  mergeConfigurationDiagnostics,
  type ConditionedFinding,
} from "./configuration-merge.js";
import type { InputNarrowing } from "./kernel-globals.js";
import { CelJudge, emptyCelFactMaps, replayCelFacts, type CelFactMaps, type CelSiteFacts } from "./cel-judge.js";
import {
  celSiteId,
  isBodySiteId,
  solveCelSites,
  type CelOccurrenceFacts,
  type CelSiteVerdict,
  type CensusEntry,
  type KeyCoverage,
  type KeyRequest,
  type OwnKeyRequest,
  type OwnVerdict,
  type CelSiteSolution,
  type RelationKeyRequest,
  type RelationMarker,
  type RelationFound,
  viewSiteNameOf,
  viewAnchorText,
  relationSitePath,
  type RelationSite,
  type WholeNameReader,
} from "./cel-site-solve.js";
import { nestedPlacesOf, ownSiteHolding, type OwnSite } from "./own-check-sites.js";
import { quotingIssue, relocatedRendering, rerootedQuotes, withQuotedPath, type QuotedPlace, type WrittenPlace } from "./quoted-place.js";
import {
  everyOptionOf,
  manifestHolding,
  shallowMember,
  placeByUnionKeys,
  placeByProjectedKeys,
  positionsOf,
  regionParity,
  regionSkeleton,
  valueAtKeys,
} from "./region-part.js";
import {
  isAtOrAbove,
  relationSiteId,
  type DeclarationIdentity,
  type OwnGroup,
  type DependentRead,
  type DependentReads,
  type EnclosingMembers,
  type RelationDoor,
  type RelationFacts,
  type RelationFinding,
  type RelationInstance,
  type RelationalGroup,
  type SchemaGroup,
  type RelationReader,
  type RelationReaderScope,
  type RelationReaderTable,
  type RelationRegion,
  type RelationRuleInput,
  type RelationTarget,
} from "./relation-sites.js";
import {
  observingKeyCosts,
  observingRelationParity,
  reportAnalysisRun,
  reportKeyCost,
  reportIdentifierPass,
  reportConditionedPass,
  reportRuleEvaluation,
  reportRelationParity,
  type AnalysisRunPurpose,
} from "./cel-site-judgements.js";

/** The sentinels the expansion reader refuses as written. */
function refusedSentinels(expansion: ExpansionReading | undefined): ReadonlySet<unknown> {
  return new Set((expansion?.sites ?? []).filter((site) => site.refusal).map((site) => site.value));
}

/**
 * The named shapes the union declares, by canonical id, and those no
 * configuration varies: every declaration of the id invariant — declared in
 * every configuration, no choice inside — and so every parent its fold reads.
 */
function namedShapesOf(
  union: ConditionedExpansion,
  isNamedShape: (m: ResourceManifest) => boolean,
): { all: ReadonlySet<string>; invariant: ReadonlySet<string> } {
  const invariant = invariantDeclarations(union);
  const declarations: NamedShapeDeclaration[] = [];
  const varying = new Set<string>();
  const all = new Set<string>();
  for (const declaration of union.declarations) {
    const m = declaration.manifest;
    const module = (m.metadata as { module?: unknown } | undefined)?.module;
    const name = m.metadata?.name;
    if (typeof module !== "string" || typeof name !== "string" || !isNamedShape(m)) continue;
    const id = canonicalTypeSchemaId(module, name);
    all.add(id);
    declarations.push({ module, name, schema: {}, extends: (m as { extends?: unknown }).extends });
    if (!invariant.has(declaration)) varying.add(id);
  }
  const reads = foldedNamedShapeReads(declarations);
  const shared = new Set<string>();
  for (const { module, name } of declarations) {
    const id = canonicalTypeSchemaId(module, name);
    if (![...reads(module, name)].some((read) => varying.has(read))) shared.add(id);
  }
  return { all, invariant: shared };
}

/** `body` run with a named-shape layer open on `defs` (`shared` deciding which
 *  shapes the shared registry takes), and what the layer registered. */
function withShapeLayer<T>(
  defs: DefinitionRegistry,
  shared: (id: string) => boolean,
  body: () => T,
): { result: T; registered: ReadonlyMap<string, Record<string, any>> } {
  defs.openShapeLayer(shared);
  let registered: ReadonlyMap<string, Record<string, any>> | undefined;
  try {
    const result = body();
    registered = defs.closeShapeLayer();
    return { result, registered };
  } finally {
    if (registered === undefined) defs.closeShapeLayer();
  }
}

/** What one configuration decides: the branch each choice takes, and each
 *  input value typed as the literal it holds. */
interface AnalysisConfiguration {
  readonly decisions: Decisions;
  readonly narrowing: InputNarrowing;
  /** The template definitions' variant this run checks each body in. */
  readonly template?: { readonly definitions: TemplateDefinitions; readonly index: number };
  /** Set where each declaration's own checks are judged once per key outside
   *  the run: it marks where their findings go (`OWN_SITE_MARKER`). */
  readonly own?: true;
  /** What the passes that carry presence conditions found in this
   *  configuration, read back from the table each built once over the union. */
  readonly passes?: PassFindingsAt;
  /** The value an expression has in this configuration, when it decides it —
   *  what a consumer's value feeding a template's choice is read as. */
  readonly decidedValue?: (holder: ResourceManifest, source: string) => { value: unknown } | undefined;
  /** How CEL sites are judged in this run: none is — each site's place among
   *  the run's findings is marked, and the verdict of the site's key in this
   *  configuration is read back for the checks over the whole application. */
  readonly cel?: { readonly mode: "configuration"; readonly verdictOf: (site: string) => CelSiteVerdict | undefined };
  /** What the run is for: the registration every configuration reads, one
   *  configuration, or a branch no configuration takes. */
  readonly run: Exclude<AnalysisRunPurpose, "whole" | "door">;
}

/** What marks a CEL site's place among a configuration run's findings: the
 *  site's verdict is taken there, once, outside the run. */
export const CEL_SITE_MARKER = "CEL_SITE_MARKER";

/** Whether a forward view's place, at union keys, holds a value its upstream
 *  evaluated before forwarding it: no expression of the view there. */
type ViewEvaluation = (view: ConditionedView, unionKeys: readonly (string | number)[]) => boolean;

/** What every key's environment reads, built once per analysis: the
 *  registries the registration run filled, the union, name resolution over it,
 *  and what no configuration varies. */
interface KeySetup {
  readonly manifests: ResourceManifest[];
  readonly options: AnalysisOptions | undefined;
  readonly defs: DefinitionRegistry;
  readonly aliases: AliasResolver;
  readonly aliasesByModule: Map<string, AliasResolver>;
  readonly rootModules: ReadonlySet<string>;
  readonly libraries: ReturnType<typeof libraryDeclarations>;
  readonly moduleCallNames: ReadonlyMap<string, ReadonlySet<string>>;
  readonly templates: TemplateDefinitions | undefined;
  readonly expansion: ExpansionReading | undefined;
  /** Whether a written document holds a template construct. */
  readonly templated: boolean;
  readonly union: ConditionedExpansion;
  /** The union's forward views. */
  readonly views: ReadonlySet<ConditionedDeclaration>;
  readonly names: ConditionedNameIndex;
  /** What a key judged at a witness holds fixed: over the configurations kept
   *  where no branch is forced, over the whole space where one is. */
  readonly careAt: (witness: Witness) => DoorCare;
  /** Whether a module document varies outside its `targets:`. */
  readonly moduleDocumentsVary: boolean;
  readonly choices: ChoiceReading;
  /** Whether the shared registry holds the named shape at an id: one no
   *  configuration varies. */
  readonly sharedShape: (id: string) => boolean;
  /** A named shape some configuration varies, as a witness holds it. */
  readonly shapeAt: (id: string, witness: Witness) => Record<string, any> | undefined;
  /** A named shape some configuration varies, every option kept: what a
   *  relation reader finding sites walks. */
  readonly censusShape: (id: string) => Record<string, any> | undefined;
  /** Each declaration normalized once per distinct content and outcomes. */
  readonly parts: KeyParts;
  /** The union's declarations by name, in union order. */
  readonly byName: ReadonlyMap<string, readonly ConditionedDeclaration[]>;
  readonly moduleDocuments: readonly ConditionedDeclaration[];
  /** Each module document's shared globals base: the document but its
   *  `targets:` — which hold every choice a module document may — normalized
   *  once and read by every key as one identity. */
  readonly moduleBases: (witness: Witness) => readonly ResourceManifest[];
  /** Each declaring module's globals, built once, a key's narrowed entries laid
   *  over them. */
  readonly globalsOverlays: ModuleGlobalsOverlays;
  /** The kind documents and the imports. */
  readonly kindsAndImports: readonly ConditionedDeclaration[];
  readonly writtenRefusals: ReadonlySet<AnalysisDiagnostic>;
  readonly libraryManifests: ReadonlyMap<string, ResourceManifest[]>;
  /** Every key's typed CEL environments, by content. */
  readonly typedEnvironments: TypedEnvironments;
  /** The module functions of each shared layer, built once. */
  readonly sharedFunctions: WeakMap<SharedLayer, ModuleFunctionIndex>;
  /** Every import of the union, by the module it loads. */
  readonly importersByModule: ImportersByModule;
  /** The named shapes some configuration varies, by id. */
  readonly varyingShapes: readonly string[];
}

/** What one analysis over every configuration reads: the union of every
 *  configuration's expansion over the whole space, and the configurations it
 *  keeps — the care of every key some configuration holds. */
export interface AnalysisReading {
  readonly union: ConditionedExpansion;
  readonly universe: Condition;
}

let analysisReadingObserver: ((reading: AnalysisReading) => void) | undefined;

/** Observe what every analysis reads until the returned function is called. */
export function observeAnalysisReadings(listener: (reading: AnalysisReading) => void): () => void {
  analysisReadingObserver = listener;
  return () => {
    if (analysisReadingObserver === listener) analysisReadingObserver = undefined;
  };
}

function reportAnalysisReading(reading: AnalysisReading): void {
  analysisReadingObserver?.(reading);
}

/** The template variant of each template definition one key holds. */
interface TemplateVariantsView {
  get(key: string): TemplateVariantOf | undefined;
  readonly size: number;
  values(): Iterable<TemplateVariantOf>;
}

/** One key's declarations, normalized as an analysis normalizes them. */
/** What one configuration's analysis found. */
interface ConfigurationAnalysis {
  diagnostics: AnalysisDiagnostic[];
  expansion?: ExpansionReading;
  consumerReads?: readonly { holder: ResourceManifest; source: string }[];
  /** Whether the run's own observed-state index holds a declaration that reports. */
  reportsObservedState?: boolean;
}

interface KeyNormalization {
  /** The key's own declarations and its forward views, in analysis order. */
  readonly allManifests: ResourceManifest[];
  /** What the key holds of forward views of the union, as regions: nothing
   *  publishes them. */
  readonly viewManifests: readonly ResourceManifest[];
  /** Where each of {@link viewManifests} stands in the layout a run's door
   *  lists forward views in — every view in the union's view order, then what
   *  each view's slots drew out of it, view by view — as `[0, view]` or
   *  `[1, view, drawn]`. */
  readonly layout: ReadonlyMap<ResourceManifest, readonly number[]>;
  /** Both layers, name resolution over them included. */
  readonly layers: DoorLayers;
  readonly scopeMembers: ScopeMembers;
  readonly templateVariants: TemplateVariantsView;
  readonly consumers: ReturnType<typeof readTemplateConsumers> | undefined;
  readonly forwardViews: ReturnType<typeof buildTemplateForwardViews> | undefined;
  /** The site's own declaration — or its region, where the key holds one in
   *  its place — and every declaration drawn out of it. */
  readonly group: ReadonlySet<ResourceManifest>;
  /** The same, in analysis order, its forward views last. */
  readonly groupManifests: readonly ResourceManifest[];
  /** Diagnostics about the key's declarations, at the place each is written. */
  placed(found: AnalysisDiagnostic[], filtered: boolean): AnalysisDiagnostic[];
  /** The same, short of a forward view's own place map: a finding about a
   *  view, or about what its slots drew out, at its place in the view. */
  inViews(found: AnalysisDiagnostic[]): AnalysisDiagnostic[];
  /** Every forward view the key holds — built in its door, or held as a
   *  region of the union — with the consumer its findings are reported at. */
  readonly views: readonly ViewOrigin[];
  /** The nodes of the declarations and regions normalized for the key, beside
   *  the shared layer — counted only while key costs are observed. */
  readonly nodes: number;
  /** Of {@link nodes}, those of the regions held of declarations reached by
   *  name, and their extent counted from the union as written. */
  readonly byName: { readonly nodes: number; readonly extent: number };
  /** Each declaration reached by name it normalized whole that is no named
   *  shape, as `<reader>:<name>` — counted only while key costs are observed. */
  readonly wholeByName: readonly string[];
  /** What the door's module documents request answers. */
  readonly moduleDocuments: readonly ResourceManifest[];
}

/**
 * A kind document never varies: a choice inside one outside its template body
 * is refused, and one as a branch is refused, so kinds resolve once for every
 * configuration. Anything else here is an internal error.
 */
function assertInvariantKindDocuments(union: ConditionedExpansion): void {
  for (const declaration of union.declarations) {
    if (!isKindDocument(declaration.manifest)) continue;
    const varies =
      declaration.condition !== TRUE ||
      Object.entries(declaration.manifest).some(
        ([key, field]) => !(declaration.manifest.kind === "Telo.Definition" && TEMPLATE_BODY_FIELDS.includes(key)) && holdsChoice(field),
      );
    if (varies) {
      throw new Error(
        `internal: the kind document ${String(declaration.manifest.kind)} '${String(declaration.manifest.metadata?.name)}' varies between configurations.`,
      );
    }
  }
}

/** Every qualified module call a parsed expression makes. */
function qualifiedCallsOf(root: CelNode): string[] {
  const out: string[] = [];
  const visit = (node: CelNode): void => {
    const call = moduleCallOf(node);
    if (call) out.push(call.qualified);
    for (const child of childNodes(node)) visit(child);
  };
  visit(root);
  return out;
}

/** A diagnostic a run reports about a template definition's body, with the
 *  variant it was found in and its path as written. */
function definitionFindingOf(
  diagnostic: AnalysisDiagnostic,
  templates: TemplateDefinitions,
  index: number,
): { variant: DefinitionVariant; path: string; definition: ResourceManifest } | undefined {
  const data = diagnostic.data as
    | { resource?: { kind?: unknown; name?: unknown }; filePath?: unknown; path?: unknown }
    | undefined;
  if (data?.resource?.kind !== "Telo.Definition" || typeof data.path !== "string") return undefined;
  const root = data.path.split(/[.[]/)[0]!;
  if (!TEMPLATE_BODY_FIELDS.includes(root)) return undefined;
  const definition = templates.definitions.find((d) => {
    const meta = d.metadata as { name?: unknown; source?: unknown } | undefined;
    return meta?.name === data.resource!.name && meta?.source === data.filePath;
  });
  if (!definition) return undefined;
  return { variant: templates.variant(definition, index), path: data.path, definition };
}

/** What a schema pass says about a splice's representative key at the
 *  definition: which key an element emits is the consumer's to decide. */
function holdsRepresentativeKey(d: AnalysisDiagnostic): boolean {
  const path = (d.data as { path?: unknown } | undefined)?.path;
  // A family's representative member is named `<family>[⟨key⟩]`, which is a
  // member's identity rather than a splice's placeholder key.
  const placeholder = d.message.split(`[${REPRESENTATIVE_KEY}]`).join("").includes(REPRESENTATIVE_KEY);
  return placeholder || (typeof path === "string" && path.includes(REPRESENTATIVE_KEY));
}

function isUnderPath(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}.`) || path.startsWith(`${prefix}[`);
}

function sameDataPath(a: AnalysisDiagnostic, b: AnalysisDiagnostic): boolean {
  const pa = (a.data as { path?: unknown; filePath?: unknown } | undefined) ?? {};
  const pb = (b.data as { path?: unknown; filePath?: unknown } | undefined) ?? {};
  return pa.path === pb.path && pa.filePath === pb.filePath && b.message.startsWith(a.message);
}

/** The key a template definition's variant is found by, whichever copy of the
 *  definition a pass holds. */
/**
 * The loop bindings in scope at `path` of a templated definition's expanded
 * body. An inline declaration an emitted item holds is extracted into an entry
 * of its own, so a path inside that entry is carried back to the place the
 * declaration was written — through any chain of extractions — before the
 * loops it stands in are read.
 */
function loopBindingsAtPath(
  variant: DefinitionVariant,
  definition: { resources?: unknown },
  path: string,
): Record<string, Record<string, any>> | undefined {
  const direct = variant.bindingsAt(path);
  if (direct) return direct;
  const entries = Array.isArray(definition.resources) ? (definition.resources as any[]) : [];
  let keys = parseKeys(path);
  for (let guard = 0; guard < entries.length + 1; guard++) {
    if (keys[0] !== "resources" || typeof keys[1] !== "number") return undefined;
    const origin = entries[keys[1]]?.metadata?.xTeloOrigin as
      | { parentName?: string; keysFromParent?: (string | number)[]; parentKind?: string }
      | undefined;
    if (!origin?.keysFromParent) return undefined;
    const parent = entries.findIndex((e) => e?.metadata?.name === origin.parentName);
    if (parent < 0) return undefined;
    keys = ["resources", parent, ...origin.keysFromParent, ...keys.slice(2)];
    const found = variant.bindingsAt(pathText(keys));
    if (found) return found;
  }
  return undefined;
}

import { TextLanguageScope, validateTexts } from "./validate-texts.js";
import { validateTextCatalogSets } from "./validate-text-catalog-sets.js";
import type { TextFragment } from "./text-slot.js";

/** One schema per text fragment, so the registry's per-schema validator memo
 *  compiles each once. */
const TEXT_FRAGMENT_SCHEMAS: Readonly<Record<TextFragment, Record<string, any>>> = {
  Message: { $ref: manifestFragmentRef("Message") },
  Text: { $ref: manifestFragmentRef("Text") },
  TextCatalog: { $ref: manifestFragmentRef("TextCatalog") },
};

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
    if (isKindDocument(m)) continue;
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

/** A library's own alias table, which names the built-ins as every module's does. */
function libraryAliasTable(tables: Map<string, AliasResolver>, module: string): AliasResolver {
  const table = new AliasResolver();
  table.registerUngatedAlias(TELO_BUILTIN_MODULE, TELO_BUILTIN_MODULE);
  tables.set(module, table);
  return table;
}

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
 * A schema finding on a `Telo.Definition` / `Telo.Abstract` document that a
 * dedicated check reports instead, so each mistake is one diagnostic: the
 * `capability:` enum (the roster's `CAPABILITY_UNKNOWN` /
 * `CAPABILITY_NOT_DECLARABLE`), the `extends:` pattern (`EXTENDS_MALFORMED`) and
 * rule 8's `throws:` refusal (`THROWS_ON_NON_DISPATCH_CAPABILITY`).
 */
function kindDocumentFindingReportedElsewhere(issue: SchemaIssue): boolean {
  if (issue.path === "capability" || issue.path === "extends") return true;
  if (/^throws\.(inherit|passthrough)$/.test(issue.path) && issue.keyword === "false schema") return true;
  return issue.path === "" && issue.keyword === "if";
}

/** What a key's environment holds beside the shared layer: the site's own
 *  declaration first, then each declaration a class covers whole, by the
 *  readers holding it so (`wholeByName`), and, by the union paths of their
 *  regions, the declarations it reaches by name only as the regions its
 *  classes read. Read `whole` (the reference side) or `byNameWhole` (by-name
 *  parity's), those are held whole too. */
function keySelection(
  setup: KeySetup,
  declaration: ConditionedDeclaration,
  coverage: KeyCoverage,
  whole = false,
): {
  declarations: ConditionedDeclaration[];
  byName: ReadonlyMap<ConditionedDeclaration, readonly (readonly (string | number)[])[]>;
  wholeByName: ReadonlyMap<ConditionedDeclaration, ReadonlySet<WholeNameReader>>;
} {
  const declarations: ConditionedDeclaration[] = [declaration];
  const wholeByName = new Map<ConditionedDeclaration, ReadonlySet<WholeNameReader>>();
  for (const name of coverage.names) {
    const readers = coverage.wholeReads.get(name) ?? new Set<WholeNameReader>();
    for (const each of setup.byName.get(name) ?? []) {
      declarations.push(each);
      wholeByName.set(each, new Set([...(wholeByName.get(each) ?? []), ...readers]));
    }
  }
  const held = new Set(declarations.slice(1));
  const byName = new Map([...coverage.parts].filter(([target]) => !held.has(target)));
  if (!whole) return { declarations, byName, wholeByName };
  declarations.push(...byName.keys());
  return { declarations, byName: new Map(), wholeByName };
}

/** Report the nodes one key's door normalized, while key costs are observed. */
function reportDoorNodes(family: "cel" | "schema" | "relation", site: string, normalized: KeyNormalization): void {
  if (!observingKeyCosts()) return;
  reportKeyCost({
    kind: "door-nodes",
    family,
    site,
    nodes: normalized.nodes,
    byNameNodes: normalized.byName.nodes,
    byNameExtent: normalized.byName.extent,
    wholeByName: normalized.wholeByName.length,
    wholeByNameReads: normalized.wholeByName,
  });
}

/** What a declaration's own checks read: the registries, the declarations
 *  named through requests, and what the configuration decides of the declaring
 *  module's inputs. */
interface OwnCheckWorld {
  readonly defs: DefinitionRegistry;
  readonly aliases: AliasResolver;
  readonly aliasesByModule: Map<string, AliasResolver>;
  readonly rootModules: Set<string>;
  readonly libraries: LibraryDeclarations | undefined;
  /** The names a CEL call's receiver may be, per declaring module. */
  readonly moduleCallNames: ReadonlyMap<string, ReadonlySet<string>>;
  /** What each expression was typed as, by the key judging it. */
  readonly celFacts: CelFactMaps;
  /** Each imported library's full documents. */
  readonly moduleDocuments: NonNullable<AnalysisOptions["moduleDocuments"]>;
  /** The child applications the loader followed, by declaring file and source. */
  readonly applicationSources: NonNullable<AnalysisOptions["applicationSources"]>;
  /** Which definition a declaration's own checks read. */
  readonly declaredScope: DeclaredDefinitionScope;
  readonly validationSchemaFor: (definition: ResourceDefinition) => Record<string, any>;
  readonly projectionScope: ProjectionScope;
  readonly narrowing: InputNarrowing | undefined;
  readonly validator: ShapeAwareValidator;
  readonly valueSchemaHost: ValueSchemaHost;
  readonly types: DeclarationRequests;
  /** The names a declaration writes and its steps', judged. */
  readonly identifierNames: (m: ResourceManifest) => OwnFinding[];
}

/** One own-check finding and the place its check judged: where a keyword is
 *  evaluated — a missing member's parent for `required` — else its own. */
interface OwnFinding {
  readonly diagnostic: AnalysisDiagnostic;
  readonly judgedAt: string;
}

/** The groups judged at the schema family's sites, and their checks. */
const OWN_GROUPS: ReadonlyArray<readonly [SchemaGroup, (world: OwnCheckWorld, m: ResourceManifest, declared: DeclaredDefinition) => OwnFinding[]]> = [
  ["schema", (world, m, declared) => ownSchemaChecks(world, m, declared)],
  ["identifiers", (world, m) => world.identifierNames(m)],
];

/** A finding judged at the place it is reported. */
function asOwnFinding(diagnostic: AnalysisDiagnostic): OwnFinding {
  return { diagnostic, judgedAt: (diagnostic.data as { path?: string }).path ?? "" };
}

/** A finding about the declaration `identity` names, at `path`, judged there. */
function relationFindingAt(
  identity: DeclarationIdentity,
  code: string,
  message: string,
  path: string,
  warning = false,
  quoted?: string | WrittenPlace | readonly (string | WrittenPlace)[],
): RelationFinding {
  const name = identity.metadata.name as string;
  const diagnostic: AnalysisDiagnostic = {
    severity: warning ? DiagnosticSeverity.Warning : DiagnosticSeverity.Error,
    code,
    source: SOURCE,
    message: `${identity.kind}/${name}: ${message}`,
    data: {
      resource: { kind: identity.kind, name },
      filePath: identity.metadata.source as string | undefined,
      path,
    },
  };
  return { diagnostic: quoted === undefined ? diagnostic : withQuotedPath(diagnostic, quoted), judgedAt: path };
}

/** Whether the declaration `identity` names is one of the entry's own modules'. */
function isEntryIdentity(identity: DeclarationIdentity, rootModules: ReadonlySet<string>): boolean {
  const module = identity.metadata.module as string | undefined;
  return !module || rootModules.has(module);
}

/** The instance at each of `fields` of a document of `kinds` the region holds. */
function fieldInstances(region: RelationRegion, kinds: ReadonlySet<string>, fields: readonly string[]): RelationInstance[] {
  if (!kinds.has(region.identity.kind)) return [];
  return fields
    .filter((field) => isAtOrAbove(region.at, [field]) && region.valueAt([field]) !== undefined)
    .map((field) => ({ anchor: [field] }));
}

const ANNOTATED_DOCUMENTS: ReadonlySet<string> = new Set(["Telo.Definition", "Telo.Abstract", "Telo.JsonSchema"]);
const TEMPLATE_DOCUMENTS: ReadonlySet<string> = new Set(["Telo.Definition"]);

/** What each relation of a template definition's entry points reads beside
 *  its anchor: the dispatch target and the body naming it, or the contract
 *  its `result:` is mapped onto. */
const TEMPLATE_TARGET_READS: Readonly<Record<string, readonly (readonly string[])[]>> = {
  inputs: [["invoke"], ["provide"], ["resources"]],
  result: [["invoke"], ["provide"], ["outputType"], ["extends"], ["capability"]],
};

/** The definition the manifest walk resolves a named declaration's kind to,
 *  in the alias scope of the module that declared it. */
function namedDeclarationDefinition(
  identity: DeclarationIdentity,
  scope: Pick<RelationReaderScope, "defs" | "aliases" | "aliasesByModule">,
): ResourceDefinition | undefined {
  if (typeof identity.kind !== "string" || typeof identity.metadata.name !== "string") return undefined;
  const resolvedKind = moduleAliasScope(identity.metadata, scope.aliases, scope.aliasesByModule)?.resolveKind(identity.kind);
  return (scope.defs.resolve(identity.kind) ?? (resolvedKind ? scope.defs.resolve(resolvedKind) : undefined)) as
    | ResourceDefinition
    | undefined;
}

const authorSchemas = new WeakMap<object, Record<string, any>>();

/** A definition's author schema, inheritance folded — read once. */
function authorSchemaOf(definition: ResourceDefinition, scope: Pick<RelationReaderScope, "defs" | "aliases">): Record<string, any> {
  let known = authorSchemas.get(definition as unknown as object);
  if (!known) {
    const { defs, aliases } = scope;
    known = effectiveAuthorSchema(definition, (k) => defs.resolve(aliases.resolveKind(k) ?? k) ?? defs.resolve(k));
    authorSchemas.set(definition as unknown as object, known);
  }
  return known;
}

/** Each of `anchors` at or beneath `at`, once. */
function uniqueAnchors(anchors: readonly (readonly (string | number)[])[], at: readonly (string | number)[]): RelationInstance[] {
  const seen = new Set<string>();
  const out: RelationInstance[] = [];
  for (const anchor of anchors) {
    const path = pathText(anchor);
    if (seen.has(path) || !isAtOrAbove(at, anchor)) continue;
    seen.add(path);
    out.push({ anchor });
  }
  return out;
}

/** The declaration `identity` names, as a manifest holding nothing else. */
function identityManifest(identity: DeclarationIdentity): ResourceManifest {
  return { kind: identity.kind, metadata: identity.metadata } as ResourceManifest;
}

/** A manifest holding only `value` at `anchor` of the declaration `identity`
 *  names: what a rule re-reads its own anchor from. */
function anchorHolder(identity: DeclarationIdentity, anchor: readonly (string | number)[], value: unknown): ResourceManifest {
  return regionSkeleton({ kind: identity.kind, metadata: identity.metadata }, [
    { place: { at: anchor, identities: new Map() }, content: value },
  ]);
}

/** The scopes a door's call and contract checks resolve in. */
function doorScopes(door: RelationDoor): CallScopes {
  return { aliasesByModule: door.aliasesByModule, rootModules: door.rootModules as Set<string>, libraries: door.libraries };
}

/** A call site's context over a door: a target resolved by the door, in the
 *  scope holding where the reference is written. */
function doorCallContext(door: RelationDoor, anchor: readonly (string | number)[]): DerivedSlotContext {
  return {
    defs: door.defs,
    aliases: door.aliases,
    aliasesByModule: door.aliasesByModule,
    rootModules: door.rootModules,
    libraries: door.libraries,
    types: door.requests,
    resolveTarget: (reference, path) => door.resolveTarget(reference, path === undefined ? anchor : parseKeys(path)),
  };
}

/** The step item anchored at `anchor`, read off its own value. */
function stepItemAt(
  identity: DeclarationIdentity,
  anchor: readonly (string | number)[],
  value: unknown,
  scope: Pick<RelationReaderScope, "defs" | "aliases" | "aliasesByModule">,
): StepItem | undefined {
  const effective = scope.defs.effectiveSchemaOf(namedDeclarationDefinition(identity, scope)) as Record<string, any> | undefined;
  if (!effective) return undefined;
  const path = pathText(anchor);
  return stepItemsOf(anchorHolder(identity, anchor, value) as Record<string, any>, effective).find((item) => item.path === path);
}

/** What a step's argument map forwards as a plain chain: the steps whose
 *  results it names, and whether it names the declaration's own inputs. */
function forwardedReads(item: StepItem | undefined): { steps: string[]; inputs: boolean } {
  const steps = new Set<string>();
  let inputs = false;
  const values = item?.value[item.inputsField];
  if (values && typeof values === "object" && !Array.isArray(values)) {
    for (const value of Object.values(values)) {
      const chain = plainChainOf(value);
      if (!chain) continue;
      if (chain.startsWith("inputs.")) inputs = true;
      const step = /^steps\.([A-Za-z_]\w*)/.exec(chain)?.[1];
      if (step) steps.add(step);
    }
  }
  return { steps: [...steps].sort(), inputs };
}

/** Where a declaration's own input contract is read: its `inputType`, or the
 *  declaration whole where its kind's contract derives from it. */
function ownInputContractPlaces(
  identity: DeclarationIdentity,
  scope: ContractScopes,
): (readonly (string | number)[])[] {
  return kindContractDerives(identity, "inputType", scope) ? [[]] : [["inputType"]];
}

/** The step-body fields a declaration's kind declares. */
function stepBodyPlaces(
  identity: DeclarationIdentity,
  scope: Pick<RelationReaderScope, "defs" | "aliases" | "aliasesByModule">,
): (readonly (string | number)[])[] {
  const effective = scope.defs.effectiveSchemaOf(namedDeclarationDefinition(identity, scope)) as Record<string, any> | undefined;
  const props = (effective?.properties ?? {}) as Record<string, any>;
  return Object.keys(props)
    .filter((field) => readStepSlot(props[field]))
    .map((field) => [field]);
}

/** Where a kind's CEL is evaluated, for a slot rule over a declaration of the
 *  entry's own modules — undefined where the rule does not apply: a kind with
 *  no schema, or a template's. */
function slotRuleSites(
  identity: DeclarationIdentity,
  scope: Pick<RelationReaderScope, "defs" | "aliases" | "aliasesByModule" | "rootModules">,
): CelEvalSites | undefined {
  if (!isEntryIdentity(identity, scope.rootModules)) return undefined;
  const definition = namedDeclarationDefinition(identity, scope);
  const { defs, aliases } = scope;
  const resolveDef: DefResolver = (k) => defs.resolve(aliases.resolveKind(k) ?? k) ?? defs.resolve(k);
  // Only a runtime resource instance's kind says where its values are
  // evaluated; the capability is inherited along `extends`.
  const capability = definition ? inheritedCapability(definition, resolveDef) : undefined;
  if (!definition?.schema || capability === undefined || capability === "Telo.Template") return undefined;
  return kindCelEvalSites(definition, resolveDef, defs.shapeLookup);
}

/** A slot rule's kind schema, for a declaration of the entry's own modules. */
function slotKindSchema(
  identity: DeclarationIdentity,
  scope: Pick<RelationReaderScope, "defs" | "aliases" | "aliasesByModule" | "rootModules">,
): Record<string, any> | undefined {
  if (!isEntryIdentity(identity, scope.rootModules)) return undefined;
  return scope.defs.effectiveSchemaOf(namedDeclarationDefinition(identity, scope)) as Record<string, any> | undefined;
}

/** The object holding an annotated browser-export value: its field, an item of
 *  a list it holds, taken away. */
function exportHolderKeys(keys: readonly (string | number)[]): (string | number)[] {
  let end = keys.length;
  while (end > 0 && typeof keys[end - 1] === "number") end--;
  return keys.slice(0, Math.max(0, end - 1));
}

/** The functions a rule condition may call, built on the first call it makes. */
function ruleFunctions(
  requests: DeclarationRequests,
  defs: DefinitionRegistry,
  aliases: AliasResolver,
  aliasesByModule: Map<string, AliasResolver>,
  rootModules: ReadonlySet<string>,
  moduleCallNames: ReadonlyMap<string, ReadonlySet<string>>,
): (caller: ResourceManifest) => ModuleCallDispatch {
  let evaluators: FunctionBodyEvaluators | undefined;
  return (caller) =>
    new LazyDispatch(() => {
      if (!evaluators) {
        const index = new ModuleFunctionIndex(requests, defs, aliases, aliasesByModule, rootModules);
        evaluators = new FunctionBodyEvaluators(index, new CallableFlagsIndex(index, moduleCallNames), moduleCallNames, (ref) => defs.schemaForId(ref));
      }
      return evaluators.dispatchFor(caller);
    });
}

/** What judging a relational group over a declaration held whole reads. */
interface DirectRelationEnvironment {
  readonly defs: DefinitionRegistry;
  readonly aliases: AliasResolver;
  readonly aliasesByModule: Map<string, AliasResolver>;
  readonly rootModules: Set<string>;
  readonly libraries: LibraryDeclarations | undefined;
  readonly validator: ShapeAwareValidator;
  readonly requests: DeclarationRequests;
  readonly declaredScope: DeclaredDefinitionScope;
  readonly moduleCallNames: ReadonlyMap<string, ReadonlySet<string>>;
  /** What each expression of the declaration was typed as. */
  readonly celFacts: CelFactMaps;
  readonly narrowing: InputNarrowing | undefined;
  readonly moduleDocuments: NonNullable<AnalysisOptions["moduleDocuments"]>;
  readonly applicationSources: NonNullable<AnalysisOptions["applicationSources"]>;
}

/** What each object on the way to `anchor` of `manifest` holds beside it,
 *  shallow. */
function enclosingOf(manifest: unknown, anchor: readonly (string | number)[]): EnclosingMembers[] {
  const out: EnclosingMembers[] = [];
  let node = manifest;
  for (let depth = 0; depth < anchor.length; depth++) {
    if (node === null || typeof node !== "object") break;
    if (!Array.isArray(node)) {
      const members: Record<string, unknown> = {};
      for (const [key, field] of Object.entries(node as Record<string, unknown>)) {
        if (key !== String(anchor[depth])) members[key] = shallowMember(field);
      }
      out.push({ at: anchor.slice(0, depth), members });
    }
    node = (node as Record<string | number, unknown>)[anchor[depth] as string];
  }
  return out;
}

/** A reader's scope over `m` held whole, its definition read as the analysis
 *  that holds it reads it. */
function directReaderScope(
  m: ResourceManifest,
  declaredScope: DeclaredDefinitionScope,
  libraries: LibraryDeclarations | undefined,
  moduleCallNames: ReadonlyMap<string, ReadonlySet<string>>,
): RelationReaderScope {
  return {
    defs: declaredScope.defs,
    aliases: declaredScope.aliases,
    aliasesByModule: declaredScope.aliasesByModule,
    rootModules: declaredScope.rootModules,
    libraries,
    declared: (identity) =>
      declaredDefinitionOf(identity.metadata === m.metadata ? m : identityManifest(identity), declaredScope),
    moduleNames: (identity) => moduleCallNamesOf(moduleCallNames, identity.metadata === m.metadata ? m : identityManifest(identity)),
  };
}

/**
 * Every instance of `group` in `m`, held whole — a plain analysis's
 * declaration, its forward views included, on which every condition is true —
 * judged through a door reading `m` itself and refusing what the instance does
 * not declare it reads.
 */
function directRelationFindings(group: RelationalGroup, m: ResourceManifest, env: DirectRelationEnvironment): RelationFinding[] {
  const { defs, aliases, aliasesByModule, rootModules, libraries, requests } = env;
  const reader = readerOf(group);
  const region = relationRegionOf(m, []);
  const readerScope = directReaderScope(m, env.declaredScope, libraries, env.moduleCallNames);
  const out: RelationFinding[] = [];
  for (const instance of reader.instances(region, readerScope)) {
    const reads = reader.reads(instance, region, readerScope);
    const declared = reads.places.map((keys) => pathText(keys));
    const refuse = (what: string): never => {
      throw new Error(`internal: the ${group} rule of ${m.kind}/${m.metadata?.name} asked for ${what}, which it does not read.`);
    };
    const door: RelationDoor = {
      defs,
      aliases,
      aliasesByModule,
      rootModules,
      libraries,
      validator: env.validator,
      requests,
      declared: readerScope.declared,
      moduleNames: (identity) =>
        moduleCallNamesOf(env.moduleCallNames, identity.metadata === m.metadata ? m : identityManifest(identity)),
      resolveTarget: (reference, keys) => {
        if (!reads.scopes) refuse(`what the reference at '${pathText(keys)}' names`);
        return callSiteContext(m as Record<string, any>, requests, defs, aliases, { aliasesByModule, rootModules, libraries }).resolveTarget(
          reference,
          pathText(keys),
        );
      },
      place: (keys) => {
        if (!declared.includes(pathText(keys))) refuse(`'${pathText(keys)}'`);
        return valueAtKeys(m, keys);
      },
      subject: () => m,
      functions: ruleFunctions(requests, defs, aliases, aliasesByModule, rootModules, env.moduleCallNames),
      facts: (keys) => {
        const within = isAtOrAbove(instance.anchor, keys) || reads.places.some((place) => isAtOrAbove(place, keys));
        if (!reads.facts || !within) refuse(`what the expression at '${pathText(keys)}' was typed as`);
        return relationFactsIn(env.celFacts, m, pathText(keys));
      },
      enclosing: () => {
        if (!reads.enclosing) refuse("what encloses its anchor");
        return enclosingOf(m, instance.anchor);
      },
      narrowing: env.narrowing,
      importInputsSchema: (importDoc) => importInputsJoinSchema(importDoc, env.moduleDocuments),
      applicationInputsSchema: (resource, authorSchema) =>
        applicationInputsSlotSchema(resource, authorSchema, env.applicationSources, (kind) => needTypeOf(defs.resolve(kind))),
      steps: () => {
        if (!reads.steps) refuse("the step results");
        const effective = defs.effectiveSchemaOf(namedDeclarationDefinition(identityOf(m), readerScope)) as Record<string, any> | undefined;
        return effective
          ? buildStepContextSchema(m as Record<string, any>, effective, requests, defs, aliases, { aliasesByModule, rootModules, libraries }, new Set(reads.steps))
          : undefined;
      },
    };
    out.push(...reader.judge(instance, { identity: region.identity, anchor: instance.anchor, value: valueAtKeys(m, instance.anchor), door }));
  }
  return out;
}

const scopeFieldsByDefinition = new WeakMap<object, readonly string[]>();

/** The top-level fields a declaration of `holder`'s kind declares a scope at
 *  (`x-telo-scope`), its kind read in the module that declared it. */
function scopeFieldsOf(
  defs: DefinitionRegistry,
  holder: { readonly kind: unknown; readonly metadata: unknown },
  aliases: AliasResolver,
  aliasesByModule: Map<string, AliasResolver>,
): readonly string[] {
  if (typeof holder.kind !== "string") return [];
  const definition = definitionInScope(defs, holder.kind, holder.metadata as Record<string, unknown> | undefined, aliases, aliasesByModule);
  if (!definition) return [];
  let known = scopeFieldsByDefinition.get(definition as unknown as object);
  if (!known) {
    const schema = defs.effectiveSchemaOf(definition) as Record<string, any> | undefined;
    const properties = (schema?.properties ?? {}) as Record<string, unknown>;
    known = Object.keys(properties).filter((field) => {
      const node = properties[field];
      return !!node && typeof node === "object" && "x-telo-scope" in node;
    });
    scopeFieldsByDefinition.set(definition as unknown as object, known);
  }
  return known;
}

/** A `named` target reading each declaration the references at `at` name as
 *  its identity alone — a named shape whole. */
function identityTarget(at: readonly (string | number)[]): RelationTarget {
  return { at, hop: "named", reads: READS_IDENTITY, transitive: false };
}

/** What a list of read places of a declaration declares, beneath `prefix`: a
 *  reference place a `named` target, any other place read by place. */
function declaredReads(
  places: readonly ReadPlace[],
  prefix: readonly (string | number)[] = [],
): { places: (readonly (string | number)[])[]; targets: RelationTarget[] } {
  const out: { places: (readonly (string | number)[])[]; targets: RelationTarget[] } = { places: [], targets: [] };
  for (const place of places) {
    if (place.kind === "referrers") throw new Error("internal: a relation read lists every referrer, which no relation reader reads.");
    const at = [...prefix, ...place.keys];
    if (place.kind === "reference") out.targets.push({ at, hop: "named", reads: place.reads, transitive: place.transitive });
    else out.places.push(at);
  }
  return out;
}

/** The resolver of kinds in the root alias scope a reader resolves contracts with. */
function rootDefResolver(scope: Pick<RelationReaderScope, "defs" | "aliases">): DefResolver {
  const { defs, aliases } = scope;
  return (k) => defs.resolve(aliases.resolveKind(k) ?? k) ?? defs.resolve(k);
}

const dispatchReadsByRegistry = new WeakMap<DefinitionRegistry, Map<string, ReferentReads>>();

/**
 * What a dispatch to a declaration reads in it, its `direction` contract
 * typing the call: what that contract reads (`contractReads`, the kind's
 * resolved along `extends`), the value slot its kind derives an output
 * contract from, and, for a step, the fields declaring a re-attempt — read off
 * the declaration it resolves to, never the kind stamped on the reference. One
 * function per registry and form, so a declaration read twice is read once.
 */
function dispatchContractReads(
  direction: ContractDirection,
  scope: Pick<RelationReaderScope, "defs" | "aliases">,
  retry: boolean,
): ReferentReads {
  let byForm = dispatchReadsByRegistry.get(scope.defs);
  if (!byForm) dispatchReadsByRegistry.set(scope.defs, (byForm = new Map()));
  const form = `${direction} ${retry}`;
  const known = byForm.get(form);
  if (known) return known;
  const resolveDef = rootDefResolver(scope);
  const reads: ReferentReads = (referent): ReferentPlace[] => {
    const kindContract = referent.definition
      ? effectiveContractField(referent.definition as ResourceDefinition, resolveDef, direction)
      : undefined;
    const slot = direction === "outputType" ? valueDerivedSlot(referent.schema, "outputType") : undefined;
    return [
      ...contractReads(direction, referent.value, kindContract, referent.definition).map((place) => {
        if (place.kind === "referrers") throw new Error("internal: a contract read lists every referrer, which a dispatch never reads.");
        return place;
      }),
      ...(slot ? [{ kind: "value" as const, keys: slot }] : []),
      ...(retry && referent.schema ? retryFieldsOf(referent.schema).map((field) => ({ kind: "value" as const, keys: [field] })) : []),
    ];
  };
  byForm.set(form, reads);
  return reads;
}

/**
 * The `resolved` target a call makes at `at`: the reference written there,
 * resolved where it is written, and what its `direction` contract reads in the
 * declaration it resolves to — undefined where no reference is written.
 */
function dispatchTarget(
  reference: unknown,
  at: readonly (string | number)[],
  direction: ContractDirection,
  scope: Pick<RelationReaderScope, "defs" | "aliases">,
  retry = false,
): RelationTarget | undefined {
  // A reference resolving to nothing here is read too: what it resolves to is
  // the read, wherever it does.
  if (!isResolvedReference(reference) && !isRefSentinel(reference)) return undefined;
  return { at, hop: "resolved", reads: dispatchContractReads(direction, scope, retry), transitive: false };
}

/**
 * What a template definition's top-level `inputs:` reads depending on what
 * its dispatch slots and body hold: the body entry dispatched — found by the
 * one reader the template call site finds it with — read for its input
 * contract under its kind, beneath the entry.
 */
function templateDispatchRead(identity: DeclarationIdentity, scope: ContractScopes): DependentRead {
  return (place): DependentReads => {
    const md: Record<string, any> = {
      kind: identity.kind,
      metadata: identity.metadata,
      invoke: place(["invoke"]),
      provide: place(["provide"]),
      resources: place(["resources"]),
    };
    for (const slot of ["invoke", "provide"] as const) {
      const target = dispatchTargetOf(md, slot);
      if (!target?.entry) continue;
      const index = (md.resources as unknown[]).indexOf(target.entry);
      const definition = moduleScopedDefResolver<ResourceDefinition>(scope.defs, scope.aliases, {
        aliasesByModule: scope.aliasesByModule,
        rootModules: scope.rootModules as Set<string>,
        libraries: scope.libraries,
      }).in(target.kind, identity.metadata.module as string | undefined);
      const kindContract = definition ? effectiveContractField(definition, rootDefResolver(scope), "inputType") : undefined;
      return declaredReads(
        contractReads("inputType", target.entry, kindContract, definition as Record<string, any> | undefined),
        ["resources", index],
      );
    }
    return { places: [] };
  };
}

/** What a contract instance reads beside its anchor: the declaration whole
 *  where its contract derives from it, and what each contract it resolves
 *  reads — at the root, the kind contracts the declaration leaves unwritten. */
function contractInstanceReads(
  instance: RelationInstance,
  region: RelationRegion,
  scope: ContractScopes,
): { places: (readonly (string | number)[])[]; targets: RelationTarget[] } {
  const { identity } = region;
  const definition = contractDefinitionOf(identity, scope);
  const read: ReadPlace[] = [];
  const kindContract = (direction: ContractDirection) =>
    definition ? effectiveContractField(definition, rootDefResolver(scope), direction) : undefined;
  if (instance.anchor.length === 0) {
    const md = region.valueAt([]) as Record<string, any>;
    for (const direction of CONTRACT_DIRECTIONS) {
      if (md[direction] !== undefined && md[direction] !== null) continue;
      read.push(...contractReads(direction, md, kindContract(direction), definition as Record<string, any> | undefined));
    }
  } else {
    const direction = instance.anchor[0] as ContractDirection;
    read.push(
      ...contractReads(direction, { [direction]: region.valueAt(instance.anchor) }, kindContract(direction), definition as Record<string, any> | undefined),
    );
  }
  const found = declaredReads(read);
  const whole = instance.anchor.length > 0 && ownContractReadsWhole(instance, identity, region.valueAt(instance.anchor), scope);
  return { places: whole ? [[], ...found.places] : found.places, targets: found.targets };
}

/** The resource rules a declaration's kind declares, when it declares any. */
function ruleSetOf(identity: DeclarationIdentity, scope: Pick<RelationReaderScope, "declared" | "defs" | "aliases">) {
  const declared = scope.declared(identity);
  if (declared.status !== "ok") return undefined;
  const rules = readResourceRules(authorSchemaOf(declared.definition, scope));
  return rules.length > 0 ? rules : undefined;
}


/**
 * Where a declaration's resource rules are judged: at the first field their
 * conditions read that the declaration holds — a forward view carries only the
 * fields it was handed, and writes `kind` nowhere a place map can follow — and
 * at `kind` when it holds none.
 */
function ruleAnchorOf(rules: ReturnType<typeof readResourceRules>, region: RelationRegion): (string | number)[] {
  for (const place of resourceRuleReads(rules).places) {
    const field = place[0];
    if (typeof field !== "string" || field === "*") continue;
    if (isAtOrAbove(region.at, [field]) && region.valueAt([field]) !== undefined) return [field];
  }
  return ["kind"];
}

/**
 * One relation reader per relational group: each instance is found by the
 * census and keyed by its anchor and reads.
 */
const RELATION_READERS: RelationReaderTable = {
  // An inline declaration extraction leaves in place at a reference slot: its
  // kind, whether it can be instantiated, and its config, recursively.
  nested: {
    instances: (region, scope) => {
      const declared = scope.declared(region.identity);
      if (declared.status !== "ok" || !declared.definition.schema) return [];
      return nestedInlineAnchors(region.holder, declared.definition.schema as Record<string, any>)
        .filter(({ keys }) => isAtOrAbove(region.at, keys))
        .map(({ keys }) => ({ anchor: keys }));
    },
    // By name it reads only the named shapes the inline declaration names.
    reads: (instance) => ({ places: [], targets: [identityTarget(instance.anchor)] }),
    judge: (instance, input) => nestedInlineChecks(instance, input),
  },
  // A contract slot typed from a referenced declaration that does not
  // resolve: at the contract the instance writes, and — for a kind's contract
  // derived from the declaration — at the declaration, which it reads whole.
  contracts: {
    instances: (region, scope) => {
      const { identity } = region;
      if (typeof identity.kind !== "string" || identity.kind.startsWith("Telo.") || !isEntryIdentity(identity, scope.rootModules)) {
        return [];
      }
      if (!contractDefinitionOf(identity, scope)) return [];
      const out: RelationInstance[] = [];
      for (const direction of CONTRACT_DIRECTIONS) {
        const own = region.valueAt([direction]);
        if (isAtOrAbove(region.at, [direction]) && own !== undefined && own !== null) out.push({ anchor: [direction] });
      }
      if (region.at.length === 0 && CONTRACT_DIRECTIONS.some((d) => kindContractDerives(identity, d, scope))) out.push({ anchor: [] });
      return out;
    },
    reads: (instance, region, scope) => contractInstanceReads(instance, region, scope),
    judge: (instance, input) => contractProjectionChecks(instance, input),
  },
  // A module call written where a field's plain text is evaluated with no
  // module function bound: the text.
  unboundCalls: {
    instances: (region, scope) => {
      const definition = namedDeclarationDefinition(region.identity, scope);
      if (!definition) return [];
      const schema = authorSchemaOf(definition, scope);
      return uniqueAnchors(
        unboundCallSources(region.holder, schema).map((source) => parseKeys(source.path)),
        region.at,
      );
    },
    reads: () => ({ places: [] }),
    judge: (instance, { identity, value, door }) => {
      const definition = namedDeclarationDefinition(identity, door);
      if (!definition || typeof value !== "string") return [];
      const path = pathText(instance.anchor);
      const reason = unboundCallReason(authorSchemaOf(definition, door), path);
      if (reason === undefined) return [];
      return unboundSourceDiagnostics(
        identityManifest(identity),
        identity.metadata.source as string | undefined,
        [{ path, source: value, reason }],
        door.moduleNames(identity),
        { isOwned: (manifest) => isOwnedByEntry(manifest, door.rootModules) },
      ).map((diagnostic) => ({ diagnostic, judgedAt: path }));
    },
  },
  // What a reference slot's target returns against what the slot reads: the
  // slot, reading its target.
  referenceOutputs: {
    instances: (region, scope) => {
      if (!namedDeclarationDefinition(region.identity, scope)) return [];
      const sites = scope.defs.referenceSites(region.holder as ResourceManifest, scope.aliases, scope.aliasesByModule);
      return uniqueAnchors(
        sites.filter((site) => site.refs.some((ref) => ref.slot.outputType)).map((site) => site.keys),
        region.at,
      );
    },
    reads: (instance, region, scope) => {
      const target = dispatchTarget(region.valueAt(instance.anchor), instance.anchor, "outputType", scope);
      return { places: [], scopes: true, ...(target ? { targets: [target] } : {}) };
    },
    judge: (instance, { identity, value, door }) => {
      const holder = anchorHolder(identity, instance.anchor, value);
      const path = pathText(instance.anchor);
      const site = door.defs.referenceSites(holder, door.aliases, door.aliasesByModule).find((each) => each.path === path);
      if (!site) return [];
      return referenceOutputIssuesAt(holder, site, door.requests, door.defs, door.aliases, doorScopes(door), (reference, at) =>
        door.resolveTarget(reference, at === undefined ? instance.anchor : parseKeys(at)),
      ).map((issue) => relationFindingAt(identity, "REFERENCE_OUTPUT_MISMATCH", `at '${issue.path}', ${issue.message}`, issue.path, false, issue.path));
    },
  },
  // The arguments a reference slot's `inputs:` pointer names against its
  // target's input contract: the slot, reading the argument map and the target.
  slotInputs: {
    instances: (region, scope) => {
      if (!namedDeclarationDefinition(region.identity, scope)) return [];
      const out: RelationInstance[] = [];
      const seen = new Set<string>();
      for (const site of scope.defs.referenceSites(region.holder as ResourceManifest, scope.aliases, scope.aliasesByModule)) {
        const inputsPath = slotInputsPath(site);
        if (inputsPath === undefined || !isAtOrAbove(region.at, site.keys) || seen.has(site.path)) continue;
        seen.add(site.path);
        out.push({ anchor: site.keys, related: [parseKeys(inputsPath)] });
      }
      return out;
    },
    reads: (instance, region, scope) => {
      const target = dispatchTarget(region.valueAt(instance.anchor), instance.anchor, "inputType", scope);
      return { places: instance.related ?? [], scopes: true, ...(target ? { targets: [target] } : {}) };
    },
    judge: (instance, { identity, value, door }) => {
      const inputsKeys = instance.related?.[0];
      if (!inputsKeys || !value || typeof value !== "object" || Array.isArray(value)) return [];
      const values = door.place(inputsKeys);
      if (!values || typeof values !== "object" || Array.isArray(values)) return [];
      const manifest = identityManifest(identity);
      const site = callSiteAt(
        "slot",
        pathText(inputsKeys),
        values as Record<string, any>,
        value as Record<string, any>,
        manifest as Record<string, any>,
        doorCallContext(door, instance.anchor),
      );
      return checkCallSite(site, manifest as Record<string, any>, door.requests, door.defs, door.aliases, doorScopes(door)).map(
        (issue) => callInputFinding(manifest, issue),
      );
    },
  },
  // A step's arguments against its target's input contract, and a live value a
  // re-attempt would lose: the step, reading its target, the results of the
  // steps its arguments forward and the declaration's own input contract.
  stepInputs: {
    instances: (region, scope) => {
      const definition = namedDeclarationDefinition(region.identity, scope);
      const effective = scope.defs.effectiveSchemaOf(definition) as Record<string, any> | undefined;
      if (!effective) return [];
      return uniqueAnchors(
        stepItemsOf(region.holder as Record<string, any>, effective).map((item) => parseKeys(item.path)),
        region.at,
      );
    },
    reads: (instance, region, scope) => {
      const item = stepItemAt(region.identity, instance.anchor, region.valueAt(instance.anchor), scope);
      const forwarded = forwardedReads(item);
      const target = item && dispatchTarget(item.value[item.invokeField], [...instance.anchor, item.invokeField], "inputType", scope, true);
      return {
        places: forwarded.inputs ? ownInputContractPlaces(region.identity, scope) : [],
        scopes: true,
        ...(target ? { targets: [target] } : {}),
        ...(forwarded.steps.length > 0 ? { steps: forwarded.steps } : {}),
      };
    },
    judge: (instance, { identity, value, door }) => {
      const item = stepItemAt(identity, instance.anchor, value, door);
      if (!item) return [];
      const manifest = identityManifest(identity);
      const site = stepCallSiteOf(item, manifest as Record<string, any>, doorCallContext(door, instance.anchor));
      if (!site) return [];
      const forwarded = forwardedReads(item);
      let holder: Record<string, any> = manifest as Record<string, any>;
      if (forwarded.inputs) {
        for (const keys of ownInputContractPlaces(identity, door)) {
          const read = door.place(keys);
          if (keys.length === 0) holder = read as Record<string, any>;
          else if (read !== undefined) holder = { ...holder, [keys[0] as string]: read };
        }
      }
      const stepContext = forwarded.steps.length > 0 ? door.steps() : undefined;
      return checkCallSite(site, holder, door.requests, door.defs, door.aliases, doorScopes(door), stepContext).map((issue) =>
        callInputFinding(manifest, issue),
      );
    },
  },
  // The names a bindings field declares, and a kind pointing the annotation at
  // several fields: the field, reading whether the declaration has a step
  // body; the kind, for the field the annotation is ambiguous about.
  bindings: {
    instances: (region, scope) => {
      const definition = namedDeclarationDefinition(region.identity, scope);
      const sites = definition && findBindingSites(definition.schema as Record<string, any>, scope.defs.shapeLookup);
      if (!sites) return [];
      const out: RelationInstance[] = [];
      if (sites.fields.length > 1 && isAtOrAbove(region.at, ["kind"])) out.push({ anchor: ["kind"] });
      if (isAtOrAbove(region.at, [sites.field]) && region.valueAt([sites.field]) !== undefined) out.push({ anchor: [sites.field] });
      return out;
    },
    reads: (instance, region, scope) => ({
      places: instance.anchor[0] === "kind" ? [] : stepBodyPlaces(region.identity, scope),
    }),
    judge: (instance, input) => bindingChecks(instance, input),
  },
  // An accessor field a plain chain or a literal.
  accessors: {
    instances: (region, scope) => {
      const sites = slotRuleSites(region.identity, scope);
      if (!sites) return [];
      return uniqueAnchors(
        accessorFields(region.holder as Record<string, unknown>, sites).map((field) => field.keys),
        region.at,
      );
    },
    reads: () => ({ places: [] }),
    judge: (instance, { identity, value, door }) => {
      const sites = slotRuleSites(identity, door);
      const path = pathText(instance.anchor);
      const site = sites && accessorFieldAt(sites, path);
      if (!site) return [];
      // A chain rooted at a name the field does not bind is left to the
      // expression's own verdict.
      return accessorProblems({ site, path, keys: [...instance.anchor], value })
        .filter((problem) => problem.unboundRoot === undefined)
        .map((problem) => relationFindingAt(identity, "ACCESSOR_NOT_PLAIN_CHAIN", problem.message, problem.path));
    },
  },
  // A value naming a browser export one the declaring module's entries hold:
  // the object holding the annotated fields and the entry they name, reading
  // the module's `exports.browser`.
  browserExports: {
    instances: (region, scope) => {
      const kindSchema = slotKindSchema(region.identity, scope);
      if (!kindSchema) return [];
      return uniqueAnchors(
        browserExportSites(kindSchema, region.holder).map((site) => exportHolderKeys(parseKeys(site.path))),
        region.at,
      );
    },
    reads: () => ({ places: [] }),
    judge: (instance, { identity, value, door }) => {
      const kindSchema = slotKindSchema(identity, door);
      if (!kindSchema) return [];
      const holder = pathText(instance.anchor);
      const sites = browserExportSites(kindSchema, anchorHolder(identity, instance.anchor, value)).filter(
        (site) => pathText(exportHolderKeys(parseKeys(site.path))) === holder,
      );
      return browserExportProblems(sites, browserEntriesIn(door.requests, identityManifest(identity), door.rootModules)).map(
        (problem) => relationFindingAt(identity, problem.code, problem.message, problem.path),
      );
    },
  },
  // AN EXPRESSION IS NEVER EVALUATED AT OR ABOVE A REFERENCE SLOT — the
  // kernel's own expansion refuses it (`ERR_REF_SLOT_COMPUTED`) from this same
  // reader: each position holding one.
  computedRefSlots: {
    instances: (region, scope) => {
      const sites = slotRuleSites(region.identity, scope);
      if (!sites) return [];
      const positions = scope.defs.referencePositions(region.holder as ResourceManifest, scope.aliases, scope.aliasesByModule);
      return uniqueAnchors(
        computedRefSlots(positions, (path) => evaluatedField(sites, path)).map((slot) => parseKeys(slot.path)),
        region.at,
      );
    },
    reads: () => ({ places: [] }),
    judge: (instance, { identity, value, door }) => {
      const sites = slotRuleSites(identity, door);
      if (!sites) return [];
      const path = pathText(instance.anchor);
      const positions = door.defs.referencePositions(anchorHolder(identity, instance.anchor, value), door.aliases, door.aliasesByModule);
      return computedRefSlots(positions, (at) => evaluatedField(sites, at))
        .filter((slot) => slot.path === path)
        .map((slot) => relationFindingAt(identity, "REF_SLOT_COMPUTED", refSlotComputedReason(slot), slot.path, false, slot.path));
    },
  },
  // A schema matched against an accessor it can never hold for, at a
  // declaration of the entry's own modules and every template-body entry it
  // declares: the matcher field, read with its accessor and what the
  // accessor's chain was typed as.
  match: {
    instances: (region, scope) => {
      if (typeof region.identity.kind !== "string" || !isEntryIdentity(region.identity, scope.rootModules)) return [];
      return matchPlacesOf(region.holder as Record<string, unknown>, region.identity, scope)
        .filter((place) => isAtOrAbove(region.at, place.anchor))
        .map((place) => ({ anchor: place.anchor, related: [place.accessor] }));
    },
    // By name it reads only the named shapes its schema and accessor name.
    reads: (instance) => ({
      places: instance.related ?? [],
      facts: true,
      targets: [instance.anchor, ...(instance.related ?? [])].map(identityTarget),
    }),
    judge: (instance, input) => matchChecks(instance, input),
  },
  // Each value an expression produces against the slot it flows into: the
  // expression, judged once for every slot it flows into and reported by the
  // phase whose slot finds it — its declaration's own fields, a template's
  // top-level `inputs:`, or a call's argument map.
  slotFitOwn: slotFitReader("own"),
  slotFitTemplate: slotFitReader("template"),
  slotFitCalls: slotFitReader("calls"),
  // A kind document's or a named shape's annotations, as declared — in the
  // entry's own modules.
  annotations: {
    instances: (region) => fieldInstances(region, ANNOTATED_DOCUMENTS, ["schema"]),
    // By name it reads only the named shapes the schema names.
    reads: (instance) => ({ places: [], targets: [identityTarget(instance.anchor)] }),
    judge: (_instance, { identity, value, door }) => {
      if (!isEntryIdentity(identity, door.rootModules)) return [];
      return annotationDeclarationProblems(value, ["schema"], door.defs.shapeLookup, identity.kind !== "Telo.JsonSchema").map(
        (problem) => relationFindingAt(identity, problem.code, problem.message, problem.path, problem.warning),
      );
    },
  },
  // A kind's resource rules over a declaration: anchored at its `kind` (the
  // rules judge the declaration, which they read by place), reading the
  // places its rules reach and, by name, what each `resolve:` pointer reaches.
  resourceRules: {
    instances: (region, scope) => {
      const rules = ruleSetOf(region.identity, scope);
      if (!rules) return [];
      const anchor = ruleAnchorOf(rules, region);
      return isAtOrAbove(region.at, anchor) ? [{ anchor }] : [];
    },
    reads: (_instance, region, scope) => {
      const rules = ruleSetOf(region.identity, scope);
      if (!rules) return { places: [] };
      const declared = scope.declared(region.identity);
      const definition = declared.status === "ok" ? declared.definition : undefined;
      const read = resourceRuleReads(
        rules,
        definition ? scope.moduleNames({ identityOnly: true, kind: definition.kind, metadata: (definition.metadata ?? {}) as Record<string, unknown> }) : undefined,
      );
      return {
        places: read.places,
        calls: read.calls,
        targets: read.targets.map((target) => ({ at: target.at, hop: "named" as const, reads: target.reads, transitive: true })),
      };
    },
    judge: (_instance, { identity, door }) => resourceRuleFindings(identity, door, (definition) => authorSchemaOf(definition, door)),
  },
  // A template definition's entry points against the contracts they meet.
  templateTargets: {
    instances: (region) => fieldInstances(region, TEMPLATE_DOCUMENTS, ["inputs", "result"]),
    // `inputs:` reads the dispatched entry's input contract, found through
    // its dispatch slots; `result:` the named shapes its output contract names.
    reads: (instance, region, scope) =>
      instance.anchor[0] === "inputs"
        ? { places: TEMPLATE_TARGET_READS.inputs!, dependent: templateDispatchRead(region.identity, scope) }
        : { places: TEMPLATE_TARGET_READS.result!, targets: [identityTarget(["outputType"])] },
    judge: (instance, input) => templateTargetChecks(instance.anchor[0] as "inputs" | "result", input),
  },
};

/** The groups judged per instance, at relation sites. */
const RELATION_GROUPS = Object.keys(RELATION_READERS) as RelationalGroup[];

function readerOf(group: string): RelationReader {
  const reader = RELATION_READERS[group as RelationalGroup];
  if (!reader) throw new Error(`internal: no relation reader for '${group}'.`);
  return reader;
}

/** A normalized region as a reader reads it. */
function relationRegionOf(manifest: ResourceManifest, at: readonly (string | number)[]): RelationRegion {
  return {
    identity: identityOf(manifest),
    at,
    valueAt: (keys) => (isAtOrAbove(at, keys) ? valueAtKeys(manifest, keys) : undefined),
    holder: manifest,
  };
}

/** What the expression at `path` of `m` was typed as, in `facts`. */
function relationFactsIn(facts: CelFactMaps, m: ResourceManifest, path: string): RelationFacts | undefined {
  const type = facts.typeByPath.get(m)?.get(path);
  const literal = facts.literalByPath.get(m)?.get(path);
  const produced = facts.sourceSchemaByPath.get(m)?.get(path);
  const composed = facts.composedByPath.get(m)?.get(path);
  const variants = facts.variantFacts.get(m)?.get(path);
  const source = facts.sourceByPath.get(m)?.get(path);
  if ([type, literal, produced, composed, variants, source].every((v) => v === undefined)) return undefined;
  return {
    ...(source !== undefined ? { source } : {}),
    ...(type !== undefined ? { type } : {}),
    ...(literal !== undefined ? { literal } : {}),
    ...(produced !== undefined ? { produced } : {}),
    ...(composed !== undefined ? { composed } : {}),
    ...(variants !== undefined ? { variants } : {}),
  };
}

/** Every instance of `reader` in a normalization's manifests at or beneath
 *  the projected keys `at` of its declaration: each with the manifest holding
 *  it, where that manifest stands, and its anchor in the declaration. */
function instancesIn(
  reader: RelationReader,
  manifests: readonly ResourceManifest[],
  at: readonly (string | number)[],
  scope: RelationReaderScope,
) {
  const out: {
    readonly manifest: ResourceManifest;
    readonly position: readonly (string | number)[];
    readonly region: RelationRegion;
    readonly instance: RelationInstance;
    readonly anchor: readonly (string | number)[];
  }[] = [];
  for (const [manifest, position] of positionsOf(manifests)) {
    const local = isAtOrAbove(position, at) ? at.slice(position.length) : isAtOrAbove(at, position) ? [] : undefined;
    if (!local) continue;
    const region = relationRegionOf(manifest, local);
    for (const instance of reader.instances(region, scope)) {
      out.push({ manifest, position, region, instance, anchor: [...position, ...instance.anchor] });
    }
  }
  return out;
}

/** The instance of `group` anchored at a region's root — an internal error
 *  where the reader no longer reports it there (a lost anchor). */
function instanceAtRoot(group: string, part: RegionPart, site: string, scope: RelationReaderScope) {
  const found = instancesIn(readerOf(group), part.manifests, part.at, scope).find(
    (each) => pathText(each.anchor) === pathText(part.at),
  );
  if (!found) throw new Error(`internal: the ${group} reader lost the anchor of ${site} at '${pathText(part.at)}'.`);
  return found;
}

function identityOf(manifest: ResourceManifest): DeclarationIdentity {
  return {
    identityOnly: true,
    kind: manifest.kind,
    metadata: (manifest.metadata ?? {}) as Record<string, unknown>,
  };
}

/** `body` with every named shape some configuration varies registered with
 *  each option of its choices kept: where a relation reader FINDS sites, which
 *  exist wherever any configuration's shape puts them. */
function withCensusShapes<T>(setup: KeySetup, body: () => T): T {
  if (setup.varyingShapes.length === 0) return body();
  return withShapeLayer(setup.defs, setup.sharedShape, () => {
    for (const id of setup.varyingShapes) {
      const shape = setup.censusShape(id);
      if (shape) setup.defs.registerNamedTypeSchema(id, shape);
    }
    return body();
  }).result;
}

const keyReaderScopes = new WeakMap<KeySetup, RelationReaderScope>();

/** What a key's readers read beside a region: the setup's registries, a
 *  forward view of the union read as analysis-only. */
function keyReaderScope(setup: KeySetup): RelationReaderScope {
  let known = keyReaderScopes.get(setup);
  if (!known) {
    const views = new Set(
      setup.union.views.map((view) => {
        const meta = view.manifest.metadata as { name?: unknown; source?: unknown } | undefined;
        return JSON.stringify([view.manifest.kind, meta?.name, meta?.source]);
      }),
    );
    const declaredScope: DeclaredDefinitionScope = {
      defs: setup.defs,
      aliases: setup.aliases,
      aliasesByModule: setup.aliasesByModule,
      rootModules: new Set(setup.rootModules),
      importersByModule: setup.importersByModule,
      analysisOnly: (m) => views.has(JSON.stringify([m.kind, m.metadata?.name, (m.metadata as { source?: unknown } | undefined)?.source])),
    };
    known = {
      defs: setup.defs,
      aliases: setup.aliases,
      aliasesByModule: setup.aliasesByModule,
      rootModules: setup.rootModules,
      libraries: setup.libraries,
      declared: (identity) =>
        declaredDefinitionOf({ kind: identity.kind, metadata: identity.metadata } as ResourceManifest, declaredScope),
      moduleNames: (identity) => moduleCallNamesOf(setup.moduleCallNames, { kind: identity.kind, metadata: identity.metadata } as ResourceManifest),
    };
    keyReaderScopes.set(setup, known);
  }
  return known;
}

/** The scopes a declaration's calls and contracts resolve in. */
function callScopesOf(world: OwnCheckWorld) {
  return { aliasesByModule: world.aliasesByModule, rootModules: world.rootModules, libraries: world.libraries };
}

/**
 * One entry point of a template definition against the contract it meets: its
 * top-level `inputs:` against its dispatch target's `inputType`, or its
 * `result:` against its own output contract — read off the anchor and the
 * places it reads by place.
 */
function templateTargetChecks(entry: "inputs" | "result", { identity, value, door }: RelationRuleInput): RelationFinding[] {
  const { defs, aliases, aliasesByModule, rootModules, libraries } = door;
  const md: Record<string, any> = { kind: identity.kind, metadata: identity.metadata, [entry]: value };
  for (const [field] of TEMPLATE_TARGET_READS[entry]!) {
    const read = door.place([field!]);
    if (read !== undefined) md[field!] = read;
  }
  const scopes = { aliasesByModule, rootModules: rootModules as Set<string>, libraries };
  const out: RelationFinding[] = [];
  const mismatch = (
    targetKind: string,
    valueSchema: Record<string, any>,
    written: unknown,
    path: string,
    /** Only the enumerated call site (`inputs:`) is decoded — the kernel
     *  decodes a definition's argument map at creation and never its
     *  `result:` mapping, which is produced at dispatch. */
    decode = false,
  ) => {
    const standIns: StandIns = new Map();
    const substituted = (decode ? substituteDecodedCelFields : substituteCelFields)(written, valueSchema, undefined, {
      standIns,
      external: door.validator.external,
    });
    for (const issue of door.validator.validate(substituted, valueSchema, standIns)) {
      out.push(
        relationFindingAt(
          identity,
          "TEMPLATE_TARGET_MISMATCH",
          `${path} does not satisfy ${targetKind}'s contract: ${issue.message}`,
          issue.path ? `${path}.${issue.path}` : path,
          false,
          { text: path, mark: "" },
        ),
      );
    }
  };
  if (entry === "inputs") {
    // Top-level `inputs:` carries the values passed to the dispatch target —
    // the site the shared reader names, which the kernel decodes literals
    // through too.
    const templateInputs = templateCallSite(md, {
      defs,
      aliases,
      aliasesByModule,
      rootModules: scopes.rootModules,
      types: door.requests,
      resolveTarget: () => undefined,
    });
    if (templateInputs?.contract) {
      mismatch(templateInputs.invoke.kind as string, templateInputs.contract.schema, templateInputs.values, templateInputs.path, true);
    }
    return out;
  }
  // Top-level `result:` maps the target's output onto THIS definition's
  // output contract — its own `outputType`, else the nearest ancestor's.
  const { invoke, provide } = md;
  const hasDispatchObject =
    (provide && typeof provide === "object" && !Array.isArray(provide)) ||
    (invoke && typeof invoke === "object" && !Array.isArray(invoke));
  if (hasDispatchObject && md.result && typeof md.result === "object") {
    const contractScope = analyzerContractScope(defs, aliases, scopes, door.requests);
    const contract = resolveContract("outputType", undefined, md as unknown as ResourceDefinition, contractScope);
    if (contract) mismatch(contractOwnerLabel(md, contract), contract.schema, md.result, "result");
  }
  return out;
}

const CONTRACT_DIRECTIONS = ["inputType", "outputType"] as const;

/** The definition a declaration's contracts resolve against, in its module. */
function contractDefinitionOf(
  identity: DeclarationIdentity,
  scope: Pick<RelationReaderScope, "defs" | "aliases" | "aliasesByModule" | "rootModules" | "libraries">,
): ResourceDefinition | undefined {
  const { defs, aliases, aliasesByModule, rootModules, libraries } = scope;
  return moduleScopedDefResolver<ResourceDefinition>(defs, aliases, {
    aliasesByModule,
    rootModules: rootModules as Set<string>,
    libraries,
  }).in(identity.kind, identity.metadata.module as string | undefined);
}

type ContractScopes = Pick<RelationReaderScope, "defs" | "aliases" | "aliasesByModule" | "rootModules" | "libraries">;

/** Whether the kind's `direction` contract, resolved along `extends`, derives
 *  a part of itself from the declaration it binds to. */
function kindContractDerives(identity: DeclarationIdentity, direction: ContractDirection, scope: ContractScopes): boolean {
  const definition = contractDefinitionOf(identity, scope);
  if (!definition) return false;
  const { defs, aliases } = scope;
  const kindContract = effectiveContractField(definition, (k) => defs.resolve(aliases.resolveKind(k) ?? k) ?? defs.resolve(k), direction);
  return derivesFromDeclaration(kindContract);
}

/** Whether the contract a declaration writes at the instance's anchor — or the
 *  kind's, where it does not resolve — reads the declaration whole. */
function ownContractReadsWhole(
  instance: RelationInstance,
  identity: DeclarationIdentity,
  value: unknown,
  scope: ContractScopes,
): boolean {
  return derivesFromDeclaration(value) || kindContractDerives(identity, instance.anchor[0] as ContractDirection, scope);
}

/**
 * A slot of a declaration's contract typed from a referenced declaration
 * (`x-telo-schema-projection-from`) that does not resolve: the contract would
 * silently reopen, so it is reported where the projection source is.
 * Entry-module-scoped. One instance judges the contract a declaration writes;
 * the one at the declaration judges each kind contract it does not replace.
 */
function contractProjectionChecks(instance: RelationInstance, { identity, value, door }: RelationRuleInput): RelationFinding[] {
  const ownModule = identity.metadata.module as string | undefined;
  const contractScope = analyzerContractScope(
    door.defs,
    door.aliases,
    { aliasesByModule: door.aliasesByModule, rootModules: door.rootModules as Set<string>, libraries: door.libraries },
    door.requests,
  );
  const definition = contractScope.resolveIn(identity.kind, ownModule);
  if (!definition) return [];
  let md: Record<string, any>;
  let directions: readonly ContractDirection[];
  if (instance.anchor.length === 0) {
    md = value as Record<string, any>;
    directions = CONTRACT_DIRECTIONS.filter((d) => md[d] === undefined || md[d] === null);
  } else {
    const direction = instance.anchor[0] as ContractDirection;
    const whole = ownContractReadsWhole(instance, identity, value, door)
      ? (door.place([]) as Record<string, any> | undefined)
      : undefined;
    md = whole ?? { kind: identity.kind, metadata: identity.metadata, [direction]: value };
    directions = [direction];
  }
  const failures: ProjectionFailure[] = [];
  for (const direction of directions) resolveContract(direction, md, definition, contractScope, failures);
  const out: RelationFinding[] = [];
  for (const failure of failures) {
    if (!isReportedAtConsumer(failure)) continue;
    const path = failure.pointer.replace(/^\//, "");
    out.push({
      diagnostic: {
        severity: DiagnosticSeverity.Error,
        code: "SCHEMA_PROJECTION_FROM_UNRESOLVED",
        source: SOURCE,
        message: `${identity.kind}: ${describeProjectionFailure(failure)}`,
        data: {
          resource: { kind: identity.kind, name: identity.metadata.name as string },
          filePath: identity.metadata.source as string | undefined,
          path,
        },
      },
      judgedAt: path,
    });
  }
  return out;
}

/** A call-site finding at `issue.path`. */
function callInputFinding(m: ResourceManifest, issue: StepInputIssue): OwnFinding {
  const name = (m.metadata as any)?.name as string | undefined;
  return {
    diagnostic: withQuotedPath(
      {
        severity: DiagnosticSeverity.Error,
        code: issue.code ?? "CONTRACT_INPUTS_MISMATCH",
        source: SOURCE,
        message:
          issue.code === "LIVE_VALUE_RETRIED"
            ? `${m.kind}/${name}: at '${issue.path}', ${issue.message}`
            : `${m.kind}/${name}: inputs at '${issue.path}' do not satisfy ${issue.targetLabel}'s declared inputType: ${issue.message}`,
        data: {
          resource: { kind: m.kind, name: name ?? "" },
          filePath: (m.metadata as { source?: string } | undefined)?.source,
          path: issue.path,
        },
      },
      issue.path,
    ),
    judgedAt: issue.path,
  };
}

/**
 * The names a declaration's bindings field declares — a cycle among them, a
 * name shadowing one in scope, naming a module or a CEL keyword, or breaking
 * the naming tiers — at the field, or, at the kind, a schema pointing the
 * annotation at more than one field.
 */
function bindingChecks(instance: RelationInstance, { identity, value, door }: RelationRuleInput): RelationFinding[] {
  const { defs } = door;
  const definition = namedDeclarationDefinition(identity, door);
  const effectiveSchema = defs.effectiveSchemaOf(definition) as Record<string, any> | undefined;
  const m = identityManifest(identity);
  const out: RelationFinding[] = [];
  const report = (diagnostic: AnalysisDiagnostic) =>
    out.push({ diagnostic, judgedAt: (diagnostic.data as { path?: string }).path ?? "" });
  const ambiguity = instance.anchor[0] === "kind";
  // Whether the declaration has a step body: what puts `steps` in scope.
  const stepContext = !ambiguity && stepBodyPlaces(identity, door).some((keys) => Array.isArray(door.place(keys)));
  const celBindingSites = findBindingSites(definition?.schema as Record<string, any>, defs.shapeLookup);
  if (celBindingSites) {
    const declared = ambiguity ? undefined : value;
    const bindingsName = (m.metadata as any)?.name as string | undefined;
    const bindingsFile = (m.metadata as { source?: string } | undefined)?.source;
    const resourceRef = { kind: m.kind, name: bindingsName ?? "" };

    // Which field holds the bindings would otherwise be decided by
    // schema walk order, silently.
    if (ambiguity && celBindingSites.fields.length > 1) {
      report({
        severity: DiagnosticSeverity.Error,
        code: "BINDING_FIELD_AMBIGUOUS",
        source: SOURCE,
        message: `${m.kind}/${bindingsName}: the kind's schema points '${BINDINGS_ANNOTATION}' at more than one field (${celBindingSites.fields.join(", ")}). Every annotated context must name the same bindings field.`,
        data: { resource: resourceRef, filePath: bindingsFile, path: celBindingSites.field },
      });
    }

    if (declared !== null && typeof declared === "object" && !Array.isArray(declared)) {
      for (const cycle of resolveBindingOrder(
        declared as Record<string, unknown>,
        door.moduleNames(identity),
      ).cycles) {
        report({
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
      if (stepContext) inScope.add("steps");
      if (collectErrorContextScopes(effectiveSchema).size > 0) inScope.add("error");
      const keywords = new Set<string>(CEL_RESERVED_WORDS);
      // A module's own names are the third way a binding can be
      // unreadable: `Billing.f(x)` under a binding named `Billing`
      // resolves to the module's function, never to the binding. Not a
      // SHADOWED variable — there is no variable — so it says what it
      // actually collides with.
      const bindingModuleNames = door.moduleNames(identity);

      for (const name of Object.keys(declared)) {
        const shadows = inScope.has(name);
        const namesModule = !shadows && bindingModuleNames.has(name);
        if (shadows || namesModule || keywords.has(name)) {
          report({
            severity: DiagnosticSeverity.Error,
            code: "BINDING_NAME_RESERVED",
            source: SOURCE,
            message: shadows
              ? `${m.kind}/${bindingsName}: binding '${name}' shadows a variable already in scope here (${[...inScope].sort().join(", ")}). Rename the binding — a scope variable always wins, so this one would never be read.`
              : namesModule
                ? `${m.kind}/${bindingsName}: binding '${name}' names a module here (an imports: alias, Self, or this module's own name), so a call written '${name}.f(…)' resolves to that module's function. Rename the binding.`
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
        report({
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
  return out;
}

/** Whether a matcher's node is an expression, not a value written as one. */
function isMatchExpression(node: unknown): boolean {
  return (
    (isTaggedSentinel(node) && !isRefSentinel(node)) ||
    (!!node && typeof node === "object" && (node as { __compiled?: unknown }).__compiled === true)
  );
}

/** Every `x-telo-match-for` field of a declaration and of each template-body
 *  entry it declares, with the accessor it names, by keys in the declaration. */
function matchPlacesOf(
  holder: Record<string, unknown>,
  identity: DeclarationIdentity,
  scope: Pick<RelationReaderScope, "defs" | "aliases" | "aliasesByModule" | "rootModules">,
): { anchor: readonly (string | number)[]; accessor: readonly (string | number)[] }[] {
  const { defs, aliases, aliasesByModule, rootModules } = scope;
  const out: { anchor: readonly (string | number)[]; accessor: readonly (string | number)[] }[] = [];
  const own = defs.effectiveSchemaOf(definitionInScope(defs, identity.kind, identity.metadata, aliases, aliasesByModule)) as
    | Record<string, any>
    | undefined;
  if (own) {
    for (const place of matchPlaces(holder, own, defs.shapeLookup, isMatchExpression)) {
      out.push({ anchor: place.keys, accessor: place.accessorKeys });
    }
  }
  for (const body of templateBodies(holder as unknown as ResourceManifest, defs, aliases, { aliasesByModule, rootModules: rootModules as Set<string> })) {
    const schema = defs.effectiveSchemaOf(body.definition) as Record<string, any> | undefined;
    if (!schema) continue;
    const prefix = parseKeys(body.prefix);
    for (const place of matchPlaces(body.manifest as Record<string, unknown>, schema, defs.shapeLookup, isMatchExpression)) {
      out.push({ anchor: [...prefix, ...place.keys], accessor: [...prefix, ...place.accessorKeys] });
    }
  }
  return out;
}

/**
 * A schema matched against an accessor that it can never hold for — judged
 * against the type the accessor's chain was typed as. A site typed by several
 * referrers is matched under each typing; a schema only some of them refuse
 * names those referrers.
 */
function matchChecks(instance: RelationInstance, { identity, value, door }: RelationRuleInput): RelationFinding[] {
  if (!isEntryIdentity(identity, door.rootModules)) return [];
  const accessorKeys = instance.related?.[0];
  if (!accessorKeys) return [];
  const accessor = door.place(accessorKeys);
  const facts = door.facts(accessorKeys);
  const variants = facts?.variants;
  const typings = Math.max(1, variants?.length ?? 0);
  const found = new Map<string, { labels: Set<string>; count: number }>();
  for (let typing = 0; typing < typings; typing++) {
    const typed = variants ? variants[typing]?.produced : facts?.produced;
    const reason = unsatisfiedMatch(value, accessor, typed, door.defs.shapeLookup, isMatchExpression);
    if (!reason) continue;
    let entry = found.get(reason);
    if (!entry) found.set(reason, (entry = { labels: new Set(), count: 0 }));
    entry.count++;
    const label = variants?.[typing]?.label;
    if (label) entry.labels.add(label);
  }
  const path = pathText(instance.anchor);
  const accessorPath = pathText(accessorKeys);
  return [...found].map(([reason, entry]) => {
    const under = entry.count < typings && entry.labels.size > 0 ? ` (as ${[...entry.labels].join(", ")} references it)` : "";
    return relationFindingAt(
      identity,
      "MATCH_UNSATISFIABLE",
      `the schema at '${path}' can never hold for '${accessorPath}' — ${reason}.${under}`,
      path,
      false,
      [path, { text: accessorPath, anywhere: true }],
    );
  });
}

// The two halves of "does this expression fit the slot it flows into" meet
// here: the engine resolved the expression's type during the walk above,
// and the schema walk recorded the slot. An expression that failed to check
// recorded no type and is already reported by its own diagnostic.
function judgeSlotWith(
  slot: JoinSlot,
  facts: CelSiteFacts,
  expression: string,
  namedShape: ExternalSchemaResolver,
): AnalysisDiagnostic | undefined {
  const found = slotFinding(slot, facts, expression, namedShape);
  return found && withQuotedPath(found, slot.path);
}

function slotFinding(
  slot: JoinSlot,
  facts: CelSiteFacts,
  expression: string,
  namedShape: ExternalSchemaResolver,
): AnalysisDiagnostic | undefined {
  const type = facts.type;
  if (type === undefined) return undefined;
  // A field whose value IS a callable's result is held to the declared
  // result rather than to its own schema, which cannot know it. The declared
  // result is a document of its own.
  const result = declaredResultSchemaAt(slot.schema, slot.manifest, (schema) =>
    shapeNamedBy(schema, schema, namedShape),
  );
  const target = result ?? slot.schema;
  const data = { resource: slot.resource, filePath: slot.filePath, path: slot.path };
  const baseType = type.split("<")[0]!;
  // What declares the slot, as a message names it.
  const holder =
    slot.callTarget !== undefined ? `${slot.callTarget}'s declared inputType` : "the field";
  const hostPath = holdsHostPath(target);
  const fits = celTypeSatisfiesJsonSchema(
    type,
    hostPath
      ? hostPathBranchesFor(
          target,
          facts.literal,
          facts.produced,
        )
      : target,
  );
  // Text that is not a host path is the host-path finding; a value that is
  // not text at all is an ordinary type mismatch.
  if (!fits && hostPath && (baseType === "string" || VALUE_BRAND_BASE[baseType] === "string")) {
    const leading = leadingRelativeLiteral(expression, target);
    return {
      severity: DiagnosticSeverity.Error,
      code: leading !== undefined ? "HOST_PATH_RELATIVE" : "HOST_PATH_UNTYPED_SOURCE",
      source: SOURCE,
      message:
        `${slot.resource.kind}/${slot.resource.name}: '${slot.path}' is a Telo.HostPath, but ` +
        (leading !== undefined
          ? `this expression builds a path starting with '${leading}', which is relative.`
          : `this expression produces a plain '${type}'.`) +
        ` ${HOST_PATH_SOURCES}${alsoAccepts(target)}`,
      data,
    };
  }
  if (!fits) {
    const expected = describeSlotType(target);
    return result
      ? {
          severity: DiagnosticSeverity.Error,
          code: "FUNCTION_RETURN_MISMATCH",
          source: SOURCE,
          message: `${slot.resource.kind}/${slot.resource.name}: CEL at '${slot.path}' returns '${type}' but '${slot.schema[RETURNS_FROM_ANNOTATION]}' declares '${expected}'.`,
          data,
        }
      : {
          severity: DiagnosticSeverity.Error,
          code: "CEL_TYPE_ERROR",
          source: SOURCE,
          message: `${slot.resource.kind}/${slot.resource.name}: CEL at '${slot.path}' returns '${type}' but ${holder} expects '${expected}'.`,
          data,
        };
  }
  // A null is refused at a slot that takes none, whatever the rest of the
  // producer's type is — and the CEL type does not carry it. Only a plain
  // chain has a producer schema to read; a guarded, computed or `dyn`
  // expression says nothing here and is left to the runtime.
  const nullable = facts.produced;
  if (!result && nullable && producerAdmitsNull(nullable) && !slotAdmitsNull(target)) {
    const chain = expression.trim();
    return {
      severity: DiagnosticSeverity.Error,
      code: "CEL_TYPE_ERROR",
      source: SOURCE,
      message:
        `${slot.resource.kind}/${slot.resource.name}: CEL at '${slot.path}' reads '${chain}', ` +
        `which may be null, but ${holder} expects '${describeSlotType(target)}', which does not ` +
        `admit null. Guard it: '${chain} != null ? ${chain} : <a value for the null case>'.`,
      data,
    };
  }
  // The type fits; do its ARGUMENTS agree? Covariant and gradual — an
  // omitted argument is *any* in both directions, so an unmigrated producer
  // or consumer is never reported, and only a definite conflict is.
  // A string that STARTS with relative text is relative whatever follows it
  // — `'data/' + variables.name` — which the expression's text alone decides.
  const leading = holdsHostPath(target)
    ? leadingRelativeLiteral(expression, target)
    : undefined;
  if (leading !== undefined) {
    return {
      severity: DiagnosticSeverity.Error,
      code: "HOST_PATH_RELATIVE",
      source: SOURCE,
      message:
        `${slot.resource.kind}/${slot.resource.name}: '${slot.path}' is a Telo.HostPath, but ` +
        `this expression builds a path starting with '${leading}', which is relative. ` +
        `${HOST_PATH_SOURCES}${alsoAccepts(target)}`,
      data,
    };
  }
  const produced = facts.produced;
  if (!produced) {
    const composed = facts.composed;
    if (!composed) return undefined;
    const misfits = producedValueMisfits(composed, target, namedShape);
    if (misfits.length === 0) return undefined;
    const reasons = misfits.map((conflict) => conflict.message).join("; ");
    return result
      ? {
          severity: DiagnosticSeverity.Error,
          code: "FUNCTION_RETURN_MISMATCH",
          source: SOURCE,
          message:
            `${slot.resource.kind}/${slot.resource.name}: CEL at '${slot.path}' produces a value ` +
            `that disagrees with '${slot.schema[RETURNS_FROM_ANNOTATION]}': ${reasons}.`,
          data,
        }
      : misfits.every((conflict) => conflict.beneathTypeArgument)
        ? {
            severity: DiagnosticSeverity.Error,
            code: "CEL_TYPE_ARGUMENT_MISMATCH",
            source: SOURCE,
            message:
              `${slot.resource.kind}/${slot.resource.name}: CEL at '${slot.path}' produces a value ` +
              `whose type arguments disagree with ${
                slot.callTarget !== undefined ? holder : "the field's"
              }: ${reasons}.`,
            data,
          }
        : {
            severity: DiagnosticSeverity.Error,
            code: "CEL_TYPE_ERROR",
            source: SOURCE,
            message:
              `${slot.resource.kind}/${slot.resource.name}: CEL at '${slot.path}' produces a value ` +
              `that does not fit what ${holder} expects: ${reasons}.`,
            data,
          };
  }
  // A host path forwarded from a source DECLARED as something else — a
  // plain `type: string` field or variable — carries whatever relative text
  // it was given, and is refused at creation for every consumer. The source
  // is what must say what it holds. An undeclared source (an open result)
  // says nothing either way and is left to the runtime.
  if (
    holdsHostPath(target) &&
    !holdsHostPath(produced) &&
    !holdsOnlyConstants(target, undefined, produced) &&
    (produced.type !== undefined ||
      produced["x-telo-type"] !== undefined ||
      unionBranches(produced) !== undefined)
  ) {
    return {
      severity: DiagnosticSeverity.Error,
      code: "HOST_PATH_UNTYPED_SOURCE",
      source: SOURCE,
      message:
        `${slot.resource.kind}/${slot.resource.name}: '${slot.path}' is a Telo.HostPath, but ` +
        `the value it reads is declared '${produced["x-telo-type"] ?? produced.type ?? "a union with no host-path branch"}', so a ` +
        `relative path reaches it unresolved and is refused when the resource is created. ` +
        `Declare the source 'x-telo-type: Telo.HostPath' — a variable resolves a relative ` +
        `value against the working directory; any other source must already hold an ` +
        `absolute one.`,
      data,
    };
  }
  // A host path declared to name one kind of entry, read where the other is
  // wanted, is refused by what it names; at a call site the generic argument
  // comparison below reports it as the call's argument mismatch.
  if (slot.callTarget === undefined && holdsHostPath(target) && holdsHostPath(produced)) {
    const wanted = hostEntryAt(target);
    const declared = hostEntryAt(produced);
    if (wanted !== undefined && declared !== undefined && wanted !== declared) {
      return {
        severity: DiagnosticSeverity.Error,
        code: "HOST_PATH_ENTRY_MISMATCH",
        source: SOURCE,
        message:
          `${slot.resource.kind}/${slot.resource.name}: '${slot.path}' takes the path of ` +
          `${describeHostEntry(wanted)}, but '${expression.trim()}' is declared to name ` +
          `${describeHostEntry(declared)} (entry: ${declared}).`,
        data,
      };
    }
  }
  const { compatible, issues, conflicts } = checkSchemaCompatibility(
    produced,
    target,
    namedShape,
    undefined,
    { targetFillsDefaults: true },
  );
  if (compatible) return undefined;
  return result
    ? {
        severity: DiagnosticSeverity.Error,
        code: "FUNCTION_RETURN_MISMATCH",
        source: SOURCE,
        message:
          `${slot.resource.kind}/${slot.resource.name}: CEL at '${slot.path}' produces a value ` +
          `whose declared shape disagrees with '${slot.schema[RETURNS_FROM_ANNOTATION]}': ${issues.join("; ")}.`,
        data,
      }
    : conflicts.every((conflict) => conflict.beneathTypeArgument)
      ? {
          // Every conflict sits beneath a type argument of a value type
          // both sides name; one outside makes it a shape misfit.
          severity: DiagnosticSeverity.Error,
          code: "CEL_TYPE_ARGUMENT_MISMATCH",
          source: SOURCE,
          message:
            `${slot.resource.kind}/${slot.resource.name}: CEL at '${slot.path}' produces a value ` +
            `whose type arguments disagree with ${
              slot.callTarget !== undefined ? holder : "the field's"
            }: ${issues.join("; ")}.`,
          data,
        }
      : {
          severity: DiagnosticSeverity.Error,
          code: "CEL_TYPE_ERROR",
          source: SOURCE,
          message:
            `${slot.resource.kind}/${slot.resource.name}: CEL at '${slot.path}' reads ` +
            `'${expression.trim()}', whose declared shape does not fit what ${holder} expects: ` +
            `${issues.join("; ")}.`,
          data,
        };
}

/** A value an expression produces, and the slot it flows into. */
type JoinSlot = CelValueSlot & {
  manifest: ResourceManifest;
  resource: { kind: string; name: string };
  filePath?: string;
  /** Set for a call-site argument: the target whose declared inputType the
   *  slot's schema is. */
  callTarget?: string;
};

/** Where a declaration's slots are found: its own fields, a template's
 *  top-level `inputs:`, and the argument maps of its calls. */
type SlotFitPhase = "own" | "template" | "calls";

/** The reader of one slot-fit phase: an instance per `!cel` leaf its phase
 *  may hold a slot for, judged by {@link slotFitAt} and reported only when the
 *  finding is its phase's. */
function slotFitReader(phase: SlotFitPhase): RelationReader {
  return {
    instances: (region, scope) => {
      const { identity } = region;
      if (typeof identity.kind !== "string") return [];
      if (phase === "own" && scope.declared(identity).status !== "ok") return [];
      if (phase === "template" && identity.kind !== "Telo.Definition") return [];
      if (phase === "calls" && typeof identity.metadata.name !== "string") return [];
      // A template body is the body census's, its entries declarations of
      // their own kinds; the definition's own schema holds them open.
      const leaves = celLeavesOf(region.holder, region.at).filter(
        (keys) =>
          identity.kind !== "Telo.Definition" ||
          (phase === "template" ? keys[0] === "inputs" : !TEMPLATE_BODY_FIELDS.includes(String(keys[0]))),
      );
      return uniqueAnchors(leaves, region.at);
    },
    reads: (instance, region, scope) => {
      const reads = slotFitReads(region.identity, instance.anchor, region.holder as Record<string, any>, scope);
      return {
        places: reads.places,
        scopes: true,
        facts: true,
        enclosing: true,
        targets: reads.targets,
        ...(reads.dependent ? { dependent: reads.dependent } : {}),
      };
    },
    judge: (instance, input) => {
      const found = slotFitAt(instance, input);
      return found && found.phase === phase ? [found.finding] : [];
    },
  };
}

/** Every `!cel` leaf of `holder` at or beneath `at`. */
function celLeavesOf(holder: unknown, at: readonly (string | number)[]): (string | number)[][] {
  const out: (string | number)[][] = [];
  const visit = (value: unknown, keys: (string | number)[]): void => {
    if (isTaggedSentinel(value)) {
      if (value.engine === CEL_ENGINE && isAtOrAbove(at, keys)) out.push(keys);
      return;
    }
    if (value === null || typeof value !== "object" || isCompiledValue(value)) return;
    if (keys.length < at.length) {
      const key = at[keys.length]!;
      const child = (value as Record<string | number, unknown>)[key as string];
      if (child !== undefined) visit(child, [...keys, key]);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, i) => visit(item, [...keys, i]));
      return;
    }
    for (const [key, child] of Object.entries(value)) visit(child, [...keys, key]);
  };
  visit(holder, []);
  return out;
}

const validationSchemas = new WeakMap<object, Record<string, any>>();

/** What a declaration's configuration is validated against: its kind's author
 *  schema, `kind` and `metadata` admitted where it is closed. */
function validationSchemaOfDefinition(definition: ResourceDefinition, scope: Pick<RelationReaderScope, "defs" | "aliases">): Record<string, any> {
  let known = validationSchemas.get(definition as unknown as object);
  if (!known) {
    const author = authorSchemaOf(definition, scope);
    known =
      author.additionalProperties === false
        ? { ...author, properties: { kind: { type: "string" }, metadata: { type: "object" }, ...author.properties } }
        : author;
    validationSchemas.set(definition as unknown as object, known);
  }
  return known;
}

/**
 * What the expression at `leaf` reads beside it to be held to its slots: the
 * declaration whole for an import or a resource running a child application
 * (whose slots its own documents type); the field a callable's declared
 * result is read from; each location an `x-telo-value-schema-from` slot
 * holding it is typed by — its first member, and what the pointer reads past
 * the references there; the step or the reference slot whose argument map
 * holds it, with its target's input contract; and a template's dispatch, with
 * the dispatched entry's input contract. Read off `holder`, which holds the
 * way to the leaf and what each object on the way holds beside it.
 */
function slotFitReads(
  identity: DeclarationIdentity,
  leaf: readonly (string | number)[],
  holder: Record<string, any>,
  scope: ContractScopes,
): {
  places: (readonly (string | number)[])[];
  targets: RelationTarget[];
  dependent?: DependentRead;
} {
  const { defs, aliases, aliasesByModule } = scope;
  const definition = namedDeclarationDefinition(identity, scope);
  const author = definition ? authorSchemaOf(definition, scope) : undefined;
  if (identity.kind === "Telo.Import" || (author && readApplicationSourceSlot(author))) {
    return { places: [[]], targets: [] };
  }
  const places = new Map<string, readonly (string | number)[]>();
  const add = (keys: readonly (string | number)[]) => places.set(pathText(keys), keys);
  const targets: RelationTarget[] = [];
  if (author) {
    const schema = validationSchemaOfDefinition(definition!, scope);
    // A field whose value IS a callable's result reads the result it declares.
    const namedShape: ExternalSchemaResolver = (ref) => defs.schemaForId(ref);
    for (const slot of collectCelValueSlots(holder, schema, "", namedShape)) {
      const returns = slot.path === pathText(leaf) ? slot.schema[RETURNS_FROM_ANNOTATION] : undefined;
      if (typeof returns === "string" && returns.length > 0) add(returns.split("/"));
    }
    for (const { scope: at, from } of valueSchemaSlots(schema)) {
      if (!resolveScopeValues(holder, at).some(({ path }) => isAtOrAbove(parseKeys(path), leaf))) continue;
      for (const location of Array.isArray(from) ? from : [from]) {
        const field = typeof location === "string" ? location : (location as { from?: unknown } | undefined)?.from;
        const keys = fieldPlace([], field)?.filter((key): key is string | number => typeof key === "string" || typeof key === "number");
        if (!keys || keys.length === 0) continue;
        // What the one reporter of the annotation reads: its first member, and
        // the rest of the pointer past every reference on the way.
        const first = keys.slice(0, 1);
        add(first);
        const pointer = (field as string).startsWith("/") ? (field as string) : `/${field as string}`;
        targets.push({ at: first, hop: "named", reads: pointerReads([pointer]), transitive: true });
      }
    }
  }
  const effective = defs.effectiveSchemaOf(definition) as Record<string, any> | undefined;
  if (effective) {
    for (const item of stepItemsOf(holder, effective)) {
      const itemKeys = parseKeys(item.path);
      if (!isAtOrAbove([...itemKeys, item.inputsField], leaf)) continue;
      add(itemKeys);
      const target = dispatchTarget(item.value[item.invokeField], [...itemKeys, item.invokeField], "inputType", scope);
      if (target) targets.push(target);
    }
  }
  for (const site of defs.referenceSites(holder as ResourceManifest, aliases, aliasesByModule)) {
    const inputs = slotInputsPath(site);
    if (inputs === undefined || !isAtOrAbove(parseKeys(inputs), leaf)) continue;
    add(site.keys);
    const target = dispatchTarget(valueAtKeys(holder, site.keys), site.keys, "inputType", scope);
    if (target) targets.push(target);
  }
  if (identity.kind === "Telo.Definition" && leaf[0] === "inputs") {
    for (const keys of TEMPLATE_TARGET_READS.inputs!) add(keys);
    return { places: [...places.values()], targets, dependent: templateDispatchRead(identity, scope) };
  }
  return { places: [...places.values()], targets };
}

/** `value` at `keys` of `root`, the containers on the way made where absent. */
function setAtKeys(root: Record<string, any>, keys: readonly (string | number)[], value: unknown): void {
  let holder: Record<string | number, any> = root;
  keys.forEach((key, depth) => {
    if (depth === keys.length - 1) {
      holder[key as string] = value;
      return;
    }
    let next = holder[key as string];
    if (next === null || typeof next !== "object" || Object.keys(next).length === 0) {
      next = typeof keys[depth + 1] === "number" ? [] : {};
      holder[key as string] = next;
    }
    holder = next;
  });
}

/**
 * Every slot the expression at the instance's anchor flows into, judged once:
 * a path that is both an own-field slot and a call-site slot (a whole-map
 * `inputs: !cel`) is held to both declarations and reported once — the
 * call-site judgement when it fails, the own-field one only when it passes. A
 * leaf several conjuncts declare is a slot per declaration, reported for the
 * first it does not fit. Judged under each referrer typing the expression was
 * typed under; a misfit only some of them make names those referrers.
 */
function slotFitAt(
  instance: RelationInstance,
  { identity, value, door }: RelationRuleInput,
): { phase: SlotFitPhase; finding: RelationFinding } | undefined {
  const { defs, aliases, aliasesByModule } = door;
  const rootModules = door.rootModules as Set<string>;
  const leaf = instance.anchor;
  const leafPath = pathText(leaf);
  const namedShape: ExternalSchemaResolver = (ref) => defs.schemaForId(ref);
  // The way to the leaf, what each object on it holds beside it, and what the
  // leaf's slots read.
  let m = anchorHolder(identity, leaf, value) as Record<string, any>;
  for (const { at, members } of door.enclosing()) {
    const holder = at.length === 0 ? m : (valueAtKeys(m, at) as Record<string, any> | undefined);
    if (!holder || Array.isArray(holder)) continue;
    for (const [key, member] of Object.entries(members)) if (!(key in holder)) holder[key] = member;
  }
  for (const keys of slotFitReads(identity, leaf, m, door).places) {
    const read = door.place(keys);
    if (keys.length === 0) m = read as Record<string, any>;
    else setAtKeys(m, keys, read);
  }
  const manifest = m as ResourceManifest;
  const name = identity.metadata.name as string;
  const resource = { kind: identity.kind, name };
  const filePath = identity.metadata.source as string | undefined;
  const slots: (JoinSlot & { phase: SlotFitPhase })[] = [];
  let narrowed: ReadonlySet<string> = new Set();
  // A call site reached by two enumerations (a boot target's inline step is a
  // step and a reference slot) contributes each argument leaf once.
  const callSiteSlots = new Map<string, JoinSlot & { phase: SlotFitPhase }>();
  const atLeaf = (slot: CelValueSlot) => slot.path === leafPath;
  const joinCallSite = (phase: SlotFitPhase, site: CallSiteArguments, label = { kind: identity.kind, name: name ?? "" }) => {
    const enumerated = new Set(callSiteSlots.keys());
    for (const slot of collectCelValueSlots(site.values, site.schema, site.path, namedShape).filter(atLeaf)) {
      if (enumerated.has(slot.path)) continue;
      const joined = { manifest, resource: label, filePath, ...slot, callTarget: site.targetLabel, phase };
      if (!callSiteSlots.has(slot.path)) callSiteSlots.set(slot.path, joined);
      slots.push(joined);
    }
  };

  // Its own fields: what its kind's schema, an import's need and input
  // entries, a child application's inputs and `x-telo-value-schema-from`
  // locations declare.
  const declared = door.declared(identity);
  if (declared.status === "ok") {
    const { definition, ownModule, entryScoped } = declared;
    const schema = validationSchemaOfDefinition(definition, door);
    if (Object.keys(schema).length > 0) {
      const own = (at: unknown, slotSchema: Record<string, any>, path = "") => {
        for (const slot of collectCelValueSlots(at, slotSchema, path, namedShape).filter(atLeaf)) {
          slots.push({ manifest, resource, filePath, ...slot, phase: "own" });
        }
      };
      own(manifest, schema);
      // An import's field-by-field need supply is typed by the TARGET's need
      // type, which the import's own schema cannot know.
      const needSlots = importNeedsSlotSchema(
        manifest,
        (module, kind) => declaringModuleScope(module, aliases, { aliasesByModule, rootModules }).resolveKind(kind),
        (kind) => defs.resolve(kind),
      );
      if (needSlots) own(manifest, needSlots);
      // An import's `variables:` / `secrets:` are typed by the library's
      // declared entries.
      const inputSlots = !ownModule || rootModules.has(ownModule) ? door.importInputsSchema(manifest) : undefined;
      if (inputSlots) own(manifest, inputSlots);
      // A child application's inputs are typed by what the child declares.
      const childSlots = entryScoped ? door.applicationInputsSchema(manifest, schema) : undefined;
      if (childSlots) own(manifest, childSlots);
      // A whole-value chain to an input the configuration decides is held to
      // its slot as that literal, so its site is not judged here.
      narrowed = withNarrowedLiterals(manifest as Record<string, unknown>, door.narrowing?.(ownModule, importPathOf(manifest))?.chains).paths;
      // An `x-telo-value-schema-from` slot's expressions, each held to the
      // type its location reaches.
      const valueSchemaHost = valueSchemaHostOf(
        analyzerContractScope(defs, aliases, { aliasesByModule, rootModules, libraries: door.libraries }, door.requests),
      );
      for (const site of valueSchemaSites(manifest, schema, { types: door.requests, valueSchemaHost })) {
        own(site.value, site.schema, site.path);
      }
    }
  }

  // A template's top-level `inputs:` against its dispatch target's contract.
  if (identity.kind === "Telo.Definition") {
    const templateInputs = templateCallSite(manifest, {
      defs,
      aliases,
      aliasesByModule,
      rootModules,
      types: door.requests,
      resolveTarget: () => undefined,
    });
    if (templateInputs?.contract) {
      joinCallSite("template", {
        path: templateInputs.path,
        values: templateInputs.values,
        schema: templateInputs.contract.schema,
        targetLabel: (templateInputs.invoke.name ?? templateInputs.invoke.kind) as string,
      });
    }
  }

  // The argument maps of its calls: a reference slot's `inputs:` and a step's.
  if (typeof name === "string") {
    const ctx = doorCallContext(door, leaf);
    const argumentMaps: CallSiteArguments[] = [];
    const caller = identityManifest(identity) as Record<string, any>;
    for (const site of defs.referenceSites(manifest, aliases, aliasesByModule)) {
      const inputs = slotInputsPath(site);
      if (inputs === undefined || !isAtOrAbove(parseKeys(inputs), leaf)) continue;
      const invoke = site.data;
      const values = valueAtKeys(manifest, parseKeys(inputs));
      if (!invoke || typeof invoke !== "object" || Array.isArray(invoke)) continue;
      if (!values || typeof values !== "object" || Array.isArray(values)) continue;
      const call = callSiteAt("slot", inputs, values as Record<string, any>, invoke as Record<string, any>, caller, ctx);
      checkCallSite(call, caller, door.requests, defs, aliases, doorScopes(door), undefined, argumentMaps);
    }
    const effective = defs.effectiveSchemaOf(namedDeclarationDefinition(identity, door)) as Record<string, any> | undefined;
    for (const item of effective ? stepItemsOf(manifest, effective) : []) {
      if (!isAtOrAbove([...parseKeys(item.path), item.inputsField], leaf)) continue;
      const call = stepCallSiteOf(item, caller, ctx);
      if (call) checkCallSite(call, caller, door.requests, defs, aliases, doorScopes(door), undefined, argumentMaps);
    }
    for (const site of argumentMaps) joinCallSite("calls", site);
  }

  const facts = door.facts(leaf);
  const judgeSlot = (slot: JoinSlot): AnalysisDiagnostic | undefined => {
    const expression = facts?.source ?? "";
    const variants = facts?.variants;
    if (!variants) {
      return judgeSlotWith(
        slot,
        { type: facts?.type, literal: facts?.literal, produced: facts?.produced, composed: facts?.composed as ProducedValue | undefined },
        expression,
        namedShape,
      );
    }
    const verdicts = variants.map((each) => ({
      label: each.label,
      verdict: judgeSlotWith(slot, each as CelSiteFacts, expression, namedShape),
    }));
    const misfits = verdicts.filter((v) => v.verdict !== undefined);
    if (misfits.length === 0) return undefined;
    const first = misfits[0]!.verdict!;
    if (misfits.length === verdicts.length && misfits.every((v) => v.verdict!.message === first.message)) return first;
    const labels = misfits.map((v) => v.label).filter((l): l is string => l !== undefined);
    return labels.length === 0 ? first : { ...first, message: `${first.message} (as ${labels.join(", ")} references it)` };
  };
  const callSiteVerdicts = new Map<JoinSlot, AnalysisDiagnostic | undefined>();
  for (const slot of slots) {
    if (narrowed.has(slot.path)) continue;
    if (slot.callTarget !== undefined) {
      if (!callSiteVerdicts.has(slot)) callSiteVerdicts.set(slot, judgeSlot(slot));
      const verdict = callSiteVerdicts.get(slot);
      if (verdict) return { phase: slot.phase, finding: { diagnostic: verdict, judgedAt: slot.path } };
      continue;
    }
    const twin = callSiteSlots.get(slot.path);
    if (twin) {
      if (!callSiteVerdicts.has(twin)) callSiteVerdicts.set(twin, judgeSlot(twin));
      if (callSiteVerdicts.get(twin)) continue;
    }
    const verdict = judgeSlot(slot);
    if (verdict) return { phase: slot.phase, finding: { diagnostic: verdict, judgedAt: slot.path } };
  }
  return undefined;
}

/** Which definition a declaration's own checks read, in `world`. */
function declaredDefinitionOfWorld(world: OwnCheckWorld, m: ResourceManifest): DeclaredDefinition {
  return declaredDefinitionOf(m, world.declaredScope);
}

/** Whether a declaration is written in the entry's own modules, as a module
 *  call's owner is told. */
function isOwnedByEntry(manifest: ResourceManifest, rootModules: ReadonlySet<string>): boolean {
  const key = declaringModuleKey(manifest);
  return key === ROOT_MODULE_KEY || rootModules.has(key);
}

/** Findings of `group` judged where `diagnostic` names it. */
function ownFindingsOfGroup(found: readonly AnalysisDiagnostic[], group: OwnGroup): AnalysisDiagnostic[] {
  const out: AnalysisDiagnostic[] = [];
  for (const d of found) {
    const data = d.data as { ownGroup?: string; ownOrigin?: string } | undefined;
    if (data?.ownGroup !== group) continue;
    const { ownGroup, ownOrigin, ...rest } = data;
    out.push({ ...d, data: rest as DiagnosticData });
  }
  return out;
}

/** Whether `m` is one of the entry's own modules' declarations. */
function isEntryDeclaration(m: ResourceManifest, rootModules: ReadonlySet<string>): boolean {
  const module = (m.metadata as { module?: string } | undefined)?.module;
  return !module || rootModules.has(module);
}

/** The definition the manifest walk resolves `m`'s kind to: in the alias scope
 *  of the module that declared it. */
function walkedDefinitionOf(world: OwnCheckWorld, m: ResourceManifest): ResourceDefinition | undefined {
  const resolvedKind = moduleAliasScope(m.metadata, world.aliases, world.aliasesByModule)?.resolveKind(m.kind);
  return (world.defs.resolve(m.kind) ?? (resolvedKind ? world.defs.resolve(resolvedKind) : undefined)) as
    | ResourceDefinition
    | undefined;
}

/** A diagnostic about `m` at `path`, judged there. */
function ownFindingAt(m: ResourceManifest, code: string, message: string, path: string, warning = false): OwnFinding {
  return {
    diagnostic: {
      severity: warning ? DiagnosticSeverity.Warning : DiagnosticSeverity.Error,
      code,
      source: SOURCE,
      message: `${m.kind}/${m.metadata?.name as string}: ${message}`,
      data: {
        resource: { kind: m.kind, name: m.metadata?.name as string },
        filePath: (m.metadata as { source?: string } | undefined)?.source,
        path,
      },
    },
    judgedAt: path,
  };
}

/** One inline declaration extraction left in place at a reference slot: its
 *  kind, whether it can be instantiated, and its config, recursively. */
function nestedInlineChecks(instance: RelationInstance, { identity, value, door }: RelationRuleInput): RelationFinding[] {
  const declared = door.declared(identity);
  if (declared.status !== "ok" || !declared.definition.schema) return [];
  const { scopeResolver } = declared;
  const { defs, aliases } = door;
  // An inline kind resolves in the parent resource's scope: directly, through
  // the owning module's aliases, then through the root's.
  const lookup = (kind: string) => {
    const direct = defs.resolve(kind);
    if (direct) return direct;
    const viaScope = scopeResolver?.resolveKind(kind);
    if (viaScope) {
      const scoped = defs.resolve(viaScope);
      if (scoped) return scoped;
    }
    const viaRoot = aliases.resolveKind(kind);
    return viaRoot ? defs.resolve(viaRoot) : undefined;
  };
  return validateNestedInline(
    value as Record<string, any>,
    pathText(instance.anchor),
    {
      resource: { kind: identity.kind, name: identity.metadata.name as string },
      filePath: identity.metadata.source as string | undefined,
    },
    lookup,
    door.requests,
    door.validator,
    (canonical) => userFacingImplementationsOf(canonical, scopeResolver ?? aliases, defs),
  ).map((diagnostic) => ({ diagnostic, judgedAt: (diagnostic.data as { path?: string }).path ?? "" }));
}

/** The browser entries of the module that declared `m` — its module doc's
 *  `exports.browser`. A declaration with no module stamp is the entry's. */
function browserEntriesIn(
  types: DeclarationRequests,
  m: ResourceManifest,
  rootModules: ReadonlySet<string>,
): readonly BrowserEntry[] {
  const module = (m.metadata as { module?: string } | undefined)?.module;
  const doc = types
    .moduleDocuments()
    .find((candidate) =>
      module === undefined ? rootModules.has(candidate.metadata?.name as string) : candidate.metadata?.name === module,
    );
  return doc ? readBrowserEntries(doc).entries : [];
}

/** The place a schema issue's keyword was evaluated at. */
function judgedPlaceOf(issue: SchemaIssue): string {
  if (issue.keyword !== "required" || issue.missingProperty === undefined) return issue.path;
  const keys = parseKeys(issue.path);
  keys.pop();
  return pathText(keys);
}

/**
 * A declaration's own schema checks: the built-in shape of a `Telo.Abstract`;
 * for a declaration of a resolved kind, its configuration against the kind's
 * author schema (projections resolved, decided inputs as their literals), each
 * `x-telo-value-schema-from` slot against the types its locations name, and a
 * module file named at a host-path slot against the entry the slot names.
 */
function ownSchemaChecks(world: OwnCheckWorld, m: ResourceManifest, declared: DeclaredDefinition): OwnFinding[] {
  const { defs, aliases, rootModules } = world;
  const out: OwnFinding[] = [];
  const filePath = (m.metadata as { source?: string } | undefined)?.source;
  const push = (diagnostic: AnalysisDiagnostic, judgedAt = (diagnostic.data as { path?: string }).path ?? "") =>
    out.push({ diagnostic, judgedAt });
  if (declared.status === "abstract-document") {
    // An abstract is held to the built-in `Telo.Abstract` schema, which the
    // kernel validates it against when it registers.
    const abstractDefinition = defs.resolve("Telo.Abstract");
    if (!abstractDefinition) return out;
    for (const issue of defs.validateResourceConfig(m, world.validationSchemaFor(abstractDefinition))) {
      // `throws:` is the rule-8 pass's, which names the rule.
      if (kindDocumentFindingReportedElsewhere(issue) || /^throws(\.|$)/.test(issue.path)) continue;
      const quoted = quotingIssue(`${m.kind}/${m.metadata?.name as string}: `, issue, issue.path);
      push(
        {
          severity: DiagnosticSeverity.Error,
          code: "SCHEMA_VIOLATION",
          source: SOURCE,
          message: quoted.message,
          data: {
            resource: { kind: m.kind, name: m.metadata?.name as string },
            filePath,
            path: issue.path,
            ...(quoted.quotedPlace ? { quotedPlace: quoted.quotedPlace } : {}),
          },
        },
        judgedPlaceOf(issue),
      );
    }
    return out;
  }
  if (declared.status !== "ok") return out;
  const { definition, ownModule } = declared;
  const resource = { kind: m.kind, name: m.metadata?.name as string };
  const schema = world.validationSchemaFor(definition);
  if (Object.keys(schema).length === 0) return out;
  // A kind's own schema may point a slot at a PROJECTION — of a resource it
  // references, or of this very declaration — resolved per resource. A failure
  // is reported, never dropped: an entry that could not be read vanishes from
  // the projected shape, so the slot typed from it would reject a field the
  // author did declare with nothing saying why.
  const projectionFailures: ProjectionFailure[] = [];
  const projected = resolveSchemaProjections(
    schema,
    m as Record<string, any>,
    world.projectionScope,
    projectionFailures,
  ) as Record<string, any>;
  if (!ownModule || rootModules.has(ownModule)) {
    for (const failure of projectionFailures) {
      // A projection through a library's own resource INPUT is the injection
      // site's to judge.
      if (!isReportedAtConsumer(failure)) continue;
      push({
        severity: DiagnosticSeverity.Error,
        code: "SCHEMA_PROJECTION_FROM_UNRESOLVED",
        source: SOURCE,
        message: `${m.kind}/${resource.name}: ${describeProjectionFailure(failure)}`,
        data: { resource, filePath, path: pointerToPath(failure.pointer) },
      });
    }
  }
  // AJV on substituted data — CEL fields replaced with typed placeholders —
  // through the REGISTRY, so a kind whose schema references a shape declared
  // elsewhere is checked on the instance that holds it. A whole-value chain to
  // an input the configuration decides is held to its slot as that literal.
  const narrowed = withNarrowedLiterals(m as Record<string, unknown>, world.narrowing?.(ownModule, importPathOf(m))?.chains);
  const standIns: StandIns = new Map();
  const ajvIssues = defs.validateResourceConfig(
    // A resource's own config: the kernel decodes its plain-encoded literals
    // when it creates it.
    substituteDecodedCelFields(narrowed.value, projected, undefined, { standIns, external: world.validator.external }),
    projected,
    standIns,
  );
  // Value slots that must satisfy a type declared elsewhere on the resource
  // (`x-telo-value-schema-from`).
  const valueSchemaIssues = collectValueSchemaIssues(
    m as Record<string, any>,
    schema,
    world.types,
    world.validator,
    world.valueSchemaHost,
  );
  const issues = [...ajvIssues, ...valueSchemaIssues];
  // A module file named at a host-path slot that says what the path names,
  // where the loader found the other kind of entry.
  if (!ownModule || rootModules.has(ownModule)) {
    for (const diagnostic of moduleFileEntryMismatches(m, (path) => navigateSchemaToExprPath(projected, path))) {
      push(diagnostic);
    }
  }
  // A child extending without `base:` keeps its parent's `required` on its own
  // surface; a missing field it inherits says so, matched against names derived
  // from the parent, never against the validator's prose.
  const inheritedRequired = inheritedRequiredFields(definition, (k) =>
    defs.resolve(aliases.resolveKind(k) ?? k) ?? defs.resolve(k),
  );
  const parentKind = (definition as { extends?: string } | undefined)?.extends;
  const fulfilment = needTypeOf(definition) !== undefined;
  const kindDocument = m.kind === "Telo.Definition";
  for (const issue of issues) {
    // An undeclared or missing field of a fulfilment is the need table's one
    // report.
    if (fulfilment && needTableReportsFinding(issue)) continue;
    if (kindDocument && kindDocumentFindingReportedElsewhere(issue)) continue;
    // A port's `default: null` is `DEFAULT_INVALID`'s one report.
    if (isNullPortDefaultFinding(m, issue.path)) continue;
    const judgedAt = judgedPlaceOf(issue);
    const inherited =
      issue.keyword === "required" && issue.missingProperty !== undefined
        ? inheritedRequired.filter((f) => f === issue.missingProperty)
        : [];
    const hint =
      inherited.length > 0 && parentKind
        ? ` — ${inherited.map((f) => `'${f}'`).join(", ")} ${inherited.length > 1 ? "come" : "comes"} from '${parentKind}', which this kind extends without a 'base:' mapping, so the parent's required fields stay on this kind's author surface. Add 'base:' to set them internally; that also narrows the surface to this kind's own schema.`
        : "";
    // A value type admitting text refuses one that does not read under its own
    // code, the reason already in the message.
    const label = `${m.kind}/${resource.name}: `;
    const quote = (quoted: { quotedPlace?: QuotedPlace[] }) => (quoted.quotedPlace ? { quotedPlace: quoted.quotedPlace } : {});
    const textRefusal = valueTypeRefusalCode(issue);
    if (textRefusal !== undefined) {
      const quoted = quotingIssue(label, issue, issue.path);
      push(
        {
          severity: DiagnosticSeverity.Error,
          code: textRefusal,
          source: SOURCE,
          message: quoted.message,
          data: { resource, filePath, path: issue.path, ...quote(quoted) },
        },
        judgedAt,
      );
      continue;
    }
    // A relative literal at a host-path slot is its own finding, with the
    // repair that is right when the path names a file of the module.
    if (issue.valueType && VALUE_TYPES.get(issue.valueType)?.fromHost !== undefined) {
      const written = navigatePath(m, issue.path);
      // A tag that always builds a string (`!interpolate`) is a string source
      // whatever its text, never a relative literal to repair.
      const slotSchema = navigateSchemaToExprPath(projected, issue.path);
      if (isTaggedSentinel(written)) {
        push(
          {
            severity: DiagnosticSeverity.Error,
            code: "HOST_PATH_UNTYPED_SOURCE",
            source: SOURCE,
            message:
              `${m.kind}/${resource.name}: '${issue.path}' is a Telo.HostPath, but !${written.engine} ` +
              `produces a plain string. ${HOST_PATH_SOURCES}${alsoAccepts(slotSchema)}`,
            data: { resource, filePath, path: issue.path },
          },
          judgedAt,
        );
        continue;
      }
      const quoted = quotingIssue(label, issue, issue.path, `.${alsoAccepts(slotSchema)}`);
      push(
        {
          severity: DiagnosticSeverity.Error,
          code: "HOST_PATH_RELATIVE",
          source: SOURCE,
          message: quoted.message,
          data: {
            resource,
            filePath,
            path: issue.path,
            ...quote(quoted),
            ...(typeof written === "string" ? { fix: { replacement: written, tag: "module-path" as const } } : {}),
          },
        },
        judgedAt,
      );
      continue;
    }
    const quoted = quotingIssue(label, issue, issue.path, hint);
    push(
      {
        severity: DiagnosticSeverity.Error,
        code: "SCHEMA_VIOLATION",
        source: SOURCE,
        message: quoted.message,
        data: { resource, filePath, path: issue.path, ...quote(quoted) },
      },
      judgedAt,
    );
  }
  return out;
}

/** What marks where a declaration's own-check findings go among a
 *  configuration run's findings: the findings of its sites' keys holding there
 *  are taken at it, judged once outside the run. */
export const OWN_SITE_MARKER = "OWN_SITE_MARKER";

/** What marks where a relation site's findings go among a configuration run's
 *  findings: one per instance the run's declaration holds, its site's key
 *  judged once outside the run. A marker the census holds no anchor for is an
 *  internal error. */
export const RELATION_SITE_MARKER = "RELATION_SITE_MARKER";

/** A forward view an analysis holds, with the consumer its findings are
 *  reported at — and, where the analysis does not hold that consumer (a view
 *  held as a region of the union), the consumer's own origin. */
interface ViewOrigin {
  readonly view: ResourceManifest;
  readonly root: ResourceManifest;
  readonly rootOrigin?: string;
}

/** Whether an origin {@link originsOf} gives is a forward view's. */
function isViewOrigin(origin: string): boolean {
  return (JSON.parse(origin) as unknown[])[0] === "view";
}

/** The written place each of `manifests` is reported at — its root's, through
 *  the run's own placement — the identity a key's findings and a run's marker
 *  share. A forward view, whose root names nothing written, is known by its
 *  consumer's origin and the body entries leading to it; any other manifest
 *  whose root no finding could name, by its own identity. */
function originsOf(
  manifests: readonly ResourceManifest[],
  placed: (found: AnalysisDiagnostic[], filtered: boolean) => AnalysisDiagnostic[],
  views: readonly ViewOrigin[] = [],
): Map<ResourceManifest, string> {
  const probed = [...new Set([...manifests, ...views.filter((v) => v.rootOrigin === undefined).map((v) => v.root)])];
  const probes: AnalysisDiagnostic[] = probed.map((m, i) => ({
    severity: DiagnosticSeverity.Hint,
    code: `${OWN_SITE_MARKER}:${i}`,
    source: SOURCE,
    message: "",
    data: {
      resource: { kind: m.kind, name: m.metadata?.name as string },
      filePath: (m.metadata as { source?: string } | undefined)?.source,
      path: "",
    },
  }));
  const out = new Map<ResourceManifest, string>();
  for (const at of placed(probes, false)) {
    const m = probed[Number(String(at.code).slice(OWN_SITE_MARKER.length + 1))]!;
    const data = at.data as { resource?: { kind?: unknown; name?: unknown }; filePath?: unknown; path?: unknown };
    out.set(m, JSON.stringify([data.resource?.kind, data.resource?.name, data.filePath, data.path]));
  }
  for (const { view, root, rootOrigin } of views) {
    if (out.has(view)) continue;
    out.set(view, JSON.stringify(["view", rootOrigin ?? out.get(root) ?? null, viewChainOf(view, root)]));
  }
  for (const m of manifests) {
    if (!out.has(m)) {
      out.set(m, JSON.stringify(["unplaced", m.kind, m.metadata?.name, (m.metadata as { source?: unknown }).source]));
    }
  }
  return new Map(manifests.map((m) => [m, out.get(m)!]));
}

/** One mapping from a rule declaration issue to a diagnostic — shared by the
 *  declaration check and the later check of the functions a condition calls, so
 *  a repair is carried by both. */
function ruleIssueDiagnostic(issue: ResourceRuleIssue | ReferrerRuleIssue): AnalysisDiagnostic {
  return {
    severity: DiagnosticSeverity.Error,
    code: issue.code,
    source: SOURCE,
    message: issue.message,
    data: {
      resource: { kind: issue.manifest.kind, name: issue.manifest.metadata?.name as string },
      filePath: (issue.manifest.metadata as { source?: string } | undefined)?.source,
      path: issue.path,
      ...(issue.fix ? { fix: issue.fix } : {}),
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

/** Kernel-owned capabilities whose contract declares no entry point. */
const NO_ENTRY_POINT_CAPABILITIES = new Set([
  "Telo.Mount",
  "Telo.Type",
  "Telo.Template",
  "Telo.Sink",
  // A callable's `call(args)` is synchronous and receives no context, so it is
  // deliberately outside `Telo.Executable`: a step's `invoke:` must refuse it,
  // and the kernel's own dispatch finds neither `invoke` nor `run` on the
  // instance (ERR_RESOURCE_NOT_INVOKABLE). A function is reached from inside a
  // CEL expression through its module name, never as a step.
  "Telo.Callable",
]);

/**
 * Validate step `invoke` references (e.g. `Run.Sequence`
 * steps).
 *
 * A schema's reference reach stops at a step body — step `invoke` slots sit in
 * the shared step grammar, and reaching them would make Phase 5 inject live
 * instances there, breaking the invoke dispatch path (see
 * `reference-reach.ts`). A consequence is that `validateReferences` never sees these slots, so a bad
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
  const localNames: ResourceManifest[] = [];
  const loadedModules = new Set<string>();
  /** A dependency's exports, for an export a choice nothing decides stands in for. */
  const forwardedExports: ResourceManifest[] = [];
  const holders = new Map<Record<string, any>, { address: ScopeAddress; scopes: DeclaredScope[] }>();

  // A declaration nested inside a manifest tree outside any scope — an inline
  // one carrying a name of its own — is named at module level too.
  // Conservative: any nested object carrying both a `kind` and a
  // `metadata.name` is a resource definition.
  const collectNestedNames = (value: unknown): void => {
    if (!value || typeof value !== "object" || isTaggedSentinel(value)) return;
    if (Array.isArray(value)) {
      for (const item of value) collectNestedNames(item);
      return;
    }
    const obj = value as Record<string, unknown>;
    // A scope member is a declaration of the set, named in its scope.
    if (isScopeMemberDeclaration(obj)) return;
    const name = (obj.metadata as { name?: unknown } | undefined)?.name;
    if (typeof obj.kind === "string" && typeof name === "string") {
      localNames.push(obj as unknown as ResourceManifest);
    }
    for (const v of Object.values(obj)) collectNestedNames(v);
  };

  for (const r of allManifests) {
    if (r.kind === "Telo.Import") {
      const m = (r.metadata as { resolvedModuleName?: unknown } | undefined)?.resolvedModuleName;
      if (typeof m === "string") loadedModules.add(m);
      continue;
    }
    const meta = r.metadata as { name?: unknown; module?: unknown };
    if (typeof meta?.name !== "string" || isKindDocument(r)) continue;
    if (isForwardedDeclaration(r)) {
      if (typeof meta.module === "string") loadedModules.add(meta.module);
      if (isForwardedExport(r)) forwardedExports.push(r as ResourceManifest);
      continue;
    }
    localNames.push(r as ResourceManifest);
    const address = addressOf(r as ResourceManifest);
    const scopes = declaredScopes(defs.referenceSites(r as ResourceManifest, aliases));
    if (address) holders.set(r, { address, scopes });
    for (const v of Object.values(r)) collectNestedNames(v);
  }
  const names = new ScopedNameResolver(localNames, MANIFEST_READING);

  const validateInvoke = (
    value: unknown,
    holder: Record<string, any>,
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
        // An export a choice nothing decides stands in for is judged once its
        // choice is decided.
        if (
          module &&
          isStandInDeclaration(
            new ScopedNameResolver(forwardedExports, MANIFEST_READING).inModule(
              refName.slice(dot + 1),
              module,
              importPathThrough(holder, aliasPrefix),
            ),
          )
        ) {
          return;
        }
        diagnostics.push(
withQuotedPath({
          severity: DiagnosticSeverity.Error,
          code: "UNRESOLVED_REFERENCE",
          source: SOURCE,
          message: `${resource.kind}/${resource.name}: step invoke at '${path}' → '${refName}' is not an exported instance of module '${module ?? aliasPrefix}' (reference a declared instance, not a kind)`,
          data: { resource, filePath, path },
        }, path),
);
        return;
      }

      const localName = aliasPrefix === "Self" ? refName.slice(dot + 1) : refName;
      const scope = holders.get(holder);
      const within = scope ? scopeSiteAtPath(scope.address, scope.scopes, path) : undefined;
      if (names.resolve(localName, holder.metadata?.module, within)) return;
      diagnostics.push(
withQuotedPath({
        severity: DiagnosticSeverity.Error,
        code: "UNRESOLVED_REFERENCE",
        source: SOURCE,
        message: `${resource.kind}/${resource.name}: step invoke at '${path}' → resource '${localName}' not found`,
        data: { resource, filePath, path },
      }, path),
);
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
      diagnostics.push(
withQuotedPath({
        severity: DiagnosticSeverity.Error,
        code: "REFERENCE_KIND_MISMATCH",
        source: SOURCE,
        message: `${resource.kind}/${resource.name}: step invoke at '${path}' → '${kind}' is a ${capability} and cannot be invoked in a step — it has no invoke or run method (runtime ERR_RESOURCE_NOT_INVOKABLE)`,
        data: { resource, filePath, path },
      }, path),
);
    }
  };

  for (const m of allManifests) {
    const meta = m.metadata as { name?: unknown; source?: unknown };
    if (
      typeof meta?.name !== "string" ||
      isKindDocument(m) ||
      isForwardedDeclaration(m)
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
        validateInvoke(invoke, m, resource, filePath, `${stepPath}.${invokeField}`);
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
/** How the zone walks resolve a kind read off a node of a given module. */
function regionDefResolver(
  defs: DefinitionRegistry,
  aliases: AliasResolver,
  aliasesByModule: Map<string, AliasResolver>,
): (kind: string, module?: string) => ResourceDefinition | undefined {
  return (kind, module) => {
    const scope = moduleAliasScope({ module }, aliases, aliasesByModule);
    const canonical = scope.resolveKind(kind);
    return defs.resolve(kind) ?? (canonical ? defs.resolve(canonical) : undefined);
  };
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
 *  in hand (`judgeSlot`, the join after the CEL walk). A reference is followed
 *  on the way down — a document-local one against the root of the document the
 *  walk is in, a named shape through `external`, which makes that shape the
 *  document — and each slot's schema is returned as the shape it names, read
 *  against that same root (`referenced-shape.ts`). A member or item is read
 *  from every `allOf` conjunct that declares it, so a leaf several declare is
 *  returned once per declaration and must fit each. */
function collectCelValueSlots(
  data: unknown,
  schema: Record<string, any>,
  path: string,
  external: ExternalSchemaResolver,
): CelValueSlot[] {
  return declaredCelSlots(data, schema, path, schema, external).map((slot) => ({
    path: slot.path,
    schema: namedSlotShape(slot, external),
  }));
}

/** A pure-CEL leaf with the schema node declared for it, as written, and the
 *  root of the document that node sits in. With no root the schema is already
 *  the shape it names. */
interface DeclaredCelSlot extends CelValueSlot {
  readonly root?: Record<string, any>;
}

const namedSlotShape = (slot: DeclaredCelSlot, external: ExternalSchemaResolver) =>
  slot.root ? shapeNamedBy(slot.schema, slot.root, external) : slot.schema;

/** A schema node with the root of the document it sits in. */
interface DeclaringNode {
  readonly schema: Record<string, any>;
  readonly root: Record<string, any>;
}

/** The node and every `allOf` conjunct beneath it, each read as the shape it
 *  names in the document that declares it. A value satisfies all of them, so
 *  what any one declares for a member holds for that member. */
function conjunctsOf(
  node: DeclaringNode,
  external: ExternalSchemaResolver,
  seen = new Set<object>(),
): DeclaringNode[] {
  if (seen.has(node.schema)) return [];
  seen.add(node.schema);
  const out = [node];
  for (const member of Array.isArray(node.schema.allOf) ? node.schema.allOf : []) {
    if (member === null || typeof member !== "object" || Array.isArray(member)) continue;
    out.push(...conjunctsOf(resolveRefIn(member, node.root, external), external, seen));
  }
  return out;
}

const isSchemaNode = (value: unknown): value is Record<string, any> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function declaredCelSlots(
  data: unknown,
  raw: Record<string, any>,
  path: string,
  base: Record<string, any>,
  external: ExternalSchemaResolver,
): DeclaredCelSlot[] {
  const slots: DeclaredCelSlot[] = [];

  // A tag whose produced type is fixed (`!interpolate`, `!literal`, an embed)
  // is checked against the slot through its placeholder; only a `!cel` value's
  // type is the expression's own.
  if (isTaggedSentinel(data)) {
    if (data.engine === CEL_ENGINE && raw) slots.push({ path, schema: raw, root: base });
    return slots;
  }
  const { schema, root } = resolveRefIn(raw, base, external);

  // A union has no `items` / `properties` of its own: continue through the ONE
  // branch the value was written against — the selection the placeholder walk
  // and the kernel's pre-validation strip make. Where several branches fit, no
  // branch is guessed: each leaf is held to the union of what every fitting
  // branch declares at its path, so it is refused only when none accepts it.
  if (data !== null && typeof data === "object") {
    const fits = fittingUnionBranches(schema, data, root, external);
    if (fits && fits.length > 1) {
      const byPath = new Map<string, DeclaredCelSlot[]>();
      for (const branch of fits) {
        for (const slot of declaredCelSlots(data, branch, path, root, external)) {
          const held = byPath.get(slot.path) ?? [];
          if (!held.some((other) => other.schema === slot.schema)) held.push(slot);
          byPath.set(slot.path, held);
        }
      }
      for (const [slotPath, held] of byPath) {
        if (held.length === 1) {
          slots.push(held[0]!);
          continue;
        }
        // Each alternative is read in its own document before they are joined.
        slots.push({
          path: slotPath,
          schema: { anyOf: held.map((slot) => namedSlotShape(slot, external)) },
        });
      }
      return slots;
    }
  }
  const selected = selectUnionBranch(schema, data, root, external);
  const entered = selected === schema ? { schema, root } : resolveRefIn(selected, root, external);
  const conjuncts = conjunctsOf(entered, external);
  // What each conjunct declares for one child; where none declares it, the
  // `undeclared` reading, in the document that reading was written in.
  const childSlots = (
    child: unknown,
    childPath: string,
    declaredBy: (conjunct: DeclaringNode) => unknown,
    undeclared: DeclaringNode,
  ): DeclaredCelSlot[] => {
    const declaring = conjuncts.filter((conjunct) => isSchemaNode(declaredBy(conjunct)));
    if (declaring.length === 0) {
      return declaredCelSlots(child, undeclared.schema, childPath, undeclared.root, external);
    }
    return declaring.flatMap((conjunct) =>
      declaredCelSlots(
        child,
        declaredBy(conjunct) as Record<string, any>,
        childPath,
        conjunct.root,
        external,
      ),
    );
  };

  if (Array.isArray(data)) {
    for (let i = 0; i < data.length; i++) {
      slots.push(
        ...childSlots(data[i], `${path}[${i}]`, (conjunct) => conjunct.schema.items, {
          schema: {},
          root: entered.root,
        }),
      );
    }
  } else if (data !== null && typeof data === "object") {
    // An object of a value type's members: each member is a slot of its own, typed
    // by the member's schema with the slot's argument laid over it.
    const members = membersSlotOf(entered.schema);
    if (members) {
      const schemas = memberSlotSchemas(members);
      for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
        if (!schemas[k]) continue;
        slots.push(...declaredCelSlots(v, schemas[k]!, path ? `${path}.${k}` : k, schemas[k]!, external));
      }
      return slots;
    }
    // An undeclared member is a map value, typed by the first conjunct that
    // says what one is and read in that conjunct's own document.
    const mapConjunct = conjuncts.find((conjunct) =>
      isSchemaNode(conjunct.schema.additionalProperties),
    );
    const mapValue: DeclaringNode = mapConjunct
      ? { schema: mapConjunct.schema.additionalProperties, root: mapConjunct.root }
      : { schema: {}, root: entered.root };
    for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
      slots.push(
        ...childSlots(
          v,
          path ? `${path}.${k}` : k,
          (conjunct) => (conjunct.schema.properties as Record<string, unknown> | undefined)?.[k],
          mapValue,
        ),
      );
    }
  }

  return slots;
}

/** What a slot holds, as a type-mismatch message names it: its value type, its
 *  JSON type, or a union's branches (`Telo.HostPath | ":memory:"`). */
function describeSlotType(schema: Record<string, any>): string {
  const branches = schema["x-telo-type"] === undefined ? unionBranches(schema) : undefined;
  if (branches) return branches.map(describeSlotType).join(" | ");
  if ("const" in schema) return JSON.stringify(schema.const);
  const type = readValueTypeSlot(schema)?.name ?? schema.type;
  if (Array.isArray(type)) return type.join(" | ");
  return typeof type === "string" ? type : "unknown";
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
  private readonly celEnv: CelEnvironment;

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
   * `flattenForAnalyzer`, telo studio's `emitDocsFor`, the VSCode
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
    const within = options?.within ?? {};
    // Every `!if` / `!switch` outside a template body: the configurations they
    // read, and the branch each takes in each. The analysis runs once per
    // configuration over that configuration's expansion, and the merge
    // reports each finding once, labelled with the configurations it holds in.
    const documents = manifests.filter(isExpansionSentinel);
    const declarations = documents.length > 0 ? manifests.filter((m) => !isExpansionSentinel(m)) : manifests;
    const written = readChoices(declarations, documents);
    const templated = declarations.some(holdsTemplateConstructs);
    const dependencyTemplates = (options?.moduleDocuments ?? []).some((d) => d.manifests.some(holdsTemplateConstructs));
    if (
      written.sites.length === 0 &&
      !templated &&
      !dependencyTemplates &&
      !manifests.some(holdsTemplateConstructs)
    ) {
      restrictConfigurations([], [{}], within);
      return this.analyzeConfiguration(manifests, options, registry, zoneExportCache).diagnostics;
    }
    const read = this.readConfigurations(manifests, options, registry, written);
    const { choices } = read;
    const scopeRegistry = read.registry;
    // Every template definition's body, read once: the variants it is checked
    // over with no consumer.
    const scope = scopeRegistry._context();
    // A dependency's definition is expanded too, so its body is typed with its
    // bindings in scope, and what is found in it is its own module's to report.
    const entryModules = new Set(
      declarations.filter((m) => isModuleKind(m.kind)).map((m) => m.metadata?.name as string),
    );
    const isOwnDefinition = (m: ResourceManifest) => {
      const module = (m.metadata as { module?: unknown } | undefined)?.module;
      return typeof module !== "string" || entryModules.has(module);
    };
    const templates = declarations.some(holdsTemplateConstructs)
      ? readTemplateDefinitions({
          manifests: declarations,
          reading: readExpansionSites(
            declarations,
            [],
            scope.definitions!,
            scope.aliases,
            scope.aliasesByModule,
            true,
          ),
          registry: scope.definitions!,
          aliases: scope.aliases!,
          aliasesByModule: scope.aliasesByModule ?? new Map(),
        })
      : undefined;
    const variants = options?.skipValidation ? 1 : (templates?.variantCount ?? 1);
    // The configurations `within` keeps, labelled among themselves.
    const restricted = restrictConfigurations(choices.dimensions, choices.configurations, within);
    // A verdict already attested for every configuration needs only the
    // registrations one run makes.
    const configurations = options?.skipValidation ? restricted.configurations.slice(0, 1) : restricted.configurations;
    // The union holds every configuration's expansion whatever `within` keeps,
    // so a branch no configuration takes is read at its own baseline. The
    // configurations kept are the care set of every key some configuration
    // holds: what they do not vary its door holds fixed, and its condition holds
    // only among them.
    const space = new ConditionSpace(choices.dimensions);
    const universe = space.some(configurations.map((a) => space.assignment(a)));
    // Every CEL site, judged once per key outside every configuration run: a
    // context judges a site in a configuration its key's condition holds in.
    const moduleNames = moduleCallNamesByModule(manifests);
    /** The definition a declaration's kind names, read in the module `within`
     *  was written in. */
    const definitionOf = (declaration: Record<string, any>, within: ResourceManifest): ResourceDefinition | undefined => {
      const ctx = scopeRegistry._context();
      const kind = declaration.kind;
      if (typeof kind !== "string") return undefined;
      const metadata = (declaration.metadata as Record<string, unknown> | undefined) ?? within.metadata;
      return definitionInScope(ctx.definitions!, kind, metadata, ctx.aliases!, ctx.aliasesByModule ?? new Map()) as
        | ResourceDefinition
        | undefined;
    };
    const registeredDefinition: DefResolver = (kind) => {
      const ctx = scopeRegistry._context();
      return ctx.definitions!.resolve(ctx.aliases!.resolveKind(kind) ?? kind) ?? ctx.definitions!.resolve(kind);
    };
    const scopedDefinitions = moduleScopedDefResolver<ResourceDefinition>(
      scopeRegistry._context().definitions!,
      scopeRegistry._context().aliases,
      {
        aliasesByModule: scopeRegistry._context().aliasesByModule ?? new Map(),
        rootModules: entryModules,
        libraries: libraryDeclarations(options?.moduleDocuments ?? []),
      },
    );
    // The union of every configuration's expansion, and name resolution over
    // it, each built once.
    const conditioned = options?.skipValidation
      ? undefined
      : this.configurationUnion(manifests, choices, read.refused, scopeRegistry, space);
    const union = conditioned?.union;
    const viewEvaluated = conditioned?.views;
    if (union) {
      assertInvariantKindDocuments(union);
      reportAnalysisReading({ union, universe });
    }
    // The named shapes no configuration varies are the shared registry's: every
    // run keeps the others in a layer of its own, and outside a run they are
    // withheld — a key reaches one only through its door.
    const scopeDefs = scopeRegistry._context().definitions!;
    const isNamedShape = (m: ResourceManifest): boolean => definitionOf(m, m)?.capability === "Telo.Type";
    // A warm boot (`skipValidation`) judges nothing, but promotes the same
    // shapes a cold one does: classified over the union all the same.
    const shapeUnion =
      union ??
      (options?.skipValidation
        ? expandUnion(manifests, space, choices.branchConditions(space), (sentinel) => read.refused.has(sentinel), true, choices.unreachable)
        : undefined);
    const shapes = shapeUnion ? namedShapesOf(shapeUnion, isNamedShape) : undefined;
    const sharedShape = (id: string): boolean => shapes === undefined || shapes.invariant.has(id);
    for (const [id, schema] of read.shapes) if (sharedShape(id)) scopeDefs.registerNamedTypeSchema(id, schema);
    if (shapes) scopeDefs.withholdShapes([...shapes.all, ...read.shapes.keys()].filter((id) => !sharedShape(id)));
    /** A named shape some configuration varies, as `witness` holds it: its
     *  declaration there, canonical in its module, its parents folded as the
     *  registry folds them. */
    // Keyed by what the witness holds, never by its object: every key carries
    // a witness of its own, and most hold one of a few configurations.
    const witnessShapes = new Map<string, (module: string, name: string) => Record<string, any> | undefined>();
    const sentinelIds = new WeakMap<object, number>();
    let nextSentinelId = 0;
    const witnessKey = (witness: Witness): string => {
      const forced = [...(witness.forcing ?? [])].map(([sentinel, branch]) => {
        let id = sentinelIds.get(sentinel as object);
        if (id === undefined) sentinelIds.set(sentinel as object, (id = nextSentinelId++));
        return `${id}=${JSON.stringify(branch)}`;
      });
      return `${assignmentKey(witness.assignment)}|${forced.join(",")}`;
    };
    const shapeAtWitness = (ref: string, witness: Witness): Record<string, any> | undefined => {
      const key = witnessKey(witness);
      let folded = witnessShapes.get(key);
      if (!folded) {
        const ctx = scopeRegistry._context();
        const scope = {
          defs: scopeDefs,
          aliases: ctx.aliases!,
          aliasesByModule: ctx.aliasesByModule ?? new Map(),
          rootModules: entryModules,
        };
        const present: ResourceManifest[] = [];
        for (const declaration of union!.declarations) {
          const m = declaration.manifest;
          if (!isNamedShape(m)) continue;
          if (!takenAt(union!.space, declaration.condition, declaration.path, witness.assignment, witness.forcing)) continue;
          present.push(union!.project(m, witness.assignment, witness.forcing).value as ResourceManifest);
        }
        folded = configuredNamedShapes(
          present,
          scope,
          libraryNamedShapes(options, scopeDefs, scope.aliases, scope.aliasesByModule, scope.rootModules),
        );
        witnessShapes.set(key, folded);
      }
      const named = parseCanonicalTypeSchemaId(ref)!;
      return folded(named.moduleName, named.typeName);
    };
    /** A named shape some configuration varies, with every option of each
     *  declaration's choices kept — what a reader finding relation sites walks. */
    let everyOptionShapes: ReturnType<typeof configuredNamedShapes> | undefined;
    const censusShape = (ref: string): Record<string, any> | undefined => {
      if (!everyOptionShapes) {
        const ctx = scopeRegistry._context();
        const scope = {
          defs: scopeDefs,
          aliases: ctx.aliases!,
          aliasesByModule: ctx.aliasesByModule ?? new Map(),
          rootModules: entryModules,
        };
        const all = union!.declarations
          .filter((declaration) => isNamedShape(declaration.manifest))
          .map((declaration) => everyOptionOf(declaration.manifest) as ResourceManifest);
        everyOptionShapes = configuredNamedShapes(
          all,
          scope,
          libraryNamedShapes(options, scopeDefs, scope.aliases, scope.aliasesByModule, scope.rootModules),
        );
      }
      const named = parseCanonicalTypeSchemaId(ref)!;
      return everyOptionShapes(named.moduleName, named.typeName);
    };
    /** One run, with a named-shape layer of its own when shapes vary. */
    const inShapeLayer = <T>(body: () => T): T => {
      if (!shapes) return body();
      const { result, registered } = withShapeLayer(scopeDefs, sharedShape, body);
      scopeDefs.withholdShapes(registered.keys());
      return result;
    };
    try {
      const keySetup: KeySetup | undefined = union
        ? this.keySetup(
            manifests,
            options,
            scopeRegistry,
            read.expansion,
            templates,
            union,
            choices,
            sharedShape,
            shapeAtWitness,
            [...(shapes?.all ?? [])].filter((id) => !sharedShape(id)),
            censusShape,
            universe,
          )
        : undefined;
      const solution = !union
        ? undefined
        : solveCelSites({
            union,
            names: keySetup!.names,
            universe,
            choices,
            variants,
            moduleNamesOf: (m) => moduleCallNamesOf(moduleNames, m),
            scopeFieldsOf: (holder) => {
              const ctx = scopeRegistry._context();
              return scopeFieldsOf(ctx.definitions!, holder, ctx.aliases!, ctx.aliasesByModule ?? new Map());
            },
            schemaOf: (declaration, within) =>
              scopeRegistry._context().definitions!.effectiveSchemaOf(definitionOf(declaration, within)) as
                | Record<string, any>
                | undefined,
            definitionOf: (declaration, within) =>
              definitionOf(declaration, within) as unknown as Record<string, any> | undefined,
            shapeOf: (ref, witness) =>
              parseCanonicalTypeSchemaId(ref) && !sharedShape(ref)
                ? shapeAtWitness(ref, witness)
                : (scopeDefs.schemaForId(ref) as Record<string, any> | undefined),
            shapeNameOf: (ref) => parseCanonicalTypeSchemaId(ref)?.typeName ?? parseTeloTypeRef(ref)?.typeName,
            isNamedShape,
            scopeAt: (declaration, projected, keys) => {
              const address = addressOf(declaration.manifest);
              if (!address) return undefined;
              const ctx = scopeRegistry._context();
              const sites = scopeDefs.referenceSites(projected as ResourceManifest, ctx.aliases, ctx.aliasesByModule);
              return scopeSiteAt(address, declaredScopes(sites), keys);
            },
            moduleForAlias: (alias, within) =>
              moduleAliasScope(within.metadata, scopeRegistry._context().aliases!, scopeRegistry._context().aliasesByModule ?? new Map())
                .moduleForAlias(alias),
            kindContractOf: (declaration, within, direction) =>
              effectiveContractField(definitionOf(declaration, within), registeredDefinition, direction),
            mayReportObservedState: (kind, within) => {
              const definition = definitionOf({ kind }, within);
              if (!definition) return false;
              const reports = analyzedKind(scopedDefinitions, kind, within.metadata?.module as string | undefined);
              if (reports.status || reports.reading) return true;
              // A template body may stand up a resource that reports.
              return [definition, ...ancestorChain(definition, registeredDefinition)].some((d) =>
                TEMPLATE_BODY_FIELDS.some((field) => (d as unknown as Record<string, unknown>)[field] !== undefined),
              );
            },
            evaluatedBeforeForward: viewEvaluated!,
            reportsObservedState: (present, witness) => this.reportsObservedStateAt(keySetup!, present, witness),
            bodyCensus: (variant) => this.bodyCensus(keySetup!, universe, variant),
            judgeKey: (request) => this.judgeKey(keySetup!, request),
            ownSchemas: {
              rootOf: (value, within) => {
                const definition = definitionOf(value, within);
                return definition ? effectiveAuthorSchema(definition, registeredDefinition) : undefined;
              },
              sharedShape: (ref) =>
                parseCanonicalTypeSchemaId(ref) && sharedShape(ref)
                  ? (scopeDefs.schemaForId(ref) as Record<string, any> | undefined)
                  : undefined,
              nestedPlacesOf: (declaration) => {
                const started = observingKeyCosts() ? performance.now() : undefined;
                const ctx = scopeRegistry._context();
                const places = nestedPlacesOf(union, declaration, (projected) =>
                  nestedDeclarationsOf([projected], ctx.definitions!, ctx.aliases!, ctx.aliasesByModule ?? new Map()),
                );
                if (started !== undefined) {
                  reportKeyCost({ kind: "nested-places", enumerations: places.enumerations, milliseconds: performance.now() - started });
                }
                return places;
              },
            },
            judgeOwnKey: (request) => this.judgeOwnKey(keySetup!, request),
            relationGroups: RELATION_GROUPS,
            relationAnchors: (group, declaration, unionKeys, witness, variant) => {
              const part = keySetup!.parts.regionAt(declaration, unionKeys, witness, variant);
              return withCensusShapes(keySetup!, () =>
                instancesIn(readerOf(group), part.manifests, part.at, keyReaderScope(keySetup!)).map((each) => each.anchor),
              );
            },
            relationReads: (group, declaration, unionKeys, witness, variant, carved) => {
              const part = keySetup!.parts.regionsAt(declaration, [unionKeys], witness, variant, carved);
              return withCensusShapes(keySetup!, () => {
                const found = instanceAtRoot(group, part, `${declaration.manifest.kind}/${declaration.manifest.metadata?.name}`, keyReaderScope(keySetup!));
                const reads = readerOf(group).reads(found.instance, found.region, keyReaderScope(keySetup!));
                const at = (keys: readonly (string | number)[]) => [...found.position, ...keys];
                const shifted = (found: DependentReads): DependentReads => ({
                  places: found.places.map(at),
                  ...(found.targets ? { targets: found.targets.map((target) => ({ ...target, at: at(target.at) })) } : {}),
                  ...(found.dependent ? { dependent: shiftedRead(found.dependent) } : {}),
                });
                const shiftedRead = (dependent: DependentRead): DependentRead => (place) => shifted(dependent((keys) => place(at(keys))));
                return { ...reads, ...shifted(reads) };
              });
            },
            judgeRelationKey: (request) => this.judgeRelationKey(keySetup!, request),
          });
      // The passes that carry conditions, each run once over the union.
      const passTables: Record<UnionPassName, PassFindings> | undefined = solution
        ? (() => {
            const { defs, aliases, aliasesByModule, rootModules, names } = keySetup!;
            reportConditionedPass("duplicateNames", false);
            reportConditionedPass("unusedDeclarations", false);
            reportConditionedPass("sinkAttachment", false);
            reportConditionedPass("observedStateDeclarations", false);
            return {
              observedStateDeclarations: observedStateDeclarationFindings(space, manifests),
              duplicateNames: duplicateNameFindings(union!, union!.declarations.map((d) => d.manifest)),
              unusedDeclarations: unusedDeclarationFindings(space, manifests),
              sinkAttachment: sinkAttachmentFindings(union!, names, defs, aliases, aliasesByModule, rootModules),
            };
          })()
        : undefined;
      const passesAt = (assignment: Assignment): PassFindingsAt | undefined =>
        passTables ? (pass) => passTables[pass].holdingAt(assignment) : undefined;
      /** The findings a configuration run's site markers stand for: each site's
       *  verdict there, under its key's condition and the run's. */
      const conditionOf = new WeakMap<AnalysisDiagnostic, Condition>();
      let ruleReach: ReturnType<typeof importReach> | undefined;
      const placeSites = (
        diagnostics: readonly AnalysisDiagnostic[],
        verdictOf: (site: string) => CelSiteVerdict | undefined,
        ownFindingsOf: (origin: string) => readonly AnalysisDiagnostic[],
        relationFindingsOf: (marker: RelationMarker) => RelationFound,
        condition: Condition,
      ): AnalysisDiagnostic[] => {
        const out: (AnalysisDiagnostic | readonly AnalysisDiagnostic[])[] = [];
        const claimed = new Set<string>();
        const ruleReports = new ResourceRuleReports((module) => (ruleReach ??= importReach(manifests, entryModules)).of(module));
        for (const diagnostic of diagnostics) {
          if (diagnostic.code === RELATION_SITE_MARKER) {
            const data = diagnostic.data as {
              relationGroup?: string;
              resource?: { kind?: unknown; name?: unknown };
              filePath?: unknown;
              path?: unknown;
              forwardedFrom?: string;
            };
            const relation = relationFindingsOf({
              group: data.relationGroup ?? "",
              kind: data.resource?.kind,
              name: data.resource?.name,
              source: data.filePath,
              path: String(data.path ?? ""),
              ...(data.forwardedFrom === undefined ? {} : { forwardedFrom: data.forwardedFrom }),
            });
            // A view's instances are taken together, at the first of them.
            if (relation.claim !== undefined) {
              if (claimed.has(relation.claim)) continue;
              claimed.add(relation.claim);
            }
            const settled = ruleReports.settle(relation.diagnostics);
            for (const found of settled) conditionOf.set(found, condition);
            // A view's findings are weighed against everything else the run
            // reports, once it is all in.
            if (relation.claim !== undefined) out.push(settled);
            else out.push(...settled);
            continue;
          }
          if (diagnostic.code === OWN_SITE_MARKER) {
            const { ownOrigin: origin, ownGroup: group } = diagnostic.data as { ownOrigin?: string; ownGroup?: OwnGroup };
            if (origin === undefined || group === undefined) {
              throw new Error("internal: an own-check marker names no declaration or no group.");
            }
            const own = ownFindingsOfGroup(ownFindingsOf(origin), group);
            for (const found of own) conditionOf.set(found, condition);
            // A view's findings are weighed against everything else the run
            // reports, once it is all in.
            if (isViewOrigin(origin)) out.push(own);
            else out.push(...own);
            continue;
          }
          if (diagnostic.code !== CEL_SITE_MARKER) {
            out.push(diagnostic);
            continue;
          }
          const { celSite, occurrence } = diagnostic.data as { celSite: string; occurrence: number };
          // Every site a run holds is one the union holds, or a template body's.
          if (!solution?.keys.has(celSite)) {
            throw new Error(`internal: the CEL site ${celSite} of a configuration run has no solved key.`);
          }
          // A site's findings are its whole verdict, placed at its first occurrence.
          if (occurrence !== 0) continue;
          for (const found of verdictOf(celSite)?.diagnostics ?? []) {
            conditionOf.set(found, condition);
            out.push(found);
          }
        }
        for (const found of ruleReports.unexercised()) {
          conditionOf.set(found, condition);
          out.push(found);
        }
        // A forward view's finding the run reports otherwise — same code, same
        // place — is dropped, as a configuration's analysis places them.
        const reported = out.filter((entry): entry is AnalysisDiagnostic => !Array.isArray(entry));
        const forwarded = withoutForwardedDuplicates(reported, out.filter((entry) => Array.isArray(entry)).flat());
        const kept = new Set(forwarded);
        return out.flatMap((entry) => (Array.isArray(entry) ? entry.filter((d) => kept.has(d)) : [entry as AnalysisDiagnostic]));
      };
      let reading: ExpansionReading | undefined;
      const findings: DefinitionFinding[] = [];
      const ordered: ConditionedFinding[] = [];
      let firstRun: AnalysisDiagnostic[] | undefined;
      for (const assignment of configurations) {
        const at = space.assignment(assignment);
        for (let variant = 0; variant < variants; variant++) {
          const run = inShapeLayer(() => this.analyzeConfiguration(manifests, options, registry, zoneExportCache, {
            run: "configuration",
            decisions: choices.decide(assignment),
            narrowing: choices.narrowing(assignment),
            ...(templates ? { template: { definitions: templates, index: variant } } : {}),
            decidedValue: (holder, source) => choices.valueIn(holder, source, assignment),
            ...(solution
              ? {
                  cel: { mode: "configuration" as const, verdictOf: (site: string) => solution.verdictAt(site, assignment, variant) },
                  own: true as const,
                  passes: passesAt(assignment)!,
                }
              : {}),
          }));
          reading ??= run.expansion;
          if (solution && observingRelationParity()) {
            this.checkRelationParity(keySetup!, solution, { assignment }, variant, run.reportsObservedState);
          }
          // What a stand-in's place holds is judged once its choice is decided.
          const standIns = choices.standIns(assignment);
          const diagnostics =
            standIns.length === 0
              ? run.diagnostics
              : withoutRefusedExpansionConsequences(run.diagnostics, { sites: [], diagnostics: [], refused: standIns });
          const closed = placeSites(
            diagnostics,
            (site) => solution?.verdictAt(site, assignment, variant),
            (origin) => solution!.ownFindingsAt(origin, assignment, variant),
            (marker) => solution!.relationFindingsAt(marker, assignment, variant),
            at,
          );
          if (!templates) {
            firstRun ??= closed;
            for (const diagnostic of closed) ordered.push({ diagnostic, condition: conditionOf.get(diagnostic) ?? at });
            continue;
          }
          // A definition's body findings are labelled by its own variants; the
          // rest of the analysis is the same in every variant, and taken once.
          const own: AnalysisDiagnostic[] = [];
          for (const diagnostic of closed) {
            const found = definitionFindingOf(diagnostic, templates, variant);
            if (!found) {
              if (variant === 0) own.push(diagnostic);
              continue;
            }
            if (!isOwnDefinition(found.definition)) continue;
            if (found.variant.forced !== undefined && !isUnderPath(found.path, found.variant.forced)) continue;
            const { assignment: chosen, dimensions } = found.variant.assignmentAt(found.path);
            findings.push({
              diagnostic,
              configuration: assignmentKey(assignment),
              assignment: chosen,
              dimensions,
              forced: found.variant.forced !== undefined,
            });
          }
          if (variant === 0) {
            firstRun ??= own;
            for (const diagnostic of own) ordered.push({ diagnostic, condition: conditionOf.get(diagnostic) ?? at });
          }
        }
      }
      if (options?.skipValidation) {
        return [...(firstRun ?? []), ...findings.map((f) => f.diagnostic)];
      }
      const byKey = new Map(configurations.map((a) => [assignmentKey(a), space.assignment(a)]));
      const conditionOfKeys = (keys: ReadonlySet<string> | undefined): Condition =>
        keys ? space.some([...keys].map((key) => byKey.get(key) ?? FALSE)) : universe;
      for (const found of choices.diagnostics) {
        if (reading && withoutRefusedExpansionConsequences([found.diagnostic], reading).length === 0) continue;
        // Outside the configurations `within` keeps a finding holds nowhere; one
        // holding in no configuration at all is still reported.
        if (found.configurations && found.configurations.size > 0) {
          const kept = new Set([...found.configurations].filter((key) => restricted.keys.has(key)));
          if (kept.size === 0) continue;
          ordered.push({ diagnostic: found.diagnostic, condition: conditionOfKeys(kept) });
          continue;
        }
        ordered.push({ diagnostic: found.diagnostic, condition: conditionOfKeys(found.configurations) });
      }
      for (const labelled of labelDefinitionFindings(findings)) {
        ordered.push({ diagnostic: labelled.diagnostic, condition: conditionOfKeys(labelled.configurations) });
      }
      if (templates) {
        for (const diagnostic of templates.diagnostics) {
          const data = diagnostic.data as { resource?: { name?: unknown }; filePath?: unknown } | undefined;
          const definition = templates.definitions.find(
            (d) => d.metadata?.name === data?.resource?.name && (d.metadata as { source?: unknown }).source === data?.filePath,
          );
          if (definition && isOwnDefinition(definition)) ordered.push({ diagnostic, condition: universe });
        }
      }
      // A branch no configuration takes is still checked: expanded in a
      // configuration reaching its choice, with that branch taken, and only what
      // is found inside it kept — in no configuration, which its label says. Its
      // expressions are judged there, once, outside the run, whatever `within`
      // keeps; the run asks only for the sites in its reach.
      for (const unreachable of choices.unreachable) {
        const decisions = new Map(choices.decide(unreachable.baseline));
        decisions.set(unreachable.site.sentinel, unreachable.branch);
        const verdictOf = (site: string) => solution?.verdictInDeadBranch(site, unreachable.site.sentinel as object, unreachable.branch);
        const run = inShapeLayer(() => this.analyzeConfiguration(manifests, options, registry, zoneExportCache, {
          run: "unreachable",
          decisions,
          narrowing: choices.narrowing(unreachable.baseline),
          ...(templates ? { template: { definitions: templates, index: 0 } } : {}),
          decidedValue: (holder, source) => choices.valueIn(holder, source, unreachable.baseline),
          cel: { mode: "configuration", verdictOf },
          ...(solution ? { own: true as const, passes: () => [] } : {}),
        }));
        if (solution && observingRelationParity()) {
          this.checkRelationParity(
            keySetup!,
            solution,
            { assignment: unreachable.baseline, forcing: new Map([[unreachable.site.sentinel, unreachable.branch]]) as unknown as Forcing },
            0,
          );
        }
        const holder = unreachable.site.holder;
        const meta = holder.metadata as { name?: unknown; source?: unknown } | undefined;
        const holderKind = holder.kind ?? expansionTagLabel(holder);
        const at = choicePathOf(unreachable.keys);
        const ownFindingsOf = (origin: string) =>
          solution!.ownFindingsInDeadBranch(origin, unreachable.site.sentinel as object, unreachable.branch);
        const relationFindingsOf = (marker: RelationMarker) =>
          solution!.relationFindingsInDeadBranch(marker, unreachable.site.sentinel as object, unreachable.branch);
        for (const diagnostic of placeSites(run.diagnostics, verdictOf, ownFindingsOf, relationFindingsOf, FALSE)) {
          const data = diagnostic.data as
            | { resource?: { kind?: unknown; name?: unknown }; filePath?: unknown; path?: unknown }
            | undefined;
          if (
            data?.resource?.kind !== holderKind ||
            data.resource.name !== meta?.name ||
            data.filePath !== meta?.source ||
            typeof data.path !== "string" ||
            !(data.path === at || data.path.startsWith(`${at}.`) || data.path.startsWith(`${at}[`))
          ) {
            continue;
          }
          ordered.push({ diagnostic, condition: FALSE });
        }
      }
      const merged = mergeConditionedDiagnostics(ordered, space, universe, restricted.dimensions);
      const branchesDropped = withoutRefusedExpansionConsequences(merged, {
        sites: [],
        diagnostics: merged.filter((d) => d.code === "BRANCH_CASE_INVALID"),
        refused: choices.refusedBranches,
      });
      return templates
        ? withoutRefusedExpansionConsequences(branchesDropped, {
            sites: [],
            diagnostics: merged.filter((d) => templates.diagnostics.some((t) => t.code === d.code && sameDataPath(t, d))),
            refused: templates.refused,
          })
        : branchesDropped;
    } finally {
      scopeDefs.releaseWithheldShapes();
    }
  }

  /**
   * The configurations `manifests` can start in, as the analysis reads them:
   * the dimensions of the whole space, every configuration `options.within`
   * keeps, and the union of every configuration's expansion over the whole
   * space with each element's presence condition — the one `analyze` reads,
   * whatever `within` keeps — beside the one configuration's expansion it
   * projects to.
   */
  configurationsOf(
    manifests: ResourceManifest[],
    options?: AnalysisOptions,
    registry?: AnalysisRegistry,
  ): {
    readonly dimensions: readonly Dimension[];
    readonly configurations: readonly Assignment[];
    readonly union: ConditionedExpansion;
    /** The branches no configuration takes, each with a configuration reaching
     *  its choice. */
    readonly unreachable: readonly UnreachableBranch[];
    expansionAt(assignment: Assignment): ResourceManifest[];
    /** The expansion of `assignment` with `forcing`'s choices taking the branch
     *  it names, and how its positions move back to where they are written. */
    expansionOf(assignment: Assignment, forcing?: Decisions): ChoiceExpansion;
    /** The forward views the one view builder makes over `assignment`'s own
     *  expansion — with `forcing`'s choices taking the branch it names — each
     *  projected there: its content and its place map. */
    viewsAt(assignment: Assignment, forcing?: Decisions): readonly { readonly view: ConditionedView; readonly projected: Projected }[];
  } {
    assertManifestPositions(manifests);
    const documents = manifests.filter(isExpansionSentinel);
    const declarations = documents.length > 0 ? manifests.filter((m) => !isExpansionSentinel(m)) : manifests;
    const { choices, refused, registry: scopeRegistry } = this.readConfigurations(
      manifests,
      options,
      registry,
      readChoices(declarations, documents),
    );
    const restricted = restrictConfigurations(choices.dimensions, choices.configurations, options?.within ?? {});
    const skip = (sentinel: ExpansionSentinel) => refused.has(sentinel);
    const { union } = this.configurationUnion(manifests, choices, refused, scopeRegistry, new ConditionSpace(choices.dimensions));
    return {
      dimensions: choices.dimensions,
      configurations: restricted.configurations,
      union,
      unreachable: choices.unreachable,
      expansionAt: (assignment) => expandChoices(manifests, choices.decide(assignment), skip, true).manifests,
      expansionOf: (assignment, forcing) => {
        const decisions = new Map(choices.decide(assignment));
        for (const [sentinel, branch] of forcing ?? []) decisions.set(sentinel, branch);
        return expandChoices(manifests, decisions, skip, true);
      },
      viewsAt: (assignment, forcing) => {
        // The same builder over the configuration's own expansion: a union of
        // no choice, every value it decides read in this configuration.
        const decisions = new Map(choices.decide(assignment));
        for (const [sentinel, branch] of forcing ?? []) decisions.set(sentinel, branch);
        const one = expandUnion(
          expandChoices(manifests, decisions, skip, true).manifests,
          new ConditionSpace([]),
          new Map(),
        );
        this.holdForwardViews(
          one,
          scopeRegistry,
          (holder, source) => {
            const decided = choices.valueIn(holder, source, assignment);
            return decided && [{ value: decided.value, condition: TRUE }];
          },
          this.runNestedConsumers(one, scopeRegistry),
        );
        return one.views.map((view) => ({ view, projected: one.project(view.manifest, {}) }));
      },
    };
  }

  /**
   * The union of every configuration's expansion over the whole space, each
   * element under its condition there, and its forward views held beside it:
   * what an analysis reads whatever `within` keeps.
   */
  private configurationUnion(
    manifests: ResourceManifest[],
    choices: ChoiceReading,
    refused: ReadonlySet<unknown>,
    registry: AnalysisRegistry,
    space: ConditionSpace,
  ): { union: ConditionedExpansion; views: ViewEvaluation } {
    const union = expandUnion(
      manifests,
      space,
      choices.branchConditions(space),
      (sentinel) => refused.has(sentinel),
      true,
      choices.unreachable,
    );
    const views = this.holdForwardViews(
      union,
      registry,
      (holder, source) => choices.valueOutcomes(holder, source, space),
      this.liftedNestedConsumers(union, registry),
    );
    return { union, views };
  }

  /**
   * Every consumer a configuration's run analyses beneath one of its own
   * declarations (`one`, a union of no choice) — inline at any depth, or a
   * scope member — as the run enumerates them: each held at its keys in the
   * declaration holding it, under the name the run gives it.
   */
  private runNestedConsumers(one: ConditionedExpansion, registry: AnalysisRegistry): ConditionedDeclaration[] {
    const ctx = registry._context();
    const found = nestedDeclarationsOf(
      one.declarations.map((d) => d.manifest),
      ctx.definitions!,
      ctx.aliases!,
      ctx.aliasesByModule ?? new Map<string, AliasResolver>(),
    );
    const out: ConditionedDeclaration[] = [];
    for (const { top, keys, name, scope } of found) {
      const declaration = one.declarations[top]!;
      let value: unknown = declaration.manifest;
      for (const key of keys) value = (value as Record<string | number, unknown> | undefined)?.[key];
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const manifest = nestedConsumerManifest(value as Record<string, unknown>, declaration.manifest, name);
      declareInScope(manifest, scope);
      one.hold(manifest as unknown as object, keys);
      out.push({ condition: TRUE, manifest, holder: declaration.holder, at: keys, path: [], declaredIn: declaration });
    }
    return out;
  }

  /**
   * Every consumer a configuration's run analyses beneath a declaration of the
   * union, lifted: each object of a templated kind written there (at any depth,
   * in every option) that the run of a witness taking it analyses as a
   * declaration of its own — held at where it is written, under the
   * declaration's holding AND the options on the way to it, and the name that
   * run gives it.
   */
  private liftedNestedConsumers(union: ConditionedExpansion, registry: AnalysisRegistry): ConditionedDeclaration[] {
    const ctx = registry._context();
    const defs = ctx.definitions!;
    const aliases = ctx.aliases!;
    const aliasesByModule = ctx.aliasesByModule ?? new Map<string, AliasResolver>();
    const rootModules = new Set(
      union.declarations.filter((d) => isModuleKind(d.manifest.kind)).map((d) => d.manifest.metadata?.name as string),
    );
    const { space } = union;
    type RunNamed = { readonly name: string; readonly scope: ScopeSite | undefined };
    const runs = new Map<ConditionedDeclaration, Map<string, ReadonlyMap<string, RunNamed>>>();
    /** The nested declarations the run at a witness analyses in `declaration`,
     *  by where each is written: its name, and the scope it is declared in. */
    const runAt = (declaration: ConditionedDeclaration, assignment: Assignment, forcing?: Forcing): ReadonlyMap<string, RunNamed> => {
      let byWitness = runs.get(declaration);
      if (!byWitness) runs.set(declaration, (byWitness = new Map()));
      const key = `${assignmentKey(assignment)}\0${[...(forcing ?? [])].map(([, branch]) => String(branch)).join(",")}`;
      let found = byWitness.get(key);
      if (!found) {
        const projected = union.project(declaration.manifest, assignment, forcing);
        found = new Map(
          nestedDeclarationsOf([projected.value as ResourceManifest], defs, aliases, aliasesByModule).map((n) => [
            pathText(parseKeys(relocatePath(pathText(n.keys), projected.places.mappings))),
            { name: n.name, scope: n.scope },
          ]),
        );
        byWitness.set(key, found);
      }
      return found;
    };
    const out: ConditionedDeclaration[] = [];
    for (const candidate of nestedCandidatesOf(union, defs, aliases, { aliasesByModule, rootModules })) {
      const { declaration, holding, dead } = candidate;
      const forcing = dead ? (new Map([[dead.sentinel, dead.branch]]) as unknown as Forcing) : undefined;
      const assignment = dead ? dead.baseline : space.firstAssignment(holding.condition);
      if (!assignment || (forcing && !takenAt(space, holding.condition, holding.path, assignment, forcing))) continue;
      const named = runAt(declaration, assignment, forcing).get(pathText(candidate.written));
      if (named === undefined) continue;
      const manifest = nestedConsumerManifest(candidate.value, declaration.manifest, named.name);
      declareInScope(manifest, named.scope);
      union.hold(manifest as unknown as object, candidate.written);
      out.push({
        condition: holding.condition,
        manifest,
        holder: declaration.holder,
        at: candidate.written,
        path: holding.path,
        declaredIn: declaration,
        ...(holding.condition === FALSE ? { unreachable: true as const } : {}),
      });
    }
    return out;
  }

  /**
   * Every forward view of `union`'s declarations, held beside them: the one
   * view builder over every configuration at once, each consumer's body
   * expanded lifted — a value a choice decides read in each of its options, a
   * value chained to a dimension in each value `valueOutcomes` gives it, a
   * reference in each declaration it names where it names it.
   */
  private holdForwardViews(
    union: ConditionedExpansion,
    registry: AnalysisRegistry,
    valueOutcomes: (
      holder: ResourceManifest,
      source: string,
    ) => readonly { readonly value: unknown; readonly condition: Condition }[] | undefined,
    /** The consumers written beneath its declarations, each held in it. */
    nested: readonly ConditionedDeclaration[],
  ): ViewEvaluation {
    const ctx = registry._context();
    const defs = ctx.definitions!;
    const aliases = ctx.aliases!;
    const aliasesByModule = ctx.aliasesByModule ?? new Map<string, AliasResolver>();
    const { space } = union;
    const manifests = union.declarations.map((d) => d.manifest);
    const rootModules = new Set(
      manifests.filter((m) => isModuleKind(m.kind)).map((m) => m.metadata?.name as string),
    );
    const names = new ConditionedNameIndex(union);
    const declared = new Map(union.declarations.map((d) => [d.manifest as object, d] as const));
    const moduleOfManifest = (m: ResourceManifest): string | undefined => {
      const module = (m.metadata as { module?: unknown } | undefined)?.module;
      return typeof module === "string" ? module : undefined;
    };
    /** Every declaration `value` names, read in `holder`, each where. */
    const targetsOf = (value: unknown, holder: ResourceManifest, within: ScopeSite | undefined) => {
      const target = refSentinelTarget(value);
      if (!target) return undefined;
      const scope = moduleAliasScope(holder.metadata, aliases, aliasesByModule);
      const module = target.alias === undefined || target.alias === "Self" ? undefined : scope?.moduleForAlias(target.alias);
      if (target.alias !== undefined && target.alias !== "Self" && module === undefined) {
        return [{ declaration: undefined, holding: EVERYWHERE }];
      }
      const outcomes =
        module === undefined
          ? names.locate("local", target.name, moduleOfManifest(holder), within)
          : names.inModule("exported", target.name, module, importPathThrough(holder, target.alias!));
      return outcomes.map(({ outcome, condition }) => {
        const declaration = declarationOf(outcome);
        const path = (declaration && declared.get(declaration)?.path) ?? [];
        if (outcome.status === "unresolved" || !outcome.address.scope) return { declaration, holding: { condition, path } };
        // A scope member as written: declared in its scope, by its holder's
        // module, so what it references resolves there too.
        declareInScope(outcome.declaration, outcome.address.scope);
        return { declaration, holding: { condition, path }, module: outcome.address.module };
      });
    };
    const sites = new WeakMap<object, Map<string, Set<string>>>();
    const steps = new WeakMap<object, Map<string, object>>();
    const syntheticStep = (holder: ResourceManifest, source: string): object => {
      let bySource = steps.get(holder);
      if (!bySource) steps.set(holder, (bySource = new Map()));
      let step = bySource.get(source);
      if (!step) bySource.set(source, (step = {}));
      return step;
    };
    const consumers = readTemplateConsumers({
      manifests: [...manifests, ...nested.map((d) => d.manifest)],
      // Lifted, a reference is read through the conditioned name index alone.
      names: namesResolution([]),
      registry: defs,
      aliases,
      aliasesByModule,
      rootModules,
      decidedValue: () => undefined,
      lift: {
        space,
        declarationsAt: (value, at) =>
          targetsOf(value, at.holder, declaringScopeOf(at.holder))?.map((t) => ({
            declaration: t.declaration,
            module: t.declaration ? moduleOfManifest(t.declaration) : undefined,
            holding: t.holding,
          })),
        valueOutcomes: (holder, source) => {
          const outcomes = valueOutcomes(holder, source);
          if (!outcomes) return undefined;
          // Decided by a dimension: a step of its own, so a forced witness
          // reads it by its condition.
          const sentinel = syntheticStep(holder, source) as ChoiceStep["sentinel"];
          return outcomes.map(({ value, condition }, i): { value: unknown; holding: Holding } => ({
            value,
            holding: condition === TRUE ? EVERYWHERE : { condition, path: [{ sentinel, branch: String(i), taken: condition }] },
          }));
        },
        emitted: (value, instance, forwards) =>
          forwards === undefined
            ? value
            : { __templateForward: { holder: forwards[0]?.holder as ResourceManifest, keys: [], outcomes: forwards } },
        writtenAt: (consumer) => union.placeOf(consumer).at,
      },
    });
    const built = buildForwardViews({
      union,
      consumers: [...union.declarations, ...nested],
      crossing: {
        isSite: (holder, keys, holding) => {
          const assignment = space.firstAssignment(holding.condition) ?? space.firstAssignment(TRUE) ?? {};
          let byWitness = sites.get(holder);
          if (!byWitness) sites.set(holder, (byWitness = new Map()));
          const key = assignmentKey(assignment);
          let found = byWitness.get(key);
          if (!found) {
            const projected = union.project(holder, assignment).value as ResourceManifest;
            const scope = moduleAliasScope(holder.metadata, aliases, aliasesByModule);
            found = new Set(
              defs
                .referenceSites(projected, scope, aliasesByModule)
                .filter((site) => site.refs.length > 0)
                .map((site) => site.path),
            );
            byWitness.set(key, found);
          }
          return found.has(formatPath(keys));
        },
        targets: (value, holder) => targetsOf(value, holder, declaringScopeOf(holder)),
      },
      registry: defs,
      aliases,
      scopes: { aliasesByModule, rootModules },
      bodyOf: (consumer) => consumers.expansions.get(consumer)?.expansion.definition,
      taken: new Set(
        [...manifests, ...nested.map((d) => d.manifest)].flatMap((m) => (typeof m.metadata?.name === "string" ? [m.metadata.name] : [])),
      ),
    });
    const held = new Map<ResourceManifest, ConditionedDeclaration>(
      [...union.declarations, ...nested].map((d) => [d.manifest, d]),
    );
    // Where each object a declaration of the union holds stands in it, by union
    // keys: a scope member a crossing is held by is read in its holder there.
    const writtenIn = new Map<ConditionedDeclaration, WeakMap<object, readonly (string | number)[]>>();
    const unionKeysOf = (holder: ConditionedDeclaration, member: object): readonly (string | number)[] | undefined => {
      let known = writtenIn.get(holder);
      if (!known) {
        const found = new WeakMap<object, readonly (string | number)[]>();
        const visit = (value: unknown, keys: readonly (string | number)[]): void => {
          if (isAlternatives(value)) {
            for (const option of value.options) if (option.present) visit(option.value, keys);
            return;
          }
          if (value === null || typeof value !== "object" || isTaggedSentinel(value)) return;
          if (!found.has(value)) found.set(value, keys);
          if (Array.isArray(value)) value.forEach((item, i) => visit(item, [...keys, i]));
          else for (const [key, field] of Object.entries(value)) visit(field, [...keys, key]);
        };
        visit(holder.manifest, []);
        writtenIn.set(holder, (known = found));
      }
      return known.get(member);
    };
    /** A crossing held by a scope member, as a crossing of the declaration of
     *  the union holding the member: the member's place, then the path. */
    const heldCrossing = (crossing: BuiltView["crossed"][number]): ViewCrossing => {
      const holder = held.get(crossing.holder);
      if (holder) return { holder, at: crossing.at, rest: crossing.rest };
      for (const declaration of union.declarations) {
        const keys = unionKeysOf(declaration, crossing.holder);
        if (keys) return { holder: declaration, at: [...keys, ...crossing.at], rest: crossing.rest };
      }
      throw new Error(
        `internal: a forward crosses a reference held by ${crossing.holder.kind}/${crossing.holder.metadata?.name}, which no declaration of the union holds.`,
      );
    };
    const linksOf = new Map<ConditionedView, BuiltView>();
    for (const view of built.views) {
      const conditioned: ConditionedView = {
        condition: view.holding.condition,
        path: view.holding.path,
        manifest: view.manifest,
        holder: view.root.holder,
        at: view.root.at,
        consumer: view.root,
        upstream: held.get(view.upstream) ?? view.root,
        entryKind: view.entryKind,
        entryName: view.entryName,
        crossed: view.crossed.map(heldCrossing),
        ...(view.root.unreachable ? { unreachable: true as const } : {}),
      };
      held.set(view.manifest, conditioned);
      linksOf.set(conditioned, view);
      union.addView(conditioned);
    }
    // A view's place holds a value its upstream evaluated before forwarding it
    // where the upstream's kind marks the path it came from compile-eval — at
    // any template further out.
    const evaluatedBefore = (view: ConditionedView, unionKeys: readonly (string | number)[]): boolean => {
      const path = formatPath(unionKeys);
      const link = linksOf.get(view)?.links.find((l) => l.at === path || path.startsWith(`${l.at}.`) || path.startsWith(`${l.at}[`));
      if (!link) return false;
      const upstreamPath = link.from + path.slice(link.at.length);
      if (celEvalModeAt(built.sites.get(view.upstream.manifest) ?? NO_CEL_EVAL_SITES, upstreamPath) === "compile") return true;
      const outer = view.upstream as ConditionedView;
      return linksOf.has(outer) && evaluatedBefore(outer, parseKeys(upstreamPath));
    };
    return evaluatedBefore;
  }

  /** What every configuration's analysis reads before it runs: the set's
   *  definitions registered, then its choices read in the scope they
   *  register, and the constructs the expansion reader refuses. */
  private readConfigurations(
    manifests: ResourceManifest[],
    options: AnalysisOptions | undefined,
    registry: AnalysisRegistry | undefined,
    written: ChoiceReading,
  ): {
    choices: ChoiceReading;
    registry: AnalysisRegistry;
    refused: ReadonlySet<unknown>;
    expansion: ExpansionReading | undefined;
    /** The named shapes the registration run registered, none of them shared
     *  yet. */
    shapes: ReadonlyMap<string, Record<string, any>>;
  } {
    const documents = manifests.filter(isExpansionSentinel);
    const declarations = documents.length > 0 ? manifests.filter((m) => !isExpansionSentinel(m)) : manifests;
    // A choice's module calls and its branches' kinds are read in the scope the
    // set's own declarations register, so they are registered first.
    const scopeRegistry = registry ?? new AnalysisRegistry();
    const first = written.configurations[0]!;
    // Which named shapes a configuration varies is read off the union, which
    // the choices read here decide: until then every shape stays this run's.
    const defs = scopeRegistry._context().definitions!;
    let registration: ReturnType<StaticAnalyzer["analyzeConfiguration"]> | undefined;
    let choices = written;
    const shapes = withShapeLayer(defs, () => false, () => {
      registration = this.analyzeConfiguration(manifests, { ...options, skipValidation: true }, scopeRegistry, undefined, {
        run: "setup",
        decisions: written.decide(first),
        narrowing: written.narrowing(first),
      });
      const consumerReads = registration.consumerReads ?? [];
      if (written.sites.length > 0 || consumerReads.length > 0) {
        choices = readChoices(
          declarations,
          documents,
          choiceScopeOf(manifests, scopeRegistry, [], registeredNeedTable(manifests, scopeRegistry, options?.moduleDocuments)),
          consumerReads,
          refusedSentinels(registration.expansion),
        );
      }
    }).registered;
    const refused = refusedSentinels(registration!.expansion);
    return { choices, registry: scopeRegistry, refused, expansion: registration!.expansion, shapes };
  }

  /** What every key's environment reads, built once per analysis. */
  private keySetup(
    manifests: ResourceManifest[],
    options: AnalysisOptions | undefined,
    registry: AnalysisRegistry,
    expansion: ExpansionReading | undefined,
    templates: TemplateDefinitions | undefined,
    union: ConditionedExpansion,
    choices: ChoiceReading,
    sharedShape: (id: string) => boolean,
    shapeAt: (id: string, witness: Witness) => Record<string, any> | undefined,
    varyingShapes: readonly string[],
    censusShape: (id: string) => Record<string, any> | undefined,
    /** The configurations kept: the care of every key some configuration holds. */
    universe: Condition,
  ): KeySetup {
    const ctx = registry._context();
    const declarations = manifests.filter((m) => !isExpansionSentinel(m));
    const rootModules = new Set<string>();
    for (const m of declarations) {
      if (isModuleKind(m.kind) && m.metadata?.name) rootModules.add(m.metadata.name as string);
    }
    const names = new ConditionedNameIndex(union);
    const kept = doorCare(union, universe);
    const whole = doorCare(union);
    const careAt = (witness: Witness): DoorCare => {
      if (witness.forcing) return whole;
      if (!union.space.holds(universe, witness.assignment)) {
        throw new Error(`internal: a key is read at ${assignmentKey(witness.assignment)}, which no configuration kept is, with no branch forced.`);
      }
      return kept;
    };
    const byName = new Map<string, ConditionedDeclaration[]>();
    const moduleDocuments: ConditionedDeclaration[] = [];
    const kindsAndImports: ConditionedDeclaration[] = [];
    for (const declaration of union.declarations) {
      const name = declaration.manifest.metadata?.name;
      if (typeof name === "string") byName.set(name, [...(byName.get(name) ?? []), declaration]);
      if (isModuleKind(declaration.manifest.kind)) moduleDocuments.push(declaration);
      if (isKindDocumentOrImport(declaration.manifest)) kindsAndImports.push(declaration);
    }
    const libraryManifests = new Map<string, ResourceManifest[]>();
    for (const doc of options?.moduleDocuments ?? []) libraryManifests.set(doc.module, doc.manifests);
    let moduleBases: readonly ResourceManifest[] | undefined;
    const typedEnvironments = new TypedEnvironments();
    const defs = ctx.definitions!;
    const aliases = ctx.aliases!;
    const aliasesByModule = ctx.aliasesByModule ?? new Map();
    const parts = new KeyParts({
      union,
      names,
      careAt,
      defs,
      aliases,
      aliasesByModule,
      templates,
      scopeFieldsOf: (holder) => scopeFieldsOf(defs, holder, aliases, aliasesByModule),
    });
    return {
      manifests,
      options,
      defs,
      aliases,
      aliasesByModule,
      rootModules,
      libraries: libraryDeclarations(options?.moduleDocuments ?? []),
      moduleCallNames: moduleCallNamesByModule(manifests),
      templates,
      expansion,
      templated: manifests.some(holdsTemplateConstructs),
      union,
      views: new Set(union.views),
      names,
      careAt,
      moduleDocumentsVary: union.declarations.some(
        (d) =>
          isModuleKind(d.manifest.kind) &&
          Object.entries(d.manifest).some(([key, field]) => key !== "targets" && holdsChoice(field)),
      ),
      choices,
      sharedShape,
      shapeAt,
      censusShape,
      parts,
      byName,
      moduleDocuments,
      moduleBases: (witness) => {
        moduleBases ??= moduleDocuments
          .filter((declaration) => parts.presentAt(declaration, witness))
          .map((declaration) => {
            const base = { ...(parts.partAt(declaration, witness, 0).manifests[0] as Record<string, unknown>) };
            delete base.targets;
            typedEnvironments.identify(base);
            return base as unknown as ResourceManifest;
          });
        return moduleBases;
      },
      globalsOverlays: new ModuleGlobalsOverlays(),
      kindsAndImports,
      writtenRefusals: new Set(expansion?.diagnostics ?? []),
      libraryManifests,
      typedEnvironments,
      sharedFunctions: new WeakMap(),
      importersByModule: importersByModuleOf(
        union.declarations.map((d) => d.manifest),
        rootModules,
      ),
      varyingShapes,
    };
  }

  /** The module functions the shared layer declares, indexed once. */
  private sharedFunctionsOf(setup: KeySetup, shared: SharedLayer): ModuleFunctionIndex {
    let index = setup.sharedFunctions.get(shared);
    if (!index) {
      index = new ModuleFunctionIndex(
        listRequests(shared.manifests),
        setup.defs,
        setup.aliases,
        setup.aliasesByModule,
        setup.rootModules,
      );
      setup.sharedFunctions.set(shared, index);
    }
    return index;
  }

  /**
   * The declarations of `selection` present at the door's witness — with every
   * declaration no configuration varies whose part is not the same at every
   * witness, and, read `whole`, every module document — each normalized as a configuration's
   * analysis normalizes it (`key-parts.ts`): a template definition's body in
   * `variant`, inline declarations extracted, references stamped with what
   * they resolve to at the witness, scope members collected. Beneath them
   * stands the shared layer of `variant`. A declaration reached by name
   * (`byName`) is held as the regions read in it, found by its name. For the
   * declarations of `group` (the site's own and what is drawn out of it), the
   * consumer expansions and the forward views.
   */
  private normalizeKey(
    setup: KeySetup,
    scope: DoorScope,
    variant: number,
    selection: Iterable<ConditionedDeclaration>,
    views: "group" | "none",
    /** Regions normalized on their own a judgement reads, placed with the rest. */
    regions: readonly RegionPart[] = [],
    /** Whether the module documents are held whole, rather than read as each
     *  declaring module's globals base. */
    whole = false,
    /** The region of `regions` the site's own checks run over, in place of its
     *  declaration. */
    ownRegion?: RegionPart,
    /** The declarations the key reaches by name only as some of their regions,
     *  by those regions' union paths: each one some configuration it is judged
     *  for varies is held as those regions, normalized on their own and found
     *  by name — never whole. */
    byName: ReadonlyMap<ConditionedDeclaration, readonly (readonly (string | number)[])[]> = new Map(),
    /** The declarations of `selection` held whole by name, and the readers
     *  holding each so. */
    wholeByName: ReadonlyMap<ConditionedDeclaration, ReadonlySet<WholeNameReader>> = new Map(),
  ): KeyNormalization {
    const { defs, aliases, aliasesByModule, rootModules, options, parts: cache } = setup;
    const { witness } = scope;
    const shared = cache.sharedLayer(variant, witness);
    if (observingKeyCosts()) {
      const varying = [...setup.union.declarations, ...setup.union.views].filter(
        (declaration) => cache.presentAt(declaration, witness) && !scope.care.invariant.has(declaration),
      );
      reportKeyCost({ kind: "varying", live: !witness.forcing, declarations: varying.length });
    }
    const selected = new Set<ConditionedDeclaration>();
    for (const each of whole ? [selection, setup.moduleDocuments, shared.dependent] : [selection, shared.dependent]) {
      for (const declaration of each) if (cache.presentAt(declaration, witness)) selected.add(declaration);
    }
    if (ownRegion && !regions.includes(ownRegion)) {
      throw new Error(`internal: the region of own-check site ${scope.site} is not among the regions its key normalizes.`);
    }
    // A declaration no configuration of the care varies is the shared layer's,
    // or held whole beside it.
    const byNameParts: RegionPart[] = [];
    let byNameExtent = 0;
    for (const [declaration, roots] of byName) {
      if (selected.has(declaration) || !cache.presentAt(declaration, witness)) continue;
      // Listed among the key's own declarations — what `resources` publishes —
      // as the shared layer's own part.
      if (scope.care.invariant.has(declaration)) {
        selected.add(declaration);
        continue;
      }
      byNameParts.push(cache.regionsAt(declaration, roots, witness, variant));
      if (observingKeyCosts()) byNameExtent += cache.extentAt(declaration, roots, witness);
    }
    const held = byNameParts.length === 0 ? regions : [...regions, ...byNameParts];
    if (scope.own && !selected.has(scope.own)) {
      throw new Error(`internal: the declaration of CEL site ${scope.site} is absent where its key is read.`);
    }
    const parts = [...selected].map((declaration) => cache.partAt(declaration, witness, variant));
    const own = partManifests(parts);
    const ownTemplates = templateVariantsOf(parts);
    const templateVariants: TemplateVariantsView = {
      get: (key) => ownTemplates.get(key) ?? shared.templateVariants.get(key),
      get size() {
        return ownTemplates.size + shared.templateVariants.size;
      },
      values: () => [...ownTemplates.values(), ...shared.templateVariants.values()],
    };
    const scopeMembers = new ScopeMembers(
      [...parts, ...held].flatMap((part) => [...part.members, ...part.kindMembers]),
    );
    const ownPart = scope.own ? parts.find((part) => part.declaration === scope.own) : undefined;
    // The site's own declaration, what extraction drew out of it, and its scope
    // members, at any depth.
    const group = new Set<ResourceManifest>(ownRegion?.manifests ?? ownPart?.manifests ?? []);
    const groupManifests: ResourceManifest[] = ownRegion ? [...ownRegion.manifests] : own.filter((m) => group.has(m));
    const layered = (list: readonly ResourceManifest[]): DoorLayers => ({
      own: list,
      names: new ScopedNameResolver(list, MANIFEST_READING, { resolver: shared.names, order: analysisOrder }),
      shared,
    });
    // What extraction drew out of a region, and its scope members, are read by
    // name — the members in the scope declaring them — where its declaration is
    // not held whole; a declaration reached by name is found by its own name
    // too, as the regions held of it.
    const regionMembers = [
      ...regions
        .filter((region) => !selected.has(region.declaration))
        .flatMap((region) => region.manifests.filter((m) => m !== region.projection.value)),
      ...byNameParts.flatMap((part) => part.manifests),
    ];
    const before = layered(regionMembers.length === 0 ? own : [...own, ...regionMembers].sort(analysisOrder));
    const over = views === "group" ? [...groupManifests] : [];
    const consumers =
      setup.templated && over.length > 0
        ? readTemplateConsumers({
            manifests: over as unknown as ResourceManifest[],
            names: doorResolution(before, scope),
            registry: defs,
            aliases,
            aliasesByModule,
            rootModules,
            decidedValue: valueInAt(setup.choices, scope.witness),
          })
        : undefined;
    const forwardViews =
      views === "none"
        ? undefined
        : buildTemplateForwardViews(
            over,
            doorResolution(before, scope),
            defs,
            aliases,
            { aliasesByModule, rootModules },
            (consumer) => consumers?.expansions.get(consumer)?.expansion.definition,
          );
    const allManifests = [...own];
    const moduleDocuments = whole ? own.filter((m) => isModuleKind(m.kind)) : setup.moduleBases(witness);
    if (forwardViews && forwardViews.analyzed.length > 0) {
      resolveSchemaTypeRefs(forwardViews.analyzed, aliases, aliasesByModule);
      rankForwardViews(forwardViews.analyzed);
      allManifests.push(...forwardViews.analyzed);
      groupManifests.push(...forwardViews.analyzed);
      for (const view of forwardViews.analyzed) group.add(view);
    }
    const layers = forwardViews && forwardViews.analyzed.length > 0 ? layered(allManifests) : before;

    // A part normalized whole moves its declaration's positions where a region
    // of the same declaration would. A forward view's region is placed by its
    // projection's place map, at its consumer, once every other move is made.
    const viewRegions = [...held, ...parts]
      .filter((region) => setup.views.has(region.declaration))
      .sort((a, b) => setup.union.views.indexOf(a.declaration as ConditionedView) - setup.union.views.indexOf(b.declaration as ConditionedView));
    const layout = new Map<ResourceManifest, readonly number[]>();
    for (const region of viewRegions) {
      const order = setup.union.views.indexOf(region.declaration as ConditionedView);
      region.manifests.forEach((m, i) => layout.set(m, i === 0 ? [0, order] : [1, order, i - 1]));
    }
    const relocate = relocatorOf(
      [...held, ...parts].filter((region) => !setup.views.has(region.declaration)).map((region) => region.projection),
    );
    const viewEntries = viewRegions.map((region) => {
      const view = region.declaration as ConditionedView;
      const consumer = view.consumer.manifest;
      // A consumer written inside a declaration is reported where it is
      // written there: its places are that declaration's holder's, and its own
      // root is where it stands in it.
      const within = view.consumer.declaredIn;
      const reportedAs = within
        ? (setup.union.placeOf(within.manifest).resource ?? {
            kind: within.manifest.kind,
            name: within.manifest.metadata?.name as string,
          })
        : setup.union.placeOf(consumer).resource;
      const consumerPlaces = setup.union.project(consumer, witness.assignment, witness.forcing).places;
      const rootPlaces = within
        ? { ...consumerPlaces, mappings: [{ from: [], to: view.consumer.at }, ...consumerPlaces.mappings] }
        : consumerPlaces;
      const reported = reportedAs ?? { kind: consumer.kind, name: consumer.metadata?.name as string };
      return {
        manifests: region.manifests,
        entryKind: view.entryKind,
        entryName: view.entryName,
        root: consumer,
        ...(reportedAs ? { reportedAs } : {}),
        places: setup.union.project(view.manifest, witness.assignment, witness.forcing).places,
        rootPlaces,
        // Where the consumer's root is written, as a run places its own.
        rootOrigin: JSON.stringify([
          reported.kind,
          reported.name,
          (consumer.metadata as { source?: unknown } | undefined)?.source,
          relocatePath("", rootPlaces.mappings),
        ]),
      };
    });
    const regionViews = viewEntries.length === 0 ? undefined : placedViews(viewEntries);
    const viewOrigins: ViewOrigin[] = [
      ...(forwardViews?.consumers() ?? []).map(([view, root]) => ({ view, root })),
      ...viewEntries.map((entry) => ({ view: entry.manifests[0]!, root: entry.root, rootOrigin: entry.rootOrigin })),
    ];
    const requiresRead = whole ? allManifests : [...allManifests.filter((m) => !isModuleKind(m.kind)), ...moduleDocuments];
    const unreadableFiles = filesOfUnreadableModules(
      allManifests,
      validateRequires(requiresRead, {
        hostVersions: options?.hostVersions,
        entryModules: rootModules,
      }),
    );
    const topLevel = [...held.flatMap((region) => region.manifests), ...allManifests].filter((m) => !isScopeMemberDeclaration(m));
    const writtenRefusals = setup.writtenRefusals;
    /** `found` placed — `intoConsumers`, a finding about a forward view moved on
     *  to where its consumer wrote it, as a last step. */
    const place = (found: AnalysisDiagnostic[], filtered: boolean, intoConsumers: boolean): AnalysisDiagnostic[] => {
      const forwarded = forwardViews && intoConsumers ? forwardViews.placed(found) : found;
      const members = scopeMembers.relocate(forwarded);
      const located = rerootedQuotes(rewriteSyntheticOrigins(
        filtered
          ? withoutRefusedFormConsequences(suppressUnreadableModuleDiagnostics(members, unreadableFiles), topLevel)
          : members,
        topLevel,
      ));
      const bodiesRelocated =
        templateVariants.size === 0
          ? located
          : relocatedRendering(located, (found) => found.map((d) => {
              if (writtenRefusals.has(d)) return d;
              const data = d.data as
                | { resource?: { kind?: unknown; name?: unknown }; filePath?: unknown; path?: unknown }
                | undefined;
              if (data?.resource?.kind !== "Telo.Definition" || typeof data.path !== "string") return d;
              for (const { variant: chosen, written } of templateVariants.values()) {
                const meta = written.metadata as { name?: unknown; source?: unknown } | undefined;
                if (meta?.name !== data.resource.name || meta?.source !== data.filePath) continue;
                const path = chosen.expansion.relocate(data.path);
                if (path === data.path) return d;
                return { ...d, data: { ...(d.data as Record<string, unknown>), path } };
              }
              return d;
            }));
      // A message quoting its place is rendered from where it now stands.
      const moved = relocatedRendering(bodiesRelocated, relocate);
      const relocated = regionViews && intoConsumers ? regionViews.placed(moved) : moved;
      if (!filtered) return relocated;
      const consumerChecked = consumers
        ? withoutRefusedExpansionConsequences(relocated, {
            sites: [],
            diagnostics: consumers.diagnostics,
            refused: consumers.refused,
          })
        : relocated;
      return setup.expansion ? withoutRefusedExpansionConsequences(consumerChecked, setup.expansion) : consumerChecked;
    };
    // A part the shared layer holds for a declaration the key reads is
    // normalized once for every key, never for this one.
    const byNameNodes = byNameParts.reduce((n, part) => n + part.nodes, 0);
    const sharedParts = new Set<object>(shared.parts);
    const nodes = observingKeyCosts()
      ? parts.reduce(
          (n, part) => (sharedParts.has(part) && part.declaration !== scope.own ? n : n + countNodes(part.projection.value)),
          0,
        ) +
        regions.reduce((n, region) => n + region.nodes, 0) +
        byNameNodes
      : 0;
    // A declaration held whole by name for a reader other than a named
    // shape's, normalized for this key.
    const heldWhole: string[] = [];
    if (observingKeyCosts()) {
      for (const part of parts) {
        const readers = wholeByName.get(part.declaration);
        if (!readers || part.declaration === scope.own || sharedParts.has(part)) continue;
        const defects = [...readers].filter((reader) => reader !== "shape");
        if (defects.length > 0 || readers.size === 0) {
          heldWhole.push(`${defects.join("+") || "unlabelled"}:${String(part.declaration.manifest.metadata?.name)}`);
        }
      }
    }
    return {
      allManifests,
      layers,
      scopeMembers,
      templateVariants,
      consumers,
      forwardViews,
      viewManifests: viewRegions.flatMap((region) => region.manifests),
      layout,
      group,
      groupManifests,
      placed: (found, filtered) => place(found, filtered, true),
      inViews: (found) => place(found, false, false),
      views: viewOrigins,
      nodes,
      byName: { nodes: byNameNodes, extent: byNameExtent },
      wholeByName: heldWhole,
      moduleDocuments,
    };
  }

  /** Each CEL expression of `manifests`' site: the written place a finding
   *  about it is reported at. */
  private siteIdsOf(
    manifests: readonly ResourceManifest[],
    placed: (found: AnalysisDiagnostic[], filtered: boolean) => AnalysisDiagnostic[],
  ): {
    siteOf(m: ResourceManifest, path: string): string | undefined;
    expressionsOf(site: string): readonly { engine: string; source: string }[];
    /** The manifests holding the site's expressions. */
    holdersOf(site: string): ReadonlySet<ResourceManifest>;
  } {
    const probes: AnalysisDiagnostic[] = [];
    const probed: { m: ResourceManifest; path: string; engine: string; source: string }[] = [];
    for (const m of manifests) {
      const meta = m.metadata as { name?: unknown; source?: unknown } | undefined;
      walkOwnCelExpressions(m, "", (source, path, engine) => {
        probes.push({
          severity: DiagnosticSeverity.Hint,
          code: `${CEL_SITE_MARKER}:${probed.length}`,
          source: SOURCE,
          message: "",
          data: { resource: { kind: m.kind, name: meta?.name as string }, filePath: meta?.source as string | undefined, path },
        });
        probed.push({ m, path, engine, source });
      });
    }
    const ids = new Map<ResourceManifest, Map<string, string>>();
    const expressions = new Map<string, { engine: string; source: string }[]>();
    const holders = new Map<string, Set<ResourceManifest>>();
    for (const at of placed(probes, false)) {
      const { m, path, engine, source } = probed[Number(String(at.code).slice(CEL_SITE_MARKER.length + 1))]!;
      const data = at.data as { resource?: { kind?: unknown; name?: unknown }; filePath?: unknown; path?: unknown };
      if (typeof data.path !== "string") continue;
      let byPath = ids.get(m);
      if (!byPath) ids.set(m, (byPath = new Map()));
      const site = celSiteId(data.resource?.kind, data.resource?.name, data.filePath, data.path);
      byPath.set(path, site);
      expressions.set(site, [...(expressions.get(site) ?? []), { engine, source }]);
      holders.set(site, (holders.get(site) ?? new Set()).add(m));
    }
    return {
      siteOf: (m, path) => ids.get(m)?.get(path),
      expressionsOf: (site) => expressions.get(site) ?? [],
      holdersOf: (site) => holders.get(site) ?? new Set(),
    };
  }

  /** Whether any of `present` — every declaration and view that may report
   *  observed state, at the witness — reports it once normalized. The views are
   *  the union's, held as parts; none is built here. */
  private reportsObservedStateAt(
    setup: KeySetup,
    present: readonly ConditionedDeclaration[],
    witness: Witness,
  ): boolean {
    const presentSet = new Set(present);
    const names = new Set(present.map((d) => d.manifest.metadata?.name).filter((n): n is string => typeof n === "string"));
    const scope: DoorScope = {
      site: "(whether any declaration reports observed state)",
      union: setup.union,
      names: setup.names,
      witness,
      coverage: { names, wholeReads: new Map(), named: new Set(), outcomes: new Set(), parts: new Map(), referrers: new Set(), presence: false },
      care: setup.careAt(witness),
    };
    const normalized = this.normalizeKey(setup, scope, 0, [...presentSet, ...setup.kindsAndImports], "none");
    const requests = doorRequests(normalized.layers, scope, () => [], setup.moduleDocumentsVary, normalized.moduleDocuments);
    const moduleScopes = { aliasesByModule: setup.aliasesByModule, rootModules: setup.rootModules, libraries: setup.libraries };
    return [...observedDeclarations(requests, setup.defs, setup.aliases, moduleScopes)].some(
      (d) => d.resource.status || d.resource.reading,
    );
  }

  /** Every template-body site of `variant`, read off the kind documents as
   *  that variant expands their bodies. */
  private bodyCensus(setup: KeySetup, universe: Condition, variant: number): ReadonlyMap<string, CensusEntry> {
    const first = setup.union.space.firstAssignment(universe);
    const census = new Map<string, CensusEntry>();
    if (!first) return census;
    const witness: Witness = { assignment: first };
    const scope: DoorScope = {
      site: "(the template bodies)",
      union: setup.union,
      names: setup.names,
      witness,
      coverage: { names: new Set(), wholeReads: new Map(), named: new Set(), outcomes: new Set(), parts: new Map(), referrers: new Set(), presence: false },
      care: setup.careAt(witness),
    };
    const normalized = this.normalizeKey(setup, scope, variant, setup.kindsAndImports, "none");
    const definitions = normalized.allManifests.filter((m) => m.kind === "Telo.Definition");
    const siteOf = this.siteIdsOf(definitions, normalized.placed).siteOf;
    const writtenOf = (m: ResourceManifest): ResourceManifest =>
      normalized.templateVariants.get(templateKeyOf(m))?.written ??
      setup.union.declarations.find(
        (d) =>
          d.manifest.kind === m.kind &&
          d.manifest.metadata?.name === m.metadata?.name &&
          (d.manifest.metadata as { source?: unknown }).source === (m.metadata as { source?: unknown }).source,
      )?.manifest ??
      m;
    // A body entry's kind may reach a named shape some configuration varies:
    // read as the census's witness holds it, as every key reads one through
    // its door.
    const shapes: NamedShapeLookup = (id) =>
      parseCanonicalTypeSchemaId(id) && !setup.sharedShape(id)
        ? setup.shapeAt(id, scope.witness)
        : setup.defs.shapeLookup(id);
    visitManifest(definitions, setup.defs, {
      onCel: (e) => {
        const m = e.source as unknown as ResourceManifest;
        if (e.engineName === REF_ENGINE) return;
        const site = siteOf(m, e.path);
        if (site === undefined || !isBodySiteId(site)) return;
        const known = census.get(site);
        const module = (m.metadata as { module?: string } | undefined)?.module;
        const importPath = (m.metadata as { importPath?: string[] } | undefined)?.importPath;
        census.set(site, {
          occurrences: (known?.occurrences ?? 0) + 1,
          expressions: [...(known?.expressions ?? []), { engine: e.engineName, source: e.expr }],
          ...(module !== undefined ? { module } : {}),
          ...(importPath ? { importPath } : {}),
          moduleNames: moduleCallNamesOf(setup.moduleCallNames, m),
          holder: writtenOf(m),
        });
      },
    }, { aliases: setup.aliases, aliasesByModule: setup.aliasesByModule, rootModules: setup.rootModules, shapes });
    return census;
  }

  /**
   * One key of a CEL site judged in its own environment: the declarations its
   * classes cover, the site's own, and the ones no configuration varies, at
   * the key's witness, read through the door (`key-door.ts`) — never a
   * configuration's analysis.
   */
  private judgeKey(setup: KeySetup, request: KeyRequest): CelSiteVerdict {
    reportAnalysisRun("door");
    const started = observingKeyCosts() ? performance.now() : undefined;
    try {
      return this.judgeKeyIn(setup, request);
    } finally {
      if (started !== undefined) reportKeyCost({ kind: "door", family: "cel", site: request.site, milliseconds: performance.now() - started });
    }
  }

  private judgeKeyIn(setup: KeySetup, request: KeyRequest): CelSiteVerdict {
    const { union, defs, aliases, aliasesByModule, rootModules, libraries, moduleCallNames, options } = setup;
    const { coverage, witness } = request;
    // A key is judged on its site's region (`CelRegion`), read at this witness:
    // its read producers carved, each stand-in carrying its producer's fact.
    // Without one — and on the reference side — the declaration is held whole.
    const region = request.region && !request.whole ? request.region(witness) : undefined;
    const carvedFacts = new Map(region?.carved.map((carve) => [JSON.stringify(carve.keys), carve.fact]));
    const part = region
      ? setup.parts.regionsAt(
          request.declaration,
          region.roots,
          witness,
          request.variant,
          region.carved.map((carve) => carve.keys),
          (keys) => carvedResult(carvedFacts.get(JSON.stringify(keys))!),
        )
      : undefined;
    const scope: DoorScope = {
      site: request.site,
      union,
      names: setup.names,
      witness,
      coverage,
      care: setup.careAt(witness),
      ...(part ? {} : { own: request.declaration }),
    };
    const selection = keySelection(setup, request.declaration, coverage, request.whole || request.byNameWhole);
    const normalized = this.normalizeKey(
      setup,
      scope,
      request.variant,
      // The site's own declaration only where a class covers it by name.
      part ? selection.declarations.slice(1) : selection.declarations,
      // A region's site is judged where the union holds it: a forwarded value
      // as a site of the view holding it, never through a view built here.
      part || setup.views.has(request.declaration) ? "none" : "group",
      part ? [part] : [],
      request.whole,
      part,
      selection.byName,
      selection.wholeByName,
    );
    if (observingKeyCosts() && !request.whole && !request.byNameWhole) {
      reportDoorNodes("cel", request.site, normalized);
      reportKeyCost({ kind: "cel", site: request.site, nodes: normalized.nodes });
    }
    const { scopeMembers, templateVariants, forwardViews } = normalized;
    const groupManifests = [...normalized.groupManifests];
    const moduleScopes = { aliasesByModule, rootModules, libraries };

    const { siteOf, expressionsOf, holdersOf } = this.siteIdsOf(groupManifests, normalized.placed);
    const stepNames = region?.stepNames;
    const siteHolders = holdersOf(request.site);
    // The steps the site reads: a step it cannot reach is typed open, its
    // target never asked for. The inputs it reads: what its classes narrow.
    let stepsRead: Set<string> | undefined = new Set();
    const inputsRead = { whole: new Set<string>(), entries: new Set<string>() };
    for (const { engine, source } of expressionsOf(request.site)) {
      for (const expression of celExpressionsOf(engine, source)) {
        const parsed = parseCelSource(expression);
        for (const chain of parsed ? extractAccessChains(parsed.root) : []) {
          const [head, name] = chain;
          if (head === "variables" || head === "secrets" || head === "resources") {
            if (name === undefined || name === INDEX_SEGMENT) inputsRead.whole.add(head);
            else inputsRead.entries.add(`${head}.${name}`);
          }
          if (head !== "steps" || !stepsRead) continue;
          if (chain.length < 2 || name === INDEX_SEGMENT) stepsRead = undefined;
          else stepsRead.add(name!);
        }
      }
    }
    let callGraphMemo: ReturnType<typeof buildCallGraph> | undefined;
    const requests = doorRequests(
      normalized.layers,
      scope,
      (all, m) => referrerSlotsOf((callGraphMemo ??= buildCallGraph([...all], defs, { aliases, aliasesByModule })), m),
      setup.moduleDocumentsVary,
      normalized.moduleDocuments,
    );
    const textLanguages = new TextLanguageScope(requests, rootModules, options?.moduleDocuments ?? []);
    const observed = [...observedDeclarations(requests, defs, aliases, moduleScopes)];
    const observedState = new Map(observed.map((d) => [d.key, d.resource]));
    const observedNames = observedStateNames(observed);
    const scopedResources = scopedResourcesOf(observed, (m) => celScopeHolderOf(m, defs, aliases, aliasesByModule));
    const bodyResources = bodyResourcesFor(
      defs,
      aliases,
      moduleScopes,
      (definition) => templateVariants.get(templateKeyOf(definition))?.variant.expansion.families,
    );
    const scopedMemberNames = new Set(scopeMembers.all.map((member) => member.address.member));
    const scopedDefs = moduleScopedDefResolver<ResourceDefinition>(defs, aliases, moduleScopes);
    const bodySites = new Map<ResourceManifest, Array<{ prefix: string; sites: CelEvalSites }>>();
    const bodyReadingAt = (host: ResourceManifest, path: string): { sites: CelEvalSites; localPath: string } | undefined => {
      if (host.kind !== "Telo.Definition") return undefined;
      let bodies = bodySites.get(host);
      if (!bodies) {
        const module = host.metadata?.module as string | undefined;
        const resolve: DefResolver = (kind) => scopedDefs.in(kind, module);
        bodies = templateBodies(host, defs, aliases, moduleScopes).map((body) => ({
          prefix: body.prefix,
          sites: kindCelEvalSites(body.definition, resolve, shapes),
        }));
        bodySites.set(host, bodies);
      }
      const body = bodies.find((b) => path.startsWith(`${b.prefix}.`));
      return body && { sites: body.sites, localPath: path.slice(body.prefix.length + 1) };
    };
    const holderScopes = new Map<ResourceManifest, readonly DeclaredScope[]>();
    const scopeOfPath = (holder: ResourceManifest, path: string): ScopeSite | undefined => {
      const address = addressOf(holder);
      if (!address) return undefined;
      let scopes = holderScopes.get(holder);
      if (!scopes) {
        scopes = declaredScopes(defs.referenceSites(holder, aliases, aliasesByModule));
        holderScopes.set(holder, scopes);
      }
      return scopeSiteAtPath(address, scopes, path);
    };
    const scopeMemberClause = (m: ResourceManifest, path: string, message: string): string => {
      const name = /^'resources\.([A-Za-z_][A-Za-z0-9_]*)' is not defined/.exec(message)?.[1];
      if (name === undefined) return "";
      const located = (isForwardedDeclaration(m) ? observedNames.forwarded : observedNames.local).locate(
        name,
        m.metadata?.module as string | undefined,
        scopeOfPath(m, path),
      );
      const declaredScope = located?.address.scope ? located.declaration.resource.scope : undefined;
      if (declaredScope) {
        return (
          ` — '${name}' is declared in the '${declaredScope.field}' scope of ${declaredScope.kind}/${declaredScope.name ?? "(unnamed)"}; ` +
          "a scope member is in `resources` only where that scope's run evaluates the field " +
          "(its regions, outside compile-eval fields)."
        );
      }
      const outside = outOfReachNames(m).get(name);
      return outside ? ` — ${outOfReachSentence(name, outside)}` : "";
    };
    /** Whether any declaration reports observed state: the key's class, or a
     *  refusal where the key holds none. */
    const reportsObservedState = (): boolean => {
      if (coverage.observed === undefined) {
        throw new DoorRefusal(request.site, "whether any declaration reports observed state");
      }
      return coverage.observed;
    };
    // A named shape no configuration varies is the shared registry's — the
    // only ones it holds; any other is read as the key covers it.
    const shapes: NamedShapeLookup = (id) => {
      const named = parseCanonicalTypeSchemaId(id);
      if (!named || setup.sharedShape(id)) return defs.shapeLookup(id);
      if (!answersName(scope, named.typeName)) {
        throw new DoorRefusal(request.site, `for the named shape '${id}'`);
      }
      const declared = requests.names
        .declarationsOf(named.typeName)
        .find((m) => (m.metadata as { module?: unknown }).module === named.moduleName && !!(m as Record<string, any>).schema);
      return declared
        ? resolveTypeFieldToSchema(
            { schema: (declared as Record<string, any>).schema, extends: (declared as Record<string, any>).extends },
            requests,
            declared as Record<string, any>,
          )
        : undefined;
    };
    const moduleFunctions = new ModuleFunctionIndex(requests, defs, aliases, aliasesByModule, rootModules, {
      index: this.sharedFunctionsOf(setup, normalized.layers.shared),
      order: analysisOrder,
    });
    const callableFlags = new CallableFlagsIndex(moduleFunctions, moduleCallNames);
    const analysisOnlyDocs: ReadonlySet<ResourceManifest> = new Set([...(forwardViews?.analyzed ?? []), ...normalized.viewManifests]);
    const kernelGlobals = buildKernelGlobalsIndex(
      requests,
      observedState,
      moduleFunctions,
      analysisOnlyDocs,
      scopedResources,
      request.whole ? narrowingAt(setup.choices, witness) : narrowingOfReads(narrowingAt(setup.choices, witness), inputsRead),
      bodyResources,
      request.whole ? undefined : setup.globalsOverlays,
    );
    const moduleManifest =
      requests.moduleDocuments().find((mm) => mm.kind === "Telo.Application") ??
      requests.moduleDocuments().find((mm) => mm.kind === "Telo.Library");
    const libraryManifests = setup.libraryManifests as Map<string, ResourceManifest[]>;
    let catchLadderMemo: CatchLadder | undefined;
    const catchLadder = (): CatchLadder =>
      (catchLadderMemo ??= new CatchLadder(requests, defs, aliases, this.celEnv, aliasesByModule, new Set(rootModules), libraryManifests));
    let ownCatchListsMemo: CatchLadder | undefined;
    const ownCatchLists = (): CatchLadder =>
      (ownCatchListsMemo ??= new CatchLadder(
        listRequests(groupManifests),
        defs,
        aliases,
        this.celEnv,
        aliasesByModule,
        new Set(rootModules),
        libraryManifests,
      ));
    let observedStateContextMemo: Record<string, any> | null | undefined;
    const celScope = new CelScopeResolver({
      celEnv: this.celEnv,
      defs,
      aliases,
      scopes: moduleScopes,
      declarations: requests,
      shapes,
      kernelGlobals,
      moduleManifest,
      get observedStateContext() {
        observedStateContextMemo ??= reportsObservedState()
          ? {
              type: "object",
              additionalProperties: true,
              properties: { resources: buildObservedStateResourcesSchema(observedState, true) },
            }
          : null;
        return observedStateContextMemo;
      },
      moduleCallNames,
      moduleFunctions,
      callableFlags,
      definitionOf: (m) =>
        definitionInScope(defs, m.kind, m.metadata, aliases, aliasesByModule) as ResourceDefinition | undefined,
      // A site's own catch lists say whether it is inside a catch entry; only
      // there does the ladder read what the entry's list encloses.
      caughtDataAt: (m, path) =>
        ownCatchLists().holdsCatchEntryAt(m, path) ? catchLadder().caughtDataAt(m, path) : undefined,
      loopBindingsAt: (m, path) => {
        const found = templateVariants.get(templateKeyOf(m));
        return found ? loopBindingsAtPath(found.variant, m as { resources?: unknown }, path) : undefined;
      },
      ...(stepsRead ? { stepsRead } : {}),
      ...(stepNames ? { stepNamesAt: (m: ResourceManifest) => (siteHolders.has(m) ? stepNames : undefined) } : {}),
      typedEnvironments: setup.typedEnvironments,
    });
    const authorSchemas = new WeakMap<object, Record<string, any>>();
    const celJudge = new CelJudge({
      celScope,
      defs,
      aliases,
      rootModules,
      shapes,
      kernelGlobals,
      moduleCallNames,
      moduleFunctions,
      observedState,
      observedNames,
      scopedResources,
      bodyResources,
      scopedMemberNames,
      get reportsObservedState() {
        return reportsObservedState();
      },
      runReachable: new Set<string>(),
      ...(forwardViews ? { forwardViews } : {}),
      textLanguages,
      bodyEvalModeAt: (host, path) => {
        const body = bodyReadingAt(host, path);
        return body ? celEvalModeAt(body.sites, body.localPath) : undefined;
      },
      bodyAccessorAt: (host, path) => {
        const body = bodyReadingAt(host, path);
        return body !== undefined && accessorSiteAt(body.sites, body.localPath) !== undefined;
      },
      scopeMemberClause,
      validationSchemaFor: (definition) => {
        const cached = authorSchemas.get(definition as unknown as object);
        if (cached) return cached;
        const authorSchema = effectiveAuthorSchema(definition, (k) =>
          defs.resolve(aliases.resolveKind(k) ?? k) ?? defs.resolve(k),
        );
        const schema =
          authorSchema.additionalProperties === false
            ? {
                ...authorSchema,
                properties: {
                  kind: { type: "string" },
                  metadata: { type: "object" },
                  ...(authorSchema.properties ?? {}),
                },
              }
            : authorSchema;
        authorSchemas.set(definition as unknown as object, schema);
        return schema;
      },
      configurationRun: false,
    });

    const found: AnalysisDiagnostic[] = [];
    const facts: CelOccurrenceFacts[] = [];
    const expressions: { engine: string; source: string; module: ResourceManifest }[] = [];
    visitManifest(
      groupManifests,
      defs,
      {
        onResourceEnter: (e) => celJudge.enterResource(e.source, e.definition as unknown as ResourceDefinition | undefined),
        onCel: (e) => {
          const m = e.source as unknown as ResourceManifest;
          if (forwardViews?.defersCel(e.source, e.path) || e.engineName === REF_ENGINE) return;
          if (siteOf(m, e.path) !== request.site) return;
          const from = found.length;
          celJudge.judge(e, "site", found, { site: request.site, key: request.key });
          for (let i = from; i < found.length; i++) {
            found[i] = { ...found[i]!, data: { ...(found[i]!.data as Record<string, unknown>), celSite: request.site } };
          }
          // Where the run meets this occurrence: the manifest it stands in.
          facts.push({ layout: normalized.layout.get(m) ?? [], ...celJudge.factsAt(m, e.path, e.expr) });
          expressions.push({ engine: e.engineName, source: e.expr, module: m });
        },
      },
      { aliases, aliasesByModule, rootModules, shapes },
    );
    if (expressions.length === 0) {
      throw new Error(`internal: the CEL site ${request.site} is missing from its key's environment.`);
    }
    const diagnostics = normalized.placed(found, true).map((d) => {
      const data = { ...(d.data as Record<string, unknown>) };
      delete data.celSite;
      return { ...d, data: data as DiagnosticData };
    });
    // A read the key does not cover is a refusal, whatever the verdict: a call
    // to a function, or a read of a declared `resources` entry — a member or
    // the whole value — whose content no class of the key holds.
    for (const { engine, source, module } of expressions) {
      const names = moduleCallNamesOf(moduleCallNames, module);
      for (const expression of celExpressionsOf(engine, source)) {
        const parsed = parseCelSource(expression, names);
        if (!parsed) continue;
        for (const call of qualifiedCallsOf(parsed.root)) {
          const callee = call.slice(call.indexOf(".") + 1);
          if (!answersName(scope, callee)) throw new DoorRefusal(request.site, `for the function '${call}'`);
        }
        for (const chain of extractAccessChains(parsed.root)) {
          if (chain[0] !== "resources") continue;
          const read = chain[1] === undefined || chain[1] === INDEX_SEGMENT ? [...setup.names.names()] : [chain[1]];
          for (const name of read) {
            if (setup.names.declarationsNamed(name).length === 0 || holdsContentOf(scope, name)) continue;
            throw new DoorRefusal(request.site, `for the content of 'resources.${name}'`);
          }
        }
      }
    }
    // What a stand-in's place holds is judged once its choice is decided.
    const standIns = standInsAt(setup.choices, witness);
    return {
      diagnostics:
        standIns.length === 0
          ? diagnostics
          : withoutRefusedExpansionConsequences(diagnostics, { sites: [], diagnostics: [], refused: standIns }),
      facts,
    };
  }

  /**
   * Hold the census and the region parts to what normalizing each declaration
   * whole gives at `witness`: every group's enumeration of the whole against
   * the census anchors holding there, and each anchor's and read place's
   * region normalized on its own against the whole restricted to it. Run only
   * while observed (`observeRelationParity`).
   */
  private checkRelationParity(
    setup: KeySetup,
    solution: CelSiteSolution,
    witness: Witness,
    variant: number,
    runObserved?: boolean,
  ): void {
    const carves = solution.carveParityAt(witness, variant);
    const keys = solution.keyParityAt(witness, variant);
    const observed = this.observedParityAt(setup, solution, witness, runObserved);
    withCensusShapes(setup, () => this.relationParityAt(setup, solution, witness, variant, carves, keys, observed));
  }

  /** Where the observed-state class's flag differs from the flag of every
   *  declaration and view present at `witness`, and from the configuration
   *  run's own when `runObserved` is given. */
  private observedParityAt(
    setup: KeySetup,
    solution: CelSiteSolution,
    witness: Witness,
    runObserved: boolean | undefined,
  ): string[] {
    const class_ = solution.observedAt(witness);
    const present = [...setup.union.declarations, ...setup.union.views].filter((d) => setup.parts.presentAt(d, witness));
    const found: string[] = [];
    const whole = this.reportsObservedStateAt(setup, present, witness);
    if (class_ !== whole) found.push(`the observed-state class holds ${class_}, every present declaration and view ${whole}`);
    if (runObserved !== undefined && class_ !== runObserved) {
      found.push(`the observed-state class holds ${class_}, the configuration run's index ${runObserved}`);
    }
    return found;
  }

  private relationParityAt(
    setup: KeySetup,
    solution: CelSiteSolution,
    witness: Witness,
    variant: number,
    carves: ReturnType<CelSiteSolution["carveParityAt"]>,
    keys: ReturnType<CelSiteSolution["keyParityAt"]>,
    observed: readonly string[],
  ): void {
    const census: string[] = [];
    const regions: string[] = [];
    let anchors = 0;
    let places = 0;
    const anchorsByGroup: Record<string, number> = {};
    const { union } = setup;
    const bySite = new Map<ConditionedDeclaration, RelationSite[]>();
    for (const site of solution.relationSites.values()) {
      bySite.set(site.declaration, [...(bySite.get(site.declaration) ?? []), site]);
    }
    for (const declaration of [...union.declarations, ...union.views]) {
      if (!setup.parts.presentAt(declaration, witness)) continue;
      const isView = setup.views.has(declaration);
      const holder = isView ? declaration.manifest : declaration.holder;
      const meta = (isView ? { ...declaration.manifest.metadata, name: viewSiteNameOf(union, declaration as ConditionedView) } : holder.metadata) as
        | { name?: unknown; source?: unknown }
        | undefined;
      const kind = holder.kind ?? expansionTagLabel(holder);
      const whole = setup.parts.partAt(declaration, witness, variant);
      // A view standing for a scope member is written where the member is; the
      // part of a region says so at its root, and the whole says it nowhere.
      const writtenAt = isView && declaration.at.length > 0 ? [{ from: [] as (string | number)[], to: declaration.at }] : [];
      const enumerated = new Set<string>();
      for (const group of RELATION_GROUPS) {
        const reader = readerOf(group);
        for (const each of instancesIn(reader, whole.manifests, [], keyReaderScope(setup))) {
          anchors++;
          anchorsByGroup[group] = (anchorsByGroup[group] ?? 0) + 1;
          const place = placeByProjectedKeys(union, declaration, each.anchor, witness);
          if (!place.present) {
            census.push(`${kind}/${meta?.name}: the ${group} anchor at '${pathText(each.anchor)}' is in no place of the union`);
            continue;
          }
          const id = relationSiteId(group, kind, meta?.name, meta?.source, isView ? viewAnchorText(place) : pathText(place.written));
          enumerated.add(id);
          // The anchor's region with its key's carves, against the declaration
          // normalized whole with the same places carved.
          const carved = carves.carved.get(id) ?? [];
          if (carved.length > 0) {
            places++;
            const wholeCarved = setup.parts.regionsAt(declaration, [[]], witness, variant, carved);
            const part = setup.parts.regionsAt(declaration, [place.unionKeys], witness, variant, carved);
            for (const mismatch of regionParity(
              { manifests: wholeCarved.manifests, mappings: [...writtenAt, ...wholeCarved.projection.places.mappings] },
              { manifests: part.manifests, mappings: part.projection.places.mappings },
              each.anchor,
            )) {
              regions.push(`${id} (carved): ${mismatch}`);
            }
          }
          const readPlaces = reader.reads(each.instance, each.region, keyReaderScope(setup)).places.map((keys) => [...each.position, ...keys]);
          for (const keys of [each.anchor, ...readPlaces]) {
            const at = placeByProjectedKeys(union, declaration, keys, witness);
            if (!at.present) continue;
            places++;
            const part = setup.parts.regionAt(declaration, at.unionKeys, witness, variant);
            for (const mismatch of regionParity(
              { manifests: whole.manifests, mappings: [...writtenAt, ...whole.projection.places.mappings] },
              { manifests: part.manifests, mappings: part.projection.places.mappings },
              keys,
            )) {
              regions.push(`${id}: ${mismatch}`);
            }
          }
        }
      }
      const holding = new Set<string>();
      for (const site of bySite.get(declaration) ?? []) {
        const path = relationSitePath(site);
        if (takenAt(union.space, site.condition, path, witness.assignment, witness.forcing)) holding.add(site.id);
      }
      for (const id of enumerated) if (!holding.has(id)) census.push(`the census holds no ${id}`);
      for (const id of holding) if (!enumerated.has(id)) census.push(`the census holds ${id}, which the declaration does not`);
    }
    reportRelationParity({
      witness: `${assignmentKey(witness.assignment)}${witness.forcing ? " (forced)" : ""}`,
      census,
      regions,
      carves: [...carves.mismatches, ...keys.mismatches],
      observed,
      byName: keys.byName,
      keySites: keys.compared,
      anchors,
      anchorsByGroup,
      places,
    });
  }

  /**
   * One key of a relation site judged in its own environment: the rule of its
   * group over its one instance — the anchor's region normalized on its own at
   * the witness, the declaration's identity, and a door answering by name what
   * the key's classes cover and by place the read places it declares, each a
   * region normalized on its own. No part of the declaration is normalized
   * whole.
   */
  private judgeRelationKey(setup: KeySetup, request: RelationKeyRequest): AnalysisDiagnostic[] {
    reportAnalysisRun("own");
    const started = observingKeyCosts() ? performance.now() : undefined;
    try {
      return this.judgeRelationKeyIn(setup, request);
    } finally {
      if (started !== undefined) {
        reportKeyCost({ kind: "door", family: "relation", site: request.site.id, milliseconds: performance.now() - started });
      }
    }
  }

  private judgeRelationKeyIn(setup: KeySetup, request: RelationKeyRequest): AnalysisDiagnostic[] {
    const { site, witness, coverage, variant, reads, roots, carved } = request;
    const { defs, aliases, aliasesByModule, rootModules, libraries } = setup;
    const reader = readerOf(site.group);
    // The anchor, its read places and the steps it reads, normalized together.
    const readRoots: (readonly (string | number)[])[] = [];
    for (const keys of reads.places) {
      const at = placeByProjectedKeys(setup.union, site.declaration, keys, witness);
      if (at.present) readRoots.push(at.unionKeys);
    }
    const part = setup.parts.regionsAt(site.declaration, [site.unionKeys, ...readRoots, ...roots], witness, variant, carved);
    if (observingKeyCosts()) reportKeyCost({ kind: "relation", site: site.id, nodes: countNodes(part.projection.value) });
    const readerScope = keyReaderScope(setup);
    const found = withCensusShapes(setup, () => instanceAtRoot(site.group, part, site.id, readerScope));
    const declared = new Set(reads.places.map((keys) => pathText(keys)));
    const scope: DoorScope = {
      site: site.id,
      union: setup.union,
      names: setup.names,
      witness,
      coverage,
      care: setup.careAt(witness),
    };
    // The site's own declaration only where a class covers it by name.
    const selection = keySelection(setup, site.declaration, coverage, request.byNameWhole);
    const normalized = this.normalizeKey(
      setup,
      scope,
      variant,
      selection.declarations.slice(1),
      "none",
      [part],
      false,
      undefined,
      selection.byName,
      selection.wholeByName,
    );
    if (!request.byNameWhole) reportDoorNodes("relation", site.id, normalized);
    let callGraphMemo: ReturnType<typeof buildCallGraph> | undefined;
    const requests = doorRequests(
      normalized.layers,
      scope,
      (all, m) => referrerSlotsOf((callGraphMemo ??= buildCallGraph([...all], defs, { aliases, aliasesByModule })), m),
      setup.moduleDocumentsVary,
      normalized.moduleDocuments,
    );
    const positions = positionsOf(part.manifests);
    const holding = (keys: readonly (string | number)[]) => manifestHolding(positions, [...found.position, ...keys]);
    // What the expressions of the part were typed as, by their keys at the witness.
    let factMaps: CelFactMaps | undefined;
    const factsOfPart = (): CelFactMaps => {
      if (factMaps) return factMaps;
      const maps = emptyCelFactMaps();
      const { siteOf } = this.siteIdsOf(part.manifests, normalized.placed);
      const occurrences = new Map<string, number>();
      visitManifest(
        [...part.manifests],
        defs,
        {
          onCel: (e) => {
            if (e.engineName === REF_ENGINE) return;
            const m = e.source as unknown as ResourceManifest;
            const id = siteOf(m, e.path);
            if (id === undefined) return;
            // Several expressions of one written place (a value forwarded across
            // a reference is written at itself) share a site: this part holds
            // some of them, so each is told apart by its own text, the nth
            // alike among them in the order the part meets them.
            const alike = `${id}\0${e.expr}`;
            const occurrence = occurrences.get(alike) ?? 0;
            occurrences.set(alike, occurrence + 1);
            replayCelFacts(maps, m, e.path, request.celFactsAt(id)?.filter((facts) => facts.source === e.expr)[occurrence]);
          },
        },
        { aliases, aliasesByModule, rootModules: new Set(rootModules), shapes: defs.shapeLookup },
      );
      return (factMaps = maps);
    };
    const read = (keys: readonly (string | number)[]) =>
      isAtOrAbove(found.instance.anchor, keys) ||
      reads.places.some((place) => isAtOrAbove(place, [...found.position, ...keys]));
    const door: RelationDoor = {
      defs,
      aliases,
      aliasesByModule,
      rootModules: new Set(rootModules),
      libraries,
      validator: {
        validate: (data, target, standIns) => defs.validateResourceConfig(data, target, standIns),
        external: (ref) => defs.schemaForId(ref),
      },
      requests,
      declared: readerScope.declared,
      moduleNames: (identity) =>
        moduleCallNamesOf(setup.moduleCallNames, { kind: identity.kind, metadata: identity.metadata } as ResourceManifest),
      resolveTarget: (reference, keys) => {
        if (!reads.scopes) {
          throw new DoorRefusal(site.id, `for what the reference at '${pathText([...found.position, ...keys])}' names, which its reader does not declare`);
        }
        return callSiteContext(found.manifest as Record<string, any>, requests, defs, aliases, {
          aliasesByModule,
          rootModules: new Set(rootModules),
          libraries,
        }).resolveTarget(reference, pathText(keys));
      },
      place: (keys) => {
        const inHolder = [...found.position, ...keys];
        if (!declared.has(pathText(inHolder))) throw new DoorRefusal(site.id, `for the place '${pathText(inHolder)}', which its reader does not declare`);
        const at = holding(keys);
        return at ? valueAtKeys(at.manifest, at.keys) : undefined;
      },
      subject: () => found.manifest,
      functions: ruleFunctions(requests, defs, aliases, aliasesByModule, new Set(rootModules), setup.moduleCallNames),
      enclosing: () => {
        if (!reads.enclosing) throw new DoorRefusal(site.id, "for what encloses its anchor, which its reader does not declare");
        return enclosingOf(found.manifest, found.instance.anchor);
      },
      narrowing: narrowingAt(setup.choices, witness),
      importInputsSchema: (importDoc) => importInputsJoinSchema(importDoc, setup.options?.moduleDocuments ?? []),
      applicationInputsSchema: (resource, authorSchema) =>
        applicationInputsSlotSchema(resource, authorSchema, setup.options?.applicationSources ?? {}, (kind) =>
          needTypeOf(defs.resolve(kind)),
        ),
      facts: (keys) => {
        if (!reads.facts || !read(keys)) {
          throw new DoorRefusal(site.id, `for what the expression at '${pathText([...found.position, ...keys])}' was typed as, which its reader does not declare`);
        }
        const at = holding(keys);
        return at ? relationFactsIn(factsOfPart(), at.manifest, pathText(at.keys)) : undefined;
      },
      steps: () => {
        if (!reads.steps) throw new DoorRefusal(site.id, "for the step results, which its reader does not declare");
        const effective = defs.effectiveSchemaOf(
          definitionInScope(defs, found.manifest.kind, found.manifest.metadata, aliases, aliasesByModule),
        ) as Record<string, any> | undefined;
        return effective
          ? buildStepContextSchema(found.manifest as Record<string, any>, effective, requests, defs, aliases, { aliasesByModule, rootModules: new Set(rootModules), libraries }, new Set(reads.steps))
          : undefined;
      },
    };
    const value = valueAtKeys(found.manifest, found.instance.anchor);
    const judge = () =>
      reader.judge(found.instance, { identity: found.region.identity, anchor: found.instance.anchor, value, door });
    const covered = setup.varyingShapes.filter((id) => answersName(scope, parseCanonicalTypeSchemaId(id)!.typeName));
    const findings =
      covered.length === 0
        ? judge()
        : withShapeLayer(defs, setup.sharedShape, () => {
            for (const id of covered) {
              const shape = setup.shapeAt(id, witness);
              if (shape) defs.registerNamedTypeSchema(id, shape);
            }
            return judge();
          }).result;
    const diagnostics = normalized.placed(findings.map((each) => each.diagnostic), true);
    // What a stand-in's place holds is judged once its choice is decided.
    const standIns = standInsAt(setup.choices, witness);
    return standIns.length === 0
      ? diagnostics
      : withoutRefusedExpansionConsequences(diagnostics, { sites: [], diagnostics: [], refused: standIns });
  }

  /**
   * One key of a declaration's own-check site judged in its own environment —
   * a schema site's region (`KeyParts.regionsAt`: its cut sub-sites carved,
   * the places it reads beyond it whole), the declaration itself where that
   * region is all of it, and what the key's classes cover at its witness, read
   * through the door (`key-door.ts`) — keeping what the site's region holds.
   */
  private judgeOwnKey(setup: KeySetup, request: OwnKeyRequest): OwnVerdict {
    reportAnalysisRun("own");
    const started = observingKeyCosts() && !request.whole ? performance.now() : undefined;
    try {
      return this.judgeOwnKeyIn(setup, request);
    } finally {
      if (started !== undefined) {
        const family = request.site.family === "schema" ? "schema" : "relation";
        reportKeyCost({ kind: "door", family, site: request.site.id, milliseconds: performance.now() - started });
      }
    }
  }

  private judgeOwnKeyIn(setup: KeySetup, request: OwnKeyRequest): OwnVerdict {
    const { site, witness, coverage } = request;
    const { defs, aliases, aliasesByModule, rootModules, libraries } = setup;
    // A schema key is judged on its site's region — its cut sub-sites carved,
    // with the places it reads beyond it — wherever that is less than the
    // declaration; the reference side holds it whole.
    // A place read beyond the region is held whole: no carve holding it or
    // inside it applies.
    const roots = new Map<string, readonly (string | number)[]>();
    for (const keys of request.reads) {
      const at = placeByProjectedKeys(setup.union, site.declaration, keys, witness);
      if (at.present) roots.set(JSON.stringify(at.unionKeys), at.unionKeys);
    }
    const carved = [...site.carved]
      .map((text) => JSON.parse(text) as (string | number)[])
      .filter((keys) => ![...roots.values()].some((root) => isAtOrAbove(root, keys) || isAtOrAbove(keys, root)));
    const regional = !request.whole && (site.unionKeys.length > 0 || carved.length > 0);
    // A site cut at a choice whose option at the witness holds nothing judges
    // nothing there.
    if (regional && !placeByUnionKeys(setup.union, site.declaration, site.unionKeys, witness).present) {
      if (observingKeyCosts()) reportKeyCost({ kind: "schema", site: site.id, nodes: 0 });
      return { diagnostics: [], origins: [] };
    }
    const region = regional
      ? setup.parts.regionsAt(site.declaration, [site.unionKeys, ...roots.values()], witness, request.variant, carved)
      : undefined;
    const scope: DoorScope = {
      site: site.id,
      union: setup.union,
      names: setup.names,
      witness,
      coverage,
      care: setup.careAt(witness),
      ...(region ? {} : { own: site.declaration }),
    };
    const selection = keySelection(setup, site.declaration, coverage, request.whole || request.byNameWhole);
    const normalized = this.normalizeKey(
      setup,
      scope,
      request.variant,
      // The site's own declaration only where a class covers it by name.
      region ? selection.declarations.slice(1) : selection.declarations,
      // A view's schema checks are its own sites': a schema key's door builds
      // none.
      "none",
      region ? [region] : [],
      request.whole,
      region,
      selection.byName,
      selection.wholeByName,
    );
    const counted = !request.whole && !request.byNameWhole;
    if (counted) reportDoorNodes("schema", site.id, normalized);
    if (observingKeyCosts() && counted) {
      reportKeyCost({ kind: "schema", site: site.id, nodes: normalized.nodes });
    }
    const group = [...normalized.groupManifests];
    let callGraphMemo: ReturnType<typeof buildCallGraph> | undefined;
    const requests = doorRequests(
      normalized.layers,
      scope,
      (all, m) => referrerSlotsOf((callGraphMemo ??= buildCallGraph([...all], defs, { aliases, aliasesByModule })), m),
      setup.moduleDocumentsVary,
      normalized.moduleDocuments,
    );
    const moduleScopes = { aliasesByModule, rootModules: new Set(rootModules), libraries };
    const celFacts = emptyCelFactMaps();
    const analysisOnly: ReadonlySet<ResourceManifest> = new Set(normalized.viewManifests);
    const declaredScope: DeclaredDefinitionScope = {
      defs,
      aliases,
      aliasesByModule,
      rootModules: moduleScopes.rootModules,
      importersByModule: setup.importersByModule,
      analysisOnly: (m) => analysisOnly.has(m),
    };
    const validationSchemas = new WeakMap<object, Record<string, any>>();
    const world: OwnCheckWorld = {
      defs,
      aliases,
      aliasesByModule,
      rootModules: moduleScopes.rootModules,
      libraries,
      moduleCallNames: setup.moduleCallNames,
      celFacts,
      moduleDocuments: setup.options?.moduleDocuments ?? [],
      applicationSources: setup.options?.applicationSources ?? {},
      declaredScope,
      validationSchemaFor: (definition) => {
        const known = validationSchemas.get(definition as unknown as object);
        if (known) return known;
        const author = effectiveAuthorSchema(definition, (k) => defs.resolve(aliases.resolveKind(k) ?? k) ?? defs.resolve(k));
        const schema =
          author.additionalProperties === false
            ? { ...author, properties: { kind: { type: "string" }, metadata: { type: "object" }, ...author.properties } }
            : author;
        validationSchemas.set(definition as unknown as object, schema);
        return schema;
      },
      projectionScope: projectionScopeOf(
        requests,
        moduleScopedDefResolver<Record<string, any>>(defs, aliases, moduleScopes),
        projectionModules(defs, aliases, moduleScopes),
      ),
      narrowing: narrowingAt(setup.choices, witness),
      validator: {
        validate: (data, target, standIns) => defs.validateResourceConfig(data, target, standIns),
        external: (ref) => defs.schemaForId(ref),
      },
      valueSchemaHost: valueSchemaHostOf(analyzerContractScope(defs, aliases, moduleScopes, requests)),
      types: requests,
      identifierNames: (m) => {
        // Step names from the call graph's step walk over the key's own
        // declarations, the only step recursion.
        if (!stepGraph) {
          reportIdentifierPass(false);
          stepGraph = buildCallGraph(group, defs, { aliases, aliasesByModule });
        }
        return declarationNameFindings(m, defs, aliases, moduleScopes.rootModules, stepGraph, moduleScopes).map(asOwnFinding);
      },
    };
    let stepGraph: ReturnType<typeof buildCallGraph> | undefined;
    const judge = (): { m: ResourceManifest; group: OwnGroup; finding: OwnFinding }[] => {
      const out: { m: ResourceManifest; group: OwnGroup; finding: OwnFinding }[] = [];
      for (const m of group) {
        const declared = declaredDefinitionOf(m, declaredScope);
        for (const [name, checks] of OWN_GROUPS) {
          for (const finding of checks(world, m, declared)) out.push({ m, group: name, finding });
        }
      }
      return out;
    };
    // A named shape some configuration varies is read as the witness holds it,
    // in a layer of this judgement's own — and only where the key covers it.
    const covered = setup.varyingShapes.filter((id) => answersName(scope, parseCanonicalTypeSchemaId(id)!.typeName));
    const raw =
      covered.length === 0
        ? judge()
        : withShapeLayer(defs, setup.sharedShape, () => {
            for (const id of covered) {
              const shape = setup.shapeAt(id, witness);
              if (shape) defs.registerNamedTypeSchema(id, shape);
            }
            return judge();
          }).result;
    const origins = originsOf(group, normalized.placed, normalized.views);
    // Each finding belongs to the site whose region holds where its check
    // judged, as written — a view's, by its place in the view: a view's own
    // places are written nowhere, and its consumer's sites hold the places it
    // moves its findings to.
    const ownView = setup.views.has(site.declaration)
      ? normalized.views.find((v) => v.rootOrigin !== undefined && normalized.group.has(v.view))?.view
      : undefined;
    if (setup.views.has(site.declaration) && !ownView) {
      throw new Error(`internal: the door of own-check site ${site.id} holds no region of its forward view.`);
    }
    const viewMeta = ownView?.metadata as { name?: unknown; source?: unknown } | undefined;
    const viewIdentity = ownView && JSON.stringify([ownView.kind, viewMeta?.name, viewMeta?.source]);
    const viewRoots = ownView
      ? request.sites.flatMap((s) => {
          const at = placeByUnionKeys(setup.union, site.declaration, s.unionKeys, witness);
          return at.present ? [{ site: s, at: at.at }] : [];
        })
      : [];
    const holdingInView = (keys: readonly (string | number)[]): OwnSite | undefined => {
      let best: { site: OwnSite; at: readonly (string | number)[] } | undefined;
      for (const root of viewRoots) {
        if (!isAtOrAbove(root.at, keys)) continue;
        if (!best || root.at.length > best.at.length) best = root;
      }
      return best?.site;
    };
    const probes: AnalysisDiagnostic[] = [];
    raw.forEach(({ finding }, i) => {
      for (const path of [finding.judgedAt, (finding.diagnostic.data as { path?: string }).path ?? ""]) {
        probes.push({
          ...finding.diagnostic,
          code: `${OWN_SITE_MARKER}:${i}`,
          data: { ...(finding.diagnostic.data as Record<string, unknown>), path },
        });
      }
    });
    // A finding whose place no placement keeps (a view's own content) is
    // dropped where it is placed, and belongs to no site.
    const siteOf = new Map<number, string | undefined>();
    const identity = JSON.stringify(JSON.parse(site.id).slice(0, 3));
    for (const at of ownView ? normalized.inViews(probes) : normalized.placed(probes, false)) {
      const i = Number(String(at.code).slice(OWN_SITE_MARKER.length + 1));
      if (siteOf.get(i) !== undefined) continue;
      const data = at.data as { resource?: { kind?: unknown; name?: unknown }; filePath?: unknown; path?: unknown };
      const keys = parseKeys(String(data.path ?? ""));
      const holder = JSON.stringify([data.resource?.kind, data.resource?.name, data.filePath]);
      const holding = ownView
        ? holder === viewIdentity
          ? holdingInView(keys)
          : undefined
        : holder === identity
          ? ownSiteHolding(request.sites, keys)
          : undefined;
      siteOf.set(i, holding?.id);
    }
    const found: AnalysisDiagnostic[] = [];
    raw.forEach(({ m, group: checkGroup, finding }, i) => {
      if (!siteOf.has(i)) return;
      const owner = siteOf.get(i);
      if (owner === undefined) {
        throw new Error(
          `internal: an own-check finding judged for ${site.id} (${finding.diagnostic.code} at '${finding.judgedAt}') ` +
            "lies in no site of its declaration.",
        );
      }
      found.push({
        ...finding.diagnostic,
        data: {
          ...(finding.diagnostic.data as Record<string, unknown>),
          ownSite: owner,
          ownOrigin: origins.get(m),
          ownGroup: checkGroup,
        },
      });
    });
    const diagnostics = normalized
      .placed(found, true)
      .filter((d) => (d.data as { ownSite?: string }).ownSite === site.id)
      .map((d) => {
        const data = { ...(d.data as Record<string, unknown>) };
        delete data.ownSite;
        return { ...d, data: data as DiagnosticData };
      });
    // What a stand-in's place holds is judged once its choice is decided.
    const standIns = standInsAt(setup.choices, witness);
    return {
      diagnostics:
        standIns.length === 0
          ? diagnostics
          : withoutRefusedExpansionConsequences(diagnostics, { sites: [], diagnostics: [], refused: standIns }),
      origins: [...origins.values()],
    };
  }

  /** One configuration's analysis: `configuration` decides every choice and
   *  types each input it decides; without one, the manifests hold none. */
  private analyzeConfiguration(
    manifests: ResourceManifest[],
    options?: AnalysisOptions,
    registry?: AnalysisRegistry,
    zoneExportCache?: ZoneExportCache,
    configuration?: AnalysisConfiguration,
  ): ConfigurationAnalysis {
    const purpose = configuration?.run ?? "whole";
    reportAnalysisRun(purpose);
    if (!observingKeyCosts()) return this.analyzeConfigurationIn(manifests, options, registry, zoneExportCache, configuration);
    const started = performance.now();
    try {
      return this.analyzeConfigurationIn(manifests, options, registry, zoneExportCache, configuration);
    } finally {
      reportKeyCost({ kind: "run", purpose, milliseconds: performance.now() - started });
    }
  }

  private analyzeConfigurationIn(
    manifests: ResourceManifest[],
    options?: AnalysisOptions,
    registry?: AnalysisRegistry,
    zoneExportCache?: ZoneExportCache,
    configuration?: AnalysisConfiguration,
  ): ConfigurationAnalysis {
    const diagnostics: AnalysisDiagnostic[] = [];
    const celVerdictOf = configuration?.cel?.verdictOf;
    // A whole document written behind an expansion tag declares nothing until it
    // is expanded, so no pass reads it as a declaration; the expansion reader
    // judges it.
    const written = manifests;
    const expansionDocuments = manifests.filter(isExpansionSentinel);
    if (expansionDocuments.length > 0) {
      manifests = manifests.filter((m) => !isExpansionSentinel(m));
    }
    let expansion: ExpansionReading | undefined;
    let choiceExpansion: ChoiceExpansion | undefined;

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
    // The one validator for a value checked against a schema that may name a
    // registered shape: a module-level AJV holds none, so it compiles such a
    // schema nowhere and the value goes unchecked.
    const shapeAwareValidator: ShapeAwareValidator = {
      validate: (data, target, standIns) => defs.validateResourceConfig(data, target, standIns),
      external: (ref) => defs.schemaForId(ref),
    };

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
    // Every import in the set, by the module it loads: what tells a kind spelled
    // by the canonical name of a module some import loads from one nothing loads.
    const importersByModule = importersByModuleOf(manifests, rootModules);
    // Every imported library's own declarations, read by a projection hop into
    // a library's internals. Shared with the registry so an editor's contract
    // query resolves the same hops `telo check` does.
    const libraries = libraryDeclarations(options?.moduleDocuments ?? []);
    registry?._setLibraries(libraries, options?.moduleDocuments ?? []);
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
          // A module's OWN NAME resolves its kinds too, beside `Self` and for
          // the same reason: `<module>.<Kind>` IS the canonical identity the
          // registry keys on and every diagnostic prints, and `<module>.fn(…)`
          // is one of the names a CEL call resolves through. The kernel
          // registers both in every context; registering only `Self` here is
          // what let a spelling pass `telo check` and fail at boot.
          if (rootModules.has(moduleName)) {
            aliases.registerUngatedAlias("Self", moduleName);
            aliases.registerUngatedAlias(moduleName, moduleName);
          } else {
            let libResolver = aliasesByModule.get(moduleName);
            if (!libResolver) {
              libResolver = new AliasResolver();
              libResolver.registerUngatedAlias(TELO_BUILTIN_MODULE, TELO_BUILTIN_MODULE);
              aliasesByModule.set(moduleName, libResolver);
            }
            libResolver.registerUngatedAlias("Self", moduleName);
            libResolver.registerUngatedAlias(moduleName, moduleName);
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
        // A module NAME is not a module INSTANCE: the same library may be
        // reached twice in one graph through two different sources (a local
        // checkout alongside its own published artifact — the diamond the
        // "resolves to two modules in this graph" warning already tolerates
        // as two scopes). Each instance's own `imports:` is declared in its
        // own file, so folding the declaring file's stamped `source` into the
        // scope key keeps the two instances' aliases apart, while every
        // import actually declared in ONE file — inline map entries and
        // authored `Telo.Import` docs alike — still shares one scope.
        const ownSource = (m.metadata as { source?: string } | undefined)?.source;
        if (alias) {
          const scopeKey = ownModule ? `${ownModule}\0${ownSource ?? ""}` : "";
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
              : (aliasesByModule.get(ownModule) ?? libraryAliasTable(aliasesByModule, ownModule));
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
      if (!isKindDocument(m)) continue;
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
      if (!libResolver.hasAlias(ownModule)) {
        libResolver.registerUngatedAlias(ownModule, ownModule);
      }
    }

    // The names a CEL call's receiver may be, per declaring module: the module's
    // `imports:` keys, `Self`, its own `metadata.name` and `Telo`. Derived from
    // the manifests rather than from the alias tables so it is the SAME rule the
    // compile half applied over one file's documents — the two halves must agree
    // about what an expression says, and an alias table is built from RESOLVED
    // imports while compilation runs before any import resolves. Inline
    // extraction adds resources, never modules, so the raw set answers exactly
    // as the normalized one would.
    const moduleCallNames = moduleCallNamesByModule(manifests);

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
    const scopeSlotDiagnostics: AnalysisDiagnostic[] = [];
    const zoneSlotIssues: ZoneSlotIssue[] = [];
    // One place a rule report becomes a diagnostic. The pass decided WHAT and
    // WHERE; this only carries it across to the diagnostic shape.
    const SEVERITY = {
      error: DiagnosticSeverity.Error,
      warning: DiagnosticSeverity.Warning,
      information: DiagnosticSeverity.Information,
    } as const;
    const referrerRuleDiagnostic = (report: ReferrerRuleDiagnostic): AnalysisDiagnostic => {
      const diagnostic: AnalysisDiagnostic = {
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
      };
      return report.path === undefined ? diagnostic : withQuotedPath(diagnostic, report.path);
    };
    // An evaluation-time rule failure is ONE diagnostic per (declaring kind,
    // rule code) per analysis, anchored where the reader can act on it — the
    // `imports:` entry that brought the kind in, or the rule's own declaration
    // for a kind of the entry's own modules. Per site it produced one diagnostic
    // per resource the rule met, every one pointing at a line the reader does
    // not own and cannot fix.
    const ruleFailureLedger = new RuleFailureLedger();
    /** Each dependency's first-reaching entry import: the `imports:` line the
     *  reader can act on, for a refusal or a rule failure inside a dependency. */
    const reach = importReach(manifests as ResourceManifest[], rootModules);
    const ruleReports = new ResourceRuleReports((module) => reach.of(module));
    /**
     * One evaluation-time rule failure, re-anchored at the `imports:` entry that
     * brought the declaring kind in. For a kind of the entry's own modules — or
     * one no import names — the rule's own declaration is already the right
     * line, so `fallback` (the family's own adapter) carries it unchanged.
     */
    const ruleFailureDiagnostic = (
      report: ResourceRuleDiagnostic | ReferrerRuleDiagnostic,
      declaringModule: string | undefined,
      fallback: AnalysisDiagnostic,
    ): AnalysisDiagnostic => {
      const anchor = declaringModule ? reach.of(declaringModule) : undefined;
      if (!anchor) return fallback;
      return {
        severity: SEVERITY[report.severity],
        code: report.code,
        source: SOURCE,
        message: report.message,
        data: { filePath: anchor.filePath, path: anchor.path, rule: report.rule },
      };
    };
    /** A `capability:` the roster refuses, at the declaration for the entry's
     *  own modules and at the entry's `imports:` entry reaching a dependency's. */
    const capabilityDiagnostic = (
      m: ResourceManifest,
      declaringModule: string | undefined,
      issue: CapabilityProblem,
    ): AnalysisDiagnostic => {
      const label = `${m.kind} '${m.metadata?.name as string}'`;
      const via = declaringModule ? reach.of(declaringModule) : undefined;
      if (declaringModule && via) {
        return importAnchoredDiagnostic(issue.code, declaringModule, via, `${label}: ${issue.message}`);
      }
      return {
        severity: DiagnosticSeverity.Error,
        code: issue.code,
        source: SOURCE,
        message: `${label}: ${issue.message}`,
        data: {
          resource: { kind: m.kind, name: m.metadata?.name as string },
          filePath: (m.metadata as { source?: string } | undefined)?.source,
          path: "capability",
        },
      };
    };
    const projectionIssues: SchemaProjectionIssue[] = [];
    const resourceRuleIssues: ResourceRuleIssue[] = [];
    const referrerRuleIssues: ReferrerRuleIssue[] = [];
    /** Definition docs of the entry's own modules that may declare rules. Their
     *  referrer-rule declarations are checked after every kind is registered,
     *  because a `peers:` pointer is checked against the REFERRER kind's schema
     *  and that kind may be declared later in the same file. */
    const ownRuleDeclarers: ResourceManifest[] = [];
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
    // A contract field naming a shape is read as contract typing reads it: in
    // the module the kind's own imports give, with `extends` parents folded.
    const namedShapes: NamedShapeScope = {
      declarations: listRequests(manifests),
      modules: projectionModules(defs, aliases, { aliasesByModule, rootModules, libraries }),
    };
    for (const m of manifests) {
      const declared = kindDeclarationOf(m);
      if (!declared) continue;
      // A need type registers the Provider kind its fulfilments are — the
      // synthesized definition the kernel's need-type controller registers
      // from the same document.
      if (needTypeOf(declared)) {
        defs.register(declared);
        continue;
      }
      const def = m as unknown as ResourceDefinition;
      const ownModule = (def.metadata as { module?: string } | undefined)?.module;
      const scopeResolver = declaringModuleScope(ownModule, aliases, {
        aliasesByModule,
        rootModules,
      });
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
        for (const problem of scopeSlotProblems(def)) {
          scopeSlotDiagnostics.push({
            severity: DiagnosticSeverity.Error,
            code: "SCOPE_SLOT_MISPLACED",
            source: SOURCE,
            message: `${m.kind} ${problem.message}`,
            data: {
              resource: { kind: m.kind, name: def.metadata?.name as string },
              filePath: (def.metadata as { source?: string } | undefined)?.source,
              path: problem.path,
            },
          });
        }
        for (const problem of valueSchemaFromProblems(
          m as Record<string, any>,
          effectiveAuthorSchema(m as any, (k) => defs.resolve(aliases.resolveKind(k) ?? k) ?? defs.resolve(k)) as
            | Record<string, any>
            | undefined,
          (typeField) => resolveNamedShape(typeField, m as Record<string, any>, namedShapes),
        )) {
          scopeSlotDiagnostics.push({
            severity: DiagnosticSeverity.Error,
            code: "VALUE_SCHEMA_FROM_INVALID",
            source: SOURCE,
            message: `${m.kind} ${problem.message}`,
            data: {
              resource: { kind: m.kind, name: def.metadata?.name as string },
              filePath: (def.metadata as { source?: string } | undefined)?.source,
              path: problem.path,
            },
          });
        }
        zoneSlotIssues.push(...validateZoneSlotDeclarations(m as unknown as ResourceManifest));
        // Both rule families are checked after the registration loop: a
        // resource rule against the MERGED schema, whose parent may be declared
        // later in the file or in an imported module, and a referrer rule's
        // `peers:` against the REFERRER kind's schema.
        ownRuleDeclarers.push(m as unknown as ResourceManifest);
        for (const rule of readReferrerRules((m as Record<string, unknown>).schema)) {
          referrerRuleExercise.set(`${m.metadata?.module}.${m.metadata?.name}#${rule.code}`, {
            manifest: m as unknown as ResourceManifest,
            rule,
            exercised: false,
            seen: false,
          });
        }
      }
      // The closed roster: a `capability:` names a lifecycle role a kernel
      // implements, or the kernel refuses the definition at registration. So a
      // DEPENDENCY's definition is reported too — anchored at the `imports:`
      // entry reaching it, the line the consumer can act on — since the manifest
      // importing it cannot start.
      const capabilityIssue = capabilityProblem(def.capability, def.extends !== undefined);
      if (capabilityIssue) diagnostics.push(capabilityDiagnostic(m, ownModule, capabilityIssue));
      const resolvedExtends = def.extends
        ? (scopeResolver.resolveKind(def.extends) ?? def.extends)
        : def.extends;
      const normalized =
        resolvedExtends !== def.extends ? { ...def, extends: resolvedExtends } : def;
      defs.register(normalized);
    }

    // Where every expansion construct stands, read once every kind is known;
    // then this configuration's expansion, which every pass below reads. A
    // construct the reader refuses stays as written.
    expansion = readExpansionSites(manifests, expansionDocuments, defs, aliases, aliasesByModule);
    if (configuration) {
      const refused = new Set(expansion.sites.filter((site) => site.refusal).map((site) => site.value));
      choiceExpansion = expandChoices(
        written,
        configuration.decisions,
        (sentinel) => refused.has(sentinel),
        true,
      );
      manifests = choiceExpansion.manifests;
    }
    // Each template definition as its body expands in this run's variant: every
    // pass below reads the expanded body, while the registered definition keeps
    // the body as written.
    const templateVariants = new Map<string, { variant: DefinitionVariant; written: ResourceManifest }>();
    if (configuration?.template) {
      const { definitions, index } = configuration.template;
      const templated = new Set(definitions.definitions);
      manifests = manifests.map((m) => {
        if (!templated.has(m)) return m;
        const variant = definitions.variant(m, index);
        templateVariants.set(templateKeyOf(m), { variant, written: m });
        return variant.expansion.definition;
      });
    }
    for (const m of manifests) {
      const declaringModule = (m.metadata as { module?: string } | undefined)?.module;
      if (!declaringModule || rootModules.has(declaringModule)) {
        valueTypeSlotIssues.push(...validateValueTypeSlots(m as unknown as ResourceManifest));
        // A derivation is written wherever a schema is — an instance's own
        // contract or a named shape as much as a definition's.
        projectionIssues.push(...validateSchemaProjection(m as unknown as ResourceManifest));
      }
    }

    /** A named shape: a resource whose kind's capability is `Telo.Type`. */
    const namedShapeOf = (
      m: ResourceManifest,
    ): { ownModule: string; typeName: string; scope: AliasResolver } | undefined => {
      const ownModule = (m.metadata as { module?: string } | undefined)?.module;
      if (!ownModule || !m.metadata?.name || typeof m.schema !== "object" || m.schema === null) {
        return undefined;
      }
      const scope = declaringModuleScope(ownModule, aliases, { aliasesByModule, rootModules });
      const canonicalKind = scope.resolveKind(m.kind as string) ?? (m.kind as string);
      if (defs.resolve(canonicalKind)?.capability !== "Telo.Type") return undefined;
      return { ownModule, typeName: m.metadata.name as string, scope };
    };

    const libraryShapes = libraryNamedShapes(options, defs, aliases, aliasesByModule, rootModules);
    /** Every named shape `set` holds with its `extends` parents folded, as the
     *  kernel registers it — a shape the set holds before a library's own. */
    const foldedShapesOf = (
      set: readonly ResourceManifest[],
      // Registration reads each shape with its nested shape references made
      // canonical in its own module, before folding mixes modules.
      canonical = false,
    ): Array<{ m: ResourceManifest; id: string; schema: Record<string, any> }> => {
      const shapes = set.flatMap((m) => {
        const shape = namedShapeOf(m);
        if (!shape) return [];
        const schema = canonical
          ? canonicalShapeSchema(m.schema as Record<string, any>, shape.ownModule, (alias) =>
              shape.scope.moduleForAlias(alias),
            )
          : (m.schema as Record<string, any>);
        return [{ m, shape, schema }];
      });
      const folded = foldedNamedShapes([
        ...shapes.map(({ m, shape, schema }) => ({
          module: shape.ownModule,
          name: shape.typeName,
          schema,
          extends: (m as { extends?: unknown }).extends,
        })),
        ...libraryShapes,
      ]);
      return shapes.map(({ m, shape, schema }) => ({
        m,
        id: canonicalTypeSchemaId(shape.ownModule, shape.typeName),
        schema: folded(shape.ownModule, shape.typeName) ?? schema,
      }));
    };

    // A named shape is part of every kind schema that `$ref`s it, and the
    // reference reach follows it — so the shapes are announced to the reach
    // BEFORE the passes that read it (inline extraction, `!ref` resolution),
    // with the reference slots they declare canonicalized in the declaring
    // module's scope exactly as a definition's are, and their `extends` parents
    // folded, so a slot a parent declares is the child's. Registration proper
    // stays Phase 2.6, which takes each schema once those passes resolved it.
    for (const m of manifests) {
      const shape = namedShapeOf(m);
      if (!shape) continue;
      const issues = resolveSchemaRefKinds(m, shape.scope);
      if (rootModules.has(shape.ownModule)) {
        refConstraintIssues.push(...issues);
        refSlotIssues.push(...validateRefSlotDeclarations(m));
      }
    }
    for (const { id, schema } of foldedShapesOf(manifests as ResourceManifest[])) {
      defs.announceNamedShape(id, schema);
    }

    /**
     * What a peer rule's `peers:` pointer names in the kind its `referrer:`
     * filters to.
     *
     * Liskov in BOTH directions, which is what the check has to be: the filter
     * is usually an abstract (`Sql.Schema`, so one rule serves every backend)
     * while the collection is declared by the backends that implement it, so a
     * pointer resolving on any candidate resolves the rule. Reported only when
     * NO candidate declares it, or when every candidate that does holds plain
     * data — the two shapes where the rule would see no declaration at all.
     */
    const peersTarget = analyzerPeersTarget(defs);
    const referrerDeclares = analyzerReferrerDeclares(defs);

    // Checked against the MERGED schema, so an `in:` pointer naming an
    // inherited field resolves — which is what lets a rule shared by every
    // backend be declared once on the abstract they extend.
    const kindSchemas = analyzerKindSchemas(defs);
    const ruleShapes = (ref: string, module: string | undefined) =>
      defs.namedShapeAt(ref, module, moduleAliasScope({ module }, aliases, aliasesByModule));
    for (const declarer of ownRuleDeclarers) {
      resourceRuleIssues.push(
        ...validateResourceRuleDeclarations(
          declarer,
          effectiveAuthorSchema(declarer as any, (k) => defs.resolve(aliases.resolveKind(k) ?? k) ?? defs.resolve(k)),
          moduleCallNamesOf(moduleCallNames, declarer),
          kindSchemas,
          ruleShapes,
        ),
      );
    }

    // `observes` on a reference slot, judged once every kind is registered: the
    // slot's need type and the kind's own capability may be declared anywhere.
    // The slot on the kind's own schema; its holder on the merged one, as the
    // kernel judges it — a slot an abstract declares binds each implementation.
    if (!options?.skipValidation) {
      const resolveDef = (k: string) => defs.resolve(aliases.resolveKind(k) ?? k) ?? defs.resolve(k);
      for (const declarer of ownRuleDeclarers) {
        const module = (declarer.metadata as { module?: string } | undefined)?.module;
        const registered =
          (module ? defs.resolve(`${module}.${declarer.metadata?.name as string}`) : undefined) ??
          (declarer as unknown as ResourceDefinition);
        for (const problem of observesProblems(
          registered,
          (declarer as Record<string, unknown>).schema as Record<string, unknown> | undefined,
          effectiveAuthorSchema(declarer as any, resolveDef) as Record<string, unknown> | undefined,
          resolveDef,
        ).problems) {
          refSlotIssues.push({ ...problem, manifest: declarer });
        }
      }
    }

    if (!options?.skipValidation) {
      for (const declarer of ownRuleDeclarers) {
        referrerRuleIssues.push(
          ...validateReferrerRuleDeclarations(declarer, {
            peersTarget,
            referrerDeclares,
            selfDeclares: (pointer) =>
              rulePointerReaches(
                effectiveAuthorSchema(declarer as any, (k) => defs.resolve(aliases.resolveKind(k) ?? k) ?? defs.resolve(k)),
                pointer,
                kindSchemas,
              ),
            moduleNames: moduleCallNamesOf(moduleCallNames, declarer),
          }),
        );
      }
      // A topology role outside the vocabulary, and a `matcher` nothing reads.
      // Judged once every kind is registered, since a trigger slot the kind
      // inherits makes a top-level matcher legal.
      const resolveDef = (k: string) => defs.resolve(aliases.resolveKind(k) ?? k) ?? defs.resolve(k);
      for (const declarer of ownRuleDeclarers) {
        for (const problem of topologyRoleProblems(
          declarer as unknown as ResourceDefinition,
          effectiveAuthorSchema(declarer as any, resolveDef),
        )) {
          diagnostics.push({
            severity: DiagnosticSeverity.Warning,
            code: problem.code,
            source: SOURCE,
            message: `${declarer.kind} ${problem.message}`,
            data: {
              resource: { kind: declarer.kind, name: declarer.metadata?.name as string },
              filePath: (declarer.metadata as { source?: string } | undefined)?.source,
              path: problem.path,
            },
          });
        }
        // A caught-member mark nothing reads, and a catch list marking no code.
        for (const problem of caughtMemberProblems(declarer as Record<string, any>)) {
          diagnostics.push({
            severity:
              problem.code === "SCHEMA_VIOLATION" ? DiagnosticSeverity.Error : DiagnosticSeverity.Warning,
            code: problem.code,
            source: SOURCE,
            message: `${declarer.kind} ${problem.message}`,
            data: {
              resource: { kind: declarer.kind, name: declarer.metadata?.name as string },
              filePath: (declarer.metadata as { source?: string } | undefined)?.source,
              path: problem.path,
            },
          });
        }
      }
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
      diagnostics.push(...expansion.diagnostics);
      // The x-telo-ref annotation's own validity — the strict half of the
      // accessor split; `readRefSlot` stays lenient so surfaces keep working
      // mid-migration, and this reports what leniency would silently absorb.
      for (const issue of refSlotIssues) diagnostics.push(refSlotIssueDiagnostic(issue));
      diagnostics.push(...scopeSlotDiagnostics);
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
      for (const issue of [...resourceRuleIssues, ...referrerRuleIssues]) {
        diagnostics.push(ruleIssueDiagnostic(issue));
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
    const allManifests = normalizeInlineResources(manifests, defs, aliases, aliasesByModule, (definition, entry, keys) => {
      const expansion = templateVariants.get(templateKeyOf(definition))?.variant.expansion;
      if (!expansion) return undefined;
      return emittedInlineName(expansion, ["resources", entry, ...keys]);
    });

    // Phase 2.5: resolve `!ref <name>` sentinels at every ref slot to canonical
    // {kind, name} objects so downstream phases (validation, dependency graph,
    // kernel controllers) see a uniform shape. Runs after normalize so both
    // original and inline-extracted manifests have their sentinels resolved.
    resolveRefSentinels(allManifests, aliases, aliasesByModule, listResolution(allManifests), defs);

    // Every `x-telo-scope` member is a declaration of its holder's module,
    // scoped to the holder: it joins the analysed set and runs through every
    // pass a top-level resource does, and `scopeMembers.relocate` below reports
    // what a pass finds about it at its place inside the holder.
    const collectedMembers = collectScopeMembers(allManifests as unknown as ResourceManifest[], (d) =>
      defs.referenceSites(d, aliases, aliasesByModule),
    );
    const scopeMembers = new ScopeMembers([
      ...collectedMembers.analysed,
      ...collectedMembers.kindDocuments,
    ]);
    allManifests.push(...collectedMembers.analysed.map((member) => member.declaration));

    // Every consumer of a template body holding an expansion construct, with
    // that body as the consumer expands it in this configuration.
    const consumers = written.some(holdsTemplateConstructs)
      ? readTemplateConsumers({
          manifests: allManifests as unknown as ResourceManifest[],
          names: namesResolution(allManifests as unknown as ResourceManifest[]),
          registry: defs,
          aliases,
          aliasesByModule,
          rootModules,
          decidedValue: configuration?.decidedValue ?? (() => undefined),
        })
      : undefined;
    if (consumers) diagnostics.push(...consumers.diagnostics);
    // A dependency's own declarations of another library's templated kind: the
    // entry's check does not read them as written, yet the kernel expands each at
    // its `init()` all the same. Their choices are decided through the import
    // binding by the configuration in force (a literal is a fact, a chain to the
    // entry's dimensions is decided per configuration), and everything the
    // expansion refuses is reported at the entry's `imports:` entry reaching the
    // dependency. A value chained to an open binding is the configuration
    // reading's one refusal at that binding; what follows from it is dropped.
    const libraryDocuments = options?.moduleDocuments ?? [];
    const dependencyReads: { holder: ResourceManifest; source: string }[] = [];
    if (libraryDocuments.some((d) => d.manifests.some(holdsTemplateConstructs))) {
      const via = importReach(manifests as ResourceManifest[], rootModules);
      for (const documents of libraryDocuments) {
        if (rootModules.has(documents.module)) continue;
        const anchor = via.of(documents.module);
        if (!anchor || !via.loads(documents)) continue;
        const instancePath = via.pathOf(documents.module);
        const instanceManifests = instancePath
          ? documents.manifests.map((m) => ({
              ...m,
              metadata: { ...m.metadata, importPath: instancePath },
            }) as unknown as ResourceManifest)
          : documents.manifests;
        const dependencyConsumers = readTemplateConsumers({
          manifests: instanceManifests,
          names: namesResolution(instanceManifests),
          registry: defs,
          aliases,
          aliasesByModule,
          rootModules,
          consumerModules: new Set([documents.module]),
          decidedValue: configuration?.decidedValue ?? (() => undefined),
        });
        dependencyReads.push(...dependencyConsumers.reads);
        if (options?.skipValidation) continue;
        for (const d of dependencyConsumers.diagnostics) {
          if (dependencyConsumers.open.has(d)) continue;
          diagnostics.push(importAnchoredDiagnostic(String(d.code), documents.module, anchor, d.message));
        }
      }
    }

    // What a template body forwards with a bare `self.<path>` is, at boot, a
    // field of a resource of the entry's kind. Each such consumer gets a view of
    // that resource, analyzed beside everything else; its place map reports
    // what is found in it at the consumer's own path.
    const forwardViews = options?.skipValidation
      ? undefined
      : buildTemplateForwardViews(
          allManifests,
          namesResolution(allManifests),
          defs,
          aliases,
          { aliasesByModule, rootModules },
          (consumer) =>
          consumers?.expansions.get(consumer)?.expansion.definition,
        );
    if (forwardViews) allManifests.push(...forwardViews.analyzed);
    // A forward view, and what was extracted from one, exists for this analysis
    // alone: it is spelled by its entry's canonical kind and holds the consumer's
    // metadata, so no alias of the consumer need name its kind.
    const analysisOnlyDocs: ReadonlySet<ResourceManifest> = new Set(forwardViews?.analyzed ?? []);
    // Every request a builder reading other declarations makes, answered from
    // this configuration's whole set.
    const declarationRequests = listRequests(allManifests as unknown as ResourceManifest[], {
      referrersOf: (m) => referrerSlotsOf(getCallGraph(), m),
    });
    // Which module wrote each manifest, and the language it writes its texts in.
    const textLanguages = new TextLanguageScope(
      declarationRequests,
      rootModules,
      options?.moduleDocuments ?? [],
    );

    // ONE typed reference graph per analysis. Both graph consumers in this
    // pass (the dynamic-selector check and run-reachability) read the same
    // build — constructing it per consumer is strictly more work than the
    // walks it replaced, and performance is a core goal. Lazy, so a
    // skipValidation pass with no observed state builds nothing.
    let callGraphMemo: ReturnType<typeof buildCallGraph> | undefined;
    /** Where a declaration's own-check findings are taken, in a run whose
     *  sites are keyed: each marker and the declaration it stands for. */
    const ownMarkers: { marker: AnalysisDiagnostic; m: ResourceManifest }[] = [];
    /** Mark where the findings of `m`'s own checks of `group` go, its sites'
     *  keys judged once outside the run. */
    const markOwnGroup = (group: OwnGroup, m: ResourceManifest): void => {
      const marker: AnalysisDiagnostic = {
        severity: DiagnosticSeverity.Hint,
        code: OWN_SITE_MARKER,
        source: SOURCE,
        message: "",
        data: { ownGroup: group },
      };
      ownMarkers.push({ marker, m });
      diagnostics.push(marker);
    };
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

      // A region must not contain a resource that declares it cannot honour what
      // the region promises — the downward walk over every zone attribute. The
      // durable rules walk the same regions once each function's flags are
      // derived, below.
      const resolveRegionDef = regionDefResolver(defs, aliases, aliasesByModule);
      diagnostics.push(
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
    // The schema registered is the shape's with its `extends` parents folded —
    // what the kernel registers, so a nested `$ref` to it reads the inherited
    // members too.
    for (const { m, id, schema } of foldedShapesOf(allManifests as unknown as ResourceManifest[], true)) {
      const typeName = m.metadata.name as string;
      const ownModule = (m.metadata as { module: string }).module;
      const registered = defs.registerNamedTypeSchema(id, schema);
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
      if (configuration?.passes) diagnostics.push(...configuration.passes("sinkAttachment"));
      else reportConditionedPass("sinkAttachment", configuration !== undefined);
      diagnostics.push(
        ...validateSinkAttachment(
          allManifests as unknown as ResourceManifest[],
          getCallGraph(),
          defs,
          aliases,
          aliasesByModule,
          rootModules,
          configuration?.passes !== undefined,
        ),
      );
      // Module-artifact surface: bundled-controller selector qualifiers and the
      // published `layers:` index. Every case is decidable from the manifest and
      // would otherwise fail on a consumer's machine — or, for a mistyped platform
      // axis, silently offer one platform's binary to every host.
      diagnostics.push(...validateModuleArtifact(allManifests));
      // The module doc's `native:` block: each rule decides whether a platform's
      // file can ever match a host, or whether two layers would write one path.
      diagnostics.push(...validateNativeEntries(allManifests, rootModules));
      // The module doc's `sources:` block: where each staged file comes from.
      diagnostics.push(...validateSourceEntries(allManifests, rootModules));
      // The descriptive `metadata:` surface. Nothing in the kernel branches on
      // these fields, which is precisely why they need a check: a mistyped one
      // has no runtime failure mode that would ever surface it.
      diagnostics.push(...validateModuleMetadata(allManifests, defs, aliases));
      // Every author-written name. Telo has no lexer, so a name's shape is
      // unchecked where it is declared and its consequences land at whichever
      // CEL site reads it — for a hyphen, sometimes as silent arithmetic. Takes
      // the call graph for step names rather than re-walking the step arrays.
      // A name's verdict reads the name and its kind's level alone, so in a run
      // whose sites are keyed each declaration's names are judged once per key
      // of its schema sites, taken at a marker here.
      if (configuration?.own) {
        for (const m of allManifests as unknown as ResourceManifest[]) {
          if (writesJudgedNames(m, rootModules)) markOwnGroup("identifiers", m);
        }
      } else {
        reportIdentifierPass(configuration !== undefined);
        diagnostics.push(
          ...validateIdentifierNames(
            allManifests as unknown as ResourceManifest[],
            defs,
            aliases,
            rootModules,
            getCallGraph(),
            { aliasesByModule, rootModules, libraries },
          ),
        );
      }
      // A `rethrow:` outside every catch: branch has no caught failure to re-raise.
      diagnostics.push(
        ...validateRethrowPlacement(defs, aliases, rootModules, getCallGraph(), {
          aliasesByModule,
          rootModules,
          libraries,
        }),
      );
      // A file embed resolves at resource creation, so one written on a doc that
      // is never instantiated is read by nothing and would ship silently.
      diagnostics.push(...validateIncludePlacement(allManifests));
      // A relative host path is read only where the host supplies it, so one a
      // kind or a library writes as its own default names nothing fixed.
      diagnostics.push(
        ...validateHostPathDefaults(allManifests as unknown as ResourceManifest[], rootModules),
      );
      // The command-line bindings the kernel parses argv against: a conflict
      // between two of them, or a secret on the command line.
      diagnostics.push(
        ...validateApplicationArguments(allManifests as unknown as ResourceManifest[], rootModules),
      );
      diagnostics.push(
        ...validateInputDefaults(allManifests as unknown as ResourceManifest[], rootModules),
      );
    }
    if (!options?.skipValidation) {
      // A `${{` left in a plain string: unmigrated, or no readable hole.
      diagnostics.push(
        ...validateUntaggedInterpolation(
          allManifests as unknown as ResourceManifest[],
          rootModules,
          options?.moduleDocuments,
        ),
      );
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
    // over both is the whole repair. The shapes a kind's contract or signature
    // names are resolved there first, for the same reason.
    resolveShapeRefs(manifests, aliases, aliasesByModule, listResolution(manifests));
    resolveSchemaTypeRefs(manifests, aliases, aliasesByModule);

    // Trusted-input fast path: when the caller has already attested that
    // this exact manifest set passes analysis (e.g. via the kernel's
    // hash-stamped `.validated.json` cache), skip the validation walk.
    // Registration of identities / aliases / definitions and inline-resource
    // normalisation have already run above; that's all downstream
    // consumers (prepare, init loop) require.
    if (options?.skipValidation) {
      return {
        diagnostics: suppressUnreadableModuleDiagnostics(rerootedQuotes(scopeMembers.relocate(diagnostics)), unreadableFiles),
        ...(expansion ? { expansion } : {}),
        ...(consumers || dependencyReads.length > 0
          ? { consumerReads: [...(consumers?.reads ?? []), ...dependencyReads] }
          : {}),
      };
    }

    // ONE binder for the whole run, built beside the binding it serves: it caches
    // each referrer's resolved collection, which is what keeps a rule over an
    // n-entry collection from re-resolving that collection once per entry.
    // A rule reads an accessor field as its binding: each bound declaration
    // through its own kind's sites, in its declaring module's scope.
    const ruleDef: DefResolver = (k) => defs.resolve(aliases.resolveKind(k) ?? k) ?? defs.resolve(k);
    const ruleSites = new WeakMap<object, CelEvalSites | undefined>();
    // A template body's entry, with the module of the definition that wrote it:
    // its kind is spelled through that module's aliases, and an expression there
    // reading only `self` is resolved before the entry is created.
    let bodyEntryModules: WeakMap<object, { module: unknown }> | undefined;
    const bodyEntryOf = (declaration: object) => {
      if (!bodyEntryModules) {
        bodyEntryModules = new WeakMap();
        for (const m of allManifests as ResourceManifest[]) {
          const entries = (m as Record<string, unknown>).resources;
          if (m.kind !== "Telo.Definition" || !Array.isArray(entries)) continue;
          const holder = { module: (m.metadata as { module?: unknown } | undefined)?.module };
          for (const entry of entries) {
            if (entry && typeof entry === "object") bodyEntryModules.set(entry, holder);
          }
        }
      }
      return bodyEntryModules.get(declaration);
    };
    // A reference a dependency's declaration writes, resolved in the module that
    // declared it: among that module's declarations this analysis holds, or
    // through that module's own import of the alias it names.
    // A module imported several times declares a name once per instance.
    let declaredByModule: Map<string, ResourceManifest[]> | undefined;
    const declaredIn = (
      module: string,
      name: string,
      instance: readonly string[] | undefined,
    ): ResourceManifest | undefined => {
      if (!declaredByModule) {
        declaredByModule = new Map();
        for (const m of allManifests as ResourceManifest[]) {
          const owner = (m.metadata as { module?: unknown } | undefined)?.module;
          const declared = m.metadata?.name;
          if (typeof owner !== "string" || typeof declared !== "string") continue;
          if (isKindDocumentOrImport(m)) continue;
          const key = `${owner}\0${declared}`;
          declaredByModule.set(key, [...(declaredByModule.get(key) ?? []), m]);
        }
      }
      const declared = declaredByModule.get(`${module}\0${name}`);
      if (!declared) return libraries.declaration(module, name);
      return ofInstance(declared, instance)[0];
    };
    const forwardedReference: ForwardedReference = (target, module, writer) => {
      const local = target.alias === undefined || target.alias === "Self";
      const owner = local ? module : aliasesByModule.get(module)?.moduleForAlias(target.alias!);
      // Read in the writer's own instance: a local name is its sibling there, an
      // alias that instance's import.
      const instance = local ? importPathOf(writer) : importPathThrough(writer, target.alias!);
      const declaration = owner === undefined ? undefined : declaredIn(owner, target.name, instance);
      if (!owner || !declaration || typeof declaration.kind !== "string") return undefined;
      // The kind is written through the declaring module's aliases.
      const kind = declaration.kind.startsWith("Self.")
        ? `${owner}.${declaration.kind.slice("Self.".length)}`
        : (aliasesByModule.get(owner)?.resolveKind(declaration.kind) ?? declaration.kind);
      return resolvedReference(kind, target.name, local ? undefined : target.alias);
    };
    const ruleViews = new RuleDeclarationViews((declaration, module) => {
      const bodyEntry = bodyEntryOf(declaration);
      const definition = definitionInScope(
        defs,
        declaration.kind,
        { module: bodyEntry ? bodyEntry.module : module },
        aliases,
        aliasesByModule,
      ) as unknown as ResourceDefinition | undefined;
      if (!definition) return bodyEntry && { bodyEntry: true };
      if (!ruleSites.has(definition)) {
        ruleSites.set(definition, governedCelEvalSites(definition, ruleDef, defs.shapeLookup));
      }
      return { sites: ruleSites.get(definition), bodyEntry: bodyEntry !== undefined };
    }, forwardedReference);
    const referrerRuleContext: ReferrerRuleContext = {
      peerBinder: analyzerPeerBinder(
        defs,
        aliases,
        declarationRequests,
        // The same acceptance rule the reference check applies at the slot, so a
        // rule is never evaluated over a declaration that slot refuses — the
        // resource is already reported there (`REFERENCE_KIND_MISMATCH`), and a
        // second diagnostic about the rule's internals would blame the kind's
        // author for the manifest author's mistake.
        (slotKinds, declarationKind) =>
          slotKinds.some((target) => kindSatisfies(declarationKind, target, defs)),
        (declaration) => ruleViews.of(declaration),
      ),
    };

    // `x-telo-sensitive` and `x-telo-span-attribute` are read by ONE consumer —
    // the kernel, off a bound contract, following `$ref` — so both run the
    // kernel's own walk over every declared contract, once named shapes resolve.
    // A mark no contract reaches is inert; for a security control above all,
    // inert-and-silent is the failure worth reporting.
    const resolveMarkDef: DefResolver = (k) => defs.resolve(aliases.resolveKind(k) ?? k) ?? defs.resolve(k);
    const capabilityOf = (m: ResourceManifest): string | undefined =>
      typeof m.kind === "string"
        ? inheritedCapability(
            definitionInScope(defs, m.kind, m.metadata, aliases, aliasesByModule),
            resolveMarkDef,
          )
        : undefined;
    for (const issue of [
      ...validateSensitiveSlots(allManifests as ResourceManifest[], rootModules, capabilityOf),
      ...validateSpanAttributes(allManifests as ResourceManifest[], rootModules, capabilityOf),
    ]) {
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
          if ("arg" in (entry as Record<string, unknown>)) {
            diagnostics.push({
              severity: DiagnosticSeverity.Error,
              code: "LIBRARY_ARG_KEY_REJECTED",
              source: SOURCE,
              message:
                `Telo.Library ${block}/${entryName}: 'arg:' is only permitted on Telo.Application entries — ` +
                `only the application being run reads the command line. ` +
                `Libraries must receive values from importers via the parent manifest's variables / secrets block.`,
              data: { resource, filePath, path: `${block}.${entryName}.arg` },
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
    const moduleScopes = { aliasesByModule, rootModules, libraries };

    const observed = [...observedDeclarations(declarationRequests, defs, aliases, moduleScopes)];
    const observedState = new Map(observed.map((d) => [d.key, d.resource]));
    const observedNames = observedStateNames(observed);
    // The one `resources` record every `resources.<name>` reader reads: a
    // scope's members only where that scope's run evaluates the field.
    const scopedResources = scopedResourcesOf(observed, (m) =>
      celScopeHolderOf(m, defs, aliases, aliasesByModule),
    );
    // What a template body's own entries add to `resources` inside the body.
    const bodyResources = bodyResourcesFor(
      defs,
      aliases,
      moduleScopes,
      (definition) => templateVariants.get(templateKeyOf(definition))?.variant.expansion.families,
    );
    const scopedMemberNames = new Set(scopeMembers.all.map((member) => member.address.member));
    const scopedDefs = moduleScopedDefResolver<ResourceDefinition>(defs, aliases, moduleScopes);
    /** How the kind of a resource declared inline below `host` evaluates the
     *  field `path` crosses into — `undefined` when the path crosses none. */
    // Whether a path inside a template body's entry is an accessor field's value,
    // by the entry kind's own sites, resolved in the defining module.
    const bodyAccessorSites = new Map<ResourceManifest, Array<{ prefix: string; sites: CelEvalSites }>>();
    const bodyReadingAt = (
      host: ResourceManifest,
      path: string,
    ): { sites: CelEvalSites; localPath: string } | undefined => {
      if (host.kind !== "Telo.Definition") return undefined;
      let bodies = bodyAccessorSites.get(host);
      if (!bodies) {
        const module = host.metadata?.module as string | undefined;
        const resolve: DefResolver = (kind) => scopedDefs.in(kind, module);
        bodies = templateBodies(host, defs, aliases, moduleScopes).map((body) => ({
          prefix: body.prefix,
          sites: kindCelEvalSites(body.definition, resolve, defs.shapeLookup),
        }));
        bodyAccessorSites.set(host, bodies);
      }
      const body = bodies.find((b) => path.startsWith(`${b.prefix}.`));
      return body && { sites: body.sites, localPath: path.slice(body.prefix.length + 1) };
    };
    const bodyAccessorAt = (host: ResourceManifest, path: string): boolean => {
      const body = bodyReadingAt(host, path);
      return body !== undefined && accessorSiteAt(body.sites, body.localPath) !== undefined;
    };
    /** The mode the NESTED kind evaluates a body entry's field in. */
    const bodyEvalModeAt = (host: ResourceManifest, path: string) => {
      const body = bodyReadingAt(host, path);
      return body ? celEvalModeAt(body.sites, body.localPath) : undefined;
    };
    /** The scope a name written at `path` on a declaration is read in. */
    const holderScopes = new Map<ResourceManifest, readonly DeclaredScope[]>();
    const scopeOfPath = (holder: ResourceManifest, path: string): ScopeSite | undefined => {
      const address = addressOf(holder);
      if (!address) return undefined;
      let scopes = holderScopes.get(holder);
      if (!scopes) {
        scopes = declaredScopes(defs.referenceSites(holder, aliases, aliasesByModule));
        holderScopes.set(holder, scopes);
      }
      return scopeSiteAtPath(address, scopes, path);
    };
    /**
     * What `CEL_UNKNOWN_FIELD` adds for a `resources.<name>` the record lacks at
     * `path` on `m` (an extraction as extracted, before its diagnostics unfold):
     * where a `!ref` written there would reach a scope member, where that member
     * is declared and where `resources` holds it; otherwise, where `m` is an
     * inline declaration created outside a scope declaring the name, why it is
     * out of reach.
     */
    const scopeMemberClause = (m: ResourceManifest, path: string, message: string): string => {
      const name = /^'resources\.([A-Za-z_][A-Za-z0-9_]*)' is not defined/.exec(message)?.[1];
      if (name === undefined) return "";
      const located = (isForwardedDeclaration(m) ? observedNames.forwarded : observedNames.local).locate(
        name,
        m.metadata?.module as string | undefined,
        scopeOfPath(m, path),
      );
      const scope = located?.address.scope ? located.declaration.resource.scope : undefined;
      if (scope) {
        return (
          ` — '${name}' is declared in the '${scope.field}' scope of ${scope.kind}/${scope.name ?? "(unnamed)"}; ` +
          "a scope member is in `resources` only where that scope's run evaluates the field " +
          "(its regions, outside compile-eval fields)."
        );
      }
      const outside = outOfReachNames(m).get(name);
      return outside ? ` — ${outOfReachSentence(name, outside)}` : "";
    };
    const reportsObservedState = [...observedState.values()].some((r) => r.status || r.reading);
    // Whether anything starts a resource is a configuration run's question.
    const runReachable =
      reportsObservedState ? collectRunReachableNames(getCallGraph()) : new Set<string>();
    // "Nothing starts this" is DECLARATION-derived, and a library does not
    // declare its injected inputs — whether the application starts the instance
    // it hands down is answerable only where that instance is declared. Inside
    // the library the question has no answer, so the name is treated as
    // reachable rather than reported on a `targets:` list the author cannot
    // write. The check still runs at the injection site, against the real
    // declaration.
    for (const m of allManifests) {
      if (isInjectedDeclaration(m)) runReachable.add(m.metadata?.name as string);
    }

    // What every module call names — resolved once per declaring module and
    // qualified name, and read by the call typing, the call diagnostics and the
    // `resources` scope (a function publishes no reading).
    const moduleFunctions = new ModuleFunctionIndex(
      declarationRequests,
      defs,
      aliases,
      aliasesByModule,
      rootModules,
    );
    // Each function's determinism and host-backedness, derived over everything
    // it reaches — read by the durable rules, the compile-eval warning, rule
    // conditions and the slots holding a function.
    const callableFlags = new CallableFlagsIndex(moduleFunctions, moduleCallNames);
    // What a rule condition's module calls run as when `telo check` evaluates it.
    const bodyEvaluators = new FunctionBodyEvaluators(
      moduleFunctions,
      callableFlags,
      moduleCallNames,
      (ref) => defs.schemaForId(ref),
    );

    // A rule condition may call a function only where the analyzer can run it:
    // judged through the derived flags, now that every function is known.
    for (const declarer of ownRuleDeclarers) {
      const names = moduleCallNamesOf(moduleCallNames, declarer);
      const flagsOf = (qualified: string) => callableFlags.ofCall(declarer, qualified);
      for (const issue of [
        ...resourceRuleCallIssues(declarer, names, flagsOf),
        ...referrerRuleCallIssues(declarer, names, flagsOf),
      ]) {
        diagnostics.push(ruleIssueDiagnostic(issue));
      }
    }

    // Durable regions — the call graph walked DOWNWARD. Every rule here keys off
    // a zone attribute rather than off any kind, so a backend that ships its own
    // workflow kind is covered without the analyzer knowing it exists: going
    // native costs a module, not a change here.
    diagnostics.push(
      ...validateDurableRegions({
        graph: getCallGraph(),
        resolveDef: regionDefResolver(defs, aliases, aliasesByModule),
        reportModules: rootModules,
        moduleCallNames,
        moduleCallFlags: (caller, qualified) => callableFlags.ofCall(caller, qualified),
      }),
    );

    // Build typed kernel globals schema so x-telo-context chain validation
    // recognises variables, secrets, resources, env automatically
    const kernelGlobals = buildKernelGlobalsIndex(
      declarationRequests,
      observedState,
      moduleFunctions,
      analysisOnlyDocs,
      scopedResources,
      configuration?.narrowing,
      bodyResources,
    );
    // What an import hands a library's host-path input, read against the
    // importer's own declarations — the library resolves nothing it is given.
    diagnostics.push(
      ...validateImportHostPaths(
        allManifests as unknown as ResourceManifest[],
        rootModules,
        kernelGlobals,
      ),
    );
    // Every literal an import supplies, held to the entry the library declares.
    diagnostics.push(
      ...validateImportInputs(
        allManifests as unknown as ResourceManifest[],
        rootModules,
        options?.moduleDocuments ?? [],
        defs,
      ),
    );

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
    // namespace; threaded into per-resource CEL typing so `!cel "ports.X"`
    // resolves its nominal brand cross-doc. A flattened set holds exactly one —
    // the entry's; see `buildKernelGlobalsSchema`.
    const moduleManifest =
      allManifests.find((mm) => mm.kind === "Telo.Application") ??
      allManifests.find((mm) => mm.kind === "Telo.Library");

    // What every CEL expression in this set is typed against. The rule lives in
    // `cel-scope.ts` so the IDE asks the same question the pass does — a
    // completion list is a claim that the name it offers will pass this check,
    // and two implementations of it could not be held in agreement.
    // Each imported library's full document set: a library's exported entry
    // point is forwarded into the flat set while the siblings it invokes are not,
    // so without them a throw union stops at the boundary.
    const libraryManifests = new Map<string, ResourceManifest[]>();
    for (const doc of options?.moduleDocuments ?? []) {
      libraryManifests.set(doc.module, doc.manifests);
    }
    // The catch ladder, built on first use: the CEL scope rule reads it to type
    // a catch entry's `data`-marked members from the codes the entry matches,
    // and the coverage pass derives its verdicts from the same one.
    let catchLadderMemo: CatchLadder | undefined;
    const catchLadder = (): CatchLadder =>
      (catchLadderMemo ??= new CatchLadder(
        declarationRequests,
        defs,
        aliases,
        this.celEnv,
        aliasesByModule,
        rootModules,
        libraryManifests,
      ));
    const celScope = new CelScopeResolver({
      celEnv: this.celEnv,
      defs,
      aliases,
      scopes: { aliasesByModule, rootModules, libraries },
      declarations: declarationRequests,
      shapes: defs.shapeLookup,
      kernelGlobals,
      moduleManifest,
      observedStateContext,
      moduleCallNames,
      moduleFunctions,
      callableFlags,
      definitionOf: (m) =>
        definitionInScope(defs, m.kind, m.metadata, aliases, aliasesByModule) as ResourceDefinition | undefined,
      caughtDataAt: (m, path) => catchLadder().caughtDataAt(m, path),
      loopBindingsAt: (m, path) => {
        const found = templateVariants.get(templateKeyOf(m));
        return found ? loopBindingsAtPath(found.variant, m as { resources?: unknown }, path) : undefined;
      },
    });
    // Every CEL site is judged over this world: what the configuration's whole
    // set contributes, built above, and the requests the scope rule answers.
    const celJudge = new CelJudge({
      celScope,
      defs,
      aliases,
      rootModules,
      shapes: defs.shapeLookup,
      kernelGlobals,
      moduleCallNames,
      moduleFunctions,
      observedState,
      observedNames,
      scopedResources,
      bodyResources,
      scopedMemberNames,
      reportsObservedState,
      runReachable,
      ...(forwardViews ? { forwardViews } : {}),
      textLanguages,
      bodyEvalModeAt,
      bodyAccessorAt,
      scopeMemberClause,
      validationSchemaFor: (definition) => validationSchemaFor(definition),
      configurationRun: celVerdictOf !== undefined,
    });
    // What each expression was typed as, read by the checks joining a value to
    // its slot.
    const {
      typeByPath: celTypeByPath,
      sourceByPath: celSourceByPath,
      literalByPath: celLiteralByPath,
      sourceSchemaByPath: celSourceSchemaByPath,
      composedByPath: celComposedByPath,
      variantFacts: celVariantFacts,
    } = celJudge;

    /**
     * The schema a resource of this kind is validated against, per DEFINITION.
     *
     * Both halves derive a fresh object — `effectiveAuthorSchema` merges along
     * `extends`, and the closed-schema branch spreads `kind` / `metadata` in —
     * so asking per resource handed `validateResourceConfig` a schema object it
     * had never seen. That registry memoizes its compiled AJV validator by
     * object IDENTITY, precisely because every resource of a kind is checked
     * against the same one at keystroke time, so a fresh object per resource
     * recompiled the whole kind schema per resource. Keyed on the definition,
     * which is stable for the run.
     */
    const authorSchemaCache = new WeakMap<object, Record<string, any>>();
    const validationSchemaFor = (def: ResourceDefinition): Record<string, any> => {
      const cached = authorSchemaCache.get(def as unknown as object);
      if (cached) return cached;
      const authorSchema = effectiveAuthorSchema(def, (k) =>
        defs.resolve(aliases.resolveKind(k) ?? k) ?? defs.resolve(k),
      );
      // `kind` and `metadata` are implicit on every resource — inject them so
      // module authors don't have to repeat them under `additionalProperties:
      // false`.
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
      authorSchemaCache.set(def as unknown as object, schema);
      return schema;
    };

    // One scope for the whole run: it closes over the manifest list and the
    // registry, neither of which changes per resource, and it is asked once per
    // schema-valued slot that carries a projection.
    const projectionDefs = moduleScopedDefResolver<Record<string, any>>(defs, aliases, {
      aliasesByModule,
      rootModules,
    });
    const resourceProjectionScope = projectionScopeOf(
      listRequests(allManifests),
      (kind, declaration) => projectionDefs(kind, declaration),
      projectionModules(defs, aliases, { aliasesByModule, rootModules, libraries }),
    );
    // The host a contract's location is read through, so a configuration slot
    // and a contract node resolve a named type field the same way: in the
    // module that declared its holder.
    const valueSchemaHost = valueSchemaHostOf(
      analyzerContractScope(
        defs,
        aliases,
        { aliasesByModule, rootModules, libraries },
        listRequests(allManifests),
      ),
    );

    // The child applications the loader followed, by declaring file and source.
    const applicationSources = options?.applicationSources ?? {};

    // Which definition each declaration's own checks read: one reader for this
    // run and for a key's environment.
    const declaredScope: DeclaredDefinitionScope = {
      defs,
      aliases,
      aliasesByModule,
      rootModules,
      importersByModule,
      analysisOnly: (m) => analysisOnlyDocs.has(m),
    };
    const ownCheckWorld: OwnCheckWorld = {
      defs,
      aliases,
      aliasesByModule,
      rootModules,
      libraries,
      moduleCallNames,
      celFacts: celJudge,
      moduleDocuments: options?.moduleDocuments ?? [],
      applicationSources,
      declaredScope,
      validationSchemaFor,
      projectionScope: resourceProjectionScope,
      narrowing: configuration?.narrowing,
      validator: shapeAwareValidator,
      valueSchemaHost,
      types: declarationRequests,
      identifierNames: (m) =>
        declarationNameFindings(m, defs, aliases, rootModules, getCallGraph(), { aliasesByModule, rootModules, libraries }).map(
          asOwnFinding,
        ),
    };
    /** A declaration's own checks of `group`: judged here, or — in a run whose
     *  sites are keyed — once per key outside it, taken at a marker pushed here. */
    const ownGroupFindings = (group: OwnGroup, m: ResourceManifest, judge: () => OwnFinding[]): void => {
      if (configuration?.own) {
        markOwnGroup(group, m);
        return;
      }
      for (const { diagnostic } of judge()) diagnostics.push(diagnostic);
    };
    /** A relational group judged per instance: each instance of `m` judged
     *  here, or — in a run whose sites are keyed — marked where it stands, its
     *  site's key judged once outside the run. */
    const relationGroupFindings = (group: RelationalGroup, m: ResourceManifest): void => {
      if (!configuration?.own) {
        for (const { diagnostic } of directRelationFindings(group, m, {
          defs,
          aliases,
          aliasesByModule,
          rootModules,
          libraries,
          validator: shapeAwareValidator,
          requests: declarationRequests,
          declaredScope,
          moduleCallNames,
          celFacts: celJudge,
          narrowing: configuration?.narrowing,
          moduleDocuments: options?.moduleDocuments ?? [],
          applicationSources,
        })) {
          for (const settled of ruleReports.settle([diagnostic])) diagnostics.push(settled);
        }
        return;
      }
      for (const instance of readerOf(group).instances(relationRegionOf(m, []), directReaderScope(m, declaredScope, libraries, moduleCallNames))) {
        diagnostics.push({
          severity: DiagnosticSeverity.Hint,
          code: RELATION_SITE_MARKER,
          source: SOURCE,
          message: "",
          data: {
            relationGroup: group,
            resource: { kind: m.kind, name: m.metadata?.name as string },
            filePath: (m.metadata as { source?: string } | undefined)?.source,
            path: pathText(instance.anchor),
          },
        });
      }
    };

    // Validate each non-definition, non-system resource; its rules are this
    // configuration's.
    for (const m of allManifests) {
      const filePath = (m.metadata as { source?: string } | undefined)?.source;
      const declared = declaredDefinitionOf(m, declaredScope);
      const ownSchemaFindings = () =>
        ownGroupFindings("schema", m, () => ownSchemaChecks(ownCheckWorld, m, declared));
      // A choice nothing decides, a forwarded export and an injected input
      // declare nothing of their own to judge here.
      if (declared.status === "skip") continue;
      if (declared.status === "missing") {
        diagnostics.push({
          severity: DiagnosticSeverity.Error,
          code: "MISSING_KIND_OR_NAME",
          source: SOURCE,
          message: "Resource is missing required 'kind' or 'metadata.name' field.",
          data: { filePath, path: declared.path },
        });
        continue;
      }
      // An abstract carries no template body, so the per-resource walk has nothing
      // to check in it beyond its shape. Definitions are walked whole: their
      // template bodies contain CEL that must be checked against `self` /
      // `inputs` / `result`.
      if (declared.status === "abstract-document") {
        ownSchemaFindings();
        continue;
      }
      const resource = { kind: m.kind, name: m.metadata?.name as string };
      if (declared.status === "gated") {
        diagnostics.push({
          severity: DiagnosticSeverity.Error,
          code: "KIND_NOT_EXPORTED",
          source: SOURCE,
          message:
            `Kind '${m.kind}' is not exported by module '${declared.module}'. ` +
            `Add '${m.kind.slice(m.kind.indexOf(".") + 1)}' to that module's exports.kinds ` +
            `to make it importable. Exported kinds: ${declared.exported.join(", ") || "(none)"}.`,
          data: { resource, filePath, path: "kind" },
        });
        continue;
      }
      // The kernel resolves an entry-module resource's kind through that module's own
      // aliases alone, so a module another module imports is not reachable by its name
      // from here, however the registry keys its definitions.
      if (declared.status === "unimported") {
        const { prefix, ownAliases } = declared;
        const suffix = m.kind.slice(prefix.length + 1);
        const repair =
          ownAliases.length > 0
            ? `This module imports it as '${ownAliases[0]}' — write '${ownAliases[0]}.${suffix}'.`
            : `It is loaded through another module's imports, which does not make its kinds ` +
              `available here — add it to this module's 'imports:'.`;
        diagnostics.push({
          severity: DiagnosticSeverity.Error,
          code: "UNDEFINED_KIND",
          source: SOURCE,
          message:
            `Kind '${m.kind}': no module imported with alias '${prefix}' in this module. ` +
            `${repair} Known aliases: ${aliases.knownAliases().join(", ") || "(none)"}.`,
          data: {
            resource,
            filePath,
            path: "kind",
            ...(ownAliases.length > 0
              ? { suggestedKind: `${ownAliases[0]}.${suffix}`, fix: { replacement: `${ownAliases[0]}.${suffix}` } }
              : {}),
          },
        });
        continue;
      }
      if (declared.status === "builtin-vocabulary") {
        // Registered nowhere on purpose; say what the document is rather than
        // suggesting a kind of a similar spelling.
        diagnostics.push({
          severity: DiagnosticSeverity.Error,
          code: "UNDEFINED_KIND",
          source: SOURCE,
          message: BUILTIN_VOCABULARY_NOT_A_MODULE,
          data: { resource, filePath, path: "kind" },
        });
        continue;
      }
      if (declared.status === "undefined") {
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
      // An abstract names a CONTRACT for reference slots, not something to
      // instantiate — the kernel refuses it outright at `create()`. Reported at
      // the declaration, with the kernel's hint: the concrete implementations
      // this analysis holds, spelled through the aliases this scope has, or the
      // reason there are none.
      if (declared.status === "not-instantiable") {
        const canonical = declared.resolvedKind ?? m.kind;
        const impls = userFacingImplementationsOf(canonical, declared.scopeResolver ?? aliases, defs);
        const kindInfo = canonical !== m.kind ? `'${m.kind}' (resolved to '${canonical}')` : `'${m.kind}'`;
        const hint = impls.length
          ? `instantiate a concrete implementation: ${impls.join(", ")}`
          : "no concrete implementations are registered — import a module that provides one";
        diagnostics.push({
          severity: DiagnosticSeverity.Error,
          code: "ABSTRACT_KIND_INSTANTIATED",
          source: SOURCE,
          message: `Kind ${kindInfo} is abstract and cannot be instantiated directly; ${hint}.`,
          data: { resource, filePath, path: "kind" },
        });
        continue;
      }
      const { definition, ownModule, entryScoped, scopeResolver } = declared;
      // A kind its own author marked `metadata.deprecated` still works exactly as
      // it did — the manifest is valid and keeps running — so this is a WARNING,
      // reported at the declaration because `kind:` is the line that has to
      // change. Emitted here rather than in a pass of its own so it reads the
      // kind THIS walk resolved: the resolution is alias- and gate-aware and
      // scope-dependent, and a second implementation of it would eventually
      // disagree about which definition a name means.
      //
      // Entry-module-scoped, like every other "not the consumer's to fix" check:
      // a library's internal use of a kind its own author deprecated is that
      // author's concern, and reporting it floods a consumer with lines they
      // cannot act on.
      //
      // No `DiagnosticFix`. `replacedBy` names a kind through the DECLARING
      // module's aliases; writing it into the consumer's file would produce a
      // prefix that resolves to nothing there — and a kind swap is not a
      // whole-value replacement anyway, since the successor needs its own import
      // and usually a different configuration.
      const deprecation = readDeprecation(definition.metadata);
      if (deprecation && (!ownModule || rootModules.has(ownModule))) {
        // Quoted CANONICALLY, not verbatim: `Self.Thing` is how the declaring
        // library names its own kind and means nothing where the warning lands.
        const declaringScope =
          scopeResolverForModule(
            (definition.metadata as { module?: string } | undefined)?.module,
            rootModules,
            aliasesByModule,
          ) ?? aliases;
        const replacement = deprecation.replacedBy
          ? (declaringScope.resolveKind(deprecation.replacedBy) ?? deprecation.replacedBy)
          : undefined;
        diagnostics.push({
          severity: DiagnosticSeverity.Warning,
          code: "DEPRECATED_KIND",
          source: SOURCE,
          // Warning-grade AND a deprecation: the severity says it must
          // eventually be dealt with, the tag says what it is, and an editor
          // strikes the kind through on the strength of the second.
          tags: [DiagnosticTag.Deprecated],
          message:
            `Kind '${m.kind}' is deprecated: ${deprecation.reason}` +
            (replacement ? ` Use '${replacement}' instead.` : ""),
          data: { resource, filePath, path: "kind" },
        });
      }

      // Validate resource config against the definition's AUTHOR-FACING schema —
      // inheritance-resolved, with `kind` / `metadata` injected. See
      // `validationSchemaFor`, which is where both derivations and the reason
      // they are memoized per definition live.
      const schema = validationSchemaFor(definition);
      ownSchemaFindings();

      // Resource rules — relationships between this resource's own fields that
      // JSON Schema cannot state, declared by the kind as CEL over `self` and
      // `this`. Read off the AUTHOR-FACING schema, so an `extends` child without
      // `base:` inherits its parent's rules and one that declares its own
      // replaces them, exactly as the rest of the config contract merges.
      // The finding→diagnostic mapping lives with the finding vocabulary in
      // `validate-resource-rules.ts`, the shape every neighbouring pass uses:
      // issues out, one emit here.
      const ruleDeclarer = (definition.metadata as { module?: string } | undefined)?.module;
      relationGroupFindings("resourceRules", m);

      // Referrer rules — what must be true of whoever REFERENCES this resource,
      // declared by the kind that has the requirement rather than by the kind
      // that must satisfy it. The subject is chosen by the EDGE, so no kind
      // literal appears on the referring side, where the spelling would be the
      // consumer's import alias rather than anything the rule's author controls.
      // A consumer of the shared call graph, never a second traversal.
      const referrerRules = readReferrerRules(schema);
      if (referrerRules.length > 0) {
        const referrers = referrersOf(m as unknown as ResourceManifest, getCallGraph());
        reportRuleEvaluation("referrerRules", configuration?.own !== undefined);
        // The shared binder, plus the DECLARING kind's call names — the binder
        // is one per run because it caches, the names are per declaration
        // because a condition is its author's expression.
        const declaringRuleContext: ReferrerRuleContext = {
          ...referrerRuleContext,
          moduleNames: moduleCallNamesOf(
            moduleCallNames,
            definition as unknown as ResourceManifest,
          ),
          functions: bodyEvaluators.dispatchFor(definition as unknown as ResourceManifest),
        };
        for (const report of reportReferrerRules(
          m as unknown as ResourceManifest,
          definition as unknown as ResourceManifest,
          evaluateReferrerRules(
            m as unknown as ResourceManifest,
            schema,
            referrers,
            kindMatches,
            declaringRuleContext,
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
          if (report.evaluationFailure) {
            const declaringKind = `referrer\u0000${ruleDeclarer ?? ""}.${definition.metadata?.name ?? ""}`;
            if (!ruleFailureLedger.first(declaringKind, report.rule)) continue;
            diagnostics.push(
              ruleFailureDiagnostic(report, ruleDeclarer, referrerRuleDiagnostic(report)),
            );
            continue;
          }
          diagnostics.push(referrerRuleDiagnostic(report));
          // A rule that VIOLATED plainly ran, whatever its peer set held. The
          // unexercised report exists to catch silence — a `peers:` naming
          // nothing makes every `!peers.exists(…)` pass vacuously — so a finding
          // is exactly the evidence it asks for.
          if (report.code === "REFERRER_RULE_VIOLATED") {
            const violated = referrerRuleExercise.get(
              `${definition.metadata?.module}.${definition.metadata?.name}#${report.rule}`,
            );
            if (violated) violated.exercised = true;
          }
        }
        for (const rule of referrerRules) {
          const key = `${definition.metadata?.module}.${definition.metadata?.name}#${rule.code}`;
          const tracked = referrerRuleExercise.get(key);
          if (!tracked) continue;
          tracked.seen = true;
          if (referrerRuleExercised(rule, referrers, kindMatches, declaringRuleContext)) {
            tracked.exercised = true;
          }
        }
      }

      // Every inline declaration extraction left in place inside this
      // resource's step bodies: its kind, whether it can be instantiated, and
      // its config schema.
      relationGroupFindings("nested", m);
    }

    // A rule whose collection was empty on every resource of its kind is a rule
    // nothing proved. `check()` types `self` only shallowly (cel-js takes a flat
    // field map, so `columns` is `map`), which means a typo below the first level
    // survives declaration validation and is caught only by evaluation — so a
    // rule that never evaluated has been verified by nothing at all. Reported
    // only when the kind HAS resources here: a kind nobody instantiated in this
    // workspace says nothing about the rule.
    if (!configuration?.own) diagnostics.push(...ruleReports.unexercised());
    for (const tracked of referrerRuleExercise.values()) {
      if (!tracked.seen || tracked.exercised) continue;
      diagnostics.push(
        referrerRuleDiagnostic(reportUnexercisedReferrerRule(tracked.manifest, tracked.rule)),
      );
    }

    // Template-body structural validations: a template's entry points against
    // the contracts of their dispatch target and of the definition itself.
    for (const m of allManifests) {
      if (m.kind !== "Telo.Definition") continue;
      relationGroupFindings("templateTargets", m);
    }

    // A consumer's slot typed from a referenced declaration
    // (`x-telo-schema-projection-from`) that does not resolve.
    for (const m of allManifests) {
      const kind = (m as Record<string, any>).kind;
      if (typeof kind !== "string" || kind.startsWith("Telo.") || !isEntryDeclaration(m, rootModules)) continue;
      relationGroupFindings("contracts", m);
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
    // Where a finding is reported: a forward view's moved to its consumer while
    // it still names the declaration it is about, a scope member's into its
    // holder, an inline extraction's back to the chain root so position-index
    // lookups land on the parent doc, a template body's and a choice's to the
    // place it was written. `filtered` also drops what a refusal elsewhere
    // already reports.
    const topLevel = (allManifests as unknown as ResourceManifest[]).filter(
      (m) => !isScopeMemberDeclaration(m),
    );
    // What the position reader reports is about the body as written already.
    const writtenRefusals = new Set(expansion?.diagnostics ?? []);
    const placed = (found: AnalysisDiagnostic[], filtered: boolean): AnalysisDiagnostic[] => {
      const forwarded = forwardViews ? forwardViews.placed(found) : found;
      const members = scopeMembers.relocate(forwarded);
      const located = rerootedQuotes(rewriteSyntheticOrigins(
        filtered
          ? withoutRefusedFormConsequences(suppressUnreadableModuleDiagnostics(members, unreadableFiles), topLevel)
          : members,
        topLevel,
      ));
      const bodiesRelocated =
        templateVariants.size === 0
          ? located
          : relocatedRendering(located, (found) => found.map((d) => {
              if (writtenRefusals.has(d)) return d;
              const data = d.data as
                | { resource?: { kind?: unknown; name?: unknown }; filePath?: unknown; path?: unknown }
                | undefined;
              if (data?.resource?.kind !== "Telo.Definition" || typeof data.path !== "string") return d;
              for (const { variant, written } of templateVariants.values()) {
                const meta = written.metadata as { name?: unknown; source?: unknown } | undefined;
                if (meta?.name !== data.resource.name || meta?.source !== data.filePath) continue;
                const path = variant.expansion.relocate(data.path);
                if (path === data.path) return d;
                return { ...d, data: { ...(d.data as Record<string, unknown>), path } };
              }
              return d;
            }));
      // A message quoting its place is rendered from where it now stands.
      const relocated = choiceExpansion
        ? relocatedRendering(bodiesRelocated, (found) => choiceExpansion.relocate(found))
        : bodiesRelocated;
      if (!filtered) return relocated;
      const consumerChecked = consumers
        ? withoutRefusedExpansionConsequences(relocated, {
            sites: [],
            diagnostics: consumers.diagnostics,
            refused: consumers.refused,
          })
        : relocated;
      return expansion ? withoutRefusedExpansionConsequences(consumerChecked, expansion) : consumerChecked;
    };
    /** Each CEL expression's site, in a run judging or marking sites: the
     *  written place a finding about it is reported at, found for every
     *  expression of the run at once. An expression no finding about could be
     *  reported for has none. */
    const celSiteIds = new Map<ResourceManifest, Map<string, string>>();
    if (celVerdictOf) {
      const probes: AnalysisDiagnostic[] = [];
      const probed: { m: ResourceManifest; path: string }[] = [];
      for (const m of allManifests as unknown as ResourceManifest[]) {
        const meta = m.metadata as { name?: unknown; source?: unknown } | undefined;
        walkOwnCelExpressions(m, "", (source, path) => {
          probes.push({
            severity: DiagnosticSeverity.Hint,
            code: `${CEL_SITE_MARKER}:${probed.length}`,
            source: SOURCE,
            message: "",
            data: { resource: { kind: m.kind, name: meta?.name as string }, filePath: meta?.source as string | undefined, path },
          });
          probed.push({ m, path });
        });
      }
      for (const at of placed(probes, false)) {
        const { m, path } = probed[Number(String(at.code).slice(CEL_SITE_MARKER.length + 1))]!;
        const data = at.data as { resource?: { kind?: unknown; name?: unknown }; filePath?: unknown; path?: unknown };
        if (typeof data.path !== "string") continue;
        let byPath = celSiteIds.get(m);
        if (!byPath) celSiteIds.set(m, (byPath = new Map()));
        byPath.set(path, celSiteId(data.resource?.kind, data.resource?.name, data.filePath, data.path));
      }
    }
    const celSiteOf = (m: ResourceManifest, path: string): string | undefined => celSiteIds.get(m)?.get(path);

    // CEL sites, in a run that marks them (`configuration.cel`): each site's
    // occurrences in walk order.
    let celOccurrences = new Map<string, number>();
    const celWalk: ManifestVisitor = {
        onResourceEnter: (e) => {
          const m = e.source;
          celJudge.enterResource(m, e.definition as unknown as ResourceDefinition | undefined);
          // Its calls through its own fields: unbound module calls, reference
          // outputs and a slot's arguments.
          relationGroupFindings("unboundCalls", m);
          relationGroupFindings("referenceOutputs", m);
          relationGroupFindings("slotInputs", m);
          // Its step body's calls and its bindings.
          relationGroupFindings("stepInputs", m);
          relationGroupFindings("bindings", m);
          // What it holds at its kind's slots: accessors, browser exports and
          // computed reference slots.
          relationGroupFindings("accessors", m);
          relationGroupFindings("browserExports", m);
          relationGroupFindings("computedRefSlots", m);
        },
        onCel: (e) => {
          const m = e.source as unknown as ResourceManifest;
          if (!celVerdictOf) {
            celJudge.judge(e, "all", diagnostics);
            return;
          }
          // A forwarded expression is a site where it is evaluated; a `!ref`
          // names a resource and has nothing to judge.
          if (forwardViews?.defersCel(e.source, e.path) || e.engineName === REF_ENGINE) return;
          const site = celSiteOf(m, e.path);
          if (site === undefined) return;
          const occurrence = celOccurrences.get(site) ?? 0;
          celOccurrences.set(site, occurrence + 1);
          // A configuration run: nothing is judged; the site's place among the
          // run's findings, where its key's verdict is taken, and what that
          // key found, for the checks over the whole application.
          celJudge.judge(e, "never-run", diagnostics);
          const meta = m.metadata as { name?: unknown; source?: unknown } | undefined;
          diagnostics.push({
            severity: DiagnosticSeverity.Hint,
            code: CEL_SITE_MARKER,
            source: SOURCE,
            message: "",
            data: {
              resource: { kind: m.kind, name: meta?.name as string },
              filePath: meta?.source as string | undefined,
              path: e.path,
              celSite: site,
              occurrence,
            },
          });
          celJudge.replay(m, e.path, celVerdictOf!(site)?.facts[occurrence]);
        },
      };
    const walkOptions = { aliases, aliasesByModule, rootModules };
    const walk = (skip?: (m: ResourceManifest) => boolean): void => {
      celOccurrences = new Map();
      visitManifest(allManifests, defs, celWalk, { ...walkOptions, ...(skip ? { skip } : {}) });
    };
    walk();

    // A schema matched against an accessor that it can never hold for — judged
    // against the type the walk above recorded for the accessor's chain, at
    // every resource and template-body entry of the entry's own modules.
    if (!options?.skipValidation) {
      for (const m of allManifests) {
        const module = (m.metadata as { module?: string } | undefined)?.module;
        if (module && !rootModules.has(module)) continue;
        if (!m.kind) continue;
        if (m.kind === "Telo.Definition" || m.kind === "Telo.Abstract" || m.kind === "Telo.JsonSchema") {
          relationGroupFindings("annotations", m);
        }
        // What its matchers ask of the accessors they match.
        relationGroupFindings("match", m);
      }
    }

    // Entries of a list that fill a binding's members and read each other's
    // through it, in a cycle — none could be entered first.
    if (!options?.skipValidation) {
      const fillHost = {
        graph: getCallGraph(),
        shapes: defs.shapeLookup,
        definitionOf: (m: ResourceManifest) =>
          definitionInScope(defs, m.kind, m.metadata, aliases, aliasesByModule) as ResourceDefinition | undefined,
        schemaOf: (definition: ResourceDefinition | undefined) =>
          defs.effectiveSchemaOf(definition) as Record<string, any> | undefined,
      };
      for (const m of allManifests) {
        const module = (m.metadata as { module?: string } | undefined)?.module;
        if ((module && !rootModules.has(module)) || !m.kind || isKindDocument(m)) continue;
        for (const finding of contextFillCycles(m, fillHost)) {
          diagnostics.push({
            severity: DiagnosticSeverity.Error,
            code: "CONTEXT_FILL_CYCLE",
            source: SOURCE,
            message: `${finding.manifest.kind}/${finding.manifest.metadata?.name as string}: ${finding.message}`,
            data: {
              resource: { kind: finding.manifest.kind, name: finding.manifest.metadata?.name as string },
              filePath: (finding.manifest.metadata as { source?: string } | undefined)?.source,
              path: finding.path,
            },
          });
        }
      }
    }

    // Each value an expression produces against the slot it flows into: a
    // declaration's own fields, then a template's top-level `inputs:`, then the
    // argument maps of its calls.
    for (const m of allManifests) {
      if (declaredDefinitionOf(m, declaredScope).status === "ok") relationGroupFindings("slotFitOwn", m);
    }
    for (const m of allManifests) {
      if (m.kind === "Telo.Definition") relationGroupFindings("slotFitTemplate", m);
    }
    for (const m of allManifests) {
      if (m.metadata?.name && m.kind) relationGroupFindings("slotFitCalls", m);
    }

    // Validate resource references (Phase 3)
    diagnostics.push(
      ...validateReferences(
        allManifests,
        { aliases, definitions: defs, aliasesByModule },
        { functions: moduleFunctions, flags: callableFlags },
        configuration?.passes !== undefined,
      ),
    );
    if (configuration?.passes) diagnostics.push(...configuration.passes("duplicateNames"));
    else reportConditionedPass("duplicateNames", configuration !== undefined);

    // The static half of `ERR_CIRCULAR_DEPENDENCY`, over the graph `prepare()`
    // orders boot by and in its wording. A loop with no participant in the
    // entry's own modules is a dependency's, reported by its own check.
    const dependencyGraph = buildDependencyGraph(
      allManifests as unknown as ResourceManifest[],
      defs,
      aliases,
      aliasesByModule,
      getCallGraph(),
    );
    for (const cycle of [...(dependencyGraph.cycles ?? []), ...scopedCycles(getCallGraph())]) {
      const own = cycle.filter((node) => {
        const module = (node.manifest.metadata as { module?: string } | undefined)?.module;
        return !module || rootModules.has(module);
      });
      // A loop through an import is reported at the import.
      const anchor = own.find((node) => node.kind === "Telo.Import") ?? own[0];
      if (!anchor) continue;
      diagnostics.push({
        severity: DiagnosticSeverity.Error,
        code: "DEPENDENCY_CYCLE",
        source: SOURCE,
        message: formatCycle(cycle),
        data: {
          resource: { kind: anchor.kind, name: anchor.name },
          filePath: (anchor.manifest.metadata as { source?: string } | undefined)?.source,
          path: "metadata.name",
        },
      });
    }

    // Validate step `invoke` references — the slots inside a step body, where
    // the reference reach stops, so a missing instance or a kind-instead-of-
    // instance ref there is caught statically, not at runtime.
    diagnostics.push(...validateStepInvokeReferences(allManifests, defs, aliases));

    // `required:` inside a `status:` block — reported here rather than by the
    // AJV shape, which could only say "must NOT be valid" without naming the
    // rule or the fix.
    if (configuration?.passes) diagnostics.push(...configuration.passes("observedStateDeclarations"));
    else {
      reportConditionedPass("observedStateDeclarations", configuration !== undefined);
      diagnostics.push(...observedStateRequiredDiagnostics(allManifests));
    }

    // Validate `extends` fields and flag legacy `capability: <UserAbstract>` overload.
    diagnostics.push(...validateExtends(allManifests, defs, aliases));

    diagnostics.push(...validateBaseMapping(allManifests, defs, aliases));
    diagnostics.push(
      ...validateInvocationContract(allManifests, defs, aliases, aliasesByModule),
    );

    // Validate provider coherence rules for `provide:` template-target definitions.
    diagnostics.push(...validateProviderCoherence(allManifests, defs, aliases));

    // Validate throws: declarations and catches: coverage (rules 1, 4, 7), over
    // the ladder the CEL scope rule typed each entry's caught data from.
    diagnostics.push(
      ...validateThrowsCoverage(
        allManifests,
        defs,
        aliases,
        this.celEnv,
        aliasesByModule,
        rootModules,
        libraryManifests,
        catchLadder(),
      ),
    );

    // Warn about declared variables / secrets / ports that no CEL references.
    if (configuration?.passes) diagnostics.push(...configuration.passes("unusedDeclarations"));
    else {
      reportConditionedPass("unusedDeclarations", configuration !== undefined);
      diagnostics.push(
        // Every expression as written, whichever branch this configuration takes,
        // counts as a read of an input.
        ...validateUnusedDeclarations(configuration ? [...allManifests, ...written] : allManifests),
      );
    }

    // A template body's reference surface — its entry names, its dispatch slots
    // and the ref slots inside each entry — which no reference pass reaches,
    // since a `Telo.Definition` is in both skip sets.
    diagnostics.push(
      ...validateTemplateBody(allManifests, defs, aliases, aliasesByModule, rootModules, (m, path) =>
        Object.keys(
          (() => {
            const found = templateVariants.get(templateKeyOf(m));
            return found ? loopBindingsAtPath(found.variant, m as { resources?: unknown }, path) : undefined;
          })() ?? {},
        ),
      ).filter((d) => !holdsRepresentativeKey(d)),
      ...[...templateVariants.values()].flatMap(({ variant, written }) =>
        representativeSpliceIssues(variant.expansion, defs, (kind) =>
          moduleAliasScope(written.metadata, aliases, aliasesByModule)?.resolveKind(kind),
        ).map((issue) => ({
          severity: DiagnosticSeverity.Error,
          code: "SCHEMA_VIOLATION",
          source: SOURCE,
          message: `Telo.Definition/${written.metadata?.name as string}: ${issue.message}`,
          data: {
            resource: { kind: "Telo.Definition", name: written.metadata?.name as string },
            filePath: (written.metadata as { source?: string } | undefined)?.source,
            path: issue.path,
          },
        })),
      ),
    );
    // ...and the schema a templated kind declares for a value it forwards, which
    // must be assignable to the entry field that receives it.
    diagnostics.push(
      ...validateTemplateForwards(allManifests, defs, aliases, aliasesByModule, rootModules),
    );

    // A library's export list, resolved against what it declares — otherwise a
    // listed name that exists nowhere fails in the consumer's file.
    diagnostics.push(...validateExports(allManifests, defs, aliases, rootModules));

    // A library's declared resource inputs, and every import that supplies them.
    diagnostics.push(
      ...validateResourceInputs(
        allManifests,
        defs,
        aliases,
        rootModules,
        (supplied, required, isDeclaration) =>
          kindSatisfies(supplied, required, defs, isDeclaration),
        options?.moduleDocuments ?? [],
      ),
    );

    // Need types, needs and every import that supplies one — the need table's
    // refusals for the entry's own modules. The kernel raises the same table's
    // `ERR_` twins at load, for every module.
    diagnostics.push(
      ...needTableDiagnostics(
        allManifests as unknown as ResourceManifest[],
        rootModules,
        (module, kind) =>
          declaringModuleScope(module, aliases, { aliasesByModule, rootModules }).resolveKind(kind),
        (kind) => defs.resolve(kind),
        options?.moduleDocuments ?? [],
        (manifest) => defs.referenceSites(manifest, aliases, aliasesByModule),
        (kind) => {
          const definition = defs.resolve(kind);
          return definition ? readApplicationSourceSlot(defs.effectiveSchemaOf(definition))?.feeds.needs : undefined;
        },
        // A need this configuration proves present may be referenced.
        (module) => {
          if (!rootModules.has(module)) return undefined;
          const present = configuration?.narrowing?.(module)?.present;
          if (!present) return undefined;
          const names = new Set<string>();
          for (const chain of present) if (chain.startsWith("resources.")) names.add(chain.slice("resources.".length));
          return names;
        },
      ),
    );

    // A library's optional resource input referenced where this configuration
    // does not prove it present; a dependency's, at the import omitting it.
    for (const reference of optionalInputReferences(allManifests as unknown as ResourceManifest[], getCallGraph(), (module, input) =>
      module === undefined || rootModules.has(module)
        ? !configuration?.narrowing?.(module)?.present?.has(`resources.${input}`)
        : false,
    )) {
      diagnostics.push({
        severity: DiagnosticSeverity.Error,
        code: "RESOURCE_INPUT_OPTIONAL_REFERENCED",
        source: SOURCE,
        message: optionalInputReferenceMessage(reference),
        data: {
          resource: { kind: reference.holder.kind, name: reference.holder.metadata?.name as string },
          filePath: (reference.holder.metadata as { source?: string } | undefined)?.source,
          path: reference.path,
        },
      });
    }
    diagnostics.push(
      ...this.omittedInputReferences(
        allManifests as unknown as ResourceManifest[],
        rootModules,
        registry ?? new AnalysisRegistry({ defs, aliases, aliasesByModule, views: new Map(), libraries: {} }),
        options?.moduleDocuments ?? [],
      ),
    );

    // A resource running a child application, held to what the child the
    // loader followed declares.
    diagnostics.push(
      ...validateApplicationInputs(allManifests as unknown as ResourceManifest[], rootModules, applicationSources, {
        authorSchemaOf: (resource, module) => {
          const kind = declaringModuleScope(module, aliases, { aliasesByModule, rootModules }).resolveKind(
            resource.kind,
          );
          const definition = kind ? defs.resolve(kind) : undefined;
          return definition ? validationSchemaFor(definition) : undefined;
        },
        resolveKind: (module, kind) =>
          declaringModuleScope(module, aliases, { aliasesByModule, rootModules }).resolveKind(kind),
        needType: (kind) => needTypeOf(defs.resolve(kind)),
        defs,
      }),
    );

    // An import alias a kind has already put in CEL scope, where a call through
    // that name would reach the module instead of the variable.
    diagnostics.push(
      ...validateModuleCallNames(allManifests, defs, aliases, aliasesByModule, rootModules),
    );

    // What a callable kind may declare, and what a signature may say. The
    // kernel refuses the same definitions at registration, reading the same
    // rules — see `validate-callable-kinds.ts`.
    diagnostics.push(
      ...validateCallableDeclarations(
        allManifests as unknown as ResourceManifest[],
        defs,
        aliases,
        aliasesByModule,
        rootModules,
      ),
    );
    // What a native function's data slot holds: the referent's configuration,
    // which must be data — the static half of the kernel's delivery at creation.
    diagnostics.push(
      ...validateCallableData({
        manifests: allManifests as unknown as ResourceManifest[],
        rootModules,
        resolveDef: moduleScopedDefResolver<ResourceDefinition>(defs, aliases, {
          aliasesByModule,
          rootModules,
        }),
        shapes: defs.shapeLookup,
        sitesOf: (manifest) => defs.referenceSites(manifest, aliases, aliasesByModule),
        scope: resourceProjectionScope,
        libraries,
        moduleDocuments: options?.moduleDocuments ?? [],
        forwards: forwardViews,
      }),
    );

    // An inline declaration referencing a name declared by a scope it was
    // written inside but is created outside of.
    diagnostics.push(
      ...validateScopedNameReach(allManifests, defs, aliases, aliasesByModule, rootModules),
    );

    // A kind document declared as a scope member, which no per-resource pass
    // reaches: its capability and its document, as the kernel judges them when
    // the scope creates it.
    diagnostics.push(
      ...validateScopedKindDocuments(
        collectedMembers.kindDocuments,
        options?.moduleDocuments ?? [],
        defs,
        aliases,
        aliasesByModule,
        rootModules,
        reach,
        (member, kind) => {
          const definition = defs.resolve(kind);
          if (!definition) throw new Error(`the built-in kind '${kind}' is not registered`);
          const schema = validationSchemaFor(definition);
          const standIns: StandIns = new Map();
          return defs.validateResourceConfig(
            substituteDecodedCelFields(member, schema, undefined, {
              standIns,
              external: (ref) => defs.schemaForId(ref),
            }),
            schema,
            standIns,
          );
        },
      ),
    );

    // A text slot at or beneath an accessor field, and a malformed
    // `x-telo-browser-export`. The kernel refuses the kind when it registers
    // it, so a dependency's is reported at the `imports:` entry reaching it; a
    // named shape is read from the registry, else from the library's own
    // documents.
    const shapeDocuments = new Map<string, Record<string, any>>();
    for (const library of options?.moduleDocuments ?? []) {
      for (const doc of library.manifests) {
        const name = doc.metadata?.name;
        if (typeof name === "string" && doc.schema && typeof doc.schema === "object") {
          shapeDocuments.set(canonicalTypeSchemaId(library.module, name), doc.schema as Record<string, any>);
        }
      }
    }
    const textAccessorKinds = new Set<string>();
    for (const m of allManifests as unknown as ResourceManifest[]) {
      if (m.kind !== "Telo.Definition" && m.kind !== "Telo.Abstract") continue;
      const ownModule = (m.metadata as { module?: string } | undefined)?.module;
      const key = `${ownModule ?? ""}\0${String(m.metadata?.name)}`;
      if (textAccessorKinds.has(key)) continue;
      textAccessorKinds.add(key);
      const resolveShape = (ref: string) => defs.schemaForId(ref) ?? shapeDocuments.get(ref);
      const kindProblems = [
        ...textSlotAccessorProblems(String(m.metadata?.name), m.schema, resolveShape).map((problem) => ({
          code: "TEXT_SLOT_ACCESSOR",
          ...problem,
        })),
        ...textValuesProblems(String(m.metadata?.name), m.schema, resolveShape).map((problem) => ({
          code: "TEXT_VALUES_INVALID",
          ...problem,
        })),
        ...browserExportAnnotationProblems(String(m.metadata?.name), m.schema).map((problem) => ({
          code: "BROWSER_EXPORT_ANNOTATION_INVALID",
          ...problem,
        })),
        ...applicationSourceAnnotationProblems(String(m.metadata?.name), m.schema).map((problem) => ({
          code: "APPLICATION_SOURCE_ANNOTATION_INVALID",
          ...problem,
        })),
      ];
      for (const problem of kindProblems) {
        const message = `${m.kind} ${problem.message}`;
        const via = ownModule ? reach.of(ownModule) : undefined;
        diagnostics.push(
          ownModule && via
            ? importAnchoredDiagnostic(problem.code, ownModule, via, message)
            : {
                severity: DiagnosticSeverity.Error,
                code: problem.code,
                source: SOURCE,
                message,
                data: {
                  resource: { kind: m.kind, name: m.metadata?.name as string },
                  filePath: (m.metadata as { source?: string } | undefined)?.source,
                  path: problem.path,
                },
              },
        );
      }
    }

    // A browser export an imported library's resource names, judged against
    // that library's own entries; the entry's own modules are judged by the
    // per-resource walk. Skipped whole when no kind declares the annotation.
    if (
      allManifests.some(
        (m) =>
          isKindDocument(m) &&
          !!m.schema &&
          typeof m.schema === "object" &&
          schemaDeclaresBrowserExport(m.schema as Record<string, any>),
      )
    ) {
      const scopes = { aliasesByModule, rootModules };
      diagnostics.push(
        ...validateLibraryBrowserExports({
          libraries: options?.moduleDocuments ?? [],
          rootModules,
          reach,
          declarationsOf: (library) =>
            normalizeInlineResources(library.manifests, defs, aliases, aliasesByModule),
          kindSchemaOf: (resource, module) => {
            const kind = declaringModuleScope(module, aliases, scopes).resolveKind(resource.kind);
            return defs.effectiveSchemaOf(kind ? defs.resolve(kind) : undefined) as
              | Record<string, any>
              | undefined;
          },
        }),
      );
    }

    // The built-in text vocabulary: each literal text judged as the module that
    // wrote it writes, catalogs, values pairings, the two text annotations, and
    // the texts each catalog's import closure shows.
    diagnostics.push(
      ...validateTexts({
        manifests: allManifests as unknown as ResourceManifest[],
        rootModules,
        resolveDef: moduleScopedDefResolver<ResourceDefinition>(defs, aliases, {
          aliasesByModule,
          rootModules,
        }),
        moduleDocuments: options?.moduleDocuments ?? [],
        moduleCallNames,
        schemaForId: (id) => defs.schemaForId(id),
        accepts: (fragment, value) =>
          defs.validateResourceConfig(value, TEXT_FRAGMENT_SCHEMAS[fragment]).length === 0,
        valueKindAt: (manifest, path) => {
          const type = celTypeByPath.get(manifest)?.get(path);
          if (type !== undefined && type !== "dyn") return celTypeValueKind(type);
          const produced = celSourceSchemaByPath.get(manifest)?.get(path);
          return produced ? schemaValueKind(produced) : undefined;
        },
        producedSchemaAt: (manifest, path) => celSourceSchemaByPath.get(manifest)?.get(path),
      }),
    );

    // A catalog set: each text translated once per language across the
    // catalogs a resource gathers, and the mark itself where a kind writes it.
    const catalogSetDefs = moduleScopedDefResolver<ResourceDefinition>(defs, aliases, {
      aliasesByModule,
      rootModules,
    });
    reportRuleEvaluation("catalogSets", configuration?.own !== undefined);
    diagnostics.push(
      ...validateTextCatalogSets({
        manifests: allManifests as unknown as ResourceManifest[],
        rootModules,
        schemaOf: (manifest) => {
          if (typeof manifest.kind !== "string") return undefined;
          const definition = catalogSetDefs(manifest.kind, manifest as { metadata?: { module?: string } });
          return definition
            ? effectiveAuthorSchema(definition, (k) => catalogSetDefs.in(k, definition.metadata?.module))
            : undefined;
        },
        resolveRef: (ref) => {
          const schema = defs.schemaForId(ref) ?? shapeDocuments.get(ref);
          return schema ? { schema, root: schema } : undefined;
        },
        sitesOf: (manifest) => defs.referenceSites(manifest, aliases, aliasesByModule),
        scope: resourceProjectionScope,
        libraries,
        moduleDocuments: options?.moduleDocuments ?? [],
        accepts: (catalog) =>
          defs.validateResourceConfig(catalog, TEXT_FRAGMENT_SCHEMAS.TextCatalog).length === 0,
        isExpression: (value) => isTaggedSentinel(value) && !isRefSentinel(value),
        reachOf: (module) => reach.of(module),
        forwards: forwardViews,
      }),
    );

    // Each own-check marker names the written place of the declaration it
    // stands for, as a key's environment names it.
    if (ownMarkers.length > 0) {
      const origins = originsOf(
        [...new Set(ownMarkers.map(({ m }) => m))],
        placed,
        (forwardViews?.consumers() ?? []).map(([view, root]) => ({ view, root })),
      );
      // The marker's data object is shared by every copy a later pass makes.
      for (const { marker, m } of ownMarkers) (marker.data as { ownOrigin?: string }).ownOrigin = origins.get(m);
    }

    return {
      diagnostics: placed(diagnostics, true),
      ...(expansion ? { expansion } : {}),
      reportsObservedState,
    };
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
    // marked resolved references for the kernel that consumes this output.
    resolveRefSentinels(
      normalized,
      ctx.aliases,
      ctx.aliasesByModule,
      listResolution(normalized, crossModuleTargets ?? []),
      ctx.definitions!,
    );
    // Canonicalize import-scoped schema `$ref`s (`telo://Self|Alias/Type`) so the
    // kernel that executes this output compiles inputs/outputs against the same
    // ids the type controllers register their schemas under.
    resolveSchemaTypeRefs(normalized, ctx.aliases, ctx.aliasesByModule);
    return normalized;
  }

  /** The expansion refusals of `manifests` — a library's raw documents, read in
   *  the registry's scope — which the kernel raises when an import loads the
   *  library, as `telo check` reports them at the library itself. */
  expansionRefusals(
    manifests: ResourceManifest[],
    registry: AnalysisRegistry,
    /** The application's load-time set: the forwarded documents of the
     *  library's own imports and those imports, which say how the library binds
     *  a dependency's inputs its choices read. */
    related: readonly ResourceManifest[] = [],
  ): AnalysisDiagnostic[] {
    const ctx = registry._context();
    const documents = manifests.filter(isExpansionSentinel);
    const declarations = manifests.filter((m) => !isExpansionSentinel(m));
    const positions = readExpansionSites(declarations, documents, ctx.definitions!, ctx.aliases, ctx.aliasesByModule);
    // Its choices, read as the root they are in its own check: every refusal an
    // error, labelled with the configurations it holds in.
    const library = declarations.find((m) => isModuleKind(m.kind))?.metadata?.name as string | undefined;
    const ownFiles = new Set(manifests.map((m) => (m.metadata as { source?: unknown } | undefined)?.source));
    const moduleOf = (m: ResourceManifest) => (m.metadata as { module?: unknown } | undefined)?.module;
    const dependencies = related.filter((m) =>
      m.kind === "Telo.Import"
        ? moduleOf(m) === library &&
          typeof (m.metadata as { resolvedModuleName?: unknown }).resolvedModuleName === "string"
        : moduleOf(m) !== library && !isModuleKind(m.kind),
    );
    const set = [...declarations, ...dependencies.filter((m) => !isExpansionSentinel(m))];
    const choices = readChoices(
      set,
      [...documents, ...dependencies.filter(isExpansionSentinel)],
      choiceScopeOf(set, registry),
    );
    const choiceErrors = mergeConfigurationDiagnostics(
      [],
      choices.diagnostics.filter(
        (d) =>
          d.diagnostic.severity === DiagnosticSeverity.Error &&
          ownFiles.has((d.diagnostic.data as { filePath?: unknown } | undefined)?.filePath),
      ),
      choices.dimensions,
      choices.configurations,
    );
    // Its template definitions, judged with no consumer: what is refused there
    // is refused at the import as at the library's own check.
    const templateErrors = declarations.some(holdsTemplateConstructs)
      ? readTemplateDefinitions({
          manifests: declarations,
          reading: positions,
          registry: ctx.definitions!,
          aliases: ctx.aliases!,
          aliasesByModule: ctx.aliasesByModule ?? new Map(),
        }).diagnostics.filter((d) => d.severity === DiagnosticSeverity.Error)
      : [];
    return [
      ...positions.diagnostics,
      ...withoutRefusedExpansionConsequences([...choiceErrors, ...templateErrors], positions),
    ];
  }

  /** The author-written `__ref` keys {@link validateReferenceForms} refuses in
   *  `manifests` — a raw, unresolved manifest set — read in the registry's
   *  scope. Only resolution writes the marker, so a library carrying one is
   *  refused when an import loads it, whose own analysis is not the entry's; a
   *  library's legacy `{ kind, name }` is read as the reference it means. */
  referenceForms(manifests: ResourceManifest[], registry: AnalysisRegistry): AnalysisDiagnostic[] {
    const ctx = registry._context();
    return markerFormRefusals(
      validateReferenceForms(manifests, ctx.definitions!, ctx.aliases, ctx.aliasesByModule),
    );
  }

  /** Each reference, in a library's documents as one import expanded and
   *  normalized them, to a resource input of `omitted` — `optional: true`
   *  inputs that import leaves out — refused as `telo check` refuses it. */
  omittedInputRefusals(
    manifests: ResourceManifest[],
    registry: AnalysisRegistry,
    omitted: ReadonlySet<string>,
  ): string[] {
    if (omitted.size === 0) return [];
    const ctx = registry._context();
    const graph = buildCallGraph(manifests, ctx.definitions!, {
      aliases: ctx.aliases,
      aliasesByModule: ctx.aliasesByModule,
    });
    return optionalInputReferences(manifests, graph, (_module, input) => omitted.has(input)).map(
      optionalInputReferenceMessage,
    );
  }

  /** A dependency's reference to an optional resource input an import of it
   *  omits, at the entry's import reaching that import: the library's documents
   *  expanded in every configuration of its own the import's literal facts
   *  allow — the inputs it omits absent, those it supplies present, a variable
   *  or secret it binds to a literal at that literal. */
  private omittedInputReferences(
    manifests: ResourceManifest[],
    rootModules: ReadonlySet<string>,
    registry: AnalysisRegistry,
    documents: readonly ModuleDocuments[],
  ): AnalysisDiagnostic[] {
    const out: AnalysisDiagnostic[] = [];
    let reach: ReturnType<typeof importReach> | undefined;
    for (const imp of manifests) {
      if (imp.kind !== "Telo.Import") continue;
      const meta = imp.metadata as {
        name?: string;
        module?: string;
        source?: string;
        resolvedModuleName?: string;
        optionalResources?: readonly string[];
      };
      if (!meta.name || !meta.resolvedModuleName || !meta.optionalResources?.length) continue;
      const supplied = readSuppliedResources(imp);
      const omitted = new Set(meta.optionalResources.filter((name) => !Object.hasOwn(supplied, name)));
      if (omitted.size === 0) continue;
      const target = documents.find((d) => d.module === meta.resolvedModuleName);
      if (!target) continue;
      const view = registry.forModule(target.module);
      const refusals = new Set<string>();
      const sentinels = target.manifests.filter(isExpansionSentinel);
      const declarations = target.manifests.filter((m) => !sentinels.includes(m));
      const choices = readChoices(declarations, sentinels, choiceScopeOf(declarations, view, manifests));
      const facts = (assignment: Record<string, unknown>) =>
        choices.dimensions.every((dimension) => {
          const value = assignment[dimension.key];
          if (dimension.input === "resources") {
            const input = dimension.needPath?.length === 1 ? dimension.needPath[0]! : undefined;
            if (input === undefined || !meta.optionalResources!.includes(input)) return true;
            return value === (omitted.has(input) ? ABSENT : PRESENT);
          }
          if (dimension.projection !== "whole") return true;
          const written = (imp as Record<string, any>)[dimension.input]?.[dimension.name];
          return written === undefined || isTaggedSentinel(written) || isCompiledValue(written) || written === value;
        });
      for (const assignment of choices.configurations.filter(facts)) {
        const expanded =
          choices.sites.length === 0
            ? target.manifests
            : expandChoices(target.manifests, choices.decide(assignment)).manifests.filter(
                (m) => !isStandInDeclaration(m),
              );
        const normalized = this.normalize(expanded, view, manifests);
        for (const refusal of this.omittedInputRefusals(normalized, view, omitted)) refusals.add(refusal);
      }
      if (refusals.size === 0) continue;
      const message = [...refusals].join(" ");
      const own = meta.module === undefined || rootModules.has(meta.module);
      if (own) {
        out.push(
          importAnchoredDiagnostic("RESOURCE_INPUT_OPTIONAL_REFERENCED", target.module, {
            alias: meta.name,
            ...(meta.source ? { filePath: meta.source } : {}),
            path: `imports.${meta.name}`,
          }, message),
        );
        continue;
      }
      reach ??= importReach(manifests, rootModules);
      const via = reach.of(meta.module!);
      if (via) out.push(importAnchoredDiagnostic("RESOURCE_INPUT_OPTIONAL_REFERENCED", target.module, via, message));
    }
    return out;
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
