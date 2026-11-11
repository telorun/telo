//! Compiling one CEL expression into a [`CompiledValue`], the one adapter a scope's module
//! functions reach evaluation through, and the repeatability verdict on a text —
//! `compile.ts`.
//!
//! **A compiled value is this crate's, not the SDK's.** Node's `CompiledValue` is the SDK's
//! interface over a closure. Here a compiled value holds an engine program and crosses the
//! controller boundary as a kernel-owned handle, so the SDK must not depend on the engine;
//! the SDK holds only the data a value evaluates to (`ParameterizedSql`).
//!
//! **A module call is dispatched through a table handed to [`CompiledValue::call`]**, never
//! read off the activation, so no source can name it. Without a table every qualified call
//! is the engine's own `unbound_function`, decided before its arguments run. A module
//! function's arguments and a compiled value's result each cross the host seam
//! (`host_value_of`), and a module function's own failure ends the evaluation and comes
//! back whole as [`CallError::Module`].
//!
//! A tag with holes (`!interpolate`, `!sql`) compiles each hole to its own program and keeps
//! them in one value: `!interpolate` joins the text with each hole converted by CEL's own
//! `string()`, `!sql` answers the parameterized record of `ParameterizedSql`.
//!
//! Node items with no twin: `CelProgramSite` and the `programSites` argument — a host
//! swapping in a program from an emitted module; the program is compiled eagerly here, so
//! an expression that does not read fails `compile`, as Node's does without program sites.
//! `MODULE_CALL_DISPATCH_KEY` and `dispatchFrom` — the table is a typed argument.

use std::any::Any;
use std::borrow::Cow;
use std::collections::HashSet;
use std::fmt;
use std::sync::{Arc, LazyLock};

use telorun_cel::{
    function_catalog, qualified_calls, root_references, walk_tree, CelActivation, CelCallContext, CelEnvironment,
    CelEvaluationError, CelExpression, CelNode, CelProgram, CelProgramError, EvaluateOptions, HostFailure,
    NamespaceImplementation, NamespaceOptions,
};
use telorun_cel_value::CelValue;
use telorun_sdk_core::host_value_of;

use telorun_cel::{type_value_name, PropertyMap};
use telorun_cel_value::cel_type_name_of;
use telorun_sdk_core::compiled_value::ParameterizedSql;

use crate::cel::interpolation_holes::InterpolationHole;
use crate::cel::literal_argument::{written_calls, WrittenArgument};
use crate::cel::module_call::{cel_namespace_names, ModuleCallDispatch};
use crate::cel::verdict_codes::{cel_verdict_error, CelErrorCode, TemplatingError};

/// Catalog functions whose result differs per call, by name.
static NON_DETERMINISTIC: LazyLock<HashSet<&'static str>> = LazyLock::new(|| {
    function_catalog().iter().filter(|entry| !entry.deterministic).map(|entry| entry.name.as_str()).collect()
});

/// Whether the expression calls a catalog function whose result differs per call, so
/// evaluating it once and reusing the value would change what it means.
fn calls_non_deterministic(root: &CelNode) -> bool {
    walk_tree(root).any(|node| match node {
        CelNode::Call(call) => NON_DETERMINISTIC.contains(call.name.as_str()),
        CelNode::ReceiverCall(call) => NON_DETERMINISTIC.contains(call.name.as_str()),
        _ => false,
    })
}

/// Whether the expression calls a method on a bare identifier (`Billing.f(x)`), which may
/// be a module's — whose determinism is its callee's, which the text does not say.
fn calls_on_bare_receiver(root: &CelNode) -> bool {
    walk_tree(root).any(|node| matches!(node, CelNode::ReceiverCall(call) if matches!(&*call.receiver, CelNode::Ident(_))))
}

/// Whether an expression's text, written twice in one value, means one value both times:
/// it reads whole, calls no catalog function whose result differs per call, and makes no
/// call that may be a module's.
pub fn repeatable_expression(expr: &str, environment: &CelEnvironment) -> bool {
    let parsed = environment.parse(expr);
    parsed.diagnostic.is_none() && !calls_non_deterministic(&parsed.root) && !calls_on_bare_receiver(&parsed.root)
}

/// The environment an expression at a site with these module names compiles against: the
/// environment itself when it already declares all of them, otherwise a clone carrying
/// them. Only the names CEL can read as a namespace are registered.
pub fn site_environment<'e>(
    environment: &'e CelEnvironment,
    module_names: Option<&HashSet<String>>,
) -> Cow<'e, CelEnvironment> {
    let namespaces = module_names.map(cel_namespace_names).unwrap_or_default();
    if namespaces.is_empty() {
        return Cow::Borrowed(environment);
    }
    let declared = environment.namespaces();
    if namespaces.iter().all(|name| declared.contains(name)) {
        return Cow::Borrowed(environment);
    }
    let mut site = environment.clone();
    for name in &namespaces {
        site.register_namespace(name, Vec::new(), NamespaceOptions::default())
            .unwrap_or_else(|refusal| panic!("the namespace {name} was filtered to a readable name: {refusal}"));
    }
    Cow::Owned(site)
}

/// Compiles one CEL expression. A call whose receiver is one of `module_names` is resolved
/// to a qualified call as the expression is read, so every later reader sees that shape.
pub fn compile_expression(
    expr: &str,
    environment: &CelEnvironment,
    module_names: Option<&HashSet<String>>,
) -> Result<CompiledValue, TemplatingError> {
    let site = site_environment(environment, module_names);
    compiled_value_of(expr, &site.parse(expr), &site)
}

/// A [`CompiledValue`] over an expression already read against its site's names.
pub fn compiled_value_of(
    expr: &str,
    parsed: &CelExpression,
    environment: &CelEnvironment,
) -> Result<CompiledValue, TemplatingError> {
    let program = environment.compile_parsed(parsed).map_err(program_refusal)?;
    Ok(CompiledValue {
        source: expr.into(),
        refs: root_references(&parsed.root),
        calls: qualified_calls(&parsed.root).into_iter().map(|call| call.qualified_name).collect(),
        call_arguments: written_calls(&parsed.root),
        volatile: calls_non_deterministic(&parsed.root),
        body: Body::Cel(program),
    })
}

/// One qualified call of a compiled expression, with how each argument is written.
#[derive(Clone, PartialEq, Debug)]
pub struct CompiledCall {
    pub qualified: String,
    pub arguments: Vec<WrittenArgument>,
}

/// What a compiled value evaluates.
enum Body {
    Cel(Arc<CelProgram>),
    /// Literal text with its holes, each converted by `conversion` (`string(value)`).
    Interpolate { fragments: Vec<String>, holes: Vec<(InterpolationHole, Arc<CelProgram>)>, conversion: Arc<CelProgram> },
    /// Literal text with its holes, whose values are bound rather than spliced.
    Sql { fragments: Vec<String>, holes: Vec<Arc<CelProgram>> },
}

/// The holes of a tag with holes, each compiled as its own expression, with the roots,
/// module calls and volatility of all of them carried together (first seen first).
pub(crate) struct CompiledHoles {
    values: Vec<CompiledValue>,
    refs: Vec<String>,
    calls: Vec<String>,
    call_arguments: Vec<CompiledCall>,
    volatile: bool,
}

impl CompiledHoles {
    pub(crate) fn new(values: Vec<CompiledValue>) -> Self {
        let mut refs: Vec<String> = Vec::new();
        let mut calls: Vec<String> = Vec::new();
        for value in &values {
            for name in &value.refs {
                if !refs.contains(name) {
                    refs.push(name.clone());
                }
            }
            for name in &value.calls {
                if !calls.contains(name) {
                    calls.push(name.clone());
                }
            }
        }
        let call_arguments = values.iter().flat_map(|value| value.call_arguments.iter().cloned()).collect();
        let volatile = values.iter().any(|value| value.volatile);
        Self { values, refs, calls, call_arguments, volatile }
    }

    fn programs(&self) -> Vec<Arc<CelProgram>> {
        self.values
            .iter()
            .map(|value| match &value.body {
                Body::Cel(program) => Arc::clone(program),
                _ => unreachable!("a hole is compiled as one expression"),
            })
            .collect()
    }
}

/// A tagged value compiled once, evaluated against an activation any number of times, on
/// any thread.
pub struct CompiledValue {
    source: Arc<str>,
    refs: Vec<String>,
    calls: Vec<String>,
    call_arguments: Vec<CompiledCall>,
    volatile: bool,
    body: Body,
}

const _: () = {
    const fn shared_across_threads<T: Send + Sync>() {}
    shared_across_threads::<CompiledValue>();
};

/// Why evaluating a compiled value answered no value: the evaluation's own failure, or a
/// module function's, handed back whole.
#[derive(Debug)]
pub enum CallError<E> {
    Templating(TemplatingError),
    Module(E),
}

impl CompiledValue {
    /// The source text it was compiled from.
    pub fn source(&self) -> &str {
        &self.source
    }

    /// The root names the expression reads: for `!cel`, sorted, each once.
    pub fn refs(&self) -> &[String] {
        &self.refs
    }

    /// The qualified module calls it makes, as written (`Billing.format`).
    pub fn calls(&self) -> &[String] {
        &self.calls
    }

    /// Each qualified call with how every argument is written.
    pub fn call_arguments(&self) -> &[CompiledCall] {
        &self.call_arguments
    }

    /// Whether it calls a catalog function whose result differs per evaluation, so it is
    /// never evaluated once and reused.
    pub fn volatile(&self) -> bool {
        self.volatile
    }

    /// `!interpolate`: the text joined with each hole converted by CEL's own `string()`.
    /// Fragments and holes are `holes + 1` and `holes` long.
    pub(crate) fn interpolated(
        source: &str,
        fragments: Vec<String>,
        holes: Vec<InterpolationHole>,
        compiled: CompiledHoles,
        environment: &CelEnvironment,
    ) -> Result<Self, TemplatingError> {
        let conversion = environment.compile("string(value)").map_err(program_refusal)?;
        let programs = compiled.programs();
        Ok(Self {
            source: source.into(),
            refs: compiled.refs,
            calls: compiled.calls,
            call_arguments: compiled.call_arguments,
            volatile: compiled.volatile,
            body: Body::Interpolate { fragments, holes: holes.into_iter().zip(programs).collect(), conversion },
        })
    }

    /// `!sql`: the literal text kept apart from each hole's bound value.
    pub(crate) fn sql(source: &str, fragments: Vec<String>, compiled: CompiledHoles) -> Self {
        let holes = compiled.programs();
        Self {
            source: source.into(),
            refs: compiled.refs,
            calls: compiled.calls,
            call_arguments: compiled.call_arguments,
            volatile: compiled.volatile,
            body: Body::Sql { fragments, holes },
        }
    }

    /// The value against `activation`, in the form a host holds it, with qualified calls
    /// dispatched through `dispatch`.
    pub fn call<E: Any + Send + Sync>(
        &self,
        activation: &dyn CelActivation,
        dispatch: Option<&ModuleCallDispatch<E>>,
    ) -> Result<CelValue, CallError<E>> {
        let bound = namespace_dispatch_of(dispatch);
        let options = EvaluateOptions {
            namespace_function: bound.as_ref().map(|bind| bind as &dyn Fn(&str, &str) -> Option<NamespaceImplementation>),
        };
        match &self.body {
            Body::Cel(program) => evaluate_program(program, activation, &options),
            Body::Interpolate { fragments, holes, conversion } => {
                let mut out = fragments[0].clone();
                for (index, (hole, program)) in holes.iter().enumerate() {
                    let value = evaluate_program(program, activation, &options)?;
                    out.push_str(&hole_text(conversion, &value, hole, &self.source)?);
                    out.push_str(&fragments[index + 1]);
                }
                Ok(CelValue::String(out.into()))
            }
            Body::Sql { fragments, holes } => {
                let values = holes
                    .iter()
                    .map(|program| evaluate_program(program, activation, &options))
                    .collect::<Result<Vec<_>, _>>()?;
                Ok(ParameterizedSql { fragments: fragments.clone(), values }.to_value())
            }
        }
    }
}

fn program_refusal(refusal: CelProgramError) -> TemplatingError {
    match refusal {
        CelProgramError::Engine(error) => TemplatingError::engine(error.code.as_str(), error.message),
        CelProgramError::Compile(error) => TemplatingError::uncoded(error.message),
    }
}

/// One program's value, in the form a host holds it.
fn evaluate_program<E: Any + Send + Sync>(
    program: &CelProgram,
    activation: &dyn CelActivation,
    options: &EvaluateOptions<'_>,
) -> Result<CelValue, CallError<E>> {
    match program.evaluate(activation, options) {
        Ok(value) => Ok(host_value_of(&value)),
        Err(CelEvaluationError::Error(error)) => {
            Err(CallError::Templating(TemplatingError::engine(error.code.as_str(), error.message)))
        }
        Err(CelEvaluationError::Host(failure)) => Err(CallError::Module(failure.downcast::<E>().unwrap_or_else(
            |_| panic!("a module function of this table failed with another table's failure type"),
        ))),
    }
}

/// A hole's value as text — CEL's `string(v)` in the compile environment, so every
/// registered overload applies (RFC 3339 for a timestamp, `5400s` for a duration, UTF-8 for
/// bytes). What `string()` refuses is refused with the hole it came from.
fn hole_text<E>(
    conversion: &CelProgram,
    value: &CelValue,
    hole: &InterpolationHole,
    source: &str,
) -> Result<String, CallError<E>> {
    if let CelValue::String(text) = value {
        return Ok(text.to_string());
    }
    let activation: PropertyMap<CelValue> = [("value", value.clone())].into_iter().collect();
    match conversion.evaluate(&activation, &EvaluateOptions::default()) {
        Ok(CelValue::String(text)) => Ok(text.to_string()),
        Ok(other) => unreachable!("string() answered {other:?}, which is not a string"),
        Err(CelEvaluationError::Error(_)) => Err(CallError::Templating(cel_verdict_error(
            CelErrorCode::ErrInterpolationHoleNotConvertible,
            format!(
                "the hole '${{{{ {} }}}}' at offset {} of !interpolate {} evaluated to {}, which CEL's string() cannot convert to text. Declare outputType on the resource producing it so the check sees its type, or guard it inside the hole.",
                hole.expr,
                hole.start,
                serde_json::to_string(source).expect("a string is JSON"),
                runtime_type_of(value),
            ),
        ))),
        Err(CelEvaluationError::Host(_)) => unreachable!("the conversion calls no module function"),
    }
}

/// The value in CEL's terms, as `type()` names it; no host type reaches the message.
///
/// Node's last branch, a value outside the CEL value domain, is reached there by any foreign
/// JavaScript value. The Rust domain is a closed union, so only a host object of no CEL type
/// can take it.
fn runtime_type_of(value: &CelValue) -> String {
    match cel_type_name_of(value) {
        None => "a value outside the CEL value domain".into(),
        Some("null_type") => "null".into(),
        Some("list") => "a list".into(),
        Some("map") => "a map".into(),
        Some(name) => format!("a value of type {}", type_value_name(name)),
    }
}

impl fmt::Debug for CompiledValue {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("CompiledValue")
            .field("source", &self.source)
            .field("refs", &self.refs)
            .field("calls", &self.calls)
            .field("volatile", &self.volatile)
            .finish_non_exhaustive()
    }
}

/// A scope's module functions as the engine's per-evaluation dispatch — the one adapter, so
/// every host binding a table converts its arguments the same way. A name the table lacks
/// answers `None`, so the call is refused where it is written, before its arguments run;
/// every argument crosses the host seam; a function's own failure ends the evaluation.
#[allow(unused_variables)]
pub fn namespace_dispatch_of<E: Any + Send + Sync>(
    table: Option<&ModuleCallDispatch<E>>,
) -> Option<impl Fn(&str, &str) -> Option<NamespaceImplementation> + '_> {
    let table = table?;
    Some(move |namespace: &str, name: &str| {
        let function = Arc::clone(table.function(namespace, name)?);
        let implementation: NamespaceImplementation = Arc::new(move |context: &CelCallContext, args: &[CelValue]| {
            let host: Vec<CelValue> = args.iter().map(host_value_of).collect();
            function(&host).map_err(HostFailure::new)
        });
        Some(implementation)
    })
}
