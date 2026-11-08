//! The templating-engine contract — `engine.ts`.
//!
//! An engine matches a YAML tag (`!<name>`); a loader and an analyzer dispatch through it
//! rather than knowing a tag. `analyze` is the engine's one verdict on a source: everything
//! derivable from the expression alone is derived there once, and everything needing
//! manifest context is left to the caller.
//!
//! Node items with no twin:
//! - `CompileEnv.programSites` and `CelProgramSite` — a host swapping in a program from an
//!   emitted JavaScript module; there is no emitter here.
//! - `AnalyzeEnv.explainSchema` and `AnalyzeEnv.moduleCallType` — Node computes them and no
//!   engine reads them, so a caller here has nothing to supply.
//! - `TemplatingEngine.language` as an optional field — it is [`TemplatingEngine::language`].
//! - `compile` answering `CompiledValue | unknown` — it answers a [`CompileOutcome`].

use std::collections::HashSet;

use serde_json::Value;
use telorun_cel::{CallForm, CelEnvironment};
use telorun_cel_value::CelValue;

use crate::cel::compile::CompiledValue;
use crate::cel::verdict_codes::TemplatingError;

/// What `compile` is handed.
#[derive(Clone, Copy)]
pub struct CompileEnv<'a> {
    pub cel_env: &'a CelEnvironment,
    /// The names a call's receiver may be for the call to be a module call — the declaring
    /// module's `imports:` keys, `Self`, its `metadata.name` and `Telo`. An input, never
    /// derived: absent leaves every call an ordinary catalog call.
    pub module_names: Option<&'a HashSet<String>>,
}

/// The flags of the module function a qualified call reaches.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct ModuleCallFlagValues {
    pub deterministic: bool,
    pub host_backed: bool,
}

/// What `analyze` is handed. `cel_env` is the environment typed for this path; the engine
/// type-checks against it, so a caller never checks the same expression again.
#[derive(Clone, Copy)]
pub struct AnalyzeEnv<'a> {
    pub cel_env: &'a CelEnvironment,
    /// The closed context schema member-access chains are validated against, or `None`
    /// for an open context.
    pub context_schema: Option<&'a Value>,
    /// The caller vouches that `cel_env` declares every name legal here, so an unknown root
    /// identifier is undeclared rather than unmodelled.
    pub roots_declared: bool,
    /// The declaring module's names — see [`CompileEnv::module_names`]; the two halves are
    /// given the same set.
    pub module_names: Option<&'a HashSet<String>>,
    /// The JSON Schema a module call's result carries, which member access on it is
    /// checked against.
    pub module_call_result: Option<&'a dyn Fn(&str) -> Option<Value>>,
    /// The derived flags of the module function a qualified call reaches, carried onto its
    /// [`CallSite`].
    pub module_call_flags: Option<&'a dyn Fn(&str) -> Option<ModuleCallFlagValues>>,
    /// Whether a bare identifier could denote a module at all — the host's naming rule.
    pub could_name_module: Option<&'a dyn Fn(&str) -> bool>,
}

impl<'a> AnalyzeEnv<'a> {
    /// An open context and nothing more: no schema, no module names, no host rules.
    pub fn new(cel_env: &'a CelEnvironment) -> Self {
        Self {
            cel_env,
            context_schema: None,
            roots_declared: false,
            module_names: None,
            module_call_result: None,
            module_call_flags: None,
            could_name_module: None,
        }
    }
}

/// A mechanically applicable repair: the whole analyzed source, corrected.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct DiagnosticFix {
    pub replacement: String,
}

/// One static finding.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct EngineDiagnostic {
    pub message: String,
    pub code: Option<String>,
    pub fix: Option<DiagnosticFix>,
}

/// One function call an engine found, whether or not it is valid.
#[derive(Clone, PartialEq, Debug)]
pub struct CallSite {
    /// For a module call, the qualified name as written (`Billing.format`).
    pub name: String,
    pub form: CallForm,
    /// The receiver is one of the declaring module's names.
    pub module_call: bool,
    /// Arguments as written, the receiver excluded.
    pub arity: usize,
    /// For a module call, each argument as the analysis saw it.
    pub arguments: Option<Vec<CallArgument>>,
    /// UTF-16 offsets of the whole call within the analyzed source.
    pub start: usize,
    pub end: usize,
    /// `None` where the name resolves to nothing or carries no determinism — absent is not
    /// "deterministic".
    pub deterministic: Option<bool>,
    pub host_backed: Option<bool>,
}

/// One argument of a module call.
#[derive(Clone, PartialEq, Debug, Default)]
pub struct CallArgument {
    /// The checked type, absent where it is `dyn`.
    pub type_name: Option<String>,
    /// The member chain the argument is, when it is one.
    pub chain: Option<Vec<String>>,
    /// The value the argument is written as, when it is literals alone.
    pub literal: Option<CelValue>,
    /// For a map literal keyed by string literals, each key and the type it holds.
    pub entries: Option<Vec<CallArgumentEntry>>,
}

/// One entry of a map-literal argument.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct CallArgumentEntry {
    pub key: String,
    pub type_name: Option<String>,
}

/// What one `analyze` establishes about one source.
#[derive(Clone, PartialEq, Debug, Default)]
pub struct AnalyzeResult {
    pub diagnostics: Vec<EngineDiagnostic>,
    /// The checked type, when the check succeeded.
    pub type_name: Option<String>,
    /// Every call, in source order.
    pub calls: Vec<CallSite>,
    /// The string the whole expression is a literal of.
    pub string_literal: Option<String>,
    /// When the checker rejected the expression, the type of each plain chain it reads.
    pub read_types: Option<Vec<String>>,
}

/// One module-root-relative file a tag embeds.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct EngineFileClaim {
    pub path: String,
    /// The path may name a directory, which then claims every file beneath it.
    pub directory: bool,
    /// The code reporting a claim that names nothing.
    pub not_found_code: &'static str,
}

/// One CEL expression inside a tagged scalar, by UTF-16 offsets into its source.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct ExpressionRegion {
    pub start: usize,
    pub end: usize,
}

/// What `compile` turns a tagged source into.
#[derive(Debug)]
pub enum CompileOutcome {
    /// A value evaluated later against an activation.
    Compiled(CompiledValue),
    /// A value resolved whole at compile time.
    Resolved(Value),
    /// The tagged marker survives compilation, to be resolved by whoever reads it.
    Unchanged,
}

/// A per-tag engine.
pub trait TemplatingEngine: Send + Sync {
    /// The YAML tag's name, without `!`.
    fn name(&self) -> &'static str;

    /// The editor language of the tagged text, where it has one.
    fn language(&self) -> Option<&'static str> {
        None
    }

    fn compile(&self, source: &str, env: &CompileEnv<'_>) -> Result<CompileOutcome, TemplatingError>;

    fn analyze(&self, source: &str, env: &AnalyzeEnv<'_>) -> AnalyzeResult;

    /// The module-relative files the tagged node embeds; pure string work.
    #[allow(unused_variables)]
    fn file_claims(&self, source: &str) -> Vec<EngineFileClaim> {
        Vec::new()
    }

    /// The JSON Schema fragment this tag always produces, where it is a constant of the tag.
    fn produced_type(&self) -> Option<Value> {
        None
    }

    /// Where the CEL expressions sit inside the tagged scalar; none for a tag holding none,
    /// or a source the engine cannot read.
    #[allow(unused_variables)]
    fn expression_regions(&self, source: &str) -> Vec<ExpressionRegion> {
        Vec::new()
    }

    /// Whether the text, written twice in one value, means one value both times. An engine
    /// giving no verdict reads as not repeatable.
    #[allow(unused_variables)]
    fn repeatable(&self, source: &str, cel_env: &CelEnvironment) -> bool {
        false
    }
}
