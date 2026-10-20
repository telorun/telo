//! The CEL language for Rust — `index.ts`, the entry of `cel/nodejs` (`@telorun/cel`).
//!
//! The crate holds the engine's front end — reading an expression into the ranged
//! syntax tree, with the input limits and error recovery; resolving namespace-qualified
//! calls; writing a tree back as source; and the two tree queries — its type system —
//! the static types, type text and signatures, the function registry with the standard
//! library read from Node's own signature data, typing from JSON Schema with its reports,
//! and the environment's registrations, declarations and listing — and the checker: every
//! verdict with its code, message, range and fix, and the call each name resolved to —
//! RE2, the pattern language of `matches`: its parser, program and machine, over the
//! engine's own Unicode 17.0 data — the runtime library: what every operator and standard
//! function does, member read, integer arithmetic, equality and ordering, a timestamp's
//! fields in a time zone over the IANA database it bundles, and ECMAScript's casing — and
//! evaluation: an expression compiled to a flat program over a snapshot of its
//! environment, run in one loop with errors as values, its comprehensions, per-site
//! dispatch, the compiled cache and namespaced calls. It answers as the Node engine answers.
//!
//! Three rules hold for every file here: two dependencies, the value crate by path and
//! `jiff-tzdb` for the zone database's names and bytes, neither deciding a verdict; no
//! host vocabulary; and nothing recurses with the depth of its input.
//!
//! Each file twins the `cel/nodejs/src` file of its name, and each header lists the
//! Node items with no twin. Six files have no Node twin, each header saying why:
//! `json_value.rs`; the RE2 files and the Unicode data, whose roles Node's dependency
//! re2js and its host's V8 fill; and the zone database, whose role its host's Intl
//! fills. The exports below are the front-end block of Node's entry, its
//! comprehension-binding table, the type system's and the checker's items, the value
//! domain's `cel-value.ts` items, the pattern language's and the bounded cache, the
//! runtime library's, member read's, equality's, the timestamp file's and `value-text.ts`'s,
//! and evaluation's: the activation, the program and its options, the compile refusal,
//! the call-site capacity and the comprehension functions.
//!
//! - `reserved_words.rs`         — `reserved-words.ts`
//! - `syntax_diagnostic.rs`      — `syntax-diagnostic.ts`
//! - `parse_limits.rs`           — `parse-limits.ts`
//! - `syntax_tree.rs`            — `syntax-tree.ts`
//! - `tree_equality.rs`          — `tree-equality.ts`
//! - `lexer.rs`                  — `lexer.ts`
//! - `parser.rs`                 — `parser.ts`
//! - `namespace_resolution.rs`   — `namespace-resolution.ts`
//! - `cel_expression.rs`         — `cel-expression.ts`
//! - `serializer.rs`             — `serializer.ts`
//! - `comprehension_bindings.rs` — `comprehension-bindings.ts`
//! - `qualified_calls.rs`        — `qualified-calls.ts`
//! - `root_references.rs`        — `root-references.ts`
//! - `declared_chain.rs`         — `declared-chain.ts`
//! - `cel_type.rs`               — `cel-type.ts`
//! - `type_expression.rs`        — `type-expression.ts`
//! - `signature.rs`              — `signature.ts`
//! - `nominal_type.rs`           — `nominal-type.ts`
//! - `check_diagnostic.rs`       — `check-diagnostic.ts`
//! - `runtime_library.rs`        — `runtime-library.ts`
//! - `member_read.rs`            — `member-read.ts`
//! - `value_equality.rs`         — `value-equality.ts`
//! - `integer_arithmetic.rs`     — `integer-arithmetic.ts`
//! - `timestamp_value.rs`        — `timestamp-value.ts` (the engine half)
//! - `value_text.rs`             — `value-text.ts` (the engine half)
//! - `zone_database.rs`          — no twin: the IANA database Node's host's Intl reads
//! - `function_registry.rs`      — `function-registry.ts`
//! - `standard_library.rs`       — `standard-library.ts`
//! - `json_value.rs`             — no twin: the JSON value a JavaScript host holds
//! - `json_text_scan.rs`         — `json-text-scan.ts`
//! - `json_schema_type.rs`       — `json-schema-type.ts`
//! - `cel_value.rs`              — `cel-value.ts` (the engine half, and the domain re-exported)
//! - `resolved_call.rs`          — `resolved-call.ts`
//! - `nullable_access.rs`        — `nullable-access.ts`
//! - `macro_shape.rs`            — `macro-shape.ts`
//! - `macro_check.rs`            — `macro-check.ts`
//! - `checker.rs`                — `checker.ts`
//! - `environment.rs`            — `environment.ts` (less the emitter)
//! - `activation.rs`             — `activation.ts`
//! - `comprehension_runtime.rs`  — `comprehension-runtime.ts`
//! - `backend_runtime.rs`        — `backend-runtime.ts`
//! - `closure_backend.rs`        — `closure-backend.ts` (a flat program, not closures)
//! - `cel_program.rs`            — `cel-program.ts`
//! - `bounded_cache.rs`          — `bounded-cache.ts`
//! - `regular_expression.rs`     — `regular-expression.ts`
//! - `re2_syntax.rs`             — no twin: re2js's parser
//! - `re2_program.rs`            — no twin: re2js's simplifier, compiler and program
//! - `re2_machine.rs`            — no twin: re2js's machine
//! - `unicode_tables.rs`         — no twin: generated from the Unicode 17.0 archive

mod activation;
mod backend_runtime;
mod bounded_cache;
mod cel_expression;
mod cel_program;
mod cel_type;
mod cel_value;
mod check_diagnostic;
mod checker;
mod closure_backend;
mod comprehension_bindings;
mod comprehension_runtime;
mod declared_chain;
mod environment;
mod function_registry;
mod integer_arithmetic;
mod json_schema_type;
mod json_text_scan;
mod json_value;
mod lexer;
mod macro_check;
mod macro_shape;
mod member_read;
mod namespace_resolution;
mod nullable_access;
mod nominal_type;
mod parse_limits;
mod parser;
mod qualified_calls;
mod re2_machine;
mod re2_program;
mod re2_syntax;
mod regular_expression;
mod reserved_words;
mod resolved_call;
mod root_references;
mod runtime_library;
mod serializer;
mod signature;
mod standard_library;
mod syntax_diagnostic;
mod syntax_tree;
mod timestamp_value;
mod tree_equality;
mod type_expression;
// The dataset is generated whole; not every table has a reader in every build.
#[allow(dead_code)]
mod unicode_tables;
mod value_equality;
mod value_text;
mod zone_database;

pub use activation::CelActivation;
pub use backend_runtime::{CelCompileError, CALL_SITE_CACHE_CAPACITY};
pub use bounded_cache::BoundedCache;
pub use cel_expression::{parse_expression, resolved_under, CelExpression, ParseExpressionOptions};
pub use cel_program::{CelProgram, EvaluateOptions};
pub use cel_type::{
    admits_null, assignable, format_type, is_dyn, is_numeric, list_of, map_of, optional_of, parameter_of,
    types_equal, unify, union_of, without_null, without_parameters, CelType, ListType, MapType, NominalType,
    OptionalType, ParameterType, PrimitiveName, RecordType, TypeFields, UnionType, BOOL, BYTES, DOUBLE, DURATION,
    DYN, INT, NULL, STRING, TIMESTAMP, TYPE, UINT, WELL_KNOWN_TYPE_NAMES,
};
pub use cel_value::{
    cel_error, cel_none, cel_some, cel_type_name_of, cel_type_value, literal_value, CelDuration, CelError,
    CelEvaluationCode, CelHostValue, CelList, CelMap, CelMapKey, CelOptional, CelRecord, CelTimestamp, CelTypeValue,
    CelValue, PropertyMap, ReservedTypeName, CEL_EVALUATION_CODES, CEL_VALUE_KEYS,
};
pub use check_diagnostic::{
    CelCheckCode, CelCheckDiagnostic, CelDiagnosticFix, CelEngineError, CelEngineErrorCode, CEL_CHECK_CODES,
};
pub use checker::{CheckResult, NamespaceFunction};
pub use comprehension_bindings::{
    namespace_macro_binding, receiver_macro_binding, ComprehensionBinding, BINDING_FORMS,
};
pub use comprehension_runtime::{
    cel_all, cel_exists, cel_exists_one, cel_filter, cel_map_comprehension, ComprehensionBody,
};
pub use declared_chain::{split_declared_chain, DeclaredChain};
pub use environment::{
    CelEnvironment, CelEnvironmentOptions, CelEvaluateError, CelProgramError, CelRegistrationError, Definitions,
    FunctionDefinition, DEFAULT_COMPILED_CACHE_CAPACITY,
    NamespaceFunctionDeclaration, NamespaceFunctionForm, NamespaceListing, NamespaceOptions, SchemaRegistrationReport,
    SignatureDeclaration, TypeDeclaration, TypeDefinitionListing, VariableDefinition, WithheldReturns,
};
pub use function_registry::{
    describe_arguments, describe_candidates, substitute, FunctionRegistry, RegisteredFunction, Resolution,
    ResolutionFailure, ResolutionFailureReason, UNKNOWN_FUNCTION_CANDIDATES,
};
pub use json_schema_type::{
    field_map_type, schema_type, FieldDeclaration, JsonSchemaDocument, NamedTypeLookup, RecursiveSchemaReference,
    SchemaConversion, SchemaTypeAnswer, SchemaTypeResolver, SchemaTypeResult, UnjudgedReason, UnjudgedSchemaNode,
    TYPE_CONSTRAINING_KEYWORDS, TYPE_KEYWORDS_READ, UNJUDGED_REASONS,
};
pub use json_text_scan::{read_json_text, scan_json_prefix, JsonRefusal, JsonTextError};
pub use json_value::JsonValue;
pub use member_read::{cel_has, cel_iterable, cel_lookup, cel_read, lookup_absence, lookup_error, HostFields, Lookup};
pub use namespace_resolution::{
    namespace_sets_equal, normalize_namespaces, resolve_namespaces, CelNamespaceError, RESERVED_NAMESPACES,
};
pub use nominal_type::{CelTypeRegistrationError, NominalOperatorDeclaration, NominalTypeDefinition};
pub use parse_limits::{CelParseLimits, DEFAULT_PARSE_LIMITS};
pub use parser::{parse_syntax, ParseOptions, ParseResult};
pub use qualified_calls::{qualified_calls, QualifiedCall};
pub use re2_program::{Re2Program, Re2Search, Re2Span};
pub use regular_expression::{
    cel_matches, re2_pattern, Re2Flags, Re2PatternErrorKind, Re2PatternRefusal, PATTERN_CACHE_CAPACITY,
    RE2_FLAG_LETTERS, RE2_PATTERN_ERROR_KINDS,
};
pub use reserved_words::{is_identifier_spelling, is_reserved_word, LITERAL_WORDS, OPERATOR_WORDS, RESERVED_WORDS};
pub use resolved_call::ResolvedCall;
pub use root_references::root_references;
pub use runtime_library::{
    base64_text, cel_type_value_of, implementation_of, implemented_keys, json_as_cel_value, optional_of_non_zero,
    standard_constant_values, type_value_name, CelCallContext, CelImplementation, CALL_SITE_DIRECT_ARITY,
};
pub use serializer::{serialize_tree, CelSerializeError};
pub use signature::{
    format_signature, parse_signature, signature_key, CallForm, CelSignature, FunctionMetadata, LiteralArgumentCheck,
};
pub use standard_library::{
    google_type_names, register_standard_library, standard_constants, standard_library_signatures, StandardConstant,
    StandardLibraryOptions, STANDARD_LIBRARY_GENERATION,
};
pub use syntax_diagnostic::{CelSyntaxCode, CelSyntaxDiagnostic};
pub use syntax_tree::{
    child_nodes, has_unparsed, walk_tree, CelBinaryNode, CelBinaryOperator, CelCallNode, CelConditionalNode,
    CelIdentNode, CelIndexNode, CelListElement, CelListNode, CelLiteral, CelLiteralNode, CelMapEntry, CelMapNode,
    CelNode, CelQualifiedCallNode, CelReceiverCallNode, CelSelectNode, CelUnaryNode, CelUnaryOperator,
    CelUnparsedNode, SourceRange, TreeWalk,
};
pub use timestamp_value::{
    cel_timestamp, cel_timestamp_from_millis, format_timestamp, parse_timestamp, timestamp_field, timestamp_nanos,
    zoned_fields, CivilFields, TimestampField, MAX_TIMESTAMP_SECONDS, MIN_TIMESTAMP_SECONDS,
};
pub use tree_equality::trees_equal;
pub use type_expression::{
    parse_type_expression, CelTypeExpressionError, CelTypeTextError, CelUnknownTypeNameError, NominalResolver,
};
pub use value_equality::{cel_compare, cel_equal};
pub use value_text::{bytes_to_text, double_text, es_to_lower_case, es_to_upper_case, text_to_bytes};
