export {
  buildCelEnvironment,
  celBuiltinFunctions,
  deriveSignatures,
  type CelHandlers,
} from "./cel/environment.js";
export {
  celFunctionCatalog,
  CEL_FUNCTIONS,
  type CelFunctionInfo,
  type CelFunctionDoc,
  type CelFunctionCategory,
} from "./cel/catalog.js";
export {
  compileExpression,
  compileString,
  toParameterized,
  TEMPLATE_REGEX,
  EXACT_TEMPLATE_REGEX,
} from "./cel/compile.js";
export {
  extractAccessChains,
  findNullableAccessIssues,
  INDEX_SEGMENT,
  validateChainAgainstSchema,
} from "./cel/analyze.js";
export { auditCalls, explainUnresolved, functionIndex, type CallAudit } from "./cel/diagnose.js";
export { walkCelExpressions, type CelSurface } from "./cel/walk.js";

export { celEngine } from "./engines/cel.js";
export {
  includeBytesEngine,
  includeTextEngine,
  normalizeIncludePath,
  type NormalizedIncludePath,
} from "./engines/include.js";
export { literalEngine } from "./engines/literal.js";
export { refEngine } from "./engines/ref.js";
export { sqlEngine, isParameterizedSql, type ParameterizedSql } from "./engines/sql.js";

export { TemplatingEngineRegistry } from "./registry.js";
export {
  builtinEngines,
  createDefaultRegistry,
  defaultRegistry,
  producedTypeOf,
} from "./builtins.js";
export type {
  AnalyzeEnv,
  AnalyzeResult,
  CallSite,
  CompileEnv,
  DiagnosticFix,
  EngineDiagnostic,
  EngineFileClaim,
  TemplatingEngine,
} from "./engine.js";

export {
  CEL_ENGINE,
  INCLUDE_BYTES_ENGINE,
  INCLUDE_ENGINE_NAMES,
  INCLUDE_TEXT_ENGINE,
  isIncludeSentinel,
  isRefSentinel,
  isTaggedSentinel,
  makeTaggedSentinel,
  plainChainOf,
  type TaggedSentinel,
} from "./sentinel.js";
export { buildCustomTags, defaultCustomTags } from "./yaml-tags.js";
