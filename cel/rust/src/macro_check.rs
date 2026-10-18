//! Typing the macros — the constructs written as calls that are not functions —
//! `macro-check.ts`.
//!
//! A macro binds a name or asks about the shape of its argument, so it cannot be a
//! registered signature: `xs.map(i, i + 1)` has no argument type for `i`, and `has(a.b)` is
//! about whether `b` is there. The tree keeps each one an ordinary call node, so this is
//! where the comprehension appears — in the checker's own lowering, which is also why a
//! macro is not a dispatched call in the call listing. Which arguments a macro binds a name
//! over is the one table in `comprehension_bindings.rs`.
//!
//! Each macro is a sequence of steps the checker drives, so typing a macro body costs no
//! stack: a step asks for the type of a subexpression — in the scope that holds, with one
//! more name bound, or read as a question about presence — and the macro resumes with it.
//! The order of every question and every report is Node's.
//!
//! Everything here is private to the crate, as on Node's entry.
//!
//! Declared differently from the Node file:
//! - `MacroHost` reports only; the three typing questions are [`MacroStep`]s.
//! - The namespaces a macro is written on are `cel` and `optional`, read as names. Node
//!   reads them as keys of a plain object, so a receiver named `constructor`, `toString`
//!   or another key of the object prototype is taken for one there.

use crate::cel_type::{format_type, is_dyn, list_of, optional_of, parameter_of, CelType, PrimitiveName, BOOL, DYN, STRING};
use crate::check_diagnostic::CelCheckCode;
use crate::comprehension_bindings::{namespace_macro_binding, receiver_macro_binding, ComprehensionBinding};
use crate::syntax_tree::{CelNode, CelReceiverCallNode, CelSelectNode, SourceRange};

/// What a macro needs of the checker around it, beyond the types it asks for.
pub(crate) trait MacroHost {
    fn report(&mut self, code: CelCheckCode, message: String, range: SourceRange);
}

/// What a macro asks next, or its answer.
pub(crate) enum MacroStep<'a> {
    Done(CelType),
    /// The type of a subexpression in the scope that holds.
    TypeOf(&'a CelNode, MacroFrame<'a>),
    /// The type of a subexpression with one more name in scope.
    TypeOfBinding(&'a CelNode, &'a str, CelType, MacroFrame<'a>),
    /// The type of a select read as a question about presence: `has()`'s argument, read as
    /// `.?b` is.
    TypeOfPresence(&'a CelSelectNode, MacroFrame<'a>),
}

/// Where a macro resumes once its question is answered.
pub(crate) struct MacroFrame<'a> {
    state: MacroState<'a>,
}

enum MacroState<'a> {
    /// `has(a.b)`, its argument read.
    Has,
    /// `cel.bind(name, value, body)`, its value typed.
    BindValue { call: &'a CelReceiverCallNode, name: &'a str },
    /// `cel.bind`, its body typed.
    BindBody,
    /// `optional.of(v)` / `optional.ofNonZeroValue(v)`, its value typed.
    OptionalOf,
    /// `opt.optMap(v, e)` / `opt.optFlatMap(v, e)`, its receiver typed.
    OptionalReceiver { call: &'a CelReceiverCallNode },
    /// The same, its expression typed.
    OptionalBody { call: &'a CelReceiverCallNode },
    /// A comprehension, its receiver typed.
    ComprehensionReceiver { call: &'a CelReceiverCallNode, binding: ComprehensionBinding },
    /// A comprehension, `types` of its scoped arguments typed so far.
    ComprehensionScoped {
        call: &'a CelReceiverCallNode,
        binding: ComprehensionBinding,
        name: &'a str,
        element: CelType,
        types: Vec<CelType>,
    },
}

fn frame(state: MacroState<'_>) -> MacroFrame<'_> {
    MacroFrame { state }
}

/// The macros written on each reserved namespace.
fn namespace_macros(namespace: &str) -> Option<&'static [&'static str]> {
    match namespace {
        "cel" => Some(&["bind"]),
        "optional" => Some(&["of", "none", "ofNonZeroValue"]),
        _ => None,
    }
}

/// The optional library's two name-binding members, which no signature can state.
fn is_optional_binding_macro(name: &str) -> bool {
    name == "optMap" || name == "optFlatMap"
}

fn receiver_name(call: &CelReceiverCallNode) -> Option<&str> {
    match &*call.receiver {
        CelNode::Ident(ident) => Some(&ident.name),
        _ => None,
    }
}

/// Whether a call is a macro at all — asked before any overload is looked for.
pub(crate) fn is_macro_call(node: &CelNode) -> bool {
    match node {
        CelNode::Call(call) => call.name == "has" && call.args.len() == 1,
        CelNode::ReceiverCall(call) => {
            receiver_macro_binding(&call.name, call.args.len()).is_some()
                || receiver_name(call)
                    .and_then(namespace_macros)
                    .is_some_and(|names| names.contains(&call.name.as_str()))
        }
        _ => false,
    }
}

/// The first step of a macro call that [`is_macro_call`] has accepted. Anything this cannot
/// type reports its own diagnostic and answers `dyn`, so one mistake stays one.
pub(crate) fn start_macro<'a>(node: &'a CelNode, host: &mut dyn MacroHost) -> MacroStep<'a> {
    match node {
        CelNode::Call(call) => match &*call.args[0] {
            // Its shape is already judged: only a select is read.
            CelNode::Select(argument) => MacroStep::TypeOfPresence(argument, frame(MacroState::Has)),
            _ => MacroStep::Done(BOOL),
        },
        CelNode::ReceiverCall(call) => match receiver_name(call).filter(|name| namespace_macros(name).is_some()) {
            Some("cel") => start_bind(call, host),
            Some(_) => start_optional_namespace(call, host),
            None if is_optional_binding_macro(&call.name) && call.args.len() == 2 => {
                MacroStep::TypeOf(&call.receiver, frame(MacroState::OptionalReceiver { call }))
            }
            None => {
                let binding = receiver_macro_binding(&call.name, call.args.len())
                    .expect("a receiver macro is one of the table's forms");
                MacroStep::TypeOf(&call.receiver, frame(MacroState::ComprehensionReceiver { call, binding }))
            }
        },
        _ => MacroStep::Done(DYN),
    }
}

/// The next step of a macro, given the type its last question asked for.
pub(crate) fn resume_macro<'a>(at: MacroFrame<'a>, ty: CelType, host: &mut dyn MacroHost) -> MacroStep<'a> {
    match at.state {
        MacroState::Has => MacroStep::Done(BOOL),
        MacroState::BindValue { call, name } => {
            MacroStep::TypeOfBinding(&call.args[2], name, ty, frame(MacroState::BindBody))
        }
        MacroState::BindBody => MacroStep::Done(ty),
        MacroState::OptionalOf => MacroStep::Done(optional_of(ty)),
        MacroState::OptionalReceiver { call } => {
            let CelNode::Ident(name) = &*call.args[0] else { return MacroStep::Done(DYN) };
            let held = match &ty {
                CelType::Optional(optional) => (*optional.value).clone(),
                receiver => {
                    if !is_dyn(receiver) && !matches!(receiver, CelType::Parameter(_)) {
                        host.report(
                            CelCheckCode::TypeError,
                            format!("{} reads an optional, and {} is not one", call.name, format_type(receiver, false)),
                            call.receiver.range(),
                        );
                    }
                    DYN
                }
            };
            MacroStep::TypeOfBinding(&call.args[1], &name.name, held, frame(MacroState::OptionalBody { call }))
        }
        MacroState::OptionalBody { call } => {
            if call.name == "optMap" {
                return MacroStep::Done(optional_of(ty));
            }
            if matches!(ty, CelType::Optional(_) | CelType::Dyn | CelType::Parameter(_)) {
                return MacroStep::Done(ty);
            }
            host.report(
                CelCheckCode::TypeError,
                format!("optFlatMap's expression must answer an optional, and it answers {}", format_type(&ty, false)),
                call.args[1].range(),
            );
            MacroStep::Done(optional_of(DYN))
        }
        MacroState::ComprehensionReceiver { call, binding } => {
            let element = iteration_type(&ty, call, host);
            let CelNode::Ident(name) = &*call.args[binding.variable_argument] else { return MacroStep::Done(DYN) };
            next_scoped(call, binding, &name.name, element, Vec::new(), host)
        }
        MacroState::ComprehensionScoped { call, binding, name, element, mut types } => {
            types.push(ty);
            next_scoped(call, binding, name, element, types, host)
        }
    }
}

/// `cel.bind(name, value, body)` — a name for one value, in scope in the body alone.
fn start_bind<'a>(call: &'a CelReceiverCallNode, host: &mut dyn MacroHost) -> MacroStep<'a> {
    let Some(binding) = namespace_macro_binding("cel", &call.name, call.args.len()) else {
        host.report(
            CelCheckCode::InvalidArgument,
            "cel.bind(name, value, body) takes three arguments: a name, its value, and the expression that reads it"
                .into(),
            call.range,
        );
        return MacroStep::Done(DYN);
    };
    let CelNode::Ident(name) = &*call.args[binding.variable_argument] else { return MacroStep::Done(DYN) };
    MacroStep::TypeOf(&call.args[1], frame(MacroState::BindValue { call, name: &name.name }))
}

/// `optional.of(v)`, `optional.ofNonZeroValue(v)` and `optional.none()`.
fn start_optional_namespace<'a>(call: &'a CelReceiverCallNode, host: &mut dyn MacroHost) -> MacroStep<'a> {
    if call.name == "none" {
        if !call.args.is_empty() {
            host.report(CelCheckCode::InvalidArgument, "optional.none() takes no argument".into(), call.range);
        }
        return MacroStep::Done(optional_of(parameter_of("T")));
    }
    if call.args.len() != 1 {
        host.report(
            CelCheckCode::InvalidArgument,
            format!("optional.{}(value) takes one argument", call.name),
            call.range,
        );
        return MacroStep::Done(optional_of(DYN));
    }
    MacroStep::TypeOf(&call.args[0], frame(MacroState::OptionalOf))
}

/// The next scoped argument of a comprehension, or its answer once every one is typed.
fn next_scoped<'a>(
    call: &'a CelReceiverCallNode,
    binding: ComprehensionBinding,
    name: &'a str,
    element: CelType,
    types: Vec<CelType>,
    host: &mut dyn MacroHost,
) -> MacroStep<'a> {
    if let Some(at) = binding.scoped_arguments.get(types.len()) {
        let bound = element.clone();
        return MacroStep::TypeOfBinding(
            &call.args[*at],
            name,
            bound,
            frame(MacroState::ComprehensionScoped { call, binding, name, element, types }),
        );
    }
    let scoped = |at: usize| (&*call.args[binding.scoped_arguments[at]], &types[at]);
    match call.name.as_str() {
        "all" | "exists" | "exists_one" => {
            require_bool(scoped(0), &call.name, host);
            MacroStep::Done(BOOL)
        }
        "filter" => {
            require_bool(scoped(0), &call.name, host);
            MacroStep::Done(list_of(element))
        }
        // `map` in both arities: the last scoped argument is the transform, and a third
        // argument makes the one before it a filter.
        _ => {
            if types.len() == 2 {
                require_bool(scoped(0), &call.name, host);
            }
            MacroStep::Done(list_of(types.last().expect("a comprehension types its body").clone()))
        }
    }
}

fn require_bool((node, ty): (&CelNode, &CelType), name: &str, host: &mut dyn MacroHost) {
    if matches!(ty, CelType::Dyn | CelType::Parameter(_) | CelType::Primitive(PrimitiveName::Bool)) {
        return;
    }
    host.report(
        CelCheckCode::TypeError,
        format!("{name}'s test must be bool, and it is {}", format_type(ty, false)),
        node.range(),
    );
}

/// What one element of a comprehension's receiver is: a list's element, a map's key.
fn iteration_type(receiver: &CelType, call: &CelReceiverCallNode, host: &mut dyn MacroHost) -> CelType {
    match receiver {
        CelType::Dyn | CelType::Parameter(_) => DYN,
        CelType::List(list) => (*list.element).clone(),
        CelType::Map(map) => (*map.key).clone(),
        CelType::Record(_) => STRING,
        _ => {
            host.report(
                CelCheckCode::TypeError,
                format!("a comprehension reads a list or a map, and {} is neither", format_type(receiver, false)),
                call.receiver.range(),
            );
            DYN
        }
    }
}
