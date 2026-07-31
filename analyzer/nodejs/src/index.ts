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
  PERMISSIVE_CONTRACT,
  resolveContract,
  resolveContractSchema,
  withStreamPropertiesSkipped,
} from "./invocation-contract.js";
export type { ContractOrigin, ContractScope, ResolvedContract } from "./invocation-contract.js";
export {
  hasIntermediateWildcard,
  parseRedactionPath,
  RedactionPathError,
} from "./redaction-path.js";
export type { RedactionSegment } from "./redaction-path.js";
export { buildReferenceFieldMap, isRefEntry, isScopeEntry } from "./reference-field-map.js";
export type { ReferenceFieldMap, RefFieldEntry } from "./reference-field-map.js";
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
export { desugarLoadedFile, inlineImportManifests } from "./inline-imports.js";
export type { SyntheticImport } from "./inline-imports.js";
export {
  compareModuleVersions,
  compareParsedModuleVersions,
  isNewerModuleVersion,
  isSameModuleVersion,
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
export {
  LayerIndexError,
  matchControllerLayers,
  parseLayerIndex,
  singletonLayer,
} from "./artifact-layer-index.js";
export type { ArtifactLayer } from "./artifact-layer-index.js";
export { validateModuleArtifact } from "./validate-module-artifact.js";
export { withSyntheticPositions } from "./with-synthetic-positions.js";
export { documentToAst, parseToAst } from "./yaml-ast.js";
export type { AstDocument, AstMap, AstNode, AstPair, AstScalar, AstSeq } from "./yaml-ast.js";
export { buildCelSegments, wrapCelAst } from "./cel-ast.js";
export type { CelNode, CelSegment } from "./cel-ast.js";
export { DEFAULT_MANIFEST_FILENAME, DiagnosticSeverity } from "./types.js";
export type {
    AnalysisDiagnostic,
    AnalysisOptions,
    LoaderInitOptions,
    LoadOptions,
    ManifestSource,
    Position,
    PositionIndex,
    Range
} from "./types.js";

