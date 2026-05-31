export { buildCelEnvironment, type CelHandlers } from "./cel/environment.js";
export {
  compileExpression,
  compileString,
  TEMPLATE_REGEX,
  EXACT_TEMPLATE_REGEX,
} from "./cel/compile.js";
export {
  extractAccessChains,
  findNullableAccessIssues,
  INDEX_SEGMENT,
  validateChainAgainstSchema,
} from "./cel/analyze.js";
export { walkCelExpressions } from "./cel/walk.js";

export { celEngine } from "./engines/cel.js";
export { literalEngine } from "./engines/literal.js";
export { refEngine } from "./engines/ref.js";

export { TemplatingEngineRegistry } from "./registry.js";
export { builtinEngines, createDefaultRegistry, defaultRegistry } from "./builtins.js";
export type {
  AnalyzeEnv,
  CompileEnv,
  EngineDiagnostic,
  TemplatingEngine,
} from "./engine.js";

export { isRefSentinel, isTaggedSentinel, makeTaggedSentinel, type TaggedSentinel } from "./sentinel.js";
export { buildCustomTags, defaultCustomTags } from "./yaml-tags.js";
export {
  MANIFEST_SCHEMA_URI,
  ManifestRootSchema,
  ResourceRefSchema,
} from "./manifest-schemas.js";
