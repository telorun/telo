/**
 * `@telorun/cel` — the CEL language.
 *
 * This entry is the front end: reading an expression, the canonical tree it reads
 * into, writing a tree back as source, and the two questions a consumer asks of a
 * tree (what it reads, and which namespaced functions it calls). It reaches no
 * runtime of its own and no host facility — nothing here touches a filesystem, a
 * clock or a network, so it runs unchanged in a browser.
 *
 * It owns CEL and nothing above it: no host's type vocabulary, no host's function
 * catalog. Those are registered onto the engine by whoever embeds it.
 */

export { parseExpression, resolvedUnder } from "./cel-expression.js";
export type { CelExpression, ParseExpressionOptions } from "./cel-expression.js";

export { MAX_INT, MAX_UINT, MIN_INT } from "./lexer.js";

export {
  CelNamespaceError,
  namespaceSetsEqual,
  normalizeNamespaces,
  RESERVED_NAMESPACES,
  resolveNamespaces,
} from "./namespace-resolution.js";

export { DEFAULT_PARSE_LIMITS, resolveParseLimits } from "./parse-limits.js";
export type { CelParseLimits } from "./parse-limits.js";

export { parseSyntax } from "./parser.js";
export type { ParseOptions, ParseResult } from "./parser.js";

export { qualifiedCalls } from "./qualified-calls.js";
export type { QualifiedCall } from "./qualified-calls.js";

export {
  isIdentifierSpelling,
  isReservedWord,
  LITERAL_WORDS,
  OPERATOR_WORDS,
  RESERVED_WORDS,
} from "./reserved-words.js";

export { rootReferences } from "./root-references.js";

export { splitDeclaredChain } from "./declared-chain.js";
export type { DeclaredChain } from "./declared-chain.js";

export { CelSerializeError, serializeTree } from "./serializer.js";

export type { CelSyntaxCode, CelSyntaxDiagnostic } from "./syntax-diagnostic.js";

export { childNodes, hasUnparsed, walkTree } from "./syntax-tree.js";
export type {
  CelBinaryNode,
  CelBinaryOperator,
  CelCallNode,
  CelConditionalNode,
  CelIdentNode,
  CelIndexNode,
  CelListNode,
  CelLiteral,
  CelLiteralNode,
  CelMapEntry,
  CelMapNode,
  CelNode,
  CelQualifiedCallNode,
  CelReceiverCallNode,
  CelSelectNode,
  CelUnaryNode,
  CelUnaryOperator,
  CelUnparsedNode,
  SourceRange,
} from "./syntax-tree.js";

export { treesEqual } from "./tree-equality.js";

// --- the type system, the registry and the checker -------------------------

export {
  admitsNull,
  assignable,
  BOOL,
  BYTES,
  DOUBLE,
  DURATION,
  DYN,
  formatType,
  INT,
  isDyn,
  isNumeric,
  listOf,
  mapOf,
  NULL,
  optionalOf,
  parameterOf,
  STRING,
  TIMESTAMP,
  TYPE,
  typesEqual,
  UINT,
  unify,
  unionOf,
  WELL_KNOWN_TYPE_NAMES,
  withoutNull,
  withoutParameters,
} from "./cel-type.js";
export type {
  CelType,
  DynType,
  ListType,
  MapType,
  NominalType,
  OptionalType,
  ParameterType,
  PrimitiveName,
  PrimitiveType,
  RecordType,
  UnionType,
} from "./cel-type.js";

export { CEL_CHECK_CODES, CelEngineError } from "./check-diagnostic.js";
export type {
  CelCheckCode,
  CelCheckDiagnostic,
  CelDiagnosticFix,
  CelEngineErrorCode,
} from "./check-diagnostic.js";

export type { CheckResult, NamespaceFunction } from "./checker.js";

export { CelEnvironment, DEFAULT_COMPILED_CACHE_CAPACITY } from "./environment.js";
export type {
  CelEnvironmentOptions,
  Definitions,
  FunctionDefinition,
  NamespaceFunctionDeclaration,
  NamespaceListing,
  NamespaceOptions,
  SchemaRegistrationReport,
  TypeDeclaration,
  TypeDefinitionListing,
  VariableDefinition,
} from "./environment.js";

export { FunctionRegistry } from "./function-registry.js";
export type { RegisteredFunction, Resolution, ResolutionFailure } from "./function-registry.js";

export {
  fieldMapType,
  schemaType,
  TYPE_CONSTRAINING_KEYWORDS,
  TYPE_KEYWORDS_READ,
  UNJUDGED_REASONS,
} from "./json-schema-type.js";
export type {
  FieldDeclaration,
  JsonSchemaDocument,
  JsonSchemaNode,
  NamedTypeLookup,
  RecursiveSchemaReference,
  SchemaConversion,
  SchemaTypeAnswer,
  SchemaTypeResolver,
  SchemaTypeResult,
  UnjudgedReason,
  UnjudgedSchemaNode,
} from "./json-schema-type.js";

export { CelTypeRegistrationError } from "./nominal-type.js";
export type {
  NominalOperatorDeclaration,
  NominalTypeDefinition,
  RegisteredType,
} from "./nominal-type.js";

export type { ResolvedCall } from "./resolved-call.js";

export { formatSignature, parseSignature, signatureKey } from "./signature.js";
export type {
  CallForm,
  CelSignature,
  FunctionMetadata,
  LiteralArgumentCheck,
} from "./signature.js";

export {
  googleTypeNames,
  registerStandardLibrary,
  standardConstants,
  STANDARD_LIBRARY_GENERATION,
  standardLibrarySignatures,
} from "./standard-library.js";
export type { StandardConstant } from "./standard-library.js";

// --- the function catalog: the dialect, registered as a host registers one ------

export {
  catalogCategories,
  catalogSignatures,
  FUNCTION_CATALOG_GENERATION,
  functionCatalog,
  registerFunctionCatalog,
} from "./function-catalog.js";
export type { CatalogFunction, RegisterCatalogOptions } from "./function-catalog.js";

export {
  catalogGuardedNames,
  catalogImplementation,
  catalogImplementedKeys,
  catalogLiteralCheck,
} from "./catalog-runtime.js";
export type { CatalogImplementation, CelCatalogHandlers } from "./catalog-runtime.js";

export { scanJsonPrefix } from "./json-text-scan.js";
export type { JsonRefusal } from "./json-text-scan.js";

export {
  civilTimeIn,
  dateTextIn,
  daysInMonth,
  instantOfCivilTime,
  isoTextIn,
  knownTimeZone,
} from "./zoned-calendar.js";
export type { CivilTime } from "./zoned-calendar.js";

export { CelTypeExpressionError, parseTypeExpression } from "./type-expression.js";
export type { NominalResolver } from "./type-expression.js";

// --- the value domain, the semantics and the closure backend ----------------

export type { CelActivation } from "./activation.js";

export { BoundedCache } from "./bounded-cache.js";

export { celMapFromEntries, celMapKeys, mapKeyIdentity } from "./cel-map-value.js";

export { CelEvaluationError, programOfStep } from "./cel-program.js";
export type { CelProgram, EvaluateOptions } from "./cel-program.js";

// --- the emitter: JavaScript source, its key, and the one store seam --------

export { ENGINE_VERSION } from "./engine-version.js";

export {
  EMITTER_FORMAT_GENERATION,
  emittedModuleIdentity,
  emittedModuleKey,
  emittedModuleRefusal,
  programsFromEmittedModule,
  readEmittedHeader,
} from "./emitted-module.js";
export type {
  EmittedFactory,
  EmittedHeader,
  EmittedIdentity,
  EmittedModule,
  EmittedModuleStore,
  EmittedRuntime,
  StoredEmittedModule,
} from "./emitted-module.js";

export { environmentDigest } from "./environment-digest.js";
export type { DigestedEnvironment } from "./environment-digest.js";

/** The whole contract between an emitted module and the runtime it is handed. */
export { RUNTIME_BINDINGS } from "./js-emitter.js";
export type { RuntimeBinding } from "./js-emitter.js";

export {
  CEL_EVALUATION_CODES,
  CEL_VALUE_KEYS,
  CEL_VALUE_TYPE,
  celError,
  celNone,
  celSome,
  celTypeNameOf,
  celTypeValue,
  celUint,
  isCelBytes,
  isCelDuration,
  isCelError,
  isCelMap,
  isCelOptional,
  isCelRecord,
  isCelTimestamp,
  isCelTypeValue,
  isCelUint,
  literalValue,
} from "./cel-value.js";
export type {
  CelDuration,
  CelError,
  CelEvaluationCode,
  CelHostValue,
  CelMap,
  CelMapValueEntry,
  CelOptional,
  CelRecord,
  CelTimestamp,
  CelTypeValue,
  CelUint,
  CelValue,
  CelValueKey,
} from "./cel-value.js";

export { compileTree } from "./closure-backend.js";
export type { CompiledTree } from "./closure-backend.js";

export { CALL_SITE_CACHE_CAPACITY, CelCompileError } from "./backend-runtime.js";
export type {
  CelStep,
  CompileTarget,
  EvaluationFrame,
  NamespaceDispatch,
} from "./backend-runtime.js";

export {
  celAll,
  celExists,
  celExistsOne,
  celFilter,
  celMapComprehension,
} from "./comprehension-runtime.js";
export type { ComprehensionBody } from "./comprehension-runtime.js";

export {
  celDurationFromNanos,
  durationField,
  durationNanos,
  durationOutOfRange,
  formatDuration,
  MAX_DURATION_NANOS,
  MIN_DURATION_NANOS,
  parseDuration,
} from "./duration-value.js";

export {
  celHas,
  celIterable,
  celLookup,
  celRead,
  lookupError,
  MISSING,
  OUT_OF_RANGE,
  UNSUPPORTED_CONTAINER,
  UNSUPPORTED_KEY,
} from "./member-read.js";
export type { Lookup } from "./member-read.js";

export {
  celMatches,
  PATTERN_CACHE_CAPACITY,
  RE2_FLAG_LETTERS,
  RE2_PATTERN_ERROR_KINDS,
  re2Pattern,
} from "./regular-expression.js";
export type { RE2Compiled, RE2PatternRefusal } from "./regular-expression.js";

export {
  base64Text,
  celTypeValueOf,
  implementationOf,
  jsonAsCelValue,
  implementedKeys,
  optionalOfNonZero,
  standardConstantValues,
  typeValueName,
} from "./runtime-library.js";
export type { CelCallContext, CelImplementation } from "./runtime-library.js";

export {
  celTimestamp,
  formatTimestamp,
  MAX_TIMESTAMP_SECONDS,
  MIN_TIMESTAMP_SECONDS,
  parseTimestamp,
  timestampField,
  timestampNanos,
  zonedFields,
} from "./timestamp-value.js";

export { celCompare, celEqual } from "./value-equality.js";

export { bytesToText, doubleText, textToBytes } from "./value-text.js";
