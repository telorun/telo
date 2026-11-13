//! Telo templating for the Rust kernel: the tag layer.
//!
//! Mirrors `templating/nodejs` file for file: the tagged-sentinel shape and the YAML tag
//! configuration the kernel reads a manifest with, over the YAML reader (`yaml_lexer.rs`,
//! `yaml_cst_parser.rs`, `yaml_composer.rs` and their helpers — a twin of the `yaml` package
//! the Node half composes with),
//! the engine contract (`engine.rs`), and
//! every tag engine over `telorun-cel` — `!cel`, `!interpolate`, `!sql` and `!literal`, the
//! `!ref`, `!include-*` and `!module-path` markers, and the closed table and registry that
//! list them. Beneath them the two environments with their brands, value-type registration,
//! the verdict codes, the hole grammar, compiling an expression with its module calls and
//! written arguments, the call audit, what an expression reads and the walk over a manifest
//! value for its tagged scalars. The tag reader (`yaml_tags.rs`) reads `!cel`, `!interpolate`,
//! `!sql` and `!literal` as sentinels, as Node does; no host compiles one here yet, and the Rust
//! kernel refuses an expression sentinel where it consumes the value.

pub mod builtins;
pub mod cel;
pub mod engine;
pub mod engines;
pub mod expansion_tags;
pub mod registry;
pub mod sentinel;
pub mod yaml_composer;
pub mod yaml_cst;
pub mod yaml_cst_parser;
pub mod yaml_errors;
pub mod yaml_lexer;
pub mod yaml_resolve;
pub mod yaml_tags;

pub use builtins::{
    cel_expressions_of, default_registry, produced_type_of, repeatable_source, BUILTIN_ENGINES,
};
pub use cel::compile::{
    compile_expression, compiled_value_of, namespace_dispatch_of, repeatable_expression, site_environment,
    CallError, CompiledCall, CompiledValue,
};
pub use cel::environment::{
    build_cel_environment, build_cel_language_environment, cel_builtin_functions, cel_function_catalog, CelHandlers,
};
pub use cel::literal_argument::WrittenArgument;
pub use cel::module_call::{ModuleCallDispatch, ModuleFunction};
pub use cel::verdict_codes::{
    cel_verdict_error, CelDiagnostic, CelDiagnosticCode, CelErrorCode, TemplatingError, CEL_VERDICT_CODES,
};
pub use engine::{
    AnalyzeEnv, AnalyzeResult, CallArgument, CallArgumentEntry, CallSite, CompileEnv, CompileOutcome, DiagnosticFix,
    EngineDiagnostic, EngineFileClaim, ExpressionRegion, ModuleCallFlagValues, TemplatingEngine,
};
pub use engines::cel::{analyze_cel_expression, analyze_cel_with_tree, CelEngine, CEL_ENGINE};
pub use cel::interpolation_holes::{
    interpolation_shape, literal_fragments, read_interpolation_holes, HoleReading, InterpolationHole,
    InterpolationShape,
};
pub use cel::walk::walk_cel_expressions;
pub use engines::hole_analysis::{analyze_holes, hole_regions, holes_repeatable, require_holes};
pub use engines::include::{
    is_include_engine, normalize_include_path, normalize_module_path, IncludeEngine, IncludePathError,
    INCLUDE_BYTES, INCLUDE_BYTES_ENGINE, INCLUDE_TEXT, INCLUDE_TEXT_ENGINE,
};
pub use engines::interpolate::{InterpolateEngine, INTERPOLATE_ENGINE};
pub use engines::literal::{LiteralEngine, LITERAL_ENGINE};
pub use engines::module_path::{ModulePathEngine, MODULE_PATH_ENGINE};
pub use engines::r#ref::{parse_ref_source, ParsedRef, RefEngine, RefIndex, RefVerdict, REF_MEMBER_INVALID};
pub use engines::sql::{SqlEngine, SQL_ENGINE};
pub use registry::TemplatingEngineRegistry;
pub use expansion_tags::{
    expansion_shape_code, expansion_tag_misuse, expansion_tag_of, is_expansion_tag, ExpansionTagMisuse, EXPANSION_MARKER, EXPANSION_TAGS,
    SPLICE_KEY,
};
pub use sentinel::{
    is_tagged_sentinel, make_tagged_sentinel, ref_sentinel_source, ref_sentinel_verdict,
    tagged_sentinel_parts, REF_ENGINE,
};
pub use yaml_composer::{
    compose_first_yaml_document, compose_yaml, NodeId, ScalarValue, YamlDocument, YamlEntry, YamlNode, YamlNodeKind,
    YamlScalar, YamlScalarStyle, YamlStream, YamlTag,
};
pub use yaml_errors::{LinePos, YamlError};
pub use yaml_tags::{document_to_json, JsonRefusal, TagError, TagRefusal, UnsupportedConstruct, NESTING_REFUSAL};
