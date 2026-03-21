export { StaticAnalyzer } from "./analyzer.js";
export { buildDependencyGraph, formatCycle } from "./dependency-graph.js";
export { validateReferences } from "./validate-references.js";
export { normalizeInlineResources } from "./normalize-inline-resources.js";
export type { DependencyGraph, ResourceNode } from "./dependency-graph.js";
export { buildReferenceFieldMap, isRefEntry, isScopeEntry } from "./reference-field-map.js";
export type {
  ReferenceFieldMap,
  FieldMapEntry,
  RefFieldEntry,
  ScopeFieldEntry,
} from "./reference-field-map.js";
export { Loader } from "./manifest-loader.js";
export { DefinitionRegistry } from "./definition-registry.js";
export { AliasResolver } from "./alias-resolver.js";
export { checkSchemaCompatibility, validateAgainstSchema, formatAjvErrors } from "./schema-compat.js";
export { resolveScope } from "./scope-resolver.js";
export { NodeAdapter, createNodeAdapter } from "./adapters/node-adapter.js";
export { HttpAdapter } from "./adapters/http-adapter.js";
export { RegistryAdapter } from "./adapters/registry-adapter.js";
export { DiagnosticSeverity } from "./types.js";
export type {
  AnalysisDiagnostic,
  AnalysisContext,
  AnalysisOptions,
  LoadOptions,
  ManifestAdapter,
  Range,
  Position,
} from "./types.js";
export type { InvocationContext } from "@telorun/sdk";
