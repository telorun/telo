export { AnalysisRegistry } from "./analysis-registry.js";
export type { RefFieldInfo } from "./analysis-registry.js";
export { StaticAnalyzer } from "./analyzer.js";
export { importResolutionDiagnostics } from "./import-resolution-diagnostics.js";
export type {
    GraphLoadError,
    ImportEdge,
    LoadedFile,
    LoadedGraph,
    LoadedModule,
    ParseError,
} from "./loaded-types.js";
export {
    collectZoneModuleDocuments,
    flattenForAnalyzer,
    flattenLoadedModule,
    forwardReExportManifests,
    parseExportEntry,
    reExportSpecsFromExports,
    resolveExportedKinds,
    selectModuleManifestsForAnalysis,
    stampExportedKinds,
    stampReExportedKinds,
    type ParsedExportEntry,
    type ReExportSpec,
} from "./flatten-for-analyzer.js";
export {
  buildEvalPaths,
  celEvalModeAt,
  celEvalSites,
  declaresCelRegion,
  evalPathCovers,
  mergeCelEvalSites,
  NO_CEL_EVAL_SITES,
} from "./eval-paths.js";
export type { CelEvalSites } from "./eval-paths.js";
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
  TYPE_LEVEL_DOC_KINDS,
  checkName,
} from "./identifier-name.js";
export type { NameLevel, NameViolation } from "./identifier-name.js";
export {
  applyObservedStateNode,
  buildObservedStateIndex,
  buildObservedStateResourcesSchema,
  collectRunReachableNames,
  observedStateRead,
  validateObservedStateDeclarations,
  OBSERVED_STATE_SCHEMA,
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
  resolveParent,
} from "./extends-resolution.js";
export type { ContractDirection, DefResolver } from "./extends-resolution.js";
export {
  defaultBearingPaths,
  declaredScalarPaths,
  PERMISSIVE_CONTRACT,
  resolveContract,
  resolveContractSchema,
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
export { buildCallGraph, projectToPairs, resourceId } from "./call-graph.js";
export type {
  BuildCallGraphOptions,
  CallGraph,
  CallGraphEdge,
  CallGraphNode,
  ResourceGraphNode,
  StepGraphNode,
} from "./call-graph.js";
export {
  buildReferenceFieldMap,
  isRefEntry,
  isScopeEntry,
  satisfiesValueBranch,
} from "./reference-field-map.js";
export type {
  ReferenceFieldMap,
  RefFieldEntry,
  ValueBranchValidator,
} from "./reference-field-map.js";
export {
  hasDeclaredUse,
  isRefSlot,
  isRefUse,
  possibleUses,
  readRefSlot,
  REF_USES,
  refSlotAnnotation,
  rewriteRefSlotKinds,
  transfersControl,
} from "./ref-slot.js";
export type { RefSlot, RefUse, RefUseCases } from "./ref-slot.js";
export { isStepSlot, readStepSlot, STEP_FRAGMENT } from "./step-slot.js";
export type { StepSlot } from "./step-slot.js";
export {
  ANNOTATION_KEYWORDS,
  registerTeloKeywords,
  valueTypeKeyword,
} from "./value-type-keyword.js";
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
  upperBound,
} from "./version-range.js";
export type {
  ComparatorOperator,
  VersionComparator,
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
export type { ZoneModuleDocuments } from "./zone-module-documents.js";
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
  navigatePath,
  referenceValueOf,
  shapeMatches,
  type DeclarationLookup,
  type PeerAliasScope,
  type PeerBinderEnv,
  type PeerBinderRegistry,
  type PeerBinding,
  type PeerBindingFailure,
  type PeerBindingResult,
  type PeersTarget,
} from "./peer-binding.js";
export { RULE_BUDGET_MS, UNTAGGED_CONDITION } from "./rule-condition.js";
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
export type { RefSlotIssue } from "./validate-ref-slots.js";
export { validateValueTypeSlots } from "./validate-value-type-slots.js";
export type { ValueTypeSlotIssue } from "./validate-value-type-slots.js";
export { checkSchemaCompatibility, resolveRefIn, selectUnionBranch } from "./schema-compat.js";
export type { CompatibilityResult, ExternalSchemaResolver } from "./schema-compat.js";
export {
  ajvErrorToPath,
  formatAjvErrors,
  formatSingleError,
  reduceSchemaErrors,
  schemaIssues,
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
export { Loader } from "./manifest-loader.js";
export { isModuleKind, MODULE_KINDS } from "./module-kinds.js";
export type { ModuleKind } from "./module-kinds.js";
export { parseLoadedFile } from "./parse-loaded-file.js";
export type { ParseOptions } from "./parse-loaded-file.js";
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
    buildDocumentPositions,
    buildLineOffsets,
    buildPositionIndex,
    documentLineOffsets,
    offsetToPosition,
} from "./position-metadata.js";
export type { DocumentPosition } from "./position-metadata.js";
export { HttpSource } from "./sources/http-source.js";
export { RegistrySource } from "./sources/registry-source.js";
export { defaultSources } from "./sources/default-sources.js";
export {
  splitIntegrity,
  foldIntegrity,
  isCanonicalIntegrity,
  verifyIntegrity,
  verifiedFetch,
  sha256Base64Url,
  IntegrityError,
} from "./sources/integrity.js";
export { parseModuleRef, isRegistryRef } from "./sources/module-ref.js";
export type { ParsedModuleRef } from "./sources/module-ref.js";
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
  normalizeSelector,
  roleCarriesSelector,
  selectorFromQualifiers,
  selectorKey,
  selectorMatches,
} from "./artifact-selector.js";
export type {
  ArtifactSelector,
  LayerRole,
  PlatformAxis,
  PlatformTarget,
} from "./artifact-selector.js";
export { collectModuleFileClaims } from "./module-file-claims.js";
export type { ModuleFileClaim } from "./module-file-claims.js";
export { readLibraryCandidates } from "./module-library.js";
export type {
  LibraryCandidate,
  LibraryCandidateProblem,
  LibraryCandidates,
} from "./module-library.js";
export {
  LayerIndexError,
  codeLayerFor,
  matchCodeLayers,
  parseLayerIndex,
  singletonLayer,
} from "./artifact-layer-index.js";
export type { ArtifactLayer } from "./artifact-layer-index.js";
export { validateModuleArtifact } from "./validate-module-artifact.js";
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
export { CelScopeQuery } from "./cel-scope-query.js";
export type { CelScopeQueryContext, ContextDeclarationSite } from "./cel-scope-query.js";
// The pairing of a registry and the manifests it analyzed — the one seam a host
// threads for every question that needs both.
export { navigateConcretePath } from "./manifest-path.js";
export { ManifestAnalysis } from "./manifest-analysis.js";
export type { ManifestRef } from "./manifest-analysis.js";
export { DEFAULT_MANIFEST_FILENAME, DiagnosticSeverity, diagnosticFix } from "./types.js";
export type {
    AnalysisDiagnostic,
    AnalysisOptions,
    DiagnosticData,
    DiagnosticFix,
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
