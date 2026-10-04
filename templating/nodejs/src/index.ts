export {
  buildCelEnvironment,
  buildCelLanguageEnvironment,
  celBuiltinFunctions,
  celFunctionCatalog,
  type CelHandlers,
} from "./cel/environment.js";
// `namespaceDispatchOf` is the ONE adapter a host's dispatch table crosses to
// become the engine's namespace seam — exported because the analyzer evaluates
// rule conditions and function bodies through the same table, and a second
// adapter is what let it convert arguments differently from the kernel.
export { compileExpression, namespaceDispatchOf } from "./cel/compile.js";
export { registerValueBrands } from "./cel/value-brands.js";
export {
  interpolationShape,
  literalFragments,
  readInterpolationHoles,
  type HoleReading,
  type InterpolationHole,
  type InterpolationShape,
} from "./cel/interpolation-holes.js";
export {
  extractAccessChains,
  findNullableAccessIssues,
  INDEX_SEGMENT,
  validateChainAgainstSchema,
} from "./cel/analyze.js";
export {
  auditCalls,
  explainUnresolved,
  type CallAudit,
  type ModuleCallFlags,
} from "./cel/diagnose.js";
// The rewrite, its reader, and the activation key the kernel binds a scope's
// dispatch table under. The unbound message and the receiver and bound-name
// walks are read inside this package only.
// `ModuleCallTypeResolver` is here because `AnalyzeEnv` names it: an exported
// interface whose field type cannot be named is not usable from outside.
export {
  celNamespaceNames,
  MODULE_CALL_DISPATCH_KEY,
  moduleCallNames,
  moduleCallOf,
  type ModuleCallDispatch,
  type ModuleCallTypeResolver,
} from "./cel/module-call.js";
export { walkCelExpressions } from "./cel/walk.js";

export { celEngine } from "./engines/cel.js";
export {
  includeBytesEngine,
  includeTextEngine,
  normalizeIncludePath,
  normalizeModulePath,
  type NormalizedIncludePath,
} from "./engines/include.js";
export { interpolateEngine } from "./engines/interpolate.js";
export { literalEngine } from "./engines/literal.js";
export { modulePathEngine } from "./engines/module-path.js";
export { refEngine } from "./engines/ref.js";
export { sqlEngine, isParameterizedSql, type ParameterizedSql } from "./engines/sql.js";

export { TemplatingEngineRegistry } from "./registry.js";
export {
  builtinEngines,
  celExpressionsOf,
  createDefaultRegistry,
  defaultRegistry,
  producedTypeOf,
  repeatableSource,
} from "./builtins.js";
export type {
  AnalyzeEnv,
  AnalyzeResult,
  CallArgument,
  CallSite,
  CompileEnv,
  DiagnosticFix,
  EngineDiagnostic,
  EngineFileClaim,
  ExpressionRegion,
  TemplatingEngine,
} from "./engine.js";

export {
  CEL_ENGINE,
  INCLUDE_BYTES_ENGINE,
  INCLUDE_ENGINE_NAMES,
  INCLUDE_TEXT_ENGINE,
  isIncludeSentinel,
  isModulePathSentinel,
  isRefSentinel,
  isTaggedSentinel,
  makeTaggedSentinel,
  MODULE_FILE_ENGINE_NAMES,
  MODULE_PATH_ENGINE,
  plainChainOf,
  type TaggedSentinel,
} from "./sentinel.js";
export { buildCustomTags, defaultCustomTags } from "./yaml-tags.js";
