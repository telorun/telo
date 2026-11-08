//! The `!cel` engine and the one verdict pipeline every CEL expression is analyzed by —
//! `engines/cel.ts`.
//!
//! [`analyze_cel_expression`] reads the expression, reserves a binding named after a
//! module, type-checks the tree in the environment typed for this path and forwards every
//! verdict the checker decides, reports an undeclared root identifier where the caller
//! vouches for its declarations, checks member reads off a module call's result, validates
//! member chains against the context schema and flags unguarded nullable access. It is
//! shared by `!cel` and by each hole of the tags with holes, so their wording cannot drift.
//!
//! Node items with no twin: the `try` around the check, which reports a checker crash as a
//! `CEL_TYPE_ERROR` — the checker answers rather than throws; and `explainUnknownFields`,
//! `checkerRejects` and `DYN_HINT`, which nothing calls.

use std::collections::HashSet;
use std::sync::Arc;

use serde_json::{json, Map};
use telorun_cel::{CelCheckCode, CelEnvironment, CelLiteral, CelNode};

use crate::cel::analyze::{
    chain_failure_against_schema, chains_refused_at, extract_access_chains, extract_call_result_accesses,
    find_nullable_access_issues, validate_chain_against_schema, INDEX_SEGMENT,
};
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

/// [`analyze_cel_expression`], with the resolved tree it read — for a tag asking its own
/// questions of one expression without reading it again. No tree where it did not read.
pub fn analyze_cel_with_tree(source: &str, env: &AnalyzeEnv<'_>) -> (CelAnalyzeResult, Option<Arc<CelNode>>) {
    let parsed = env.cel_env.parse(source);
    // Reading never fails: the first unreadable thing is one ranged diagnostic.
    if let Some(diagnostic) = &parsed.diagnostic {
        let result = CelAnalyzeResult {
            diagnostics: vec![diagnostic_of(CelDiagnosticCode::CelSyntaxError, diagnostic.message.clone())],
            ..CelAnalyzeResult::default()
        };
        return (result, None);
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

    let checked = env.cel_env.check_parsed(&parsed).expect("the tree was read against the same environment");
    let audit = audit_calls(source, &ast, env.cel_env, env.module_call_flags, Some(&checked));
    out.extend(audit.argument_issues);

    let mut type_name = None;
    let mut check_error = None;
    if checked.valid {
        type_name = Some(checked.type_name.clone());
    } else {
        // Every verdict is the engine's, coded and ranged.
        for diagnostic in &checked.diagnostics {
            out.push(CelDiagnostic {
                code: diagnostic.code.into(),
                message: diagnostic.message.clone(),
                fix: diagnostic.fix.as_ref().map(|fix| DiagnosticFix { replacement: fix.replacement.clone() }),
            });
        }
        check_error = checked.diagnostics.first().map(|diagnostic| diagnostic.message.clone());
    }

    // What the engine already said, so the context's own chain check does not say it again.
    let explained: HashSet<String> = out.iter().map(|diagnostic| diagnostic.message.clone()).collect();

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

    // A module call's result is typed by the callee's declared `returns`.
    if let Some(result_schema) = env.module_call_result {
        if !telorun_cel::qualified_calls(&ast).is_empty() {
            for access in extract_call_result_accesses(&ast) {
                let Some(schema) = result_schema(&access.qualified) else { continue };
                let label = format!("{}(…)", access.qualified);
                let mut chain = vec![label.clone()];
                chain.extend(access.members);
                let mut properties = Map::new();
                properties.insert(label, schema);
                let context = json!({ "type": "object", "properties": properties });
                if let Some(message) = validate_chain_against_schema(&chain, &context) {
                    out.push(diagnostic_of(CelDiagnosticCode::CelUnknownField, message));
                }
            }
        }
    }

    if let Some(context_schema) = env.context_schema {
        // A member of a closed record the checker refused is its verdict already.
        let refused_ranges: Vec<_> = if checked.valid {
            Vec::new()
        } else {
            checked
                .diagnostics
                .iter()
                .filter(|diagnostic| diagnostic.code == CelCheckCode::UnknownField)
                .map(|diagnostic| diagnostic.range)
                .collect()
        };
        let refused = chains_refused_at(&ast, &refused_ranges);
        for chain in extract_access_chains(&ast) {
            let Some(failure) = chain_failure_against_schema(&chain, context_schema) else { continue };
            if explained.contains(&failure.message) || refused.contains(&failure.path) {
                continue;
            }
            out.push(diagnostic_of(CelDiagnosticCode::CelUnknownField, failure.message));
        }
        for issue in find_nullable_access_issues(&ast, context_schema) {
            // An index attaches without a dot, a named field with one.
            let access = if issue.member == "[index]" { issue.member.clone() } else { format!(".{}", issue.member) };
            let path = &issue.path;
            out.push(diagnostic_of(
                CelDiagnosticCode::CelNullableAccess,
                format!(
                    "'{path}' may be null — guard it (e.g. '{path} != null && …' or '{path} == null ? … : {path}{access}') before accessing '{access}'"
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
    let read_types = check_error.map(|_| chain_types(&ast, env.cel_env));
    let result = CelAnalyzeResult { diagnostics: out, type_name, calls: audit.calls, string_literal, read_types };
    (result, Some(ast))
}

fn diagnostic_of(code: CelDiagnosticCode, message: String) -> CelDiagnostic {
    CelDiagnostic { code, message, fix: None }
}

/// The checked type of each distinct plain chain the expression reads, first seen first.
fn chain_types(ast: &CelNode, environment: &CelEnvironment) -> Vec<String> {
    let mut types: Vec<String> = Vec::new();
    for chain in extract_access_chains(ast) {
        if chain.iter().any(|segment| segment == INDEX_SEGMENT) {
            continue;
        }
        let result = environment.check(&chain.join("."));
        if result.valid && !types.contains(&result.type_name) {
            types.push(result.type_name);
        }
    }
    types
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

    fn expression_regions(&self, source: &str) -> Vec<ExpressionRegion> {
        vec![ExpressionRegion { start: 0, end: source.encode_utf16().count() }]
    }

    fn repeatable(&self, source: &str, cel_env: &CelEnvironment) -> bool {
        repeatable_expression(source, cel_env)
    }
}
