//! A tree compiled to a program, and the program run — `closure-backend.ts`.
//!
//! **The program is a flat list of instructions, not closures.** Node composes a tree
//! into nested closures; composed here they would recurse with the tree's depth twice,
//! once to build and once to run, and a stack overflow aborts a Rust process. So
//! compiling is a heap walk over the tree that writes instructions with explicit jumps,
//! and evaluating is one loop over an operand stack, the binding slots, a stack of
//! comprehension frames and a stack of namespaced functions bound for a call. A nested
//! comprehension is a frame, never a call.
//!
//! Everything an expression's shape decides is decided once, at compile time, as Node
//! decides it: which name is a bound slot, which select is a dotted read — split over the
//! names the host declared, or searched in the activation — and which call is a macro.
//! Semantics are not here: every operator and function is the runtime library's, every
//! comprehension's meaning `comprehension_runtime.rs`'s, every member read, name read and
//! call-site dispatch `backend_runtime.rs`'s.
//!
//! **Errors are operands, in Node's exact orders.** A call's arguments are evaluated left
//! to right and the first error ends the call; list elements, and map keys then values,
//! in order, the first error winning; `&&` and `||` evaluate the left, skip the right
//! when the left decides, and otherwise answer the decided value, else the left error,
//! else the right; `?:` answers an erroring condition and evaluates only the chosen
//! branch; a namespaced function is looked up before any of its arguments is evaluated.
//!
//! A compile refusal is a [`CelCompileError`] with Node's text, raised at the first node
//! Node's compiler refuses, in its order.
//!
//! Node items with no twin in this file:
//! - `compileTree` and `CompiledTree` — a program is reached only through the
//!   environment; the compiled form is crate-private.
//! - The thenable refusal of a `cel.bind` value and of an optional's held value — no Rust
//!   value can be awaited.

use std::collections::HashMap;

use telorun_cel_value::{
    cel_error, cel_map_from_entries, cel_none, cel_some, json_quote, CelEvaluationCode, CelList, CelValue, SourceRange,
};

use crate::activation::CelActivation;
use crate::backend_runtime::{
    bool_operand, compile_error, has_member, optional_entry, read_name, read_name_chain, read_through,
    search_name_chain, CallSite, CelCompileError, DeclaredNameChain, EnvironmentSnapshot, SearchedNameChain,
};
use crate::cel_value::literal_value;
use crate::comprehension_bindings::{namespace_macro_binding, receiver_macro_binding};
use crate::comprehension_runtime::{filter_verdict, ComprehensionFold, ComprehensionMacro};
use crate::declared_chain::split_declared_chain;
use crate::macro_check::is_macro_call;
use crate::member_read::cel_iterable;
use crate::runtime_library::{optional_of_non_zero, CelCallContext, CelImplementation};
use crate::signature::CallForm;
use crate::syntax_tree::{CelBinaryOperator, CelNode, CelReceiverCallNode, CelSelectNode};

/// What a namespaced call is dispatched through for one evaluation.
pub(crate) type NamespaceDispatch<'a> = &'a dyn Fn(&str, &str) -> Option<CelImplementation>;

/// One step of a program. A `target` is the index of the instruction to go on at.
enum Instruction {
    Constant(CelValue),
    /// A name a macro bound.
    Slot(usize),
    Name { name: Box<str>, range: SourceRange },
    DeclaredChain { chain: usize, range: SourceRange },
    SearchedChain { chain: usize, range: SourceRange },
    /// An error on top ends the node: it replaces the `discard` operands beneath it.
    JumpIfError { target: usize, discard: usize },
    Jump { target: usize },
    Read { key: CelValue, optional: bool, range: SourceRange },
    ReadIndex { optional: bool, range: SourceRange },
    Has { field: CelValue, range: SourceRange },
    OptionalEntry { range: SourceRange },
    /// `optional` indexes the aggregate's table of which elements were written `[?x]`.
    MakeList { count: usize, optional: Option<usize> },
    MakeMap { count: usize, optional: Option<usize>, range: SourceRange },
    BoolOperand { range: SourceRange },
    /// Leaves a bool equal to `decided` on top and goes on at `target`.
    ShortCircuit { decided: bool, target: usize },
    Logic { decided: bool },
    BranchFalse { target: usize },
    Call { site: usize, count: usize },
    BindNamespace { namespace: Box<str>, name: Box<str>, range: SourceRange, target: usize },
    CallBound { count: usize, range: SourceRange },
    DropBound,
    Store { slot: usize },
    OptionalOf { non_zero: bool },
    OptionalBind { name: Box<str>, slot: usize, range: SourceRange, target: usize },
    OptionalAnswer { wrap: bool, range: SourceRange },
    ComprehensionStart { comprehension: ComprehensionMacro, range: SourceRange, target: usize },
    ComprehensionNext { slot: usize, target: usize },
    ComprehensionTest { range: SourceRange, target: usize },
    ComprehensionFilter { range: SourceRange, skip: usize, target: usize },
    ComprehensionTransform { target: usize },
    ComprehensionEnd,
}

impl Instruction {
    /// Every jump target, for the pass that turns labels into instruction indexes.
    fn targets(&mut self) -> Vec<&mut usize> {
        match self {
            Self::JumpIfError { target, .. }
            | Self::Jump { target }
            | Self::ShortCircuit { target, .. }
            | Self::BranchFalse { target }
            | Self::BindNamespace { target, .. }
            | Self::OptionalBind { target, .. }
            | Self::ComprehensionStart { target, .. }
            | Self::ComprehensionNext { target, .. }
            | Self::ComprehensionTest { target, .. }
            | Self::ComprehensionTransform { target } => vec![target],
            Self::ComprehensionFilter { skip, target, .. } => vec![skip, target],
            _ => Vec::new(),
        }
    }
}

/// A tree compiled: its instructions and what they index.
pub(crate) struct CompiledTree {
    instructions: Box<[Instruction]>,
    sites: Box<[CallSite]>,
    declared: Box<[DeclaredNameChain]>,
    searched: Box<[SearchedNameChain]>,
    optional_entries: Box<[Box<[bool]>]>,
    slots: usize,
}

// --- compiling ---------------------------------------------------------------

enum Task<'a> {
    /// A node to compile. `not_plain` counts the selects from it down a member chain
    /// already known to read no dotted name, so a chain is examined once.
    Visit(&'a CelNode, usize),
    Emit(Instruction),
    Place(usize),
    Bind(&'a str, usize),
    Unbind(&'a str),
}

/// What a select's member chain is: a dotted name rooted at a free name, or how many of
/// its selects, from the outermost, read no such name.
enum ChainShape<'a> {
    Plain(Vec<&'a str>),
    NotPlain(usize),
}

struct Compiler<'a, 'd> {
    code: Vec<Instruction>,
    labels: Vec<usize>,
    sites: Vec<CallSite>,
    declared: Vec<DeclaredNameChain>,
    searched: Vec<SearchedNameChain>,
    optional_entries: Vec<Box<[bool]>>,
    slots: usize,
    /// Each name bound in scope, the innermost binding last.
    scopes: HashMap<&'a str, Vec<usize>>,
    declares: &'d dyn Fn(&str) -> bool,
}

/// Compiles a tree. `declares` answers whether the host declared a name, dotted or not:
/// a dotted chain splits at the longest declared prefix, as the checker splits it.
pub(crate) fn compile_tree(root: &CelNode, declares: &dyn Fn(&str) -> bool) -> Result<CompiledTree, CelCompileError> {
    let mut compiler = Compiler {
        code: Vec::new(),
        labels: Vec::new(),
        sites: Vec::new(),
        declared: Vec::new(),
        searched: Vec::new(),
        optional_entries: Vec::new(),
        slots: 0,
        scopes: HashMap::new(),
        declares,
    };
    let mut tasks = vec![Task::Visit(root, 0)];
    while let Some(task) = tasks.pop() {
        match task {
            Task::Visit(node, not_plain) => {
                let expanded = compiler.visit(node, not_plain)?;
                tasks.extend(expanded.into_iter().rev());
            }
            Task::Emit(instruction) => compiler.code.push(instruction),
            Task::Place(label) => compiler.labels[label] = compiler.code.len(),
            Task::Bind(name, slot) => compiler.scopes.entry(name).or_default().push(slot),
            Task::Unbind(name) => {
                compiler.scopes.get_mut(name).and_then(Vec::pop).expect("a binding leaves the scope it entered");
            }
        }
    }
    let Compiler { mut code, labels, sites, declared, searched, optional_entries, slots, .. } = compiler;
    for instruction in &mut code {
        for target in instruction.targets() {
            *target = labels[*target];
        }
    }
    Ok(CompiledTree {
        instructions: code.into(),
        sites: sites.into(),
        declared: declared.into(),
        searched: searched.into(),
        optional_entries: optional_entries.into(),
        slots,
    })
}

impl<'a> Compiler<'a, '_> {
    fn label(&mut self) -> usize {
        self.labels.push(usize::MAX);
        self.labels.len() - 1
    }

    fn slot(&mut self) -> usize {
        self.slots += 1;
        self.slots - 1
    }

    fn bound(&self, name: &str) -> Option<usize> {
        self.scopes.get(name).and_then(|slots| slots.last().copied())
    }

    /// The tasks one node compiles to, in order.
    fn visit(&mut self, node: &'a CelNode, not_plain: usize) -> Result<Vec<Task<'a>>, CelCompileError> {
        Ok(match node {
            CelNode::Literal(node) => vec![Task::Emit(Instruction::Constant(literal_value(&node.literal)))],
            CelNode::Ident(node) => match (node.absolute, self.bound(&node.name)) {
                (false, Some(slot)) => vec![Task::Emit(Instruction::Slot(slot))],
                _ => vec![Task::Emit(Instruction::Name { name: node.name.as_str().into(), range: node.range })],
            },
            CelNode::List(node) => {
                let end = self.label();
                let mut tasks = Vec::new();
                for (at, element) in node.elements.iter().enumerate() {
                    tasks.push(Task::Visit(&element.value, 0));
                    tasks.push(Task::Emit(Instruction::JumpIfError { target: end, discard: at }));
                    if element.optional {
                        tasks.push(Task::Emit(Instruction::OptionalEntry { range: node.range }));
                        tasks.push(Task::Emit(Instruction::JumpIfError { target: end, discard: at }));
                    }
                }
                let flags: Vec<bool> = node.elements.iter().map(|element| element.optional).collect();
                let optional = self.optional_entries(flags);
                tasks.push(Task::Emit(Instruction::MakeList { count: node.elements.len(), optional }));
                tasks.push(Task::Place(end));
                tasks
            }
            CelNode::Map(node) => {
                let end = self.label();
                let mut tasks = Vec::new();
                for (at, entry) in node.entries.iter().enumerate() {
                    tasks.push(Task::Visit(&entry.key, 0));
                    tasks.push(Task::Emit(Instruction::JumpIfError { target: end, discard: 2 * at }));
                    tasks.push(Task::Visit(&entry.value, 0));
                    tasks.push(Task::Emit(Instruction::JumpIfError { target: end, discard: 2 * at + 1 }));
                    if entry.optional {
                        tasks.push(Task::Emit(Instruction::OptionalEntry { range: node.range }));
                        tasks.push(Task::Emit(Instruction::JumpIfError { target: end, discard: 2 * at + 1 }));
                    }
                }
                let flags: Vec<bool> = node.entries.iter().map(|entry| entry.optional).collect();
                let optional = self.optional_entries(flags);
                tasks.push(Task::Emit(Instruction::MakeMap { count: node.entries.len(), optional, range: node.range }));
                tasks.push(Task::Place(end));
                tasks
            }
            CelNode::Select(node) => self.select(node, not_plain),
            CelNode::Index(node) => {
                let end = self.label();
                vec![
                    Task::Visit(&node.operand, 0),
                    Task::Emit(Instruction::JumpIfError { target: end, discard: 0 }),
                    Task::Visit(&node.index, 0),
                    Task::Emit(Instruction::JumpIfError { target: end, discard: 1 }),
                    Task::Emit(Instruction::ReadIndex { optional: node.optional, range: node.range }),
                    Task::Place(end),
                ]
            }
            CelNode::Unary(node) => {
                self.call(node.operator.as_str(), CallForm::Global, vec![&*node.operand], node.range)
            }
            CelNode::Binary(node) => match node.operator {
                CelBinaryOperator::And | CelBinaryOperator::Or => {
                    let decided = node.operator == CelBinaryOperator::Or;
                    let end = self.label();
                    vec![
                        Task::Visit(&node.left, 0),
                        Task::Emit(Instruction::BoolOperand { range: node.range }),
                        Task::Emit(Instruction::ShortCircuit { decided, target: end }),
                        Task::Visit(&node.right, 0),
                        Task::Emit(Instruction::BoolOperand { range: node.range }),
                        Task::Emit(Instruction::Logic { decided }),
                        Task::Place(end),
                    ]
                }
                operator => self.call(operator.as_str(), CallForm::Global, vec![&*node.left, &*node.right], node.range),
            },
            CelNode::Conditional(node) => {
                let otherwise = self.label();
                let end = self.label();
                vec![
                    Task::Visit(&node.condition, 0),
                    Task::Emit(Instruction::BoolOperand { range: node.range }),
                    Task::Emit(Instruction::JumpIfError { target: end, discard: 0 }),
                    Task::Emit(Instruction::BranchFalse { target: otherwise }),
                    Task::Visit(&node.when_true, 0),
                    Task::Emit(Instruction::Jump { target: end }),
                    Task::Place(otherwise),
                    Task::Visit(&node.when_false, 0),
                    Task::Place(end),
                ]
            }
            CelNode::Call(call) => {
                // A macro is not a function, and it is recognised before any overload is
                // looked for — the checker's question, in the same place.
                if is_macro_call(node) {
                    return self.has(node);
                }
                self.call(&call.name, CallForm::Global, call.args.iter().map(|arg| &**arg).collect(), call.range)
            }
            CelNode::ReceiverCall(call) => {
                if is_macro_call(node) {
                    return self.receiver_macro(call);
                }
                let mut args: Vec<&'a CelNode> = vec![&*call.receiver];
                args.extend(call.args.iter().map(|arg| &**arg));
                self.call(&call.name, CallForm::Receiver, args, call.range)
            }
            CelNode::QualifiedCall(call) => {
                let failed = self.label();
                let end = self.label();
                let mut tasks = vec![Task::Emit(Instruction::BindNamespace {
                    namespace: call.namespace.as_str().into(),
                    name: call.name.as_str().into(),
                    range: call.range,
                    target: end,
                })];
                for (at, argument) in call.args.iter().enumerate() {
                    tasks.push(Task::Visit(argument, 0));
                    tasks.push(Task::Emit(Instruction::JumpIfError { target: failed, discard: at }));
                }
                tasks.extend([
                    Task::Emit(Instruction::CallBound { count: call.args.len(), range: call.range }),
                    Task::Emit(Instruction::Jump { target: end }),
                    Task::Place(failed),
                    Task::Emit(Instruction::DropBound),
                    Task::Place(end),
                ]);
                tasks
            }
            CelNode::Unparsed(_) => {
                return Err(compile_error("the expression could not be read whole, so it cannot be compiled"));
            }
        })
    }

    fn optional_entries(&mut self, flags: Vec<bool>) -> Option<usize> {
        if !flags.contains(&true) {
            return None;
        }
        self.optional_entries.push(flags.into());
        Some(self.optional_entries.len() - 1)
    }

    /// One dispatch: the arguments in order, the first error carried out, then the site.
    fn call(&mut self, name: &str, form: CallForm, args: Vec<&'a CelNode>, range: SourceRange) -> Vec<Task<'a>> {
        self.sites.push(CallSite::new(name, form, range));
        let site = self.sites.len() - 1;
        let end = self.label();
        let mut tasks = Vec::new();
        for (at, argument) in args.iter().enumerate() {
            tasks.push(Task::Visit(argument, 0));
            tasks.push(Task::Emit(Instruction::JumpIfError { target: end, discard: at }));
        }
        tasks.push(Task::Emit(Instruction::Call { site, count: args.len() }));
        tasks.push(Task::Place(end));
        tasks
    }

    /// A select: one read of a dotted name where the chain is plain members of a free
    /// name, otherwise a member read of its operand.
    fn select(&mut self, node: &'a CelSelectNode, not_plain: usize) -> Vec<Task<'a>> {
        let below = match not_plain {
            0 => match self.chain_shape(node) {
                ChainShape::Plain(segments) => return vec![self.name_chain(&segments, node.range)],
                ChainShape::NotPlain(levels) => levels - 1,
            },
            known => known - 1,
        };
        let end = self.label();
        vec![
            Task::Visit(&node.operand, below),
            Task::Emit(Instruction::JumpIfError { target: end, discard: 0 }),
            Task::Emit(Instruction::Read {
                key: CelValue::String(node.field.as_str().into()),
                optional: node.optional,
                range: node.range,
            }),
            Task::Place(end),
        ]
    }

    fn chain_shape(&self, node: &'a CelSelectNode) -> ChainShape<'a> {
        let mut segments: Vec<&'a str> = Vec::new();
        let mut deepest_unplain: Option<usize> = None;
        let mut at = node;
        let root = loop {
            if at.optional || at.field.is_empty() {
                deepest_unplain = Some(segments.len());
            }
            segments.push(&at.field);
            match &*at.operand {
                CelNode::Select(inner) => at = inner,
                CelNode::Ident(ident) => break Some(ident),
                _ => break None,
            }
        };
        let free_root = root.filter(|ident| ident.absolute || self.bound(&ident.name).is_none());
        match (free_root, deepest_unplain) {
            (Some(ident), None) => {
                segments.push(&ident.name);
                segments.reverse();
                ChainShape::Plain(segments)
            }
            (Some(_), Some(deepest)) => ChainShape::NotPlain(deepest + 1),
            (None, _) => ChainShape::NotPlain(segments.len()),
        }
    }

    /// A dotted name: split at compile time over the declared names, or searched in the
    /// activation where nothing declares a prefix of it.
    fn name_chain(&mut self, segments: &[&str], range: SourceRange) -> Task<'a> {
        if let Some(split) = split_declared_chain(segments, self.declares) {
            self.declared.push(DeclaredNameChain {
                name: split.name.into(),
                rest: split.rest.into_iter().map(|field| CelValue::String(field.into())).collect(),
            });
            return Task::Emit(Instruction::DeclaredChain { chain: self.declared.len() - 1, range });
        }
        let mut written = String::new();
        let mut ends = Vec::with_capacity(segments.len());
        for (at, segment) in segments.iter().enumerate() {
            if at > 0 {
                written.push('.');
            }
            written.push_str(segment);
            ends.push(written.len());
        }
        self.searched.push(SearchedNameChain {
            written: written.into(),
            ends: ends.into(),
            segments: segments.iter().map(|segment| CelValue::String((*segment).into())).collect(),
        });
        Task::Emit(Instruction::SearchedChain { chain: self.searched.len() - 1, range })
    }

    /// `has(a.b)` — presence, which a missing key answers `false` rather than erroring.
    fn has(&mut self, node: &'a CelNode) -> Result<Vec<Task<'a>>, CelCompileError> {
        let CelNode::Call(call) = node else { unreachable!("has() is a global call") };
        let CelNode::Select(argument) = &*call.args[0] else {
            return Err(compile_error("has() asks about a member, so its argument ends in a select"));
        };
        let end = self.label();
        Ok(vec![
            Task::Visit(&argument.operand, 0),
            Task::Emit(Instruction::JumpIfError { target: end, discard: 0 }),
            Task::Emit(Instruction::Has { field: CelValue::String(argument.field.as_str().into()), range: call.range }),
            Task::Place(end),
        ])
    }

    fn receiver_macro(&mut self, call: &'a CelReceiverCallNode) -> Result<Vec<Task<'a>>, CelCompileError> {
        let receiver = match &*call.receiver {
            CelNode::Ident(ident) => Some(ident.name.as_str()),
            _ => None,
        };
        if receiver == Some("cel") && call.name == "bind" {
            return self.bind(call);
        }
        if receiver == Some("optional") {
            return self.optional_namespace(call);
        }
        if (call.name == "optMap" || call.name == "optFlatMap") && call.args.len() == 2 {
            return self.optional_binding(call);
        }
        self.comprehension(call)
    }

    /// `cel.bind(name, value, body)`: the value bound once, then the body.
    fn bind(&mut self, call: &'a CelReceiverCallNode) -> Result<Vec<Task<'a>>, CelCompileError> {
        let Some(binding) = namespace_macro_binding("cel", &call.name, call.args.len()) else {
            return Err(compile_error("cel.bind(name, value, body) takes a name, its value and a body"));
        };
        let CelNode::Ident(name) = &*call.args[binding.variable_argument] else {
            return Err(compile_error("cel.bind binds a name"));
        };
        let slot = self.slot();
        let end = self.label();
        Ok(vec![
            Task::Visit(&call.args[1], 0),
            Task::Emit(Instruction::JumpIfError { target: end, discard: 0 }),
            Task::Emit(Instruction::Store { slot }),
            Task::Bind(&name.name, slot),
            Task::Visit(&call.args[2], 0),
            Task::Unbind(&name.name),
            Task::Place(end),
        ])
    }

    /// `optional.of(v)`, `optional.ofNonZeroValue(v)` and `optional.none()`, which reads
    /// none of its arguments.
    fn optional_namespace(&mut self, call: &'a CelReceiverCallNode) -> Result<Vec<Task<'a>>, CelCompileError> {
        if call.name == "none" {
            return Ok(vec![Task::Emit(Instruction::Constant(CelValue::Optional(cel_none())))]);
        }
        if call.args.len() != 1 {
            return Err(compile_error(format!("optional.{}(value) takes one argument", call.name)));
        }
        let end = self.label();
        Ok(vec![
            Task::Visit(&call.args[0], 0),
            Task::Emit(Instruction::JumpIfError { target: end, discard: 0 }),
            Task::Emit(Instruction::OptionalOf { non_zero: call.name == "ofNonZeroValue" }),
            Task::Place(end),
        ])
    }

    /// `opt.optMap(v, body)` wraps what the body answers; `optFlatMap` does not.
    fn optional_binding(&mut self, call: &'a CelReceiverCallNode) -> Result<Vec<Task<'a>>, CelCompileError> {
        let CelNode::Ident(name) = &*call.args[0] else {
            return Err(compile_error(format!("{} binds a name", call.name)));
        };
        let slot = self.slot();
        let end = self.label();
        Ok(vec![
            Task::Visit(&call.receiver, 0),
            Task::Emit(Instruction::JumpIfError { target: end, discard: 0 }),
            Task::Emit(Instruction::OptionalBind { name: call.name.as_str().into(), slot, range: call.range, target: end }),
            Task::Bind(&name.name, slot),
            Task::Visit(&call.args[1], 0),
            Task::Unbind(&name.name),
            Task::Emit(Instruction::OptionalAnswer { wrap: call.name == "optMap", range: call.range }),
            Task::Place(end),
        ])
    }

    /// A comprehension: the receiver's elements, each bound in turn, folded by the macro's
    /// meaning until it is decided or the elements run out.
    fn comprehension(&mut self, call: &'a CelReceiverCallNode) -> Result<Vec<Task<'a>>, CelCompileError> {
        let Some(binding) = receiver_macro_binding(&call.name, call.args.len()) else {
            return Err(compile_error(format!("{} is not a comprehension", call.name)));
        };
        let CelNode::Ident(name) = &*call.args[binding.variable_argument] else {
            return Err(compile_error(format!("{} binds a name", call.name)));
        };
        let comprehension = match call.name.as_str() {
            "all" => ComprehensionMacro::All,
            "exists" => ComprehensionMacro::Exists,
            "exists_one" => ComprehensionMacro::ExistsOne,
            "filter" => ComprehensionMacro::Filter,
            _ => ComprehensionMacro::Map,
        };
        let slot = self.slot();
        let end = self.label();
        let head = self.label();
        let done = self.label();
        let range = call.range;
        let scoped: Vec<&'a CelNode> = binding.scoped_arguments.iter().map(|at| &*call.args[*at]).collect();
        let mut tasks = vec![
            Task::Visit(&call.receiver, 0),
            Task::Emit(Instruction::JumpIfError { target: end, discard: 0 }),
            Task::Emit(Instruction::ComprehensionStart { comprehension, range, target: end }),
            Task::Bind(&name.name, slot),
            Task::Place(head),
            Task::Emit(Instruction::ComprehensionNext { slot, target: done }),
        ];
        match (comprehension, scoped.as_slice()) {
            (ComprehensionMacro::Map, [filter, transform]) => tasks.extend([
                Task::Visit(filter, 0),
                Task::Emit(Instruction::ComprehensionFilter { range, skip: head, target: done }),
                Task::Visit(transform, 0),
                Task::Emit(Instruction::ComprehensionTransform { target: done }),
            ]),
            (ComprehensionMacro::Map, [transform]) => tasks.extend([
                Task::Visit(transform, 0),
                Task::Emit(Instruction::ComprehensionTransform { target: done }),
            ]),
            (_, [test]) => tasks.extend([
                Task::Visit(test, 0),
                Task::Emit(Instruction::ComprehensionTest { range, target: done }),
            ]),
            _ => unreachable!("the binding table gives a map one or two bodies and every other macro one"),
        }
        tasks.extend([
            Task::Emit(Instruction::Jump { target: head }),
            Task::Unbind(&name.name),
            Task::Place(done),
            Task::Emit(Instruction::ComprehensionEnd),
            Task::Place(end),
        ]);
        Ok(tasks)
    }
}

// --- evaluating --------------------------------------------------------------

/// What a comprehension ranges over.
enum Elements {
    List(CelList),
    Keys(Vec<CelValue>),
}

impl Elements {
    fn items(&self) -> &[CelValue] {
        match self {
            Self::List(list) => list,
            Self::Keys(keys) => keys,
        }
    }
}

/// One comprehension in progress.
struct Frame {
    elements: Elements,
    next: usize,
    fold: ComprehensionFold,
    decided: Option<CelValue>,
}

const NO_FRAME: &str = "a comprehension step runs inside its frame";

/// Runs a compiled tree: the value, or the error value that survived to the top.
pub(crate) fn run(
    tree: &CompiledTree,
    snapshot: &EnvironmentSnapshot,
    activation: &dyn CelActivation,
    namespace_function: Option<NamespaceDispatch<'_>>,
) -> CelValue {
    let code = &tree.instructions;
    let mut stack: Vec<CelValue> = Vec::with_capacity(8);
    let mut slots: Vec<CelValue> = vec![CelValue::Null; tree.slots];
    let mut frames: Vec<Frame> = Vec::new();
    let mut bound: Vec<CelImplementation> = Vec::new();
    let mut pc = 0;
    while pc < code.len() {
        let mut next = pc + 1;
        match &code[pc] {
            Instruction::Constant(value) => stack.push(value.clone()),
            Instruction::Slot(slot) => stack.push(slots[*slot].clone()),
            Instruction::Name { name, range } => stack.push(read_name(activation, snapshot, name, *range)),
            Instruction::DeclaredChain { chain, range } => {
                stack.push(read_name_chain(activation, snapshot, &tree.declared[*chain], *range));
            }
            Instruction::SearchedChain { chain, range } => {
                stack.push(search_name_chain(activation, snapshot, &tree.searched[*chain], *range));
            }
            Instruction::JumpIfError { target, discard } => {
                if let Some(CelValue::Error(_)) = stack.last() {
                    let error = pop(&mut stack);
                    stack.truncate(stack.len() - discard);
                    stack.push(error);
                    next = *target;
                }
            }
            Instruction::Jump { target } => next = *target,
            Instruction::Read { key, optional, range } => {
                let container = pop(&mut stack);
                stack.push(read_through(&container, key, *optional, *range, snapshot));
            }
            Instruction::ReadIndex { optional, range } => {
                let key = pop(&mut stack);
                let container = pop(&mut stack);
                stack.push(read_through(&container, &key, *optional, *range, snapshot));
            }
            Instruction::Has { field, range } => {
                let container = pop(&mut stack);
                stack.push(has_member(&container, field, *range, snapshot));
            }
            Instruction::OptionalEntry { range } => {
                let value = pop(&mut stack);
                stack.push(optional_entry(value, *range));
            }
            Instruction::MakeList { count, optional } => {
                let items = stack.split_off(stack.len() - count);
                let items: Vec<CelValue> = match optional {
                    None => items,
                    Some(flags) => present(items, &tree.optional_entries[*flags]),
                };
                stack.push(CelValue::List(items.into()));
            }
            Instruction::MakeMap { count, optional, range } => {
                let flat = stack.split_off(stack.len() - 2 * count);
                let mut flat = flat.into_iter();
                let mut entries = Vec::with_capacity(*count);
                for at in 0..*count {
                    let key = flat.next().expect("an entry's key");
                    let value = flat.next().expect("an entry's value");
                    match optional.map(|flags| tree.optional_entries[flags][at]) {
                        Some(true) => {
                            let CelValue::Optional(held) = value else { unreachable!("an optional entry was checked") };
                            if let Some(held) = held.into_held() {
                                entries.push((key, held));
                            }
                        }
                        _ => entries.push((key, value)),
                    }
                }
                stack.push(match cel_map_from_entries(entries) {
                    Ok(map) => CelValue::Map(map),
                    Err(error) => error.with_range(*range).into(),
                });
            }
            Instruction::BoolOperand { range } => {
                let value = pop(&mut stack);
                stack.push(bool_operand(value, *range));
            }
            Instruction::ShortCircuit { decided, target } => {
                if let Some(CelValue::Bool(held)) = stack.last() {
                    if held == decided {
                        next = *target;
                    }
                }
            }
            Instruction::Logic { decided } => {
                let right = pop(&mut stack);
                let left = pop(&mut stack);
                stack.push(match (left, right) {
                    (_, CelValue::Bool(held)) if held == *decided => CelValue::Bool(held),
                    (left @ CelValue::Error(_), _) => left,
                    (_, right @ CelValue::Error(_)) => right,
                    _ => CelValue::Bool(!decided),
                });
            }
            Instruction::BranchFalse { target } => match pop(&mut stack) {
                CelValue::Bool(true) => {}
                CelValue::Bool(false) => next = *target,
                _ => unreachable!("a condition is a bool once its error is carried out"),
            },
            Instruction::Call { site, count } => {
                let at = stack.len() - count;
                let answer = tree.sites[*site].call(&stack[at..], snapshot);
                stack.truncate(at);
                stack.push(answer);
            }
            Instruction::BindNamespace { namespace, name, range, target } => {
                match namespace_function.and_then(|dispatch| dispatch(namespace, name)) {
                    Some(implementation) => bound.push(implementation),
                    None => {
                        stack.push(
                            cel_error(
                                CelEvaluationCode::UnboundFunction,
                                format!("unbound function '{namespace}.{name}' — nothing is bound under that name here"),
                                Some(*range),
                            )
                            .into(),
                        );
                        next = *target;
                    }
                }
            }
            Instruction::CallBound { count, range } => {
                let implementation = bound.pop().expect("a namespaced call's function was bound");
                let at = stack.len() - count;
                let answer = implementation(&CelCallContext { range: Some(*range) }, &stack[at..]);
                stack.truncate(at);
                stack.push(answer);
            }
            Instruction::DropBound => {
                bound.pop().expect("a namespaced call's function was bound");
            }
            Instruction::Store { slot } => slots[*slot] = pop(&mut stack),
            Instruction::OptionalOf { non_zero } => {
                let held = pop(&mut stack);
                stack.push(CelValue::Optional(if *non_zero { optional_of_non_zero(held) } else { cel_some(held) }));
            }
            Instruction::OptionalBind { name, slot, range, target } => match pop(&mut stack) {
                CelValue::Optional(optional) => match optional.into_held() {
                    Some(held) => slots[*slot] = held,
                    None => {
                        stack.push(CelValue::Optional(cel_none()));
                        next = *target;
                    }
                },
                _ => {
                    stack.push(
                        cel_error(
                            CelEvaluationCode::NoMatchingOverload,
                            format!("{} reads an optional", json_quote(name)),
                            Some(*range),
                        )
                        .into(),
                    );
                    next = *target;
                }
            },
            Instruction::OptionalAnswer { wrap, range } => {
                let answered = pop(&mut stack);
                stack.push(match answered {
                    CelValue::Error(_) => answered,
                    _ if *wrap => CelValue::Optional(cel_some(answered)),
                    CelValue::Optional(_) => answered,
                    _ => cel_error(
                        CelEvaluationCode::NoMatchingOverload,
                        "optFlatMap's body answers an optional",
                        Some(*range),
                    )
                    .into(),
                });
            }
            Instruction::ComprehensionStart { comprehension, range, target } => {
                let elements = match pop(&mut stack) {
                    CelValue::List(list) => Some(Elements::List(list)),
                    other => match cel_iterable(&other, Some(*range)) {
                        Ok(keys) => Some(Elements::Keys(keys.into_owned())),
                        Err(error) => {
                            stack.push(error.into());
                            next = *target;
                            None
                        }
                    },
                };
                if let Some(elements) = elements {
                    frames.push(Frame { elements, next: 0, fold: ComprehensionFold::new(*comprehension), decided: None });
                }
            }
            Instruction::ComprehensionNext { slot, target } => {
                let frame = frames.last_mut().expect(NO_FRAME);
                match frame.elements.items().get(frame.next) {
                    Some(element) => {
                        slots[*slot] = element.clone();
                        frame.next += 1;
                    }
                    None => next = *target,
                }
            }
            Instruction::ComprehensionTest { range, target } => {
                let answered = pop(&mut stack);
                let frame = frames.last_mut().expect(NO_FRAME);
                let element = &frame.elements.items()[frame.next - 1];
                if let Some(decided) = frame.fold.test(answered, element, Some(*range)) {
                    frame.decided = Some(decided);
                    next = *target;
                }
            }
            Instruction::ComprehensionFilter { range, skip, target } => {
                let answered = pop(&mut stack);
                match filter_verdict(answered, Some(*range)) {
                    Ok(true) => {}
                    Ok(false) => next = *skip,
                    Err(error) => {
                        frames.last_mut().expect(NO_FRAME).decided = Some(error);
                        next = *target;
                    }
                }
            }
            Instruction::ComprehensionTransform { target } => {
                let value = pop(&mut stack);
                let frame = frames.last_mut().expect(NO_FRAME);
                if let Some(error) = frame.fold.transform(value) {
                    frame.decided = Some(error);
                    next = *target;
                }
            }
            Instruction::ComprehensionEnd => {
                let frame = frames.pop().expect(NO_FRAME);
                stack.push(match frame.decided {
                    Some(decided) => decided,
                    None => frame.fold.finish(),
                });
            }
        }
        pc = next;
    }
    debug_assert!(frames.is_empty() && bound.is_empty() && stack.len() == 1);
    pop(&mut stack)
}

fn pop(stack: &mut Vec<CelValue>) -> CelValue {
    stack.pop().expect("an instruction finds the operands its node left")
}

/// A list literal's elements, each written `[?x]` contributing what its optional holds,
/// or nothing.
fn present(items: Vec<CelValue>, optional: &[bool]) -> Vec<CelValue> {
    let mut kept = Vec::with_capacity(items.len());
    for (item, flagged) in items.into_iter().zip(optional) {
        match (item, flagged) {
            (CelValue::Optional(held), true) => kept.extend(held.into_held()),
            (_, true) => unreachable!("an optional entry was checked"),
            (item, false) => kept.push(item),
        }
    }
    kept
}
