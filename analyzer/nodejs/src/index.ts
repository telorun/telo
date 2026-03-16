export { StaticAnalyzer } from "./analyzer.js";
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
