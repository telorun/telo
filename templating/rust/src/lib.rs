//! Telo templating for the Rust kernel.
//!
//! Mirrors `templating/nodejs` file for file: the tagged-sentinel shape and the YAML tag
//! configuration the kernel reads a manifest with, the engine contract (`engine.rs`), and
//! the `!cel` engine over `telorun-cel` — the two environments, value-type registration,
//! the verdict codes, compiling an expression with its module calls and written
//! arguments, the call audit, what an expression reads and the verdict pipeline — beside
//! the hole grammar. Nothing wires the engine in yet: the kernel's tag reader
//! (`yaml_tags.rs`) still refuses `!cel`, `!interpolate` and `!sql`.

pub mod cel;
pub mod engine;
pub mod engines;
pub mod expansion_tags;
pub mod sentinel;
pub mod yaml_tags;

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
pub use engines::include::{
    is_include_engine, normalize_include_path, normalize_module_path, IncludePathError,
    INCLUDE_BYTES_ENGINE, INCLUDE_TEXT_ENGINE,
};
pub use engines::module_path::MODULE_PATH_ENGINE;
pub use engines::r#ref::{parse_ref_source, ParsedRef, RefIndex, RefVerdict, REF_MEMBER_INVALID};
pub use expansion_tags::{
    expansion_shape_code, expansion_tag_of, is_expansion_tag, EXPANSION_MARKER, EXPANSION_TAGS,
    SPLICE_KEY,
};
pub use sentinel::{
    is_tagged_sentinel, make_tagged_sentinel, ref_sentinel_source, ref_sentinel_verdict,
    tagged_sentinel_parts, REF_ENGINE,
};
pub use yaml_tags::{yaml_to_json, TagError};
