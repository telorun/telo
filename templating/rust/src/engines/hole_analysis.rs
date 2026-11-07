//! What the tags with holes (`!interpolate`, `!sql`) share — `hole-analysis.ts`: reading a
//! scalar's holes, compiling each as its own expression, analyzing each with the one `!cel`
//! verdict pipeline, and answering where the expressions sit and whether they repeat.
//!
//! Node items with no twin: `CompileEnv.programSites`, which `compileHoles` threads to
//! `compileExpression`.

use telorun_cel::{CelEnvironment, CelNode};

use crate::cel::compile::{compile_expression, repeatable_expression, CompiledHoles};
use crate::cel::interpolation_holes::{read_interpolation_holes, HoleReading, InterpolationHole};
use crate::cel::verdict_codes::{CelAnalyzeResult, CelDiagnostic, CelDiagnosticCode, TemplatingError};
use crate::engine::{AnalyzeEnv, CompileEnv, DiagnosticFix, ExpressionRegion};
use crate::engines::cel::analyze_cel_with_tree;

/// A tag's own verdict on a hole that analyzed clean: the hole, its analysis and its tree.
pub type HoleVerdict<'a> = &'a dyn Fn(&InterpolationHole, &CelAnalyzeResult, Option<&CelNode>) -> Vec<CelDiagnostic>;

/// The holes of a scalar a hole-bearing tag compiles, or an error naming where the reading
/// failed — a tag's scalar that cannot be read is not a value.
pub fn require_holes(tag: &str, source: &str) -> Result<Vec<InterpolationHole>, TemplatingError> {
    match read_interpolation_holes(source) {
        HoleReading::Holes(holes) => Ok(holes),
        HoleReading::Failed { message, .. } => Err(TemplatingError::uncoded(format!("!{tag}: {message}"))),
    }
}

/// Every hole compiled as its own CEL expression, with the roots, module calls and
/// volatility of all of them carried together.
pub(crate) fn compile_holes(holes: &[InterpolationHole], env: &CompileEnv<'_>) -> Result<CompiledHoles, TemplatingError> {
    holes
        .iter()
        .map(|hole| compile_expression(&hole.expr, env.cel_env, env.module_names))
        .collect::<Result<Vec<_>, _>>()
        .map(CompiledHoles::new)
}

/// Analyze each hole with the shared CEL analysis, so diagnostics read exactly as they do
/// under `!cel`; a fix computed against one hole's expression is re-anchored onto the whole
/// scalar, and call offsets onto the scalar too. `per_hole` adds a tag's own verdict on a
/// hole that analyzed clean.
pub fn analyze_holes(source: &str, env: &AnalyzeEnv<'_>, per_hole: Option<HoleVerdict<'_>>) -> CelAnalyzeResult {
    let holes = match read_interpolation_holes(source) {
        HoleReading::Holes(holes) => holes,
        HoleReading::Failed { message, .. } => {
            return CelAnalyzeResult {
                diagnostics: vec![CelDiagnostic { code: CelDiagnosticCode::CelSyntaxError, message, fix: None }],
                ..CelAnalyzeResult::default()
            };
        }
    };
    let mut diagnostics: Vec<CelDiagnostic> = Vec::new();
    let mut calls = Vec::new();
    for hole in &holes {
        let (result, tree) = analyze_cel_with_tree(&hole.expr, env);
        for diagnostic in &result.diagnostics {
            diagnostics.push(match &diagnostic.fix {
                Some(fix) => CelDiagnostic { fix: Some(reanchor(source, hole, fix)), ..diagnostic.clone() },
                None => diagnostic.clone(),
            });
        }
        for call in &result.calls {
            calls.push(crate::engine::CallSite {
                start: hole.expr_start + call.start,
                end: hole.expr_start + call.end,
                ..call.clone()
            });
        }
        if let Some(verdict) = per_hole {
            if result.diagnostics.is_empty() {
                diagnostics.extend(verdict(hole, &result, tree.as_deref()));
            }
        }
    }
    CelAnalyzeResult { diagnostics, calls, ..CelAnalyzeResult::default() }
}

/// The CEL expressions of a hole-bearing scalar, by offset.
pub fn hole_regions(source: &str) -> Vec<ExpressionRegion> {
    match read_interpolation_holes(source) {
        HoleReading::Holes(holes) => holes
            .iter()
            .map(|hole| ExpressionRegion {
                start: hole.expr_start,
                end: hole.expr_start + hole.expr.encode_utf16().count(),
            })
            .collect(),
        HoleReading::Failed { .. } => Vec::new(),
    }
}

/// Whether every hole of a hole-bearing scalar is repeatable; the literal text between them
/// always is. A scalar that does not read is not.
pub fn holes_repeatable(source: &str, cel_env: &CelEnvironment) -> bool {
    match read_interpolation_holes(source) {
        HoleReading::Holes(holes) => holes.iter().all(|hole| repeatable_expression(&hole.expr, cel_env)),
        HoleReading::Failed { .. } => false,
    }
}

fn reanchor(source: &str, hole: &InterpolationHole, fix: &DiagnosticFix) -> DiagnosticFix {
    DiagnosticFix {
        replacement: format!(
            "{}{}{}",
            &source[..hole.expr_byte_start],
            fix.replacement,
            &source[hole.expr_byte_start + hole.expr.len()..]
        ),
    }
}
