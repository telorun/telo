export { AnalysisRegistry } from "./analysis-registry.js";
export type { RefFieldInfo } from "./analysis-registry.js";
export { StaticAnalyzer } from "./analyzer.js";
export {
    importFailureDiagnostics,
    importResolutionDiagnostics,
} from "./import-resolution-diagnostics.js";
export { assembleGraphDiagnostics, compromisedFiles } from "./graph-diagnostics.js";
export { findPositions, locateDiagnostic, resolveRange } from "./diagnostic-location.js";
export type { DiagnosticPositions } from "./diagnostic-location.js";
export type {
    GraphLoadError,
    ImportEdge,
    LoadedFile,
    LoadedGraph,
    LoadedModule,
    ParseError,
} from "./loaded-types.js";
export {
    collectModuleDocuments,
    flattenForAnalyzer,
    flattenLoadedModule,
    forwardReExportManifests,
    parseExportEntry,
    reExportSpecsFromExports,
    resolveExportedKinds,
    selectModuleManifestsForAnalysis,
    stampExportedKinds,
    stampReExportedKinds,
    stampRequiredNeeds,
    stampRequiredResources,
    stampResolvedSource,
    stampSharedLifecycle,
    type ParsedExportEntry,
    type ReExportSpec,
} from "./flatten-for-analyzer.js";
export {
  accessorBindingOf,
  accessorFields,
  accessorProblems,
  accessorTagEngines,
  withAccessorBindings,
  type AccessorBinding,
  type AccessorField,
  type AccessorProblem,
  type AccessorTag,
} from "./accessor-binding.js";
export {
  accessorFieldAt,
  accessorSiteAt,
  buildAccessorSites,
  buildEvalPaths,
  celEvalModeAt,
  celEvalSites,
  concreteEvalPaths,
  declaredEvalMode,
  declaresCelRegion,
  evalPathCovers,
  extractCelRegionScopes,
  governedCelEvalSites,
  implicitEvalSites,
  mergeCelEvalSites,
  pathMatchesScope,
  scopeMatchOf,
  NO_CEL_EVAL_SITES,
  NO_NAMED_SHAPES,
} from "./eval-paths.js";
export type {
  AccessorSite,
  CelEvalMode,
  CelEvalSites,
  NamedShapeLookup,
  ScopeMatch,
} from "./eval-paths.js";
export { isSelfForward, SELF_PATH } from "./template-self-forward.js";
export {
  injectedDeclarations,
  isInjectedDeclaration,
  readLibraryLifecycle,
  readResourceInputs,
  readSuppliedResources,
} from "./resource-input.js";
export type { LibraryLifecycle, ResourceInput } from "./resource-input.js";
// Which kind a document declares, and its definition — the one answer every
// consumer reads instead of testing a document's `kind:`.
export { isKindDocument, kindDeclarationOf } from "./kind-declaration.js";
// Need types and needs, read once for `telo check`, the kernel and the report.
export {
  injectedNeedDeclarations,
  injectedNeedOf,
  isNeedTypeDoc,
  holdsSensitiveMembers,
  isTextFieldSchema,
  NEED_TYPE_CONTROLLER_ENTRY,
  NEED_TYPE_KIND,
  needParametersWithDefaults,
  needReadingSchema,
  needSupplyOf,
  needTypeOf,
  readNeeds,
  readNeedTypeShape,
  readSuppliedNeeds,
  sensitiveNeedFields,
} from "./need-type.js";
export type { NeedDeclaration, NeedSupply, NeedTypeShape } from "./need-type.js";
export {
  constraintObservations,
  needEntryAt,
  needFeatures,
  needGraphFromLoadedGraph,
  needGraphFromManifests,
  needGraphScopeOf,
  needVersionRange,
  outermostNeedEntry,
  resolveNeedTable,
} from "./need-table.js";
export { isNeedTableDiagnostic } from "./validate-needs.js";
export {
  OBSERVATION_DEADLINES,
  observationDeadline,
  observesProblems,
} from "./observing-slot.js";
export type { ObservationDeadline, ObservesProblem } from "./observing-slot.js";
export type {
  NeedEnvField,
  NeedEnvironmentEntry,
  NeedField,
  NeedGraph,
  NeedGraphReference,
  NeedGraphScope,
  NeedImporterEntry,
  NeedProblem,
  NeedSuppliedEntry,
  NeedSupplyForm,
  NeedTable,
  NeedTableEntry,
} from "./need-table.js";
export {
  addressLabel,
  HOST_PATTERN_ORIGIN,
  invalidLabelReason,
  isAddressNeedType,
  normalizeHost,
  parseHostPattern,
  parseHostPatternOrigin,
  PUBLIC_HOST_PATTERN_TYPE,
  PUBLIC_URL_HOST_VALUES,
  PUBLIC_URL_SECONDARY_TEMPLATE_ENV,
  PUBLIC_URL_TEMPLATE_ENV,
  PUBLIC_URL_TYPE,
} from "./public-address.js";
export type { HostPattern } from "./public-address.js";
export {
  directoryForwardRefusal,
  directorySizeBytes,
  DURABLE_DIRECTORY_TYPE,
  durableDirectoryParameters,
  STATE_DIR_HOST_VALUE,
} from "./durable-directory.js";
export type { DirectoryAccess, DurableDirectoryParameters } from "./durable-directory.js";
export { derivedNeedEnvName, envNameSegment, NEED_ENV_PREFIX } from "./need-env-name.js";
export {
  BINDINGS_ANNOTATION,
  bindingContextProperties,
  bindingDependencies,
  findBindingSites,
  resolveBindingOrder,
} from "./cel-bindings.js";
export type { BindingSites } from "./cel-bindings.js";
export {
  CEL_RESERVED_WORDS,
  checkName,
  isTypeLevelDocument,
} from "./identifier-name.js";
export type { NameLevel, NameViolation } from "./identifier-name.js";
export {
  applyObservedStateNode,
  applyReadingNode,
  buildObservedStateIndex,
  buildObservedStateResourcesSchema,
  collectRunReachableNames,
  observedStateRead,
  reportsFromInit,
  startupObservedStateReads,
  validateObservedStateDeclarations,
} from "./validate-observed-state.js";
export type { AnalyzedResource, ObservedStateRead } from "./validate-observed-state.js";
export { moduleScopedDefResolver, scopeResolverForModule } from "./alias-resolver.js";
export type { ModuleScopes } from "./alias-resolver.js";
export {
  ancestorChain,
  contractDeclarer,
  controllerBearingAncestor,
  effectiveAuthorSchema,
  effectiveContractField,
  effectiveStatusSchema,
  hasOwnControllerOrTemplate,
  inheritedCapability,
  isInheritedDelegation,
  mappingFieldFor,
  needsContractMapping,
  publishedOwnFields,
  resolveParent,
} from "./extends-resolution.js";
export type {
  ContractDirection,
  DefResolver,
  ReplacingDeclaration,
  SignatureDirection,
} from "./extends-resolution.js";
// A template's `targets:`, read once for `telo check` and the kernel.
export {
  capabilityStartsTargets,
  templateTargetProblems,
  templateTargetsOf,
} from "./template-targets.js";
export { nearestName } from "./nearest-name.js";
// An ancestor's `throws:` as a ceiling, read once for `telo check` and the kernel.
export { codesOutsideCeiling, throwsNotSubstitutableMessage } from "./throws-ceiling.js";
export { builtinDocumentSchema } from "./builtins.js";
// The closed capability roster, read from the built-in entries for `telo check`,
// the kernel and the editor support alike.
export {
  builtinKindNames,
  capabilityDescription,
  capabilityProblem,
  capabilityRoster,
  declarableCapabilities,
  isCapabilityRole,
  throwsAllowedCapabilities,
} from "./capability-roster.js";
export type {
  CapabilityProblem,
  CapabilityProblemCode,
  CapabilityRosterEntry,
} from "./capability-roster.js";
export type { TemplateTarget, TemplateTargetProblem } from "./template-targets.js";
// The built-in vocabulary as the `Telo.Builtins` archive: the bytes this build
// renders, its one reader, and the slicing `telo builtins` prints with.
export { BUILTIN_VOCABULARY_ARCHIVE } from "./builtin-vocabulary/index.js";
export {
  BUILTIN_VOCABULARY_KIND,
  BUILTIN_VOCABULARY_NOT_A_MODULE,
  builtinVocabularyImportMessage,
  isBuiltinVocabularyRoot,
  readBuiltinVocabulary,
} from "./builtin-vocabulary.js";
export type { BuiltinVocabulary, BuiltinVocabularyReading } from "./builtin-vocabulary.js";
// `Telo` and `Self` as kind prefixes no module or import may take.
export {
  RESERVED_KIND_PREFIXES,
  isReservedKindPrefix,
  reservedImportAliasMessage,
  reservedLibraryNameMessage,
  reservedModuleNameMessage,
} from "./reserved-kind-prefix.js";
export {
  builtinVocabularyEntries,
  describeBuiltinNames,
  selectBuiltins,
} from "./builtin-vocabulary-slices.js";
export type {
  BuiltinEntryClass,
  BuiltinSelection,
  BuiltinVocabularyEntry,
} from "./builtin-vocabulary-slices.js";
// The callable signature, and the rules a callable kind is subject to. Shared
// with the kernel so its definition-registration refusal and `telo check` cannot
// drift — the `buildEvalPaths` / `evalPathCovers` precedent.
export {
  CALLABLE_CAPABILITY,
  callableBodyField,
  claimsDeterministic,
  parameterSchemaOf,
  FUNCTION_KIND,
  isCallableKind,
  argumentRecordSchema,
  readDeterministic,
  readParams,
  readReturns,
  resolveSignature,
  signatureDeclarer,
  signatureSchemaOf,
} from "./callable-signature.js";
export type {
  CallableSignature,
  SignatureParam,
  SignatureResult,
} from "./callable-signature.js";
export { callArgumentBinding } from "./callable-binding.js";
export type { ArityRefusal, CallArgumentBinding } from "./callable-binding.js";
export {
  callableInstanceIssues,
  callableKindIssues,
  declaredSignatureIssues,
  validateCallableDeclarations,
} from "./validate-callable-kinds.js";
export type { CallableKindIssue } from "./validate-callable-kinds.js";
export {
  callableReferenceNotDataMessage,
  isDataSite,
  isDataSlot,
  isNativeCallableKind,
} from "./callable-data-slot.js";
export type { NotData, NotDataReason } from "./callable-data-slot.js";
export { validateSensitiveSlots } from "./validate-sensitive-slots.js";
export type { SensitiveSlotIssue } from "./validate-sensitive-slots.js";
export { validateSpanAttributes } from "./validate-span-attributes.js";
export type { SpanAttributeIssue } from "./validate-span-attributes.js";
export {
  describeSpanAttributeProblem,
  RUNTIME_SPAN_ATTRIBUTES,
  spanAttributePaths,
  X_TELO_SPAN_ATTRIBUTE,
} from "./span-attribute.js";
export type {
  SpanAttributePath,
  SpanAttributeProblem,
  SpanAttributeReading,
} from "./span-attribute.js";
export {
  defaultBearingPaths,
  declaredScalarPaths,
  normalizeDeclaredScalars,
  PERMISSIVE_CONTRACT,
  reachesMembersSlot,
  resolveContract,
  resolveContractSchema,
  sensitivePaths,
  withLiveValuesSkipped,
} from "./invocation-contract.js";
export type {
  ContractOrigin,
  ContractScope,
  DeclaredScalarForm,
  DeclaredScalarPath,
  ResolvedContract,
} from "./invocation-contract.js";
export {
  hasIntermediateWildcard,
  parseRedactionPath,
  RedactionPathError,
} from "./redaction-path.js";
export type { RedactionSegment } from "./redaction-path.js";
export {
  buildCallGraph,
  nodeIdFor,
  projectToPairs,
  resolveScopedName,
  resourceId,
} from "./call-graph.js";
export type {
  BuildCallGraphOptions,
  CallGraph,
  CallGraphEdge,
  CallGraphNode,
  ResourceGraphNode,
  StepGraphNode,
} from "./call-graph.js";
export { celResourceReads } from "./cel-access-chains.js";
// The pair a host outside this package needs to read an expression the way the
// checker does: build the table once, then ask it per manifest. The file's own
// derivations (`accessChains`, `moduleCallNamesOfFile`, `ROOT_MODULE_KEY`) are
// load-time internals with no reader beyond the analyzer.
export { moduleCallNamesByModule, moduleCallNamesOf } from "./module-call-names.js";
export { declarationSignature, diffManifests } from "./manifest-diff.js";
export type {
  DiffEntry,
  ManifestDiff,
  ManifestDiffOptions,
  ResourceChangeKind,
} from "./manifest-diff.js";
export {
  AMBIENT_CAPABILITIES,
  buildModuleGraph,
  contentKey,
  edgeClassOf,
  isAmbientCapability,
  isAmbientHold,
  isOrderedRow,
  isUnwired,
  templateModule,
} from "./module-graph.js";
export type {
  BuildModuleGraphOptions,
  TemplateModule,
  EdgeClass,
  GraphEdge,
  GraphKind,
  GraphNode,
  GraphPort,
  GraphRegion,
  GraphRow,
  ModuleGraph,
  ModuleGraphDeps,
  NodeOwnership,
  PortSlot,
  RowKind,
} from "./module-graph.js";
export { satisfiesValueBranch } from "./reference-field-map.js";
export type { RefFieldEntry, ValueBranchValidator } from "./reference-field-map.js";
export { reachPositions, reachSites, type ReachPosition } from "./reference-reach.js";
export {
  computedRefSlots,
  evaluatedCelSource,
  evaluatedField,
  refSlotComputedReason,
  type ComputedRefSlot,
} from "./ref-slot-computed.js";
export type {
  DeclaredReach,
  DeclaredReference,
  ReachRef,
  ReachSite,
  SchemaFromResolver,
} from "./reference-reach.js";
export { scopeSlotProblems } from "./validate-scope-slots.js";
export type { ScopeSlotProblem } from "./validate-scope-slots.js";
export { namedContractShape, valueSchemaFromProblems } from "./validate-value-schema-location.js";
export type {
  NamedContractShape,
  ValueSchemaFromProblem,
} from "./validate-value-schema-location.js";
export { resolveContractValueSchemas } from "./value-schema-slot.js";
export type { ValueSchemaHost } from "./value-schema-slot.js";
export {
  hasDeclaredUse,
  isNeedConstraint,
  isRefSlot,
  NEED_CONSTRAINTS,
  isRefUse,
  possibleUses,
  readRefSlot,
  REF_USES,
  refSlotAnnotation,
  rewriteRefSlotKinds,
  transfersControl,
} from "./ref-slot.js";
export type { NeedConstraint, RefSlot, RefUse, RefUseCases } from "./ref-slot.js";
export { isStepSlot, readStepSlot, STEP_FRAGMENT } from "./step-slot.js";
export type { StepSlot } from "./step-slot.js";
// The built-in text vocabulary: the fragments' and annotations' one reader, the
// judgement both halves share, and where a manifest holds schemas.
export {
  declaredTextValuesOf,
  expressionsWithin,
  catalogsComputedAbove,
  fragmentAdmits,
  isTextRecordSchema,
  isTextSchema,
  MESSAGE_FRAGMENT,
  pointerSegments,
  renderValuePath,
  siteValueOf,
  TEXT_ANNOTATION_VALUE_SCHEMAS,
  TEXT_CATALOG_FRAGMENT,
  TEXT_CONTEXT_ANNOTATION,
  TEXT_FRAGMENT,
  TEXT_RECORD_FRAGMENT,
  TEXT_VALUES_ANNOTATION,
  TEXT_VALUES_FOR_ANNOTATION,
  textFragmentOf,
  textSites,
  UNDETERMINED_LANGUAGE,
} from "./text-slot.js";
export type {
  TextExpressionSite,
  TextFragment,
  TextSite,
  TextValuesSite,
  TextWalk,
  TextWalkOptions,
  ValuePath,
} from "./text-slot.js";
export {
  catalogComputedProblem,
  judgeCatalog,
  judgeMessage,
  judgeText,
  judgeValues,
  keyOfText,
  languageProblems,
  runtimeValueKind,
  SOURCE_LANGUAGE_MISSING_MESSAGE,
  textKey,
} from "./text-judgement.js";
export type {
  CatalogEntry,
  KnownValues,
  MessageValueKind,
  TextProblem,
  TextProblemCode,
} from "./text-judgement.js";
export {
  schemaNodes,
  schemaTexts,
  schemaValueSites,
  textAnnotationProblems,
  textContextNodes,
  textParameters,
} from "./text-schemas.js";
export type {
  SchemaRole,
  SchemaText,
  SchemaValueSite,
  TextAnnotationProblem,
  TextParameter,
} from "./text-schemas.js";
export { textSlotAccessorProblems } from "./text-slot-accessor.js";
export { declaredValueKinds, judgeDeclaredValues, textValuesProblems } from "./text-values.js";
export {
  declaresTextCatalogSet,
  TEXT_CATALOG_SET_ANNOTATION,
  textCatalogSetDuplicates,
  textCatalogSetMembers,
  textCatalogSetProblems,
} from "./text-catalog-set.js";
export type {
  CatalogSetReferenceSite,
  NamedShapeResolver,
  TextCatalogSetDuplicate,
  TextCatalogSetHost,
  TextCatalogSetMember,
  TextCatalogSetProblem,
} from "./text-catalog-set.js";
export type { TextSlotAccessorProblem } from "./text-slot-accessor.js";
export { moduleLangOf, moduleLangs, recordLangOf } from "./module-lang.js";
export { TextLanguageScope } from "./validate-texts.js";
export {
  entryListsOf,
  rootMatchersOf,
  roledProperties,
  topologyRoleOf,
  TOPOLOGY_ROLES,
} from "./topology-role.js";
export type {
  EntryListDeclaration,
  RoledProperty,
  TopologyRole,
} from "./topology-role.js";
export { topologyRoleProblems } from "./validate-topology-roles.js";
export type { TopologyRoleProblem } from "./validate-topology-roles.js";
export { readDeprecation } from "./deprecation.js";
export type { Deprecation } from "./deprecation.js";
export {
  ANNOTATION_KEYWORDS,
  hostPathRelativeMessage,
  registerTeloKeywords,
  valueTypeKeyword,
  VALUE_TYPE_KEYWORD_VERSION,
} from "./value-type-keyword.js";
export {
  describeTeloFormatFailure,
  TELO_AJV_FORMATS,
  TELO_FORMATS,
  teloFormatFailure,
  teloFormatOf,
} from "./telo-format.js";
export type { TeloFormatEntry, TeloFormatFailure } from "./telo-format.js";
export {
  applyTextEdits,
  isPlainSafe,
  quoteStyleOf,
  renderFixReplacement,
} from "./yaml-source-edit.js";
export type { QuoteStyle, TextEdit } from "./yaml-source-edit.js";
export { KNOWN_HOST_AXES, evaluateRequires, readRequires } from "./requires-block.js";
export type {
  HostAxis,
  HostVersions,
  ReadRequiresResult,
  RequiresBlock,
  RequiresIssue,
  RequiresVerdict,
} from "./requires-block.js";
export { manifestCompatibility } from "./module-compatibility.js";
export type { ModuleCompatibility } from "./module-compatibility.js";
export { TELO_SURFACE_VERSION } from "./telo-version.js";
export { validateRequires } from "./validate-requires.js";
export type { ValidateRequiresOptions } from "./validate-requires.js";
export {
  isUnsatisfiable,
  lowerBound,
  parseVersionRange,
  rangeAccepts,
  rangeInterval,
  rangeWithin,
  upperBound,
} from "./version-range.js";
export type {
  ComparatorOperator,
  VersionComparator,
  VersionInterval,
  VersionIntervalBound,
  VersionRange,
  VersionRangeResult,
} from "./version-range.js";
export {
  hasProvidesZone,
  hasRequiresZone,
  providedZoneAttributes,
  readProvidesZone,
  readRequiresZone,
  readViolatesZone,
  rewriteRequiresZoneKind,
} from "./zone-slot.js";
export type { ProvidesZoneSlot, RequiresZoneSlot } from "./zone-slot.js";
export {
  deriveLibraryExportRequirements,
  projectZoneRequirements,
  runZoneAnalysis,
  zoneDocumentsSignature,
} from "./resolve-zone-requirements.js";
export type {
  ZoneExportCache,
  ZoneExportCacheEntry,
  ZoneExportRequirements,
  ZoneRequirementSpec,
} from "./resolve-zone-requirements.js";
export type { ModuleDocuments } from "./module-documents.js";
export { validateZoneSlotDeclarations } from "./validate-zone-slots.js";
export {
  RESOURCE_RULES_ANNOTATION,
  readResourceRules,
  readRawResourceRules,
  resolveRuleSubjects,
  findDynamicLeaf,
  dynamicNode,
  type DynamicLeaf,
  type ResourceRule,
  type ResourceRuleSeverity,
  type RuleSubject,
} from "./resource-rule.js";
export {
  validateResourceRuleDeclarations,
  evaluateResourceRules,
  ruleExercised,
  RESOURCE_RULE_BUDGET_MS,
  type ResourceRuleIssue,
  type ResourceRuleFinding,
} from "./validate-resource-rules.js";
export {
  REFERRER_RULES_ANNOTATION,
  readReferrerRules,
  readRawReferrerRules,
  hasReferrerRules,
  rewriteReferrerRuleKinds,
  type ReferrerRule,
} from "./referrer-rule.js";
export {
  validateReferrerRuleDeclarations,
  evaluateReferrerRules,
  referrerRuleExercised,
  reportReferrerRules,
  reportUnexercisedReferrerRule,
  type Referrer,
  type ReferrerRuleIssue,
  type ReferrerRuleFinding,
  type ReferrerRuleDiagnostic,
  type ReferrerRuleContext,
  type ReferrerRuleDeclarationContext,
} from "./validate-referrer-rules.js";
export {
  PeerBinder,
  analyzerPeerBinder,
  analyzerPeersTarget,
  entryBoundary,
  isSilentBindingFailure,
  navigatePath,
  referenceValueOf,
  type DeclarationLookup,
  type RefSite,
  type PeerAliasScope,
  type PeerBinderEnv,
  type PeerBinderRegistry,
  type PeerBinding,
  type PeerBindingFailure,
  type PeerBindingResult,
  type PeersTarget,
} from "./peer-binding.js";
export { RULE_BUDGET_MS, RuleFailureLedger, UNTAGGED_CONDITION } from "./rule-condition.js";
export {
  readSchemaProjection,
  type ProjectionReference,
  readSchemaMap,
  schemaMapBranch,
  readProjectionFrom,
  readProjectionRef,
  manifestListScope,
  projectionKeyMap,
  projectEntries,
  resolveSchemaProjections,
  describeProjectionFailure,
  type SchemaProjection,
  type SchemaMap,
  type ProjectionRef,
  type ProjectionLookup,
  type ProjectionScope,
  type ProjectionFailure,
} from "./schema-projection.js";
export { validateSchemaProjection, type SchemaProjectionIssue } from "./validate-schema-projection.js";
export { validateDurableRegions } from "./validate-durable-regions.js";
export { validateZoneViolations } from "./validate-zone-violations.js";
export {
  containmentIndex,
  findZoneRegions,
  regionManifests,
  type ContainedNode,
  type DefinitionLookup,
  type RegionBoundary,
  type ZoneRegion,
} from "./resolve-zone-containment.js";
export type { ZoneSlotIssue } from "./validate-zone-slots.js";
export { validateDynamicSelectors, validateRefSlotDeclarations } from "./validate-ref-slots.js";
export { producedOutputContract, referenceOutputRefusal } from "./validate-reference-output.js";
export type { RefSlotIssue } from "./validate-ref-slots.js";
export { validateValueTypeSlots } from "./validate-value-type-slots.js";
export type { ValueTypeSlotIssue } from "./validate-value-type-slots.js";
export {
  celPlaceholderForSchema,
  checkSchemaCompatibility,
  collectProperties,
  producedPlaceholder,
  resolveRefIn,
  selectUnionBranch,
  undeclaredKeySchema,
} from "./schema-compat.js";
export type {
  CompatibilityConflict,
  CompatibilityResult,
  ExternalSchemaResolver,
  StandInOptions,
} from "./schema-compat.js";
export { schemaWithTagsAsText } from "./schema-tag-text.js";
export { readStandIn, withoutStandInFindings } from "./stand-in-findings.js";
export type {
  LocatedFinding,
  SchemaNodeFindings,
  StandIn,
  StandInClass,
  StandInIdentity,
  StandInJudgment,
  StandInReading,
  StandIns,
} from "./stand-in-findings.js";
export { SchemaNodeValidator } from "./schema-node-validator.js";
export type { NodeValidatingAjv, SchemaNodeValidatorOptions } from "./schema-node-validator.js";
export {
  ajvErrorToPath,
  explainFormatErrors,
  explainValueTypeErrors,
  formatAjvErrors,
  formatSingleError,
  reduceSchemaErrors,
  schemaIssues,
  valueTypeRefusalCode,
} from "./schema-error-report.js";
export type { AjvErrorLike, SchemaIssue } from "./schema-error-report.js";
export { visitManifest } from "./manifest-visitor.js";
export type {
    CelSiteEvent,
    ManifestVisitor,
    RefSiteEvent,
    ResourceEnterEvent,
    ResourceExitEvent,
    ScopeBoundaryEvent,
    SchemaFromSiteEvent,
    VisitOptions,
} from "./manifest-visitor.js";
export { loadImportTarget, Loader } from "./manifest-loader.js";
export type { ImportRequest, ImportTargetLoad, ImportTargetPort } from "./manifest-loader.js";
export { isModuleKind, MODULE_KINDS } from "./module-kinds.js";
export type { ModuleKind } from "./module-kinds.js";
export { parseLoadedFile } from "./parse-loaded-file.js";
export type { ParseOptions } from "./parse-loaded-file.js";
export { YAML_PARSE_CACHE_FORMAT } from "./yaml-parse-cache.js";
export type { CachedYamlParse, YamlParseCache } from "./yaml-parse-cache.js";
export {
  CORE_MIGRATIONS,
  migrateFileText,
  migrateManifests,
  NO_MIGRATIONS,
  parseMigrationEntry,
  remapMigratedPaths,
} from "./migrations/index.js";
export type { FileMigrations, MigrationEntry, MigrationRewrite } from "./migrations/index.js";
export { desugarLoadedFile, inlineImportManifests } from "./inline-imports.js";
export type { SyntheticImport } from "./inline-imports.js";
export {
  compareModuleVersions,
  compareParsedModuleVersions,
  isNewerModuleVersion,
  isSameModuleVersion,
  newestModuleVersion,
  parseModuleVersion,
} from "./module-version-order.js";
export type { ParsedModuleVersion } from "./module-version-order.js";
export { reconcileModuleVersions } from "./reconcile-module-versions.js";
export type { VersionReconciliation } from "./reconcile-module-versions.js";
export { residualEntrySchema, residualEntrySchemaMap } from "./residual-schema.js";
export {
  ARG_NEGATION_PREFIX,
  describeArgBinding,
  HELP_ARG_FLAG,
  inputValueTypeName,
  readApplicationArguments,
  renderApplicationUsage,
  renderArgumentSynopsis,
  RESERVED_ARG_FLAGS,
} from "./application-arguments.js";
export type {
  ApplicationArguments,
  ArgBinding,
  ArgBindingIssue,
  ArgValueType,
  FlagArgBinding,
  PositionalArgBinding,
} from "./application-arguments.js";
export { readApplicationContract } from "./application-contract.js";
export type {
  ApplicationContract,
  ApplicationContractArg,
  ApplicationContractPort,
  ApplicationContractSecret,
  ApplicationContractVariable,
} from "./application-contract.js";
export { sensitiveEnvironmentInputs } from "./sensitive-environment-inputs.js";
export type { SensitiveEnvironmentInput } from "./sensitive-environment-inputs.js";
export {
  decodePlainLiterals,
  mapTextLeaves,
  type RecordMapper,
  type SchemaNodeVisitor,
  type TextLeafMapper,
} from "./plain-literal-decoding.js";
export {
  boundArgumentRefusal,
  memberSlotSchema,
  memberSlotSchemas,
  membersAuthoringSchema,
  membersRefusalCode,
  membersRefusalMessage,
  membersSlotOf,
  membersValueRefusal,
  readMembersLiteral,
  readMembersValue,
  type MembersSlot,
} from "./members-value-slot.js";
export { describeHostEntry, holdsHostPath, hostAnchorFor, hostEntryAt } from "./host-path-slot.js";
export {
  compiledResultSlots,
  formatSlotPath,
  type CompiledResultSlot,
} from "./compiled-result-slots.js";
export type { DerivedSlot, DerivedSlotContext } from "./derived-slots.js";
export {
    buildDocumentPositions,
    buildLineOffsets,
    buildPositionIndex,
    documentLineOffsets,
    offsetToPosition,
} from "./position-metadata.js";
export type { DocumentPosition } from "./position-metadata.js";
export { HttpSource } from "./sources/http-source.js";
export { defaultSources } from "./sources/default-sources.js";
export {
  splitIntegrity,
  foldIntegrity,
  isCanonicalIntegrity,
  verifyIntegrity,
  verifiedFetch,
  sha256Base64Url,
  IntegrityError,
  ManifestNotFoundError,
} from "./sources/integrity.js";
export { OCI_SCHEME, isOciRef, parseOciRef } from "./sources/oci-ref.js";
export type { ParsedOciRef } from "./sources/oci-ref.js";
export { parseVersionedRef, withRefVersion } from "./sources/versioned-ref.js";
export type { ParsedVersionedRef } from "./sources/versioned-ref.js";
export { isLocalPathSource } from "./sources/local-path-ref.js";
export {
  MANIFEST_CACHE_BASE_URL,
  ManifestCacheSource,
  isHttpsModuleRef,
  manifestCacheKey,
  manifestCacheUrl,
  ociManifestCacheCoords,
  urlManifestCacheCoords,
} from "./sources/manifest-cache.js";
export type { ManifestCacheCoords } from "./sources/manifest-cache.js";
export {
  CODE_LAYER_ROLES,
  LAYER_ROLES,
  PLATFORM_AXES,
  ArtifactSelectorError,
  describeSelector,
  isLayerRole,
  normalizeAxisValue,
  normalizeSelector,
  roleCarriesSelector,
  selectorContradictions,
  selectorFromQualifiers,
  selectorKey,
  selectorMatches,
  undeterminedAxesBlockingMatch,
} from "./artifact-selector.js";
export type {
  ArtifactSelector,
  LayerRole,
  PlatformAxis,
  PlatformTarget,
  SelectorContradiction,
} from "./artifact-selector.js";
export { collectModuleFileClaims } from "./module-file-claims.js";
export type { LocatedClaim, ModuleFileClaim } from "./module-file-claims.js";
export {
  crossLayerSourceLinks,
  describeClaim,
  nativeClaimConflicts,
  pathsAtOrBeneath,
  readAssetPatterns,
  stageableFiles,
  stagedModuleFiles,
  unclaimedSourceEntries,
} from "./module-named-files.js";
export type {
  CrossLayerLink,
  LocatedSourceEntry,
  NativeClaimConflict,
  StageableFile,
  StagedAssets,
} from "./module-named-files.js";
export { readLibraryCandidates } from "./module-library.js";
export { BROWSER_FORMAT, readBrowserEntries } from "./module-browser.js";
export type { BrowserEntries, BrowserEntry, BrowserEntryProblem } from "./module-browser.js";
export {
  BROWSER_EXPORT_ANNOTATION,
  browserExportProblems,
  browserExportSites,
  type BrowserExportProblem,
  type BrowserExportSite,
} from "./browser-export-slot.js";
export type {
  LibraryCandidate,
  LibraryCandidateProblem,
  LibraryCandidates,
} from "./module-library.js";
export {
  LayerIndexError,
  browserLayerFor,
  codeLayerFor,
  matchCodeLayers,
  parseLayerIndex,
  singletonLayer,
} from "./artifact-layer-index.js";
export type { ArtifactLayer } from "./artifact-layer-index.js";
export { validateModuleArtifact } from "./validate-module-artifact.js";
export { normalizeNativePath, readNativeEntries } from "./native-entries.js";
export type { NativeEntries, NativeEntry, NativeEntryProblem } from "./native-entries.js";
export {
  SOURCE_ARCHIVE_FORMATS,
  readModuleSources,
  resolveSourceUrl,
  sourceUrlProblem,
} from "./source-entries.js";
export type {
  ModuleSource,
  ModuleSources,
  SourceArchiveFormat,
  SourceBuild,
  SourceEntry,
  SourcePin,
  SourceProblem,
  SourceProblemCode,
} from "./source-entries.js";
// Warnings everywhere, fatal at `telo publish` — descriptive metadata has no
// runtime failure mode, so it must not stop a manifest running, but it is the
// module's public face the moment it is published.
export { PUBLISH_BLOCKING_CODES } from "./validate-module-metadata.js";
export { withSyntheticPositions } from "./with-synthetic-positions.js";
export { documentToAst, parseToAst } from "./yaml-ast.js";
export type { AstDocument, AstMap, AstNode, AstPair, AstScalar, AstSeq } from "./yaml-ast.js";
export { CelParseError, buildCelSegments, wrapCelAst } from "./cel-ast.js";
export type { CelNode, CelSegment } from "./cel-ast.js";

// The CEL scope rule, and the way into it from outside the analysis pass. What
// completes, what hovers and what type-checks are one answer because they are
// one function.
export { CelScopeResolver } from "./cel-scope.js";
export type { CelScope, CelScopeInputs, CelSiteRef } from "./cel-scope.js";
export type { FunctionParameter, ResolvedFunction } from "./module-function-index.js";
export { renderChain, type CallableFlags } from "./callable-flags.js";
export { CelScopeQuery } from "./cel-scope-query.js";
export type { CelScopeQueryContext, ContextDeclarationSite } from "./cel-scope-query.js";
// The pairing of a registry and the manifests it analyzed — the one seam a host
// threads for every question that needs both.
export { navigateConcretePath } from "./manifest-path.js";
export { ManifestAnalysis } from "./manifest-analysis.js";
export type { ManifestRef } from "./manifest-analysis.js";
// What a module does, read from its manifest — `ManifestAnalysis.outline`.
export { OUTLINE_VERSION } from "./outline.js";
// A value as written, as the module graph's `match` and the outline carry it.
export { readWrittenValue } from "./written-value.js";
export type {
  TaggedWrittenValue,
  WrittenMap,
  WrittenScalar,
  WrittenValue,
  WrittenValueReading,
} from "./written-value.js";
export type {
  OutlineBootTarget,
  OutlineCatchAnswer,
  OutlineDocument,
  OutlineEdge,
  OutlineEntryPoint,
  OutlineInput,
  OutlineListAnswer,
  OutlineModule,
  OutlineNeedField,
  OutlineRead,
  OutlineResource,
  OutlineRow,
  OutlineScopeRung,
  OutlineUnreached,
} from "./outline.js";
export {
  DEFAULT_MANIFEST_FILENAME,
  DiagnosticSeverity,
  DiagnosticTag,
  diagnosticFix,
} from "./types.js";
export type {
    AnalysisDiagnostic,
    AnalysisOptions,
    DiagnosticData,
    DiagnosticFix,
    DiagnosticFixTag,
    LoaderInitOptions,
    LoadOptions,
    ManifestSource,
    Position,
    PositionIndex,
    Range
} from "./types.js";
export * from "./manifest-schemas.js";
// The JSON Schema vocabulary a manifest may write, as data — the source both the
// validating fragments and the IDE's completion are built from.
export * from "./schema-keywords.js";
// The release model — module identity, fragments, the ledger, the edge graph and
// version planning. Pure data in, plan out, so the editor and the CLI release
// from one model.
export {
  DERIVED_METADATA_FIELDS,
  authoredModuleMetadata,
} from "./module-metadata-scope.js";
export * from "./release/index.js";
// The workspace's env files — the walk, the format and the sensitive mark —
// shared by the CLI, a packaged application and Studio.
export * from "./workspace-env/index.js";
