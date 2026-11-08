//! The `!interpolate` engine — `interpolate.ts`: literal text with `${{ expr }}` holes,
//! always a string. Its meaning is exactly the CEL expression that joins the text with
//! `string(<hole>)` for each hole — every hole converts through CEL's own `string()`
//! overloads (RFC 3339 for a timestamp, `5400s` for a duration, UTF-8 for bytes), never the
//! host language's conversion. A hole whose type has no `string()` overload is refused
//! statically, and a `dyn` hole whose value `string()` refuses (null, a list, a map, an optional, a type) is refused at runtime
//! with the hole it came from; that runtime refusal, and its wording, are `cel/compile.rs`'s
//! `CompiledValue::call`, where the conversion program lives.
//!
//! Which types `string()` converts is read off the environment's own registrations named
//! `string` (one global parameter each, plus `dyn`) — not off overload resolution, so the
//! check is Node's rule.
//!
//! Node items with no twin: the `CONVERTIBLE` and `CONVERSIONS` weak maps — the set is read
//! once per analyzed scalar and the conversion program is compiled into each compiled value.

use std::collections::HashSet;

use telorun_cel::{CelEnvironment, CelNode};

use crate::cel::analyze::nullable_value_chain;
use crate::cel::compile::CompiledValue;
use crate::cel::interpolation_holes::{literal_fragments, InterpolationHole};
use crate::cel::verdict_codes::{CelAnalyzeResult, CelDiagnostic, CelDiagnosticCode, TemplatingError};
use crate::engine::{AnalyzeEnv, AnalyzeResult, CompileEnv, CompileOutcome, ExpressionRegion, TemplatingEngine};
use crate::engines::hole_analysis::{analyze_holes, compile_holes, hole_regions, holes_repeatable, require_holes};

/// The registry key of the `!interpolate` engine.
pub const INTERPOLATE_ENGINE: &str = "interpolate";

pub struct InterpolateEngine;

impl TemplatingEngine for InterpolateEngine {
    fn name(&self) -> &'static str {
        INTERPOLATE_ENGINE
    }

    fn language(&self) -> Option<&'static str> {
        Some("cel")
    }

    fn compile(&self, source: &str, env: &CompileEnv<'_>) -> Result<CompileOutcome, TemplatingError> {
        let holes = require_holes(INTERPOLATE_ENGINE, source)?;
        let fragments = literal_fragments(source, &holes);
        let compiled = compile_holes(&holes, env)?;
        CompiledValue::interpolated(source, fragments, holes, compiled, env.cel_env).map(CompileOutcome::Compiled)
    }

    fn analyze(&self, source: &str, env: &AnalyzeEnv<'_>) -> AnalyzeResult {
        let convertible = convertible_types(env.cel_env);
        let verdict = |hole: &InterpolationHole, result: &CelAnalyzeResult, tree: Option<&CelNode>| {
            hole_verdict(hole, result, tree, env, &convertible)
        };
        analyze_holes(source, env, Some(&verdict)).into()
    }

    fn produced_type(&self) -> Option<serde_json::Value> {
        Some(serde_json::json!({ "type": "string" }))
    }

    fn expression_regions(&self, source: &str) -> Vec<ExpressionRegion> {
        hole_regions(source)
    }

    fn repeatable(&self, source: &str, cel_env: &CelEnvironment) -> bool {
        holes_repeatable(source, cel_env)
    }
}

/// A clean hole's own checks, over the tree its analysis already built: whether it may be
/// null, and whether CEL can turn its type into text at all.
fn hole_verdict(
    hole: &InterpolationHole,
    result: &CelAnalyzeResult,
    tree: Option<&CelNode>,
    env: &AnalyzeEnv<'_>,
    convertible: &HashSet<String>,
) -> Vec<CelDiagnostic> {
    if let (Some(tree), Some(schema)) = (tree, env.context_schema) {
        if let Some(chain) = nullable_value_chain(tree, schema) {
            return vec![CelDiagnostic {
                code: CelDiagnosticCode::CelNullableAccess,
                message: format!(
                    "'{chain}' may be null, and a null has no text \u{2014} guard it in the hole (e.g. '${{{{ {chain} != null ? {chain} : \"\" }}}}')."
                ),
                fix: None,
            }];
        }
    }
    match &result.type_name {
        Some(type_name) if !convertible.contains(type_name) => vec![CelDiagnostic {
            code: CelDiagnosticCode::InterpolationHoleNotConvertible,
            message: format!(
                "the hole '${{{{ {} }}}}' is {type_name}, which CEL's string() cannot convert to text. Convert it inside the hole (e.g. join a list, or read the field you meant), or write the whole value as !cel.",
                hole.expr
            ),
            fix: None,
        }],
        _ => Vec::new(),
    }
}

/// The types a `string()` overload of `env` accepts, `dyn` among them — read off the
/// registered overloads, so the check is the one evaluation applies.
fn convertible_types(env: &CelEnvironment) -> HashSet<String> {
    let mut types: HashSet<String> = HashSet::from(["dyn".to_string()]);
    for function in env.functions_named("string") {
        if function.receiver_type.is_none() && function.parameters.len() == 1 {
            types.insert(function.parameters[0].clone());
        }
    }
    types
}
