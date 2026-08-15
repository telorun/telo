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
export { buildEvalPaths, evalPathCovers } from "./eval-paths.js";
export {
  BINDINGS_ANNOTATION,
  bindingContextProperties,
  bindingDependencies,
  findBindingSites,
  resolveBindingOrder,
} from "./cel-bindings.js";
export type { BindingSites } from "./cel-bindings.js";
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
export { buildReferenceFieldMap, isRefEntry, isScopeEntry } from "./reference-field-map.js";
export type { ReferenceFieldMap, RefFieldEntry } from "./reference-field-map.js";
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
export {
  hasProvidesZone,
  hasRequiresZone,
  readProvidesZone,
  readRequiresZone,
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
export type { ZoneSlotIssue } from "./validate-zone-slots.js";
export { validateDynamicSelectors, validateRefSlotDeclarations } from "./validate-ref-slots.js";
export type { RefSlotIssue } from "./validate-ref-slots.js";
export { validateValueTypeSlots } from "./validate-value-type-slots.js";
export type { ValueTypeSlotIssue } from "./validate-value-type-slots.js";
export { checkSchemaCompatibility, selectUnionBranch } from "./schema-compat.js";
export type { CompatibilityResult } from "./schema-compat.js";
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
  LAYER_ROLES,
  PLATFORM_AXES,
  ArtifactSelectorError,
  describeSelector,
  isLayerRole,
  normalizeSelector,
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
export {
  LayerIndexError,
  matchControllerLayers,
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
