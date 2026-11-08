//! The built-in engines — `builtins.ts`: the single source of truth for which engines
//! exist, so the parse-side tag set, the precompile dispatch and the analyzer agree. The
//! table is closed and static; the three readers below ask the default registry what a tag
//! produces, where its CEL sits and whether its text repeats, so no consumer recognises a tag
//! by name.
//!
//! Node items with no twin: `createDefaultRegistry` and the `defaultRegistry` memo — the
//! default registry is a static over a static table.

use serde_json::Value;
use telorun_cel::CelEnvironment;

use crate::engine::TemplatingEngine;
use crate::engines::cel::CelEngine;
use crate::engines::include::{INCLUDE_BYTES, INCLUDE_TEXT};
use crate::engines::interpolate::InterpolateEngine;
use crate::engines::literal::LiteralEngine;
use crate::engines::module_path::ModulePathEngine;
use crate::engines::r#ref::RefEngine;
use crate::engines::sql::SqlEngine;
use crate::registry::TemplatingEngineRegistry;

/// Every built-in engine, in Node's order.
pub static BUILTIN_ENGINES: [&'static dyn TemplatingEngine; 8] = [
    &CelEngine,
    &INCLUDE_BYTES,
    &INCLUDE_TEXT,
    &InterpolateEngine,
    &LiteralEngine,
    &ModulePathEngine,
    &RefEngine,
    &SqlEngine,
];

static DEFAULT_REGISTRY: TemplatingEngineRegistry = TemplatingEngineRegistry::new(&BUILTIN_ENGINES);

/// The registry every host shares.
pub fn default_registry() -> &'static TemplatingEngineRegistry {
    &DEFAULT_REGISTRY
}

/// The type a tag always produces, or `None` when its produced type is a function of the
/// slot rather than of the tag (`!cel`, `!ref`) or the tag is unknown.
pub fn produced_type_of(engine_name: &str) -> Option<Value> {
    default_registry().get(engine_name)?.produced_type()
}

/// The CEL expressions a tagged scalar holds — its whole source under `!cel`, each hole
/// under a tag with holes, none under a tag holding no CEL.
pub fn cel_expressions_of(engine_name: &str, source: &str) -> Vec<String> {
    let Some(engine) = default_registry().get(engine_name) else { return Vec::new() };
    let units: Vec<u16> = source.encode_utf16().collect();
    engine
        .expression_regions(source)
        .iter()
        .map(|region| {
            String::from_utf16(&units[region.start..region.end])
                .expect("an engine's region falls on character boundaries of its own source")
        })
        .collect()
}

/// Whether a tagged scalar's text, written twice in one value, means one value both times —
/// false for a tag whose engine gives no such verdict.
pub fn repeatable_source(engine_name: &str, source: &str, cel_env: &CelEnvironment) -> bool {
    default_registry().get(engine_name).is_some_and(|engine| engine.repeatable(source, cel_env))
}
