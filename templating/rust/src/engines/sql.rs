//! The `!sql` engine — `sql.ts`. Treats the tagged scalar as a SQL string with `${{ }}`
//! holes whose values are *bound*, not spliced. Unlike `!cel` (one bare expression) it keeps
//! the literal text and each hole separate: at runtime `call` answers the parameterized
//! record (`ParameterizedSql`) a consumer turns into a parameterized query.
//!
//! Node's `export { isParameterizedSql, ParameterizedSql }` re-export has no twin: they are
//! `telorun_sdk_core::compiled_value`'s.

use crate::cel::compile::CompiledValue;
use crate::cel::interpolation_holes::literal_fragments;
use crate::cel::verdict_codes::TemplatingError;
use crate::engine::{AnalyzeEnv, AnalyzeResult, CompileEnv, CompileOutcome, ExpressionRegion, TemplatingEngine};
use crate::engines::hole_analysis::{analyze_holes, compile_holes, hole_regions, holes_repeatable, require_holes};
use telorun_cel::CelEnvironment;

/// The registry key of the `!sql` engine.
pub const SQL_ENGINE: &str = "sql";

pub struct SqlEngine;

impl TemplatingEngine for SqlEngine {
    fn name(&self) -> &'static str {
        SQL_ENGINE
    }

    fn language(&self) -> Option<&'static str> {
        Some("sql")
    }

    fn compile(&self, source: &str, env: &CompileEnv<'_>) -> Result<CompileOutcome, TemplatingError> {
        let holes = require_holes(SQL_ENGINE, source)?;
        let fragments = literal_fragments(source, &holes);
        let compiled = compile_holes(&holes, env)?;
        Ok(CompileOutcome::Compiled(CompiledValue::sql(source, fragments, compiled)))
    }

    fn analyze(&self, source: &str, env: &AnalyzeEnv<'_>) -> AnalyzeResult {
        // No type: a SQL template is a query built from many expressions, so there is no
        // single checked type to report.
        analyze_holes(source, env, None).into()
    }

    fn expression_regions(&self, source: &str) -> Vec<ExpressionRegion> {
        hole_regions(source)
    }

    fn repeatable(&self, source: &str, cel_env: &CelEnvironment) -> bool {
        holes_repeatable(source, cel_env)
    }
}
