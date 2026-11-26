//! The `!cel` engine and the one verdict pipeline every CEL expression is analyzed by —
//! `engines/cel.ts`.
//!
//! [`analyze_cel_expression`] reads the expression, reserves a binding named after a
//! module, type-checks the tree in the environment typed for this path — which judges every
//! member read, operand and nullable read to full depth — forwards every verdict, each
//! member read's worded from the schema node it names, and reports an undeclared root
//! identifier where the caller vouches for its declarations. It is shared by `!cel` and by
//! each hole of the tags with holes, so their wording cannot drift.
//!
//! Node items with no twin: the `try` around the check, which reports a checker crash as a
//! `CEL_TYPE_ERROR` — the checker answers rather than throws; `DYN_HINT`, which nothing
//! calls; and `AnalyzeEnv.assumptions` (handed to the check and to each read chain's type)
//! and `AnalyzeResult.origins`, which no Rust host supplies or reads — the analyzer's slot
//! fit, their one consumer, has no Rust twin, so this crate's `AnalyzeEnv` and
//! `AnalyzeResult` carry neither.

use std::collections::HashSet;
use std::sync::Arc;

use telorun_cel::{types_equal, CelEnvironment, CelLiteral, CelNode, CelType, CheckOptions};

use crate::cel::analyze::{extract_access_chains, INDEX_SEGMENT};
use crate::cel::verdict_wording::worded_verdicts;
use crate::cel::compile::{compile_expression, repeatable_expression};
use crate::cel::diagnose::audit_calls;
use crate::cel::module_call::{module_name_bindings, unresolved_call_receivers};
use crate::cel::verdict_codes::{CelAnalyzeResult, CelDiagnostic, CelDiagnosticCode, TemplatingError};
use crate::engine::{
    AnalyzeEnv, AnalyzeResult, CompileEnv, CompileOutcome, DiagnosticFix, ExpressionRegion, TemplatingEngine,
};

/// The registry key of the `!cel` engine.
pub const CEL_ENGINE: &str = "cel";

/// Statically analyzes one CEL expression against the effective context.
pub fn analyze_cel_expression(source: &str, env: &AnalyzeEnv<'_>) -> CelAnalyzeResult {
    analyze_cel_with_tree(source, env).0
}

/// [`analyze_cel_expression`], with the resolved tree it read and, where it checked clean,
/// the type it checked — for a tag asking its own questions of one expression without
/// reading or checking it again. No tree where it did not read.
pub fn analyze_cel_with_tree(source: &str, env: &AnalyzeEnv<'_>) -> (CelAnalyzeResult, Option<Arc<CelNode>>, Option<CelType>) {
    let parsed = env.cel_env.parse(source);
    // Reading never fails: the first unreadable thing is one ranged diagnostic.
    if let Some(diagnostic) = &parsed.diagnostic {
        let result = CelAnalyzeResult {
            diagnostics: vec![diagnostic_of(CelDiagnosticCode::CelSyntaxError, diagnostic.message.clone())],
            ..CelAnalyzeResult::default()
        };
        return (result, None, None);
    }
    let ast = Arc::clone(&parsed.root);
    let mut out: Vec<CelDiagnostic> = Vec::new();

    for name in module_name_bindings(&ast, env.module_names) {
        out.push(diagnostic_of(
            CelDiagnosticCode::BindingNameReserved,
            format!(
                "'{name}' names a module here (an imports: alias, Self, or this module's own name), so a call written '{name}.f(…)' resolves to that module and this binding could never be read. Rename the bound variable."
            ),
        ));
    }

    let checked = env
        .cel_env
        .check_parsed_with(&parsed, CheckOptions { schema_nodes: true, ..CheckOptions::default() })
        .expect("the tree was read against the same environment");
    let audit = audit_calls(source, &ast, env.cel_env, env.module_call_flags, Some(&checked));
    out.extend(audit.argument_issues);

    let mut type_name = None;
    let mut checked_type = None;
    let mut check_error = None;
    if checked.valid {
        type_name = Some(checked.type_name.clone());
        checked_type = Some(checked.ty.clone());
    } else {
        // Every verdict is the engine's, coded and ranged; a member read gets one finding,
        // worded from the node the verdict names.
        for diagnostic in &worded_verdicts(source, &ast, &checked.diagnostics) {
            out.push(CelDiagnostic {
                code: diagnostic.code.into(),
                message: diagnostic.message.clone(),
                fix: diagnostic.fix.as_ref().map(|fix| DiagnosticFix { replacement: fix.replacement.clone() }),
            });
        }
        check_error = checked.diagnostics.first().map(|diagnostic| diagnostic.message.clone());
    }

    if env.roots_declared {
        let mut call_receivers: Option<HashSet<String>> = None;
        let mut reported: HashSet<String> = HashSet::new();
        for chain in extract_access_chains(&ast) {
            let Some(root) = chain.first() else { continue };
            if reported.contains(root) || env.cel_env.has_variable(root) {
                continue;
            }
            reported.insert(root.clone());
            let receivers = call_receivers.get_or_insert_with(|| unresolved_call_receivers(&ast, env.module_names));
            let hint = receivers.contains(root) && env.could_name_module.is_some_and(|could| could(root));
            out.push(diagnostic_of(
                CelDiagnosticCode::CelUnknownIdentifier,
                format!(
                    "unknown identifier '{root}' — nothing by that name is in scope here.{}",
                    if hint {
                        format!(" To call a function another module declares, '{root}' must be one of this module's names — an 'imports:' alias, 'Self', or the module's own metadata.name.")
                    } else {
                        String::new()
                    }
                ),
            ));
        }
    }

    let string_literal = match &*ast {
        CelNode::Literal(literal) => match &literal.literal {
            CelLiteral::String(text) => Some(text.clone()),
            _ => None,
        },
        _ => None,
    };
    let (read_types, read_checked_types) = match check_error.map(|_| chain_types(&ast, env.cel_env)) {
        Some((names, types)) => (Some(names), Some(types)),
        None => (None, None),
    };
    let result = CelAnalyzeResult {
        diagnostics: out,
        type_name,
        checked_type: checked_type.clone(),
        calls: audit.calls,
        string_literal,
        read_types,
        read_checked_types,
    };
    (result, Some(ast), checked_type)
}

fn diagnostic_of(code: CelDiagnosticCode, message: String) -> CelDiagnostic {
    CelDiagnostic { code, message, fix: None }
}

/// The checked type of each distinct plain chain the expression reads, first seen first.
fn chain_types(ast: &CelNode, environment: &CelEnvironment) -> (Vec<String>, Vec<CelType>) {
    let (mut names, mut types): (Vec<String>, Vec<CelType>) = (Vec::new(), Vec::new());
    for chain in extract_access_chains(ast) {
        if chain.iter().any(|segment| segment == INDEX_SEGMENT) {
            continue;
        }
        let result = environment.check(&chain.join("."));
        if !result.valid {
            continue;
        }
        if !types.iter().any(|held| types_equal(held, &result.ty)) {
            types.push(result.ty.clone());
        }
        if !names.contains(&result.type_name) {
            names.push(result.type_name);
        }
    }
    (names, types)
}

/// The `!cel` engine: the whole tagged scalar is one CEL expression.
pub struct CelEngine;

impl TemplatingEngine for CelEngine {
    fn name(&self) -> &'static str {
        CEL_ENGINE
    }

    fn language(&self) -> Option<&'static str> {
        Some("cel")
    }

    fn compile(&self, source: &str, env: &CompileEnv<'_>) -> Result<CompileOutcome, TemplatingError> {
        compile_expression(source, env.cel_env, env.module_names).map(CompileOutcome::Compiled)
    }

    fn analyze(&self, source: &str, env: &AnalyzeEnv<'_>) -> AnalyzeResult {
        analyze_cel_expression(source, env).into()
    }

    fn holds_expressions(&self) -> bool {
        true
    }

    fn expression_regions(&self, source: &str) -> Vec<ExpressionRegion> {
        vec![ExpressionRegion { start: 0, end: source.encode_utf16().count() }]
    }

    fn repeatable(&self, source: &str, cel_env: &CelEnvironment) -> bool {
        repeatable_expression(source, cel_env)
    }
}
