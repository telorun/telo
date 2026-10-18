//! The type checker: one walk, every verdict — `checker.ts`.
//!
//! It answers three things at once, because all three come from the same walk: the type of
//! the expression, every mistake in it with a range and a code, and which signature each
//! call resolved to. Two properties are deliberate:
//!
//! - **One mistake is one diagnostic.** A subexpression that failed is typed `dyn`, so the
//!   operator above it does not report a second mistake about the first.
//! - **Nothing reads a message.** Every code is decided where its cause is known, and a
//!   repair, where there is an obvious one, is built by rewriting the tree and writing it
//!   back out, so a fix is always a whole source that parses.
//!
//! The walk runs on a heap stack of continuations, one per activation of Node's recursive
//! walk, so a tree of any depth is checked on a small stack; every order Node shows is kept
//! — diagnostics, calls, the scopes a macro opens and the proofs a guard carries. A chain of
//! members asks which declared name it reads once, at its outermost member, and a fix's node
//! replacement runs on a heap list in Node's search order.
//!
//! Declared differently from the Node file:
//! - The checker's context and options are crate-private structs, as Node's entry keeps
//!   `checkExpression` and its context private.
//! - A literal guard's refusal names the call as written, sliced from the source by UTF-16
//!   code units as Node slices it; a slice a hand-built range cuts inside a character
//!   holds U+FFFD where Node's holds the lone surrogate no Rust string can.

use std::collections::HashMap;
use std::sync::Arc;

use telorun_cel_value::{compare_code_units, json_quote, CelValue};

use crate::cel_expression::CelExpression;
use crate::cel_type::{
    admits_null, assignable, format_type, is_dyn, list_of, map_of, optional_of, parameter_of, unify, union_of,
    without_null, without_parameters, CelType, NominalType, PrimitiveName, RecordType, UnionType, BOOL, BYTES, DOUBLE,
    DYN, INT, NULL, STRING, UINT,
};
use crate::cel_value::literal_value;
use crate::check_diagnostic::{CelCheckCode, CelCheckDiagnostic, CelDiagnosticFix};
use crate::declared_chain::split_declared_chain;
use crate::function_registry::{
    describe_arguments, describe_candidates, FunctionRegistry, RegisteredFunction, ResolutionFailure,
    ResolutionFailureReason,
};
use crate::macro_check::{is_macro_call, resume_macro, start_macro, MacroFrame, MacroHost, MacroStep};
use crate::macro_shape::macro_shape_findings;
use crate::nullable_access::{chain_root, chain_text, proven_where_false, proven_where_true};
use crate::resolved_call::ResolvedCall;
use crate::serializer::serialize_tree;
use crate::signature::{format_signature, CallForm};
use crate::syntax_tree::{
    CelBinaryNode, CelBinaryOperator, CelCallNode, CelConditionalNode, CelIdentNode, CelIndexNode, CelListNode,
    CelLiteral, CelMapNode, CelNode, CelQualifiedCallNode, CelReceiverCallNode, CelSelectNode, SourceRange,
};

/// A namespaced function the host has declared, as the environment holds it.
///
/// The parameter list is withheld structurally: `parameters` and `signature` are both
/// absent where the host declared only the name and the result, and the call's arity
/// and arguments are then judged by nobody here.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct NamespaceFunction {
    pub name: String,
    pub returns: CelType,
    /// Absent where the host withholds it.
    pub parameters: Option<Vec<CelType>>,
    /// How the declaration is written, for a listing; absent with the parameters.
    pub signature: Option<String>,
    /// Types the declaration named that nothing is registered under, in the order
    /// written; each reads `dyn`.
    pub unregistered_types: Vec<String>,
    pub deterministic: bool,
    pub host_backed: bool,
    pub throws: Option<Vec<String>>,
}

/// What checking an expression answers.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct CheckResult {
    /// No diagnostic, the syntax one included.
    pub valid: bool,
    /// The type of the whole expression, every unresolved type parameter `dyn`; `dyn`
    /// where something failed.
    pub ty: CelType,
    /// How that type is written.
    pub type_name: String,
    pub diagnostics: Vec<CelCheckDiagnostic>,
    pub calls: Vec<ResolvedCall>,
}

#[derive(Clone, Copy)]
pub(crate) struct CheckerOptions {
    pub(crate) unlisted_variables_are_dyn: bool,
    pub(crate) homogeneous_aggregate_literals: bool,
    pub(crate) enable_optional_types: bool,
}

/// Everything the checker reads about the environment it checks against.
pub(crate) struct CheckerContext<'e> {
    pub(crate) registry: &'e FunctionRegistry,
    pub(crate) variable: Box<dyn Fn(&str) -> Option<&'e CelType> + 'e>,
    pub(crate) declared_variable_names: Box<dyn Fn() -> Vec<&'e str> + 'e>,
    pub(crate) namespace_function: Box<dyn Fn(&str, &str) -> Option<&'e NamespaceFunction> + 'e>,
    /// Whether a namespace declares only part of what it reaches: a name it did not
    /// declare types `dyn`, is listed, and is reported by nobody.
    pub(crate) namespace_is_open: Box<dyn Fn(&str) -> bool + 'e>,
    pub(crate) options: CheckerOptions,
}

pub(crate) fn check_expression(expression: &CelExpression, context: &CheckerContext<'_>) -> CheckResult {
    Checker {
        expression,
        context,
        diagnostics: Vec::new(),
        calls: Vec::new(),
        scopes: HashMap::new(),
        proven: HashMap::new(),
        longest_variable: None,
    }
    .run()
}

/// What the walk does next.
enum Step<'a> {
    /// Type a node; the flag says its member chain is already known to read no dotted
    /// declaration.
    Eval(&'a CelNode, bool),
    /// Type a select as a question about presence.
    Presence(&'a CelSelectNode),
    /// A type, handed to the continuation on top.
    Return(CelType),
}

/// Where the walk resumes once the type it asked for is known.
enum Cont<'a> {
    List { node: &'a CelListNode, types: Vec<CelType> },
    MapKeys { node: &'a CelMapNode, keys: Vec<CelType> },
    MapValues { node: &'a CelMapNode, keys: Vec<CelType>, values: Vec<CelType> },
    Select { node: &'a CelSelectNode, presence: bool },
    IndexOperand { node: &'a CelIndexNode },
    IndexIndex { node: &'a CelIndexNode, operand: CelType },
    Operator { operator: &'static str, operands: Vec<&'a CelNode>, args: Vec<CelType>, range: SourceRange },
    LogicalLeft { node: &'a CelBinaryNode },
    LogicalRight { node: &'a CelBinaryNode, left: CelType },
    Condition { node: &'a CelConditionalNode },
    WhenTrue { node: &'a CelConditionalNode },
    WhenFalse { node: &'a CelConditionalNode, when_true: CelType },
    CallReceiver { node: &'a CelNode },
    CallArguments { node: &'a CelNode, receiver: Option<CelType>, args: Vec<CelType> },
    QualifiedArguments { node: &'a CelQualifiedCallNode, args: Vec<CelType> },
    Macro(MacroFrame<'a>),
    /// A macro's scope closes.
    Unbind(&'a str),
    /// A guard's proofs go out of scope.
    Unprove(Vec<String>),
}

struct Checker<'a, 'e> {
    expression: &'a CelExpression,
    context: &'a CheckerContext<'e>,
    diagnostics: Vec<CelCheckDiagnostic>,
    calls: Vec<ResolvedCall>,
    /// Every name a macro bound, its innermost binding last.
    scopes: HashMap<&'a str, Vec<CelType>>,
    /// Every chain proven non-null where the walk stands, with how many guards prove it.
    proven: HashMap<String, usize>,
    /// The length of the longest declared name, once a chain asks.
    longest_variable: Option<usize>,
}

impl MacroHost for Checker<'_, '_> {
    fn report(&mut self, code: CelCheckCode, message: String, range: SourceRange) {
        self.diagnostics.push(CelCheckDiagnostic { code, message, range, fix: None });
    }
}

impl<'a> Checker<'a, '_> {
    fn run(mut self) -> CheckResult {
        let expression = self.expression;
        if let Some(syntax) = &expression.diagnostic {
            self.report(CelCheckCode::SyntaxError, syntax.message.clone(), syntax.range);
        }
        for finding in macro_shape_findings(&expression.root) {
            self.report(finding.code, finding.message, finding.range);
        }
        // The type is reported, so a parameter nothing resolved in it is `dyn`.
        let ty = without_parameters(&self.type_of(&expression.root));
        CheckResult {
            valid: self.diagnostics.is_empty(),
            type_name: format_type(&ty, true),
            ty,
            diagnostics: self.diagnostics,
            calls: self.calls,
        }
    }

    fn report_with_fix(&mut self, code: CelCheckCode, message: String, range: SourceRange, fix: Option<CelDiagnosticFix>) {
        self.diagnostics.push(CelCheckDiagnostic { code, message, range, fix });
    }

    // --- the walk ---------------------------------------------------------------

    fn type_of(&mut self, root: &'a CelNode) -> CelType {
        let mut stack: Vec<Cont<'a>> = Vec::new();
        let mut step = Step::Eval(root, false);
        loop {
            step = match step {
                Step::Eval(node, absent) => self.start(node, absent, &mut stack),
                Step::Presence(select) => self.start_select(select, true, false, &mut stack),
                Step::Return(ty) => match stack.pop() {
                    None => return ty,
                    Some(cont) => self.resume(cont, ty, &mut stack),
                },
            };
        }
    }

    fn start(&mut self, node: &'a CelNode, absent: bool, stack: &mut Vec<Cont<'a>>) -> Step<'a> {
        match node {
            CelNode::Unparsed(_) => Step::Return(DYN),
            CelNode::Literal(literal) => Step::Return(literal_type(&literal.literal)),
            CelNode::Ident(ident) => Step::Return(self.ident_type(ident)),
            CelNode::List(list) => match list.elements.first() {
                None => Step::Return(list_of(parameter_of("T"))),
                Some(first) => {
                    stack.push(Cont::List { node: list, types: Vec::new() });
                    Step::Eval(&first.value, false)
                }
            },
            CelNode::Map(map) => match map.entries.first() {
                None => Step::Return(map_of(parameter_of("K"), parameter_of("V"))),
                Some(first) => {
                    stack.push(Cont::MapKeys { node: map, keys: Vec::new() });
                    Step::Eval(&first.key, false)
                }
            },
            CelNode::Select(select) => self.start_select(select, select.optional, absent, stack),
            CelNode::Index(index) => {
                stack.push(Cont::IndexOperand { node: index });
                Step::Eval(&index.operand, false)
            }
            CelNode::Unary(unary) => self.start_operator(unary.operator.as_str(), vec![&*unary.operand], unary.range, stack),
            CelNode::Binary(binary) => match binary.operator {
                CelBinaryOperator::And | CelBinaryOperator::Or => {
                    stack.push(Cont::LogicalLeft { node: binary });
                    Step::Eval(&binary.left, false)
                }
                operator => self.start_operator(operator.as_str(), vec![&*binary.left, &*binary.right], binary.range, stack),
            },
            CelNode::Conditional(conditional) => {
                stack.push(Cont::Condition { node: conditional });
                Step::Eval(&conditional.condition, false)
            }
            CelNode::Call(_) | CelNode::ReceiverCall(_) => self.start_call(node, stack),
            CelNode::QualifiedCall(call) => match call.args.first() {
                None => Step::Return(self.finish_qualified_call(call, Vec::new())),
                Some(first) => {
                    stack.push(Cont::QualifiedArguments { node: call, args: Vec::new() });
                    Step::Eval(first, false)
                }
            },
        }
    }

    fn resume(&mut self, cont: Cont<'a>, ty: CelType, stack: &mut Vec<Cont<'a>>) -> Step<'a> {
        match cont {
            Cont::List { node, mut types } => {
                let element = &node.elements[types.len()];
                types.push(if element.optional { self.held_by_optional(ty, &element.value, "a list element") } else { ty });
                if let Some(next) = node.elements.get(types.len()) {
                    stack.push(Cont::List { node, types });
                    return Step::Eval(&next.value, false);
                }
                let values: Vec<&CelNode> = node.elements.iter().map(|element| &*element.value).collect();
                Step::Return(list_of(self.reduce(&types, &values, "list")))
            }
            Cont::MapKeys { node, mut keys } => {
                keys.push(ty);
                if let Some(next) = node.entries.get(keys.len()) {
                    stack.push(Cont::MapKeys { node, keys });
                    return Step::Eval(&next.key, false);
                }
                stack.push(Cont::MapValues { node, keys, values: Vec::new() });
                Step::Eval(&node.entries[0].value, false)
            }
            Cont::MapValues { node, keys, mut values } => {
                let entry = &node.entries[values.len()];
                values.push(if entry.optional { self.held_by_optional(ty, &entry.value, "a map entry") } else { ty });
                if let Some(next) = node.entries.get(values.len()) {
                    stack.push(Cont::MapValues { node, keys, values });
                    return Step::Eval(&next.value, false);
                }
                let key_nodes: Vec<&CelNode> = node.entries.iter().map(|entry| &*entry.key).collect();
                let value_nodes: Vec<&CelNode> = node.entries.iter().map(|entry| &*entry.value).collect();
                let key = self.reduce(&keys, &key_nodes, "map key");
                let value = self.reduce(&values, &value_nodes, "map value");
                Step::Return(map_of(key, value))
            }
            Cont::Select { node, presence } => Step::Return(self.finish_select(node, presence, ty)),
            Cont::IndexOperand { node } => {
                stack.push(Cont::IndexIndex { node, operand: ty });
                Step::Eval(&node.index, false)
            }
            Cont::IndexIndex { node, operand } => Step::Return(self.finish_index(node, operand, ty)),
            Cont::Operator { operator, operands, mut args, range } => {
                args.push(ty);
                if let Some(next) = operands.get(args.len()).copied() {
                    stack.push(Cont::Operator { operator, operands, args, range });
                    return Step::Eval(next, false);
                }
                Step::Return(self.finish_operator(operator, &args, range))
            }
            Cont::LogicalLeft { node } => {
                let proofs = if node.operator == CelBinaryOperator::And {
                    proven_where_true(&node.left)
                } else {
                    proven_where_false(&node.left)
                };
                stack.push(Cont::LogicalRight { node, left: ty });
                self.prove(proofs, stack);
                Step::Eval(&node.right, false)
            }
            Cont::LogicalRight { node, left } => {
                for operand in [&left, &ty] {
                    if !is_dyn(operand) && !assignable(operand, &BOOL) {
                        self.report(
                            CelCheckCode::TypeError,
                            format!(
                                "{} joins bool values, and {} is not one",
                                node.operator.as_str(),
                                format_type(operand, false)
                            ),
                            node.range,
                        );
                    }
                }
                Step::Return(BOOL)
            }
            Cont::Condition { node } => {
                if !is_dyn(&ty) && !assignable(&ty, &BOOL) {
                    self.report(
                        CelCheckCode::TypeError,
                        format!("a condition must be bool, and this one is {}", format_type(&ty, false)),
                        node.condition.range(),
                    );
                }
                stack.push(Cont::WhenTrue { node });
                self.prove(proven_where_true(&node.condition), stack);
                Step::Eval(&node.when_true, false)
            }
            Cont::WhenTrue { node } => {
                stack.push(Cont::WhenFalse { node, when_true: ty });
                self.prove(proven_where_false(&node.condition), stack);
                Step::Eval(&node.when_false, false)
            }
            Cont::WhenFalse { node, when_true } => {
                let unified = unify(&when_true, &ty);
                // A value read out of a conditional has one type, so two branches that share
                // none is a mistake rather than a `dyn`.
                if is_dyn(&unified) && !is_dyn(&when_true) && !is_dyn(&ty) {
                    self.report(
                        CelCheckCode::TypeError,
                        format!(
                            "the branches of a condition answer {} and {}, which are not one type",
                            format_type(&when_true, false),
                            format_type(&ty, false)
                        ),
                        node.range,
                    );
                }
                Step::Return(unified)
            }
            Cont::CallReceiver { node } => {
                let CelNode::ReceiverCall(call) = node else { unreachable!("only a receiver call types a receiver") };
                match call.args.first() {
                    None => Step::Return(self.finish_call(node, Some(ty), Vec::new())),
                    Some(first) => {
                        stack.push(Cont::CallArguments { node, receiver: Some(ty), args: Vec::new() });
                        Step::Eval(first, false)
                    }
                }
            }
            Cont::CallArguments { node, receiver, mut args } => {
                args.push(ty);
                if let Some(next) = call_arguments(node).get(args.len()) {
                    stack.push(Cont::CallArguments { node, receiver, args });
                    return Step::Eval(next, false);
                }
                Step::Return(self.finish_call(node, receiver, args))
            }
            Cont::QualifiedArguments { node, mut args } => {
                args.push(ty);
                if let Some(next) = node.args.get(args.len()) {
                    stack.push(Cont::QualifiedArguments { node, args });
                    return Step::Eval(next, false);
                }
                Step::Return(self.finish_qualified_call(node, args))
            }
            Cont::Macro(at) => {
                let step = resume_macro(at, ty, self);
                self.macro_step(step, stack)
            }
            Cont::Unbind(name) => {
                if let Some(held) = self.scopes.get_mut(name) {
                    held.pop();
                    if held.is_empty() {
                        self.scopes.remove(name);
                    }
                }
                Step::Return(ty)
            }
            Cont::Unprove(proofs) => {
                for proof in proofs {
                    if let Some(count) = self.proven.get_mut(&proof) {
                        *count -= 1;
                        if *count == 0 {
                            self.proven.remove(&proof);
                        }
                    }
                }
                Step::Return(ty)
            }
        }
    }

    /// The proofs of a guard, in scope until the continuation pushed here runs.
    fn prove(&mut self, proofs: Vec<String>, stack: &mut Vec<Cont<'a>>) {
        if proofs.is_empty() {
            return;
        }
        for proof in &proofs {
            *self.proven.entry(proof.clone()).or_insert(0) += 1;
        }
        stack.push(Cont::Unprove(proofs));
    }

    fn macro_step(&mut self, step: MacroStep<'a>, stack: &mut Vec<Cont<'a>>) -> Step<'a> {
        match step {
            MacroStep::Done(ty) => Step::Return(ty),
            MacroStep::TypeOf(node, at) => {
                stack.push(Cont::Macro(at));
                Step::Eval(node, false)
            }
            MacroStep::TypeOfBinding(node, name, ty, at) => {
                stack.push(Cont::Macro(at));
                self.scopes.entry(name).or_default().push(ty);
                stack.push(Cont::Unbind(name));
                Step::Eval(node, false)
            }
            MacroStep::TypeOfPresence(select, at) => {
                stack.push(Cont::Macro(at));
                Step::Presence(select)
            }
        }
    }

    fn ident_type(&mut self, node: &CelIdentNode) -> CelType {
        // An absolute name is resolved against the environment alone: that is what it is for.
        if !node.absolute {
            if let Some(bound) = self.scopes.get(node.name.as_str()).and_then(|held| held.last()) {
                return bound.clone();
            }
        }
        if let Some(declared) = (self.context.variable)(&node.name) {
            return declared.clone();
        }
        if self.context.options.unlisted_variables_are_dyn {
            return DYN;
        }
        let message = format!("{} is not declared here{}", json_quote(&node.name), self.available_names());
        self.report(CelCheckCode::UnknownIdentifier, message, node.range);
        DYN
    }

    fn available_names(&self) -> String {
        let mut names = (self.context.declared_variable_names)();
        if names.is_empty() {
            return String::new();
        }
        names.sort_by(|left, right| compare_code_units(left, right));
        format!(" (declared: {})", names.join(", "))
    }

    /// What an optional entry contributes: the value inside the optional.
    fn held_by_optional(&mut self, ty: CelType, node: &CelNode, what: &str) -> CelType {
        match &ty {
            CelType::Optional(optional) => (*optional.value).clone(),
            CelType::Dyn | CelType::Parameter(_) => DYN,
            _ => {
                self.report(
                    CelCheckCode::TypeError,
                    format!("{what} written with '?' holds an optional, and this one is {}", format_type(&ty, false)),
                    node.range(),
                );
                DYN
            }
        }
    }

    /// One type for several written values. Mixed types are `dyn` unless the environment
    /// asked for homogeneous aggregates, where the mixture is the mistake.
    fn reduce(&mut self, types: &[CelType], nodes: &[&CelNode], what: &str) -> CelType {
        let mut reduced = types[0].clone();
        for (at, ty) in types.iter().enumerate().skip(1) {
            let next = unify(&reduced, ty);
            if self.context.options.homogeneous_aggregate_literals && is_dyn(&next) && !is_dyn(&reduced) && !is_dyn(ty) {
                self.report(
                    CelCheckCode::TypeError,
                    format!("this {what} is {} where the others are {}", format_type(ty, false), format_type(&reduced, false)),
                    nodes[at].range(),
                );
            }
            reduced = next;
        }
        reduced
    }

    // --- member reads -------------------------------------------------------------

    /// `presence` is whether the read asks whether the member is there — `.?b`, or the
    /// argument of `has()`. It decides which branches of a union are judged.
    fn start_select(
        &mut self,
        node: &'a CelSelectNode,
        presence: bool,
        absent: bool,
        stack: &mut Vec<Cont<'a>>,
    ) -> Step<'a> {
        if !absent {
            if let Some(qualified) = self.qualified_variable_type(node) {
                return Step::Return(qualified);
            }
        }
        stack.push(Cont::Select { node, presence });
        // A member below this one on the same plain run reads no dotted declaration either:
        // its chain is a prefix of this one's, over the same root, in the same scope.
        let inner_absent = is_plain_step(node) && matches!(&*node.operand, CelNode::Select(inner) if is_plain_step(inner));
        Step::Eval(&node.operand, inner_absent)
    }

    fn finish_select(&mut self, node: &CelSelectNode, presence: bool, operand: CelType) -> CelType {
        if node.field.is_empty() {
            return DYN;
        }
        let guarded = self.check_nullable(&node.operand, operand, &format!(".{}", node.field), node.field_range);
        let held = self.member_type(&guarded, &node.field, node.field_range, presence);
        // Reading through an optional answers an optional, whichever form the read is
        // written in.
        if node.optional || matches!(guarded, CelType::Optional(_)) {
            optional_of(unwrap_optional(held))
        } else {
            held
        }
    }

    /// A dotted declaration is one name, and the longest one wins. A name the expression
    /// bound takes precedence over a declaration, unless the chain is absolute.
    fn qualified_variable_type(&mut self, node: &CelSelectNode) -> Option<CelType> {
        let mut segments: Vec<(&str, SourceRange)> = Vec::new();
        let mut at = node;
        let root = loop {
            if !is_plain_step(at) {
                return None;
            }
            segments.push((&at.field, at.field_range));
            match &*at.operand {
                CelNode::Select(inner) => at = inner,
                CelNode::Ident(ident) => break ident,
                _ => return None,
            }
        };
        segments.push((&root.name, root.range));
        segments.reverse();
        if !root.absolute && self.scopes.contains_key(root.name.as_str()) {
            return None;
        }
        let longest = self.longest_variable();
        let context = self.context;
        let variable = &context.variable;
        let names: Vec<&str> = segments.iter().map(|(name, _)| *name).collect();
        let split = split_declared_chain(&names, |name| name.len() <= longest && variable(name).is_some())?;
        // A split at the root alone is the ordinary read of a name and then its members.
        if split.rest.len() == segments.len() - 1 {
            return None;
        }
        let mut held = variable(&split.name).expect("the split names a declared variable").clone();
        for (name, range) in &segments[segments.len() - split.rest.len()..] {
            held = self.member_type(&held, name, *range, false);
        }
        Some(held)
    }

    fn longest_variable(&mut self) -> usize {
        if let Some(longest) = self.longest_variable {
            return longest;
        }
        let longest = (self.context.declared_variable_names)().iter().map(|name| name.len()).max().unwrap_or(0);
        self.longest_variable = Some(longest);
        longest
    }

    fn is_bound(&self, name: &str) -> bool {
        self.scopes.contains_key(name)
    }

    /// The type of a named member, reported against whatever the operand turned out to be.
    fn member_type(&mut self, operand: &CelType, field: &str, range: SourceRange, presence: bool) -> CelType {
        enum Task<'t> {
            Visit(&'t CelType),
            Union(usize),
        }
        let mut results: Vec<CelType> = Vec::new();
        let mut tasks = vec![Task::Visit(operand)];
        while let Some(task) = tasks.pop() {
            let ty = match task {
                Task::Union(count) => {
                    let members = results.split_off(results.len() - count);
                    results.push(union_of(members));
                    continue;
                }
                Task::Visit(ty) => ty,
            };
            let answer = match ty {
                CelType::Dyn | CelType::Parameter(_) => DYN,
                CelType::Optional(optional) => {
                    tasks.push(Task::Visit(&optional.value));
                    continue;
                }
                CelType::Union(union) => {
                    let branches = presence_branches(union, false, presence);
                    tasks.push(Task::Union(branches.len()));
                    tasks.extend(branches.into_iter().rev().map(Task::Visit));
                    continue;
                }
                CelType::Record(record) => self.record_member_type(record, field, range),
                CelType::Nominal(nominal) if nominal.fields.is_some() => self.field_type(nominal, field, range),
                CelType::Map(map) => {
                    if assignable(&STRING, &map.key) {
                        (*map.value).clone()
                    } else {
                        self.report(
                            CelCheckCode::TypeError,
                            format!(
                                "{} is keyed by {}, so {} cannot name an entry of it",
                                format_type(ty, false),
                                format_type(&map.key, false),
                                json_quote(field)
                            ),
                            range,
                        );
                        DYN
                    }
                }
                _ => {
                    self.report(CelCheckCode::TypeError, format!("{} holds no members", format_type(ty, false)), range);
                    DYN
                }
            };
            results.push(answer);
        }
        results.pop().expect("the operand is answered last")
    }

    fn record_member_type(&mut self, record: &RecordType, field: &str, range: SourceRange) -> CelType {
        if let Some(held) = record.fields.get(field) {
            return held.clone();
        }
        if record.open {
            return DYN;
        }
        let declared: Vec<&str> = record.fields.keys().collect();
        let listing = if declared.is_empty() { String::new() } else { format!(" (declared: {})", declared.join(", ")) };
        self.report(CelCheckCode::UnknownField, format!("{} is not declared here{listing}", json_quote(field)), range);
        DYN
    }

    /// A field of a host's named type: the type its definition declares, and any other
    /// name is unknown.
    fn field_type(&mut self, ty: &NominalType, field: &str, range: SourceRange) -> CelType {
        let fields = ty.fields.as_ref().expect("only a named type with fields is read by field");
        if let Some(held) = fields.get(field) {
            return held.clone();
        }
        let message = format!(
            "{} is not a field of {} (fields: {})",
            json_quote(field),
            format_type(&CelType::Nominal(ty.clone()), false),
            fields.keys().collect::<Vec<_>>().join(", ")
        );
        self.report(CelCheckCode::UnknownField, message, range);
        DYN
    }

    fn finish_index(&mut self, node: &CelIndexNode, operand: CelType, index: CelType) -> CelType {
        let guarded = self.check_nullable(&node.operand, operand, "[…]", node.range);
        let held = self.element_type(&guarded, &index, node, node.optional);
        if node.optional || matches!(guarded, CelType::Optional(_)) {
            optional_of(unwrap_optional(held))
        } else {
            held
        }
    }

    fn element_type(&mut self, operand: &CelType, index: &CelType, node: &CelIndexNode, presence: bool) -> CelType {
        enum Task<'t> {
            Visit(&'t CelType),
            Union(usize),
        }
        let literal_key = match &*node.index {
            CelNode::Literal(literal) => match &literal.literal {
                CelLiteral::String(key) => Some(key.as_str()),
                _ => None,
            },
            _ => None,
        };
        let index_range = node.index.range();
        let mut results: Vec<CelType> = Vec::new();
        let mut tasks = vec![Task::Visit(operand)];
        while let Some(task) = tasks.pop() {
            let ty = match task {
                Task::Union(count) => {
                    let members = results.split_off(results.len() - count);
                    results.push(union_of(members));
                    continue;
                }
                Task::Visit(ty) => ty,
            };
            let answer = match ty {
                CelType::Dyn | CelType::Parameter(_) => DYN,
                CelType::Optional(optional) => {
                    tasks.push(Task::Visit(&optional.value));
                    continue;
                }
                CelType::Union(union) => {
                    let branches = presence_branches(union, true, presence);
                    tasks.push(Task::Union(branches.len()));
                    tasks.extend(branches.into_iter().rev().map(Task::Visit));
                    continue;
                }
                CelType::List(list) => {
                    if !assignable(index, &INT) && !is_dyn(index) {
                        self.report(
                            CelCheckCode::TypeError,
                            format!("a list is indexed by int, and this index is {}", format_type(index, false)),
                            index_range,
                        );
                    }
                    (*list.element).clone()
                }
                CelType::Map(map) => {
                    if !assignable(index, &map.key) && !is_dyn(index) {
                        self.report(
                            CelCheckCode::TypeError,
                            format!(
                                "{} is indexed by {}, and this index is {}",
                                format_type(ty, false),
                                format_type(&map.key, false),
                                format_type(index, false)
                            ),
                            index_range,
                        );
                    }
                    (*map.value).clone()
                }
                CelType::Record(record) => match literal_key {
                    Some(key) => self.record_member_type(record, key, index_range),
                    None => DYN,
                },
                CelType::Nominal(nominal) if nominal.fields.is_some() => match literal_key {
                    Some(key) => self.field_type(nominal, key, index_range),
                    None => {
                        if !assignable(index, &STRING) && !is_dyn(index) {
                            self.report(
                                CelCheckCode::TypeError,
                                format!(
                                    "{} is read by field name, and this index is {}",
                                    format_type(ty, false),
                                    format_type(index, false)
                                ),
                                index_range,
                            );
                        }
                        DYN
                    }
                },
                _ => {
                    self.report(CelCheckCode::TypeError, format!("{} holds no elements", format_type(ty, false)), node.range);
                    DYN
                }
            };
            results.push(answer);
        }
        results.pop().expect("the operand is answered last")
    }

    /// A dereference of something that may be null. The type is answered with null taken
    /// out either way, so one missing guard is one diagnostic.
    fn check_nullable(&mut self, operand: &CelNode, ty: CelType, access: &str, range: SourceRange) -> CelType {
        if !admits_null(&ty) {
            return ty;
        }
        let Some(chain) = chain_text(operand) else { return without_null(&ty) };
        if self.proven.contains_key(&chain) {
            return without_null(&ty);
        }
        // A chain rooted at a name the expression bound is not a subject of this verdict.
        if chain_root(operand).is_some_and(|root| self.is_bound(root)) {
            return without_null(&ty);
        }
        if matches!(ty, CelType::Primitive(_)) {
            self.report(CelCheckCode::TypeError, "null holds no members".into(), range);
            return DYN;
        }
        self.report(
            CelCheckCode::NullableAccess,
            format!(
                "{} may be null — guard it (e.g. '{chain} != null && …' or '{chain} == null ? … : {chain}{access}') before reading {access}",
                json_quote(&chain)
            ),
            range,
        );
        without_null(&ty)
    }

    // --- operators ----------------------------------------------------------------

    fn start_operator(
        &mut self,
        operator: &'static str,
        operands: Vec<&'a CelNode>,
        range: SourceRange,
        stack: &mut Vec<Cont<'a>>,
    ) -> Step<'a> {
        let first = operands[0];
        stack.push(Cont::Operator { operator, operands, args: Vec::new(), range });
        Step::Eval(first, false)
    }

    fn finish_operator(&mut self, operator: &str, args: &[CelType], range: SourceRange) -> CelType {
        // A value whose declared type admits null may always be tested against null.
        if (operator == "==" || operator == "!=") && is_null_test(args) {
            return BOOL;
        }
        match self.context.registry.resolve(operator, CallForm::Global, args, None) {
            Ok(resolution) => resolution.returns,
            Err(failure) => {
                let mut types: Vec<&CelType> = args.iter().collect();
                types.extend(candidate_types(&failure));
                let (code, message) = match type_argument_mismatch(&types) {
                    Some(mismatch) => (CelCheckCode::TypeArgumentMismatch, mismatch),
                    None => (
                        CelCheckCode::TypeError,
                        format!("no {} is declared over {}", json_quote(operator), describe_arguments(args)),
                    ),
                };
                self.report(code, message, range);
                DYN
            }
        }
    }

    // --- calls --------------------------------------------------------------------

    fn start_call(&mut self, node: &'a CelNode, stack: &mut Vec<Cont<'a>>) -> Step<'a> {
        if is_macro_call(node) {
            if !self.context.options.enable_optional_types && is_optional_macro(node) {
                self.report(
                    CelCheckCode::UnknownFunction,
                    "optional types are not enabled in this environment".into(),
                    node.range(),
                );
                return Step::Return(DYN);
            }
            let step = start_macro(node, self);
            return self.macro_step(step, stack);
        }
        match node {
            CelNode::ReceiverCall(call) => {
                stack.push(Cont::CallReceiver { node });
                Step::Eval(&call.receiver, false)
            }
            _ => match call_arguments(node).first() {
                None => Step::Return(self.finish_call(node, None, Vec::new())),
                Some(first) => {
                    stack.push(Cont::CallArguments { node, receiver: None, args: Vec::new() });
                    Step::Eval(first, false)
                }
            },
        }
    }

    fn finish_call(&mut self, node: &CelNode, receiver: Option<CelType>, args: Vec<CelType>) -> CelType {
        let (name, form, range) = call_parts(node);
        match self.context.registry.resolve(name, form, &args, receiver.as_ref()) {
            Ok(resolution) => {
                let metadata = &resolution.resolved.metadata;
                self.calls.push(ResolvedCall {
                    name: name.into(),
                    form,
                    namespace: None,
                    arity: args.len(),
                    range,
                    signature: Some(format_signature(&resolution.resolved.signature)),
                    returns: Some(format_type(&without_parameters(&resolution.returns), false)),
                    deterministic: Some(metadata.deterministic),
                    host_backed: Some(metadata.host_backed),
                    throws: metadata.throws.clone(),
                    argument_types: None,
                });
                self.check_literal_arguments(node, &resolution.resolved);
                resolution.returns
            }
            Err(failure) => {
                self.calls.push(ResolvedCall {
                    name: name.into(),
                    form,
                    namespace: None,
                    arity: args.len(),
                    range,
                    signature: None,
                    returns: None,
                    deterministic: None,
                    host_backed: None,
                    throws: None,
                    argument_types: None,
                });
                self.report_call_failure(node, form, &args, receiver.as_ref(), &failure);
                DYN
            }
        }
    }

    /// A registration's own guard over the arguments written as literals, asked where the
    /// call has just resolved and nowhere else.
    fn check_literal_arguments(&mut self, node: &CelNode, resolved: &RegisteredFunction) {
        let Some(check) = &resolved.metadata.check_arguments else { return };
        let mut written: Vec<&CelNode> = Vec::new();
        if let CelNode::ReceiverCall(call) = node {
            written.push(&call.receiver);
        }
        written.extend(call_arguments(node).iter().map(|argument| &**argument));
        let values: Vec<Option<CelValue>> = written
            .into_iter()
            .map(|argument| match argument {
                CelNode::Literal(literal) => Some(literal_value(&literal.literal)),
                _ => None,
            })
            .collect();
        let Some(refusal) = check(&values) else { return };
        let range = node.range();
        let source = utf16_slice(&self.expression.source, range.start, range.end);
        self.report(CelCheckCode::InvalidArgument, format!("{refusal} (in `{source}`)"), range);
    }

    fn report_call_failure(
        &mut self,
        node: &CelNode,
        form: CallForm,
        args: &[CelType],
        receiver: Option<&CelType>,
        failure: &ResolutionFailure,
    ) {
        let (name, _, range) = call_parts(node);
        match failure.reason {
            ResolutionFailureReason::Unknown => {
                let message = format!(
                    "no function named {} is registered{}",
                    json_quote(name),
                    self.closest_names(name, form, args.len())
                );
                let fix = self.rename_fix(node);
                self.report_with_fix(CelCheckCode::UnknownFunction, message, range, fix);
            }
            ResolutionFailureReason::WrongForm => {
                let wanted = if form == CallForm::Global { "on a value" } else { "without a receiver" };
                let message =
                    format!("{} is called {wanted}: {}", json_quote(name), describe_candidates(&failure.candidates));
                let fix = self.form_fix(node);
                self.report_with_fix(CelCheckCode::WrongCallForm, message, range, fix);
            }
            ResolutionFailureReason::NoOverload => {
                let mut types: Vec<&CelType> = receiver.into_iter().collect();
                types.extend(args);
                types.extend(candidate_types(failure));
                let (code, message) = match type_argument_mismatch(&types) {
                    Some(mismatch) => (CelCheckCode::TypeArgumentMismatch, mismatch),
                    None => {
                        let on = if form == CallForm::Receiver {
                            format!("{}.", format_type(receiver.unwrap_or(&DYN), false))
                        } else {
                            String::new()
                        };
                        (
                            CelCheckCode::TypeError,
                            format!(
                                "no overload of {} takes {on}{name}({}): {}",
                                json_quote(name),
                                describe_arguments(args),
                                describe_candidates(&failure.candidates)
                            ),
                        )
                    }
                };
                self.report(code, message, range);
            }
        }
    }

    /// The registered names accepting a call's form and arity, nearest first, as a clause
    /// to hang off the refusal. The fix stays singular; the alternatives are named here.
    fn closest_names(&self, name: &str, form: CallForm, arity: usize) -> String {
        let candidates = self.context.registry.candidate_names(name, form, arity);
        if candidates.is_empty() {
            return String::new();
        }
        let written = match arity {
            0 => "no arguments".to_string(),
            1 => "1 argument".to_string(),
            _ => format!("{arity} arguments"),
        };
        let shape =
            if form == CallForm::Receiver { format!("written on a value with {written}") } else { format!("taking {written}") };
        format!(" — the closest {shape}: {}", candidates.join(", "))
    }

    /// The one registered name this call might have meant, as a whole-source repair.
    fn rename_fix(&self, node: &CelNode) -> Option<CelDiagnosticFix> {
        let (name, form, _) = call_parts(node);
        let arity = call_arguments(node).len();
        let wanted = name.to_lowercase();
        let mut candidates: Vec<String> = Vec::new();
        for entry in self.context.registry.list() {
            let signature = &entry.signature;
            if signature.form() == form
                && signature.parameters.len() == arity
                && signature.name.to_lowercase() == wanted
                && signature.name != name
                && !candidates.contains(&signature.name)
            {
                candidates.push(signature.name.clone());
            }
        }
        let [candidate] = <[String; 1]>::try_from(candidates).ok()?;
        let renamed = match node {
            CelNode::Call(call) => CelNode::Call(CelCallNode { name: candidate, ..call.clone() }),
            CelNode::ReceiverCall(call) => CelNode::ReceiverCall(CelReceiverCallNode { name: candidate, ..call.clone() }),
            _ => unreachable!("only a call is renamed"),
        };
        self.replacement(node, Arc::new(renamed))
    }

    /// The same call written in its other form, parenthesized as the tree requires.
    fn form_fix(&self, node: &CelNode) -> Option<CelDiagnosticFix> {
        let other = match node {
            CelNode::Call(call) => {
                let (receiver, rest) = call.args.split_first()?;
                CelNode::ReceiverCall(CelReceiverCallNode {
                    receiver: Arc::clone(receiver),
                    name: call.name.clone(),
                    name_range: call.name_range,
                    args: rest.to_vec(),
                    range: call.range,
                })
            }
            CelNode::ReceiverCall(call) => CelNode::Call(CelCallNode {
                name: call.name.clone(),
                name_range: call.name_range,
                args: std::iter::once(Arc::clone(&call.receiver)).chain(call.args.iter().cloned()).collect(),
                range: call.range,
            }),
            _ => unreachable!("only a call changes form"),
        };
        self.replacement(node, Arc::new(other))
    }

    /// The whole expression with one node replaced, written back out. A tree holding
    /// something with no source cannot be written, so it offers no fix.
    fn replacement(&self, from: &CelNode, to: Arc<CelNode>) -> Option<CelDiagnosticFix> {
        let rewritten = replace_node(&self.expression.root, from, &to)?;
        serialize_tree(&rewritten).ok().map(|replacement| CelDiagnosticFix { replacement })
    }

    // --- namespaced calls -----------------------------------------------------------

    fn finish_qualified_call(&mut self, node: &CelQualifiedCallNode, args: Vec<CelType>) -> CelType {
        let qualified = format!("{}.{}", node.namespace, node.name);
        let argument_types: Vec<String> = args.iter().map(|ty| format_type(&without_parameters(ty), false)).collect();
        let Some(declared) = (self.context.namespace_function)(&node.namespace, &node.name) else {
            self.calls.push(ResolvedCall {
                name: qualified,
                form: CallForm::Receiver,
                namespace: Some(node.namespace.clone()),
                arity: args.len(),
                range: node.range,
                signature: None,
                returns: None,
                deterministic: None,
                host_backed: None,
                throws: None,
                argument_types: Some(argument_types),
            });
            // An open namespace declares only part of what it reaches: the name is listed
            // and left to the host.
            if !(self.context.namespace_is_open)(&node.namespace) {
                self.report(
                    CelCheckCode::FunctionUnresolved,
                    format!("{} declares no function named {}", json_quote(&node.namespace), json_quote(&node.name)),
                    node.range,
                );
            }
            return DYN;
        };
        self.calls.push(ResolvedCall {
            name: qualified.clone(),
            form: CallForm::Receiver,
            namespace: Some(node.namespace.clone()),
            arity: args.len(),
            range: node.range,
            signature: declared.signature.clone(),
            returns: Some(format_type(&without_parameters(&declared.returns), false)),
            deterministic: Some(declared.deterministic),
            host_backed: Some(declared.host_backed),
            throws: declared.throws.clone(),
            argument_types: Some(argument_types),
        });
        // A type the host named and its own registry does not carry: the declaration stands,
        // reads `dyn` where that type stood, and the disagreement is a verdict here, where
        // the name has a range.
        let unregistered = &declared.unregistered_types;
        if !unregistered.is_empty() {
            let names = unregistered.iter().map(|name| json_quote(name)).collect::<Vec<_>>().join(", ");
            let message = if unregistered.len() == 1 {
                format!("{qualified} is declared over the type {names}, and no type is registered under that name")
            } else {
                format!("{qualified} is declared over the types {names}, and no type is registered under those names")
            };
            self.report(CelCheckCode::TypeError, message, node.range);
        }
        // Parameters withheld: the host judges arity and arguments itself.
        let Some(parameters) = &declared.parameters else { return declared.returns.clone() };
        if args.len() != parameters.len() {
            self.report(
                CelCheckCode::FunctionArityMismatch,
                format!(
                    "{qualified} takes {} argument{}, and {} {} written",
                    parameters.len(),
                    if parameters.len() == 1 { "" } else { "s" },
                    args.len(),
                    if args.len() == 1 { "is" } else { "are" }
                ),
                node.range,
            );
            return declared.returns.clone();
        }
        for (at, (argument, wanted)) in args.iter().zip(parameters).enumerate() {
            if assignable(argument, wanted) {
                continue;
            }
            let (code, message) = match type_argument_mismatch(&[argument, wanted]) {
                Some(mismatch) => (CelCheckCode::TypeArgumentMismatch, mismatch),
                None => (
                    CelCheckCode::FunctionArgumentMismatch,
                    format!(
                        "{qualified} takes {} here, and this argument is {}",
                        format_type(wanted, false),
                        format_type(argument, false)
                    ),
                ),
            };
            self.report(code, message, node.args[at].range());
        }
        declared.returns.clone()
    }
}

fn literal_type(literal: &CelLiteral) -> CelType {
    match literal {
        CelLiteral::Int(_) => INT,
        CelLiteral::Uint(_) => UINT,
        CelLiteral::Double(_) => DOUBLE,
        CelLiteral::String(_) => STRING,
        CelLiteral::Bytes(_) => BYTES,
        CelLiteral::Bool(_) => BOOL,
        CelLiteral::Null => NULL,
    }
}

/// A named member read that a chain of names can continue through.
fn is_plain_step(node: &CelSelectNode) -> bool {
    !node.optional && !node.field.is_empty()
}

fn call_parts(node: &CelNode) -> (&str, CallForm, SourceRange) {
    match node {
        CelNode::Call(call) => (&call.name, CallForm::Global, call.range),
        CelNode::ReceiverCall(call) => (&call.name, CallForm::Receiver, call.range),
        _ => unreachable!("only a call is resolved"),
    }
}

fn call_arguments(node: &CelNode) -> &[Arc<CelNode>] {
    match node {
        CelNode::Call(call) => &call.args,
        CelNode::ReceiverCall(call) => &call.args,
        _ => unreachable!("only a call has arguments"),
    }
}

fn is_optional_macro(node: &CelNode) -> bool {
    let CelNode::ReceiverCall(call) = node else { return false };
    if call.name == "optMap" || call.name == "optFlatMap" {
        return true;
    }
    matches!(&*call.receiver, CelNode::Ident(ident) if ident.name == "optional")
}

/// Whether a comparison is a test against null of something that may be null.
fn is_null_test(args: &[CelType]) -> bool {
    let [left, right] = args else { return false };
    let is_null = |ty: &CelType| matches!(ty, CelType::Primitive(PrimitiveName::Null));
    (is_null(left) && admits_null(right)) || (is_null(right) && admits_null(left))
}

/// Every type a set of candidates mentions, for naming a type-argument mismatch.
fn candidate_types(failure: &ResolutionFailure) -> Vec<&CelType> {
    failure
        .candidates
        .iter()
        .flat_map(|candidate| candidate.signature.receiver.iter().chain(candidate.signature.parameters.iter()))
        .collect()
}

/// Two named types of one name whose arguments differ: invariance, a mistake of its own.
/// Only fully resolved types are compared.
fn type_argument_mismatch(types: &[&CelType]) -> Option<String> {
    let nominals: Vec<&NominalType> = types
        .iter()
        .filter_map(|ty| match ty {
            CelType::Nominal(nominal) if nominal.args.iter().all(|argument| !matches!(argument, CelType::Parameter(_))) => {
                Some(nominal)
            }
            _ => None,
        })
        .collect();
    for (at, left) in nominals.iter().enumerate() {
        for right in &nominals[at + 1..] {
            if left.name == right.name && !same_arguments(&left.args, &right.args) {
                return Some(format!(
                    "{} and {} are the same type with different type arguments, which never match",
                    format_type(&CelType::Nominal((*left).clone()), false),
                    format_type(&CelType::Nominal((*right).clone()), false)
                ));
            }
        }
    }
    None
}

fn same_arguments(left: &[CelType], right: &[CelType]) -> bool {
    left.len() == right.len() && left.iter().zip(right).all(|(left, right)| format_type(left, false) == format_type(right, false))
}

/// Which branches of a union a read is judged against. A presence-shaped read judges only
/// the branches that can hold the member or element, when any can.
fn presence_branches(union: &UnionType, elements: bool, presence: bool) -> Vec<&CelType> {
    if !presence {
        return union.members().iter().collect();
    }
    let holding: Vec<&CelType> = union.members().iter().filter(|member| holds(member, elements)).collect();
    if holding.is_empty() {
        union.members().iter().collect()
    } else {
        holding
    }
}

/// Whether a type can hold a named member (or, for `elements`, an element) at all.
fn holds(ty: &CelType, elements: bool) -> bool {
    let mut pending = vec![ty];
    while let Some(ty) = pending.pop() {
        match ty {
            CelType::Dyn | CelType::Parameter(_) | CelType::Record(_) | CelType::Map(_) => return true,
            CelType::List(_) if elements => return true,
            CelType::Nominal(nominal) if nominal.fields.is_some() => return true,
            CelType::Optional(optional) => pending.push(&optional.value),
            CelType::Union(union) => pending.extend(union.members()),
            _ => {}
        }
    }
    false
}

/// An optional of an optional is one optional; a chain of reads does not nest them.
fn unwrap_optional(ty: CelType) -> CelType {
    let mut held = ty;
    while let CelType::Optional(optional) = &held {
        let inner = (*optional.value).clone();
        held = inner;
    }
    held
}

/// `source.slice(start, end)` over UTF-16 code units, as ECMAScript slices a string.
fn utf16_slice(source: &str, start: u32, end: u32) -> String {
    let units: Vec<u16> = source.encode_utf16().collect();
    let start = (start as usize).min(units.len());
    let end = (end as usize).min(units.len());
    if end <= start {
        return String::new();
    }
    String::from_utf16_lossy(&units[start..end])
}

// --- node replacement ---------------------------------------------------------------

/// The `at`-th child of a node, in the order the tree holds them.
fn nth_child(node: &CelNode, at: usize) -> Option<&Arc<CelNode>> {
    match node {
        CelNode::Literal(_) | CelNode::Ident(_) | CelNode::Unparsed(_) => None,
        CelNode::List(list) => list.elements.get(at).map(|element| &element.value),
        CelNode::Map(map) => map.entries.get(at / 2).map(|entry| if at % 2 == 0 { &entry.key } else { &entry.value }),
        CelNode::Select(select) => (at == 0).then_some(&select.operand),
        CelNode::Index(index) => [&index.operand, &index.index].get(at).copied(),
        CelNode::Call(call) => call.args.get(at),
        CelNode::QualifiedCall(call) => call.args.get(at),
        CelNode::ReceiverCall(call) => {
            if at == 0 {
                Some(&call.receiver)
            } else {
                call.args.get(at - 1)
            }
        }
        CelNode::Unary(unary) => (at == 0).then_some(&unary.operand),
        CelNode::Binary(binary) => [&binary.left, &binary.right].get(at).copied(),
        CelNode::Conditional(conditional) => {
            [&conditional.condition, &conditional.when_true, &conditional.when_false].get(at).copied()
        }
    }
}

/// The node with its `at`-th child replaced. A map is rebuilt by [`with_entry`].
fn with_child(node: &CelNode, at: usize, child: Arc<CelNode>) -> Arc<CelNode> {
    let mut rebuilt = node.clone();
    match &mut rebuilt {
        CelNode::List(list) => list.elements[at].value = child,
        CelNode::Select(select) => select.operand = child,
        CelNode::Index(index) => *[&mut index.operand, &mut index.index][at] = child,
        CelNode::Call(call) => call.args[at] = child,
        CelNode::QualifiedCall(call) => call.args[at] = child,
        CelNode::ReceiverCall(call) => {
            if at == 0 {
                call.receiver = child;
            } else {
                call.args[at - 1] = child;
            }
        }
        CelNode::Unary(unary) => unary.operand = child,
        CelNode::Binary(binary) => *[&mut binary.left, &mut binary.right][at] = child,
        CelNode::Conditional(conditional) => {
            *[&mut conditional.condition, &mut conditional.when_true, &mut conditional.when_false][at] = child
        }
        CelNode::Literal(_) | CelNode::Ident(_) | CelNode::Unparsed(_) | CelNode::Map(_) => {
            unreachable!("a leaf has no child, and a map is rebuilt by entry")
        }
    }
    Arc::new(rebuilt)
}

fn with_entry(node: &CelNode, at: usize, key: Option<Arc<CelNode>>, value: Option<Arc<CelNode>>) -> Arc<CelNode> {
    let mut rebuilt = node.clone();
    let CelNode::Map(map) = &mut rebuilt else { unreachable!("only a map has entries") };
    let entry = &mut map.entries[at];
    if let Some(key) = key {
        entry.key = key;
    }
    if let Some(value) = value {
        entry.value = value;
    }
    Arc::new(rebuilt)
}

/// The tree with one node swapped — the first occurrence, by identity, in Node's search
/// order — or nothing when the node is not in it. A map entry asks its key and its value
/// both, and replaces in each; every other node stops at the first child holding it.
fn replace_node(root: &Arc<CelNode>, from: &CelNode, to: &Arc<CelNode>) -> Option<Arc<CelNode>> {
    /// One activation: the node, the next child it will ask, and a map key's answer.
    struct Frame<'t> {
        node: &'t Arc<CelNode>,
        next: usize,
        key: Option<Arc<CelNode>>,
    }
    enum Visit<'t> {
        Enter(&'t Arc<CelNode>),
        Answer(Option<Arc<CelNode>>),
    }
    let mut frames: Vec<Frame<'_>> = Vec::new();
    let mut visit = Visit::Enter(root);
    loop {
        visit = match visit {
            Visit::Enter(node) => {
                if std::ptr::eq(&**node, from) {
                    Visit::Answer(Some(Arc::clone(to)))
                } else {
                    match nth_child(node, 0) {
                        None => Visit::Answer(None),
                        Some(child) => {
                            frames.push(Frame { node, next: 1, key: None });
                            Visit::Enter(child)
                        }
                    }
                }
            }
            Visit::Answer(answer) => {
                let Some(frame) = frames.last_mut() else { return answer };
                let node = frame.node;
                let answered = frame.next - 1;
                let rebuilt = if let CelNode::Map(_) = &**node {
                    if answered % 2 == 0 {
                        // A key: its value is asked whatever the key answered.
                        frame.key = answer;
                        frame.next += 1;
                        visit = Visit::Enter(nth_child(node, answered + 1).expect("an entry has a value"));
                        continue;
                    }
                    let key = frame.key.take();
                    (key.is_some() || answer.is_some()).then(|| with_entry(node, answered / 2, key, answer))
                } else {
                    answer.map(|child| with_child(node, answered, child))
                };
                match rebuilt {
                    Some(rebuilt) => {
                        frames.pop();
                        Visit::Answer(Some(rebuilt))
                    }
                    None => match nth_child(node, frame.next) {
                        Some(child) => {
                            frame.next += 1;
                            Visit::Enter(child)
                        }
                        None => {
                            frames.pop();
                            Visit::Answer(None)
                        }
                    },
                }
            }
        };
    }
}
