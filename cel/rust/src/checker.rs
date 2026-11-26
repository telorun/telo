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

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use telorun_cel_value::{compare_code_units, json_quote, CelValue};

use crate::cel_expression::CelExpression;
use crate::cel_type::{
    admits_null, assignable, format_type, is_dyn, is_numeric, list_of, map_of, optional_of, parameter_of, types_equal, unify, union_of,
    walk_key, without_null, without_parameters, CelType, FieldEnumValue, ListType, NominalType, PrimitiveName, RecordType, UnionType,
    WalkKey, BOOL, BYTES, DOUBLE, DYN, INT, NULL, STRING, UINT,
};
use crate::cel_value::literal_value;
use crate::check_diagnostic::{CelCheckCode, CelCheckDiagnostic, CelDiagnosticFix};
use crate::construction::{construction_target, duplicate_field_message, unknown_field_message, ConstructionTypes};
use crate::declared_chain::split_declared_chain;
use crate::function_registry::{
    describe_arguments, describe_candidates, expanded_members, Expansion, FunctionRegistry, RegisteredFunction,
    ResolutionFailure, ResolutionFailureReason, UNION_EXPANSION_LIMIT,
};
use crate::macro_check::{is_macro_call, macro_hands_on, resume_macro, start_macro, MacroFrame, MacroHost, MacroStep};
use crate::macro_shape::macro_shape_findings;
use crate::nominal_type::RegisteredType;
use crate::nullable_access::{
    chain_text, chain_text_root, is_type_call, proven_where_false, proven_where_true, select_chain_text, type_tested_chain,
    EqualityProof, Proof,
};
use crate::record_member::{read_record_member, record_member_edges, record_members};
use crate::resolved_call::ResolvedCall;
use crate::schema_dependencies::{
    kept_in, EdgeKey, SchemaDependency, SchemaDependencyRecorder, SchemaProvenance, ELEMENT_EDGE,
};
use crate::schema_nodes::{address, node_key, same_type, BranchRead, ResultOrigin, SchemaNodeAt, SchemaNodeLocator};
use crate::serializer::{literal_source, member_name_source, serialize_tree};
use crate::signature::{format_signature, CallForm};
use crate::syntax_tree::{
    CelBinaryNode, CelBinaryOperator, CelCallNode, CelConditionalNode, CelIdentNode, CelIndexNode, CelListNode,
    CelLiteral, CelMapNode, CelNode, CelQualifiedCallNode, CelReceiverCallNode, CelSelectNode, CelStructNode,
    SourceRange,
};
use crate::type_visits::count_type_visit;
use crate::value_equality::cel_equal;
use crate::value_text::es_to_lower_case;

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
    /// Present exactly when the host asked: every schema node the verdicts and the result
    /// type read, each once, in the order first read (`schema_dependencies.rs`).
    pub schema_dependencies: Option<Vec<SchemaDependency>>,
    /// Present exactly when the host asked for schema nodes: every place the result may
    /// have come from, in written order (`schema_nodes.rs`), each with the schema node it was
    /// read straight from where it was.
    pub result_origins: Option<Vec<ResultOrigin>>,
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
    /// Where a variable's types came from, where it was typed from a schema.
    pub(crate) variable_provenance: Box<dyn Fn(&str) -> Option<&'e Arc<SchemaProvenance>> + 'e>,
    /// Whether the check lists the schema nodes it read.
    pub(crate) schema_dependencies: bool,
    /// Whether the check names the schema node each verdict and the result was read from.
    pub(crate) schema_nodes: bool,
    pub(crate) declared_variable_names: Box<dyn Fn() -> Vec<&'e str> + 'e>,
    pub(crate) namespace_function: Box<dyn Fn(&str, &str) -> Option<&'e NamespaceFunction> + 'e>,
    /// Where a namespaced function's result types came from, where the host declared the
    /// result as a JSON Schema document: a call reads it as a schema-typed variable is read.
    pub(crate) namespace_result_provenance: Box<dyn Fn(&str, &str) -> Option<&'e Arc<SchemaProvenance>> + 'e>,
    /// Whether a namespace declares only part of what it reaches: a name it did not
    /// declare types `dyn`, is listed, and is reported by nobody.
    pub(crate) namespace_is_open: Box<dyn Fn(&str) -> bool + 'e>,
    /// The registered types a construction's name is resolved against.
    pub(crate) construction: ConstructionTypes<'e>,
    /// The type a name denotes as a type value (`string`, `list`, a registered type's name).
    pub(crate) type_named: Box<dyn Fn(&str) -> Option<CelType> + 'e>,
    pub(crate) options: CheckerOptions,
    /// What is known at the expression's site, in the order the host hands it over.
    pub(crate) assumptions: Vec<CheckerAssumption>,
}

/// A condition known to have held (`holds`) or failed on the way to the expression, read as
/// if a conditional enclosed it; a proof rooted at a `rebound` chain — one that may denote
/// another value at the site — is dropped.
pub(crate) struct CheckerAssumption {
    pub(crate) condition: Arc<CelNode>,
    pub(crate) holds: bool,
    pub(crate) rebound: Vec<String>,
}

pub(crate) fn check_expression(expression: &CelExpression, context: &CheckerContext<'_>) -> CheckResult {
    Checker {
        expression,
        context,
        diagnostics: Vec::new(),
        calls: Vec::new(),
        scopes: HashMap::new(),
        proven: HashMap::new(),
        type_arguments: HashMap::new(),
        type_test_keys: HashMap::new(),
        longest_variable: None,
        source_units: None,
        reads: context.schema_dependencies.then(SchemaDependencyRecorder::default),
        nodes: context.schema_nodes.then(SchemaNodeLocator::default),
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
    /// A construction's field `at` is typed; `registered` is the type its name resolved
    /// to, nothing where the name was refused, and `written` the fields judged so far.
    Struct { node: &'a CelStructNode, registered: Option<&'a RegisteredType>, at: usize, written: HashSet<&'a str> },
    Select { node: &'a CelSelectNode, presence: bool },
    IndexOperand { node: &'a CelIndexNode },
    IndexIndex { node: &'a CelIndexNode, operand: CelType },
    /// `comparison`: the binary node, which a type test's proofs name.
    Operator {
        operator: &'static str,
        operands: Vec<&'a CelNode>,
        args: Vec<CelType>,
        range: SourceRange,
        comparison: Option<&'a CelNode>,
    },
    /// `held`: when the left operand joins with the same operator, the proofs its own
    /// left made, still in scope — part of what this one proves.
    LogicalLeft { node: &'a CelBinaryNode, held: Vec<(String, Fact)> },
    LogicalRight { node: &'a CelBinaryNode, left: CelType },
    Condition { node: &'a CelConditionalNode },
    WhenTrue { node: &'a CelConditionalNode },
    WhenFalse { node: &'a CelConditionalNode, when_true: CelType },
    CallReceiver { node: &'a CelNode },
    CallArguments { node: &'a CelNode, receiver: Option<CelType>, args: Vec<CelType> },
    QualifiedArguments { node: &'a CelQualifiedCallNode, args: Vec<CelType> },
    Macro(MacroFrame<'a>),
    /// A macro's scope closes, and the proofs about its name it suspended hold again.
    Unbind(&'a str, Vec<(String, Vec<Fact>)>),
    /// A guard's proofs go out of scope.
    Unprove(Vec<(String, Fact)>),
}

/// What the guards around a walk know of a chain: a proof, its type test typed.
#[derive(Clone, Debug, PartialEq)]
enum Fact {
    NonNull,
    Member(String),
    /// A type test against the runtime type `key` came out `holds`.
    TypeIs { key: String, holds: bool },
    /// An equality or membership test came out as it says.
    Equals(EqualityProof),
}

struct Checker<'a, 'e> {
    expression: &'a CelExpression,
    context: &'a CheckerContext<'e>,
    diagnostics: Vec<CelCheckDiagnostic>,
    calls: Vec<ResolvedCall>,
    /// Every name a macro bound, its innermost binding last, beside the schema node its
    /// value was read from.
    scopes: HashMap<&'a str, Vec<(CelType, Option<SchemaNodeAt>)>>,
    /// What the guards around the walk prove, by the chain each proof names.
    proven: HashMap<String, Vec<Fact>>,
    /// The argument type of each `type(x)` call typed so far, by the call's node key: what a
    /// type test compares.
    type_arguments: HashMap<usize, CelType>,
    /// Per type-test comparison, the runtime type each tested chain is compared with.
    type_test_keys: HashMap<usize, Vec<(String, String)>>,
    /// The length of the longest declared name, once a chain asks.
    longest_variable: Option<usize>,
    /// The source as UTF-16 code units, once a refusal quotes it.
    source_units: Option<Vec<u16>>,
    /// The schema nodes read so far, where the host asked for them.
    reads: Option<SchemaDependencyRecorder>,
    /// The schema node each subexpression was read from, where the host asked for them.
    nodes: Option<SchemaNodeLocator>,
}

impl MacroHost for Checker<'_, '_> {
    fn report(&mut self, code: CelCheckCode, message: String, range: SourceRange) {
        self.report_at(code, message, range, None);
    }

    fn report_at(&mut self, code: CelCheckCode, message: String, range: SourceRange, node: Option<SchemaNodeAt>) {
        let schema_node = node.map(|node| node.dependency());
        self.diagnostics.push(CelCheckDiagnostic { code, message, range, fix: None, schema_node, absent: false });
    }

    fn read_member(&mut self, container: &CelType, key: &str) {
        self.read_edge(container, &EdgeKey::member(key));
    }

    fn node_at(&self, node: &CelNode) -> Option<SchemaNodeAt> {
        self.nodes.as_ref()?.at(node_key(node))
    }

    fn member_node(&self, container: &CelType, key: &str) -> Option<SchemaNodeAt> {
        self.nodes.as_ref()?.member(container, &EdgeKey::member(key))
    }

    fn union_member_node(&self, union: &CelType, at: usize) -> Option<SchemaNodeAt> {
        self.nodes.as_ref()?.union_member(union, at)
    }

    fn locate(&mut self, key: usize, at: Option<SchemaNodeAt>) {
        if let Some(nodes) = &mut self.nodes {
            nodes.locate(key, at);
        }
    }

    fn relay(&mut self, key: usize, answers: &[(&CelNode, &CelType)]) {
        if let Some(nodes) = &mut self.nodes {
            nodes.relay(key, answers.iter().map(|(node, ty)| (node_key(node), node.range(), (*ty).clone())).collect());
        }
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
        let context = self.context;
        for assumption in &context.assumptions {
            self.assume(assumption);
        }
        let answered = self.type_of(&expression.root);
        self.read_whole(&answered);
        // The type is reported, so a parameter nothing resolved in it is `dyn`.
        let ty = without_parameters(&answered);
        let result_origins =
            self.nodes.as_ref().map(|nodes| nodes.origins(node_key(&expression.root), expression.root.range(), answered));
        CheckResult {
            valid: self.diagnostics.is_empty(),
            type_name: format_type(&ty, true),
            ty,
            diagnostics: self.diagnostics,
            calls: self.calls,
            schema_dependencies: self.reads.map(SchemaDependencyRecorder::dependencies),
            result_origins,
        }
    }

    /// What an assumption proves, from here on: its condition is typed — so a type test it
    /// holds is decided — under what the assumptions before it prove, with nothing it says
    /// reported or recorded, since it is the host's own site to judge.
    fn assume(&mut self, assumption: &'a CheckerAssumption) {
        let diagnostics = std::mem::take(&mut self.diagnostics);
        let calls = self.calls.len();
        let reads = self.reads.take();
        let nodes = self.nodes.take();
        self.type_of(&assumption.condition);
        self.diagnostics = diagnostics;
        self.calls.truncate(calls);
        self.reads = reads;
        self.nodes = nodes;
        let proofs = if assumption.holds { proven_where_true(&assumption.condition) } else { proven_where_false(&assumption.condition) };
        let kept = proofs
            .into_iter()
            .filter(|proof| {
                !assumption.rebound.iter().any(|chain| {
                    proof.chain == *chain || proof.chain.strip_prefix(chain.as_str()).is_some_and(|rest| rest.starts_with('.'))
                })
            })
            .collect();
        self.add_proofs(kept);
    }

    fn report_with_fix(&mut self, code: CelCheckCode, message: String, range: SourceRange, fix: Option<CelDiagnosticFix>) {
        self.diagnostics.push(CelCheckDiagnostic { code, message, range, fix, schema_node: None, absent: false });
    }

    /// The first of several subexpressions located at a schema node: what a verdict over
    /// them names.
    fn first_node(&self, nodes: &[&CelNode]) -> Option<SchemaNodeAt> {
        self.nodes.as_ref()?;
        nodes.iter().find_map(|node| self.node_at(node))
    }

    /// The node a type narrowed from another was read from: the narrowed member's own
    /// node, where the narrowing kept one member of a union, else the node the whole was.
    fn narrowed_node(&self, from: &CelType, to: &CelType, whole: Option<SchemaNodeAt>) -> Option<SchemaNodeAt> {
        let nodes = self.nodes.as_ref()?;
        let CelType::Union(union) = from else { return whole };
        match union.members().iter().position(|member| same_type(member, to)) {
            Some(at) => nodes.union_member(from, at).or(whole),
            None => whole,
        }
    }

    /// A descent from a container into the member an edge key names.
    fn read_edge(&mut self, container: &CelType, key: &EdgeKey) {
        if let Some(reads) = &mut self.reads {
            reads.read_member(container, key);
        }
    }

    /// The node a member read was read from: a member or element of a type a conversion
    /// built, through one optional layer — a tuple's position or rest where a literal
    /// `position` names one. Nothing for a union's members read together.
    fn read_node(&self, operand: &CelType, key: Option<&str>, position: Option<usize>) -> Option<SchemaNodeAt> {
        let nodes = self.nodes.as_ref()?;
        let held = match operand {
            CelType::Optional(optional) => &*optional.value,
            other => other,
        };
        match held {
            CelType::Record(record) => {
                let reading = read_record_member(record, key?);
                if reading.absent {
                    return None;
                }
                nodes.member(held, &reading.placed?)
            }
            CelType::List(list) => nodes.member(held, &tuple_edge(list, position).unwrap_or_else(|| EdgeKey::member(ELEMENT_EDGE))),
            CelType::Map(map) if assignable(&STRING, &map.key) => nodes.member(held, &EdgeKey::member(ELEMENT_EDGE)),
            _ => None,
        }
    }

    /// The node a union's branch was read from, else the node the union was.
    fn branch_node(&self, union: &CelType, branch: &CelType, subject: &Option<SchemaNodeAt>) -> Option<SchemaNodeAt> {
        let nodes = self.nodes.as_ref()?;
        let CelType::Union(held) = union else { return subject.clone() };
        held.members()
            .iter()
            .position(|member| std::ptr::eq(member, branch))
            .and_then(|at| nodes.union_member(union, at))
            .or_else(|| subject.clone())
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
            CelNode::Ident(ident) => {
                let ty = self.ident_type(ident);
                Step::Return(self.narrowed(address(ident), || Some(ident.name.clone()), ty))
            }
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
            CelNode::Struct(node) => {
                // A refused name types the construction `dyn`, its values still checked for
                // what is wrong inside them.
                let registered = match construction_target(&node.type_name, &self.context.construction) {
                    Ok(registered) => Some(registered),
                    Err(refusal) => {
                        self.report(refusal.code, refusal.message, node.type_name_range);
                        None
                    }
                };
                match node.entries.first() {
                    None => Step::Return(self.finish_struct(node, registered, &HashSet::new())),
                    Some(first) => {
                        stack.push(Cont::Struct { node, registered, at: 0, written: HashSet::new() });
                        Step::Eval(&first.value, false)
                    }
                }
            }
            CelNode::Select(select) => self.start_select(select, select.optional, absent, stack),
            CelNode::Index(index) => {
                stack.push(Cont::IndexOperand { node: index });
                Step::Eval(&index.operand, false)
            }
            CelNode::Unary(unary) => {
                self.start_operator(unary.operator.as_str(), vec![&*unary.operand], unary.range, None, stack)
            }
            CelNode::Binary(binary) => match binary.operator {
                CelBinaryOperator::And | CelBinaryOperator::Or => {
                    stack.push(Cont::LogicalLeft { node: binary, held: Vec::new() });
                    Step::Eval(&binary.left, false)
                }
                operator => {
                    self.start_operator(operator.as_str(), vec![&*binary.left, &*binary.right], binary.range, Some(node), stack)
                }
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

    /// A use of a type: everything beneath it is read.
    fn read_whole(&mut self, ty: &CelType) {
        if let Some(reads) = &mut self.reads {
            reads.read_whole(ty);
        }
    }

    fn resume(&mut self, cont: Cont<'a>, ty: CelType, stack: &mut Vec<Cont<'a>>) -> Step<'a> {
        // A parent that descends into the type, or hands it on unread, reads only what it
        // reaches; every other parent uses it.
        let hands_on = match &cont {
            Cont::Select { .. } | Cont::IndexOperand { .. } | Cont::Unbind(..) | Cont::Unprove(_) => true,
            Cont::Macro(at) => macro_hands_on(at),
            _ => false,
        };
        if !hands_on {
            self.read_whole(&ty);
        }
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
            Cont::Struct { node, registered, at, mut written } => {
                if let Some(registered) = registered {
                    self.check_struct_entry(node, registered, at, ty, &mut written);
                }
                match node.entries.get(at + 1) {
                    Some(next) => {
                        stack.push(Cont::Struct { node, registered, at: at + 1, written });
                        Step::Eval(&next.value, false)
                    }
                    None => Step::Return(self.finish_struct(node, registered, &written)),
                }
            }
            Cont::Select { node, presence } => {
                let ty = self.finish_select(node, presence, ty);
                Step::Return(if presence { ty } else { self.narrowed(address(node), || select_chain_text(node), ty) })
            }
            Cont::IndexOperand { node } => {
                stack.push(Cont::IndexIndex { node, operand: ty });
                Step::Eval(&node.index, false)
            }
            Cont::IndexIndex { node, operand } => Step::Return(self.finish_index(node, operand, ty)),
            Cont::Operator { operator, operands, mut args, range, comparison } => {
                args.push(ty);
                if let Some(next) = operands.get(args.len()).copied() {
                    stack.push(Cont::Operator { operator, operands, args, range, comparison });
                    return Step::Eval(next, false);
                }
                Step::Return(self.finish_operator(operator, &operands, &args, range, comparison))
            }
            Cont::LogicalLeft { node, held } => {
                let proven = if node.operator == CelBinaryOperator::And { proven_where_true } else { proven_where_false };
                // A left operand joining with the same operator proves its two operands'
                // proofs, and those of its own left are `held`: only its right is new.
                let unproven = match &*node.left {
                    CelNode::Binary(left) if left.operator == node.operator => &left.right,
                    left => left,
                };
                let mut proofs = held;
                proofs.extend(self.add_proofs(proven(unproven)));
                stack.push(Cont::LogicalRight { node, left: ty });
                self.hand_on_or_unprove(node, proofs, stack);
                Step::Eval(&node.right, false)
            }
            Cont::LogicalRight { node, left } => {
                for (operand, written) in [(&left, &*node.left), (&ty, &*node.right)] {
                    if !is_dyn(operand) && !assignable(operand, &BOOL) {
                        let at = self.node_at(written);
                        self.report_at(
                            CelCheckCode::TypeError,
                            format!(
                                "{} joins bool values, and {} is not one",
                                node.operator.as_str(),
                                format_type(operand, false)
                            ),
                            node.range,
                            at,
                        );
                    }
                }
                Step::Return(BOOL)
            }
            Cont::Condition { node } => {
                if !is_dyn(&ty) && !assignable(&ty, &BOOL) {
                    let at = self.node_at(&node.condition);
                    self.report_at(
                        CelCheckCode::TypeError,
                        format!("a condition must be bool, and this one is {}", format_type(&ty, false)),
                        node.condition.range(),
                        at,
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
                self.relay(address(node), &[(&node.when_true, &when_true), (&node.when_false, &ty)]);
                let unified = unify(&when_true, &ty);
                // A value read out of a conditional has one type, so two branches that share
                // none is a mistake rather than a `dyn`.
                if is_dyn(&unified) && !is_dyn(&when_true) && !is_dyn(&ty) {
                    let at = self.first_node(&[&node.when_true, &node.when_false]);
                    self.report_at(
                        CelCheckCode::TypeError,
                        format!(
                            "the branches of a condition answer {} and {}, which are not one type",
                            format_type(&when_true, false),
                            format_type(&ty, false)
                        ),
                        node.range,
                        at,
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
            Cont::Unbind(name, suspended) => {
                if let Some(held) = self.scopes.get_mut(name) {
                    held.pop();
                    if held.is_empty() {
                        self.scopes.remove(name);
                    }
                }
                for (chain, proofs) in suspended {
                    self.proven.entry(chain).or_default().extend(proofs);
                }
                Step::Return(ty)
            }
            Cont::Unprove(proofs) => {
                for (chain, fact) in proofs {
                    if let Some(held) = self.proven.get_mut(&chain) {
                        if let Some(at) = held.iter().rposition(|held| *held == fact) {
                            held.remove(at);
                        }
                        if held.is_empty() {
                            self.proven.remove(&chain);
                        }
                    }
                }
                Step::Return(ty)
            }
        }
    }

    /// The proofs of a guard, in scope until the continuation pushed here runs.
    fn prove(&mut self, proofs: Vec<Proof>, stack: &mut Vec<Cont<'a>>) {
        let proofs = self.add_proofs(proofs);
        if !proofs.is_empty() {
            stack.push(Cont::Unprove(proofs));
        }
    }

    fn add_proofs(&mut self, proofs: Vec<Proof>) -> Vec<(String, Fact)> {
        let mut added = Vec::new();
        for proof in proofs {
            let Some(fact) = self.fact_of(&proof) else { continue };
            let key = self.proof_key(&proof.chain);
            self.proven.entry(key.clone()).or_default().push(fact.clone());
            added.push((key, fact));
        }
        added
    }

    /// The key a chain's proofs are held under here: the absolute spelling wherever its root
    /// is bound by nothing, so a guard on `x.a` outside a binding of `x` proves `.x.a` and the
    /// reverse, while one rooted at a bound name stays that binding's.
    fn proof_key(&self, chain: &str) -> String {
        match chain_text_root(chain) {
            Some(root) if !self.scopes.contains_key(root) => format!(".{chain}"),
            _ => chain.to_string(),
        }
    }

    /// What a proof says once its comparison is typed: a type test names the runtime type
    /// its chain was compared with, and is no proof where the other side named none.
    fn fact_of(&self, proof: &Proof) -> Option<Fact> {
        if let Some(equals) = &proof.equals {
            return Some(Fact::Equals(equals.clone()));
        }
        match (&proof.type_test, &proof.member) {
            (Some((comparison, holds)), _) => {
                let keys = self.type_test_keys.get(comparison)?;
                let (_, key) = keys.iter().find(|(chain, _)| *chain == proof.chain)?;
                Some(Fact::TypeIs { key: key.clone(), holds: *holds })
            }
            (None, Some(member)) => Some(Fact::Member(member.clone())),
            (None, None) => Some(Fact::NonNull),
        }
    }

    /// Which runtime type each chain a comparison tests with `type(chain)` is compared with:
    /// the other side is a name denoting a type value, or `type(e)` over a single known type.
    fn record_type_test(&mut self, comparison: &CelNode, operands: &[&CelNode], args: &[CelType]) {
        let mut keys: Vec<(String, String)> = Vec::new();
        for (side, other) in [(0, 1), (1, 0)] {
            let Some(chain) = type_tested_chain(operands[side]) else { continue };
            if !is_type_value(&args[side]) {
                continue;
            }
            let Some(key) = self.compared_type_key(operands[other], &args[other]) else { continue };
            if !keys.iter().any(|(held, _)| *held == chain) {
                keys.push((chain, key));
            }
        }
        if !keys.is_empty() {
            self.type_test_keys.insert(node_key(comparison), keys);
        }
    }

    /// The runtime type a type test's other side names, where it names exactly one.
    fn compared_type_key(&self, node: &CelNode, ty: &CelType) -> Option<String> {
        if !is_type_value(ty) {
            return None;
        }
        if is_type_call(node) {
            return runtime_type_key(self.type_arguments.get(&node_key(node))?);
        }
        let chain = chain_text(node)?;
        let name = match chain_text_root(&chain) {
            Some(root) if self.scopes.contains_key(root) => return None,
            Some(_) => chain.as_str(),
            None => &chain[1..],
        };
        runtime_type_key(&(self.context.type_named)(name)?)
    }

    /// Takes out the proofs about a name a scope binds again: none holds beneath it.
    fn suspend_proofs(&mut self, name: &str) -> Vec<(String, Vec<Fact>)> {
        if self.proven.is_empty() {
            return Vec::new();
        }
        let rebound: Vec<String> = self.proven.keys().filter(|chain| chain_text_root(chain) == Some(name)).cloned().collect();
        rebound.into_iter().filter_map(|chain| self.proven.remove_entry(&chain)).collect()
    }

    fn proven_non_null(&self, chain: &str) -> bool {
        self.proven.get(&self.proof_key(chain)).is_some_and(|held| held.contains(&Fact::NonNull))
    }

    /// A plain chain's type where a guard proved something of it: without null where it is
    /// proven non-null, only the shapes holding a member `has()` proved it holds, only the
    /// members a type test left, and only those an equality or membership test left. A
    /// narrowing leaving nothing leaves the type as it is. It is located at the remaining
    /// branch's node.
    fn narrowed(&mut self, key: usize, chain: impl FnOnce() -> Option<String>, ty: CelType) -> CelType {
        if self.proven.is_empty() || !matches!(ty, CelType::Union(_)) {
            return ty;
        }
        let Some(proofs) = chain().and_then(|chain| self.proven.get(&self.proof_key(&chain))) else { return ty };
        let mut narrowed = ty.clone();
        let mut changed = false;
        for proof in proofs {
            match proof {
                Fact::TypeIs { key: tested, holds } => {
                    let CelType::Union(union) = &narrowed else { continue };
                    let kept: Vec<CelType> = union
                        .members()
                        .iter()
                        .filter(|member| runtime_type_key(member).is_none_or(|held| (held == *tested) == *holds))
                        .cloned()
                        .collect();
                    if !kept.is_empty() && kept.len() < union.members().len() {
                        narrowed = union_of(kept);
                        changed = true;
                    }
                }
                Fact::NonNull => {
                    if admits_null(&narrowed) && matches!(narrowed, CelType::Union(_)) {
                        narrowed = without_null(&narrowed);
                        changed = true;
                    }
                }
                Fact::Member(member) => {
                    let CelType::Union(union) = &narrowed else { continue };
                    let holding: Vec<CelType> =
                        union.members().iter().filter(|branch| can_hold_member(branch, member, false)).cloned().collect();
                    if !holding.is_empty() && holding.len() < union.members().len() {
                        narrowed = union_of(holding);
                        changed = true;
                    }
                }
                Fact::Equals(equals) => {
                    let CelType::Union(union) = &narrowed else { continue };
                    let kept: Vec<CelType> = union
                        .members()
                        .iter()
                        .filter(|member| match &equals.member {
                            None => may_equal_any(member, &equals.values),
                            Some(field) => discriminant_keeps(member, field, equals),
                        })
                        .cloned()
                        .collect();
                    if !kept.is_empty() && kept.len() < union.members().len() {
                        narrowed = union_of(kept);
                        changed = true;
                    }
                }
            }
        }
        if changed && self.nodes.is_some() {
            let whole = self.nodes.as_ref().and_then(|nodes| nodes.at(key));
            let at = self.narrowed_node(&ty, &narrowed, whole);
            self.locate(key, at);
        }
        narrowed
    }

    /// Scopes the proofs of a `&&` / `||` to its right operand. When it is itself the left
    /// operand of the same operator, they stay in scope and pass to that one, whose
    /// proofs include them, so a chain proves each of its operands once.
    fn hand_on_or_unprove(&mut self, node: &'a CelBinaryNode, proofs: Vec<(String, Fact)>, stack: &mut Vec<Cont<'a>>) {
        if let Some(Cont::LogicalLeft { node: parent, held }) = stack.iter_mut().rev().nth(1) {
            let joins = matches!(&*parent.left, CelNode::Binary(left) if std::ptr::eq(left, node));
            if joins && parent.operator == node.operator {
                *held = proofs;
                return;
            }
        }
        if !proofs.is_empty() {
            stack.push(Cont::Unprove(proofs));
        }
    }

    fn macro_step(&mut self, step: MacroStep<'a>, stack: &mut Vec<Cont<'a>>) -> Step<'a> {
        match step {
            MacroStep::Done(ty) => Step::Return(ty),
            MacroStep::TypeOf(node, at) => {
                stack.push(Cont::Macro(at));
                Step::Eval(node, false)
            }
            MacroStep::TypeOfBinding(node, name, ty, bound, proofs, at) => {
                stack.push(Cont::Macro(at));
                self.scopes.entry(name).or_default().push((ty, bound));
                let suspended = self.suspend_proofs(name);
                stack.push(Cont::Unbind(name, suspended));
                self.prove(proofs, stack);
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
            if let Some((bound, at)) = self.scopes.get(node.name.as_str()).and_then(|held| held.last()).cloned() {
                self.locate(address(node), at);
                return bound;
            }
        }
        if let Some(declared) = (self.context.variable)(&node.name) {
            let at = self.read_variable(&node.name);
            self.locate(address(node), at);
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
                let at = self.node_at(node);
                self.report_at(
                    CelCheckCode::TypeError,
                    format!("{what} written with '?' holds an optional, and this one is {}", format_type(&ty, false)),
                    node.range(),
                    at,
                );
                DYN
            }
        }
    }

    /// One field of a construction, its value typed: written twice, undeclared, required and
    /// written with `?`, or holding a value its field does not take.
    fn check_struct_entry(
        &mut self,
        node: &'a CelStructNode,
        registered: &RegisteredType,
        at: usize,
        ty: CelType,
        written: &mut HashSet<&'a str>,
    ) {
        let entry = &node.entries[at];
        let value = if entry.optional { self.held_by_optional(ty, &entry.value, "a field") } else { ty };
        let own = &registered.self_type;
        if !written.insert(&entry.field) {
            self.report(CelCheckCode::InvalidArgument, duplicate_field_message(own, &entry.field), entry.field_range);
            return;
        }
        let fields = own.fields.as_ref().expect("a constructible type declares its fields");
        let Some(declared) = fields.get(&entry.field) else {
            self.report(CelCheckCode::UnknownField, unknown_field_message(own, &entry.field), entry.field_range);
            return;
        };
        let name = format_type(&CelType::Nominal(own.clone()), false);
        if entry.optional && registered.required.contains(&entry.field) {
            self.report(
                CelCheckCode::MissingField,
                format!(
                    "{name} requires the field {}, which an entry written with '?' may leave unset",
                    json_quote(&entry.field)
                ),
                entry.field_range,
            );
        }
        if !assignable(&value, declared) {
            let message = format!(
                "field {} of {name} is {}, and this value is {}",
                json_quote(&entry.field),
                format_type(declared, false),
                format_type(&value, false)
            );
            let at = self.node_at(&entry.value);
            self.report_at(CelCheckCode::TypeError, message, entry.value.range(), at);
        }
    }

    /// A construction's type once its fields are judged: the named type, every required
    /// field it does not write reported, or `dyn` where its name was refused.
    fn finish_struct(&mut self, node: &CelStructNode, registered: Option<&RegisteredType>, written: &HashSet<&str>) -> CelType {
        let Some(registered) = registered else { return DYN };
        let own = CelType::Nominal(registered.self_type.clone());
        for field in &registered.required {
            if written.contains(field.as_str()) {
                continue;
            }
            self.report(
                CelCheckCode::MissingField,
                format!(
                    "{} requires the field {}, and this construction does not write it",
                    format_type(&own, false),
                    json_quote(field)
                ),
                node.range,
            );
        }
        own
    }

    /// One type for several written values. Mixed types are `dyn` unless the environment
    /// asked for homogeneous aggregates, where the mixture is the mistake.
    fn reduce(&mut self, types: &[CelType], nodes: &[&CelNode], what: &str) -> CelType {
        let mut reduced = types[0].clone();
        for (at, ty) in types.iter().enumerate().skip(1) {
            let next = unify(&reduced, ty);
            if self.context.options.homogeneous_aggregate_literals && is_dyn(&next) && !is_dyn(&reduced) && !is_dyn(ty) {
                let node = self.node_at(nodes[at]);
                self.report_at(
                    CelCheckCode::TypeError,
                    format!("this {what} is {} where the others are {}", format_type(ty, false), format_type(&reduced, false)),
                    nodes[at].range(),
                    node,
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
                return Step::Return(if presence {
                    qualified
                } else {
                    self.narrowed(address(node), || select_chain_text(node), qualified)
                });
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
        let from = self.nodes.is_some().then(|| operand.clone());
        let guarded = self.check_nullable(&node.operand, operand, &format!(".{}", node.field), node.field_range);
        let subject = from.and_then(|from| self.narrowed_node(&from, &guarded, self.node_at(&node.operand)));
        let mut branches = self.nodes.is_some().then(Vec::new);
        let held = self.member_type(&guarded, &node.field, node.field_range, presence, subject, branches.as_mut(), Some(&node.operand));
        let at = self.read_node(&guarded, Some(&node.field), None);
        self.locate(address(node), at);
        // Reading through an optional answers an optional, whichever form the read is
        // written in, and is one value, the optional, whichever branch it read.
        let wrapped = node.optional || matches!(guarded, CelType::Optional(_));
        if let (Some(nodes), Some(branches), false) = (&mut self.nodes, branches, wrapped) {
            nodes.union_read(address(node), branches);
        }
        if wrapped {
            optional_of(held)
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
        let mut at = self.read_variable(&split.name);
        for (name, range) in &segments[segments.len() - split.rest.len()..] {
            let read = self.member_type(&held, name, *range, false, at, None, None);
            at = self.read_node(&held, Some(name), None);
            // Reading through an optional answers an optional, as a select does.
            held = if matches!(held, CelType::Optional(_)) { optional_of(read) } else { read };
        }
        self.locate(address(node), at);
        Some(held)
    }

    /// A variable read: its schema nodes, and the node its type was read from.
    fn read_variable(&mut self, name: &str) -> Option<SchemaNodeAt> {
        let provenance = (self.context.variable_provenance)(name);
        if let Some(reads) = &mut self.reads {
            reads.read_registration(provenance);
        }
        self.nodes.as_mut()?.registration(provenance)
    }

    /// The members a read over a union's branches answers. A member the union drops as
    /// equal to another is read whole: the answer would differ if it differed.
    fn joined(&mut self, members: Vec<CelType>) -> CelType {
        let ty = union_of(members.iter().cloned());
        if let Some(reads) = &mut self.reads {
            for member in &members {
                if !kept_in(&ty, member) {
                    reads.read_whole(member);
                }
            }
        }
        ty
    }

    fn longest_variable(&mut self) -> usize {
        if let Some(longest) = self.longest_variable {
            return longest;
        }
        let longest = (self.context.declared_variable_names)().iter().map(|name| name.len()).max().unwrap_or(0);
        self.longest_variable = Some(longest);
        longest
    }

    /// The type of a named member, reported against whatever the operand turned out to be;
    /// `subject` is the node the operand was read from.
    /// `branches` collects what each branch of a union operand answered.
    fn member_type(
        &mut self,
        operand: &CelType,
        field: &str,
        range: SourceRange,
        presence: bool,
        subject: Option<SchemaNodeAt>,
        mut branches: Option<&mut Vec<BranchRead>>,
        operand_node: Option<&CelNode>,
    ) -> CelType {
        enum Task<'t> {
            Visit(&'t CelType, bool, Option<SchemaNodeAt>),
            Union(usize, Vec<&'t CelType>),
        }
        let mut results: Vec<CelType> = Vec::new();
        let mut tasks = vec![Task::Visit(operand, false, subject.clone())];
        while let Some(task) = tasks.pop() {
            let (ty, layered, at) = match task {
                Task::Union(count, read) => {
                    let members = results.split_off(results.len() - count);
                    if let Some(branches) = branches.as_deref_mut() {
                        for (branch, ty) in read.into_iter().zip(&members) {
                            branches.push(BranchRead { ty: ty.clone(), schema_node: self.read_node(branch, Some(field), None) });
                        }
                    }
                    let joined = self.joined(members);
                    results.push(joined);
                    continue;
                }
                Task::Visit(ty, layered, at) => (ty, layered, at),
            };
            let answer = match ty {
                CelType::Dyn | CelType::Parameter(_) => DYN,
                // Exactly one optional layer is read through, as at runtime.
                CelType::Optional(optional) => {
                    if layered || matches!(&*optional.value, CelType::Optional(_)) {
                        self.report_at(CelCheckCode::TypeError, nested_optional_message(operand), range, subject.clone());
                        results.push(DYN);
                    } else {
                        tasks.push(Task::Visit(&optional.value, true, at));
                    }
                    continue;
                }
                CelType::Union(union) => {
                    let held = self.partly_declared(union, field, false, layered, presence, range, &at, operand_node);
                    let read = if branches.is_some() { held.clone() } else { Vec::new() };
                    tasks.push(Task::Union(held.len(), read));
                    let visits: Vec<Task<'_>> = held
                        .into_iter()
                        .map(|branch| Task::Visit(branch, layered, self.branch_node(ty, branch, &at)))
                        .collect();
                    tasks.extend(visits.into_iter().rev());
                    continue;
                }
                CelType::Record(record) => self.record_member_type(record, field, range, presence, at),
                CelType::Nominal(nominal) if nominal.fields.is_some() => self.field_type(nominal, field, range, at),
                CelType::Map(map) => {
                    if assignable(&STRING, &map.key) {
                        self.read_member(ty, ELEMENT_EDGE);
                        (*map.value).clone()
                    } else {
                        self.report_at(
                            CelCheckCode::TypeError,
                            format!(
                                "{} is keyed by {}, so {} cannot name an entry of it",
                                format_type(ty, false),
                                format_type(&map.key, false),
                                json_quote(field)
                            ),
                            range,
                            at,
                        );
                        DYN
                    }
                }
                _ => {
                    self.report_at(CelCheckCode::TypeError, format!("{} holds no members", format_type(ty, false)), range, at);
                    DYN
                }
            };
            results.push(answer);
        }
        results.pop().expect("the operand is answered last")
    }

    /// A named member of a record: a declared field as declared; a member declared absent,
    /// or matched by a pattern admitting no value, absent to a presence read and refused
    /// otherwise; one patterns match, typed as their meet; any other, typed as the record's
    /// undeclared members, or refused where the record is closed.
    fn record_member_type(
        &mut self,
        record: &RecordType,
        field: &str,
        range: SourceRange,
        presence: bool,
        subject: Option<SchemaNodeAt>,
    ) -> CelType {
        let container = CelType::Record(record.clone());
        let reading = read_record_member(record, field);
        // A member's node is read either way: typed, or admitting no value.
        if self.reads.is_some() {
            for edge in &reading.edges {
                self.read_edge(&container, edge);
            }
            for ty in &reading.whole {
                self.read_whole(ty);
            }
        }
        if let Some(ty) = reading.ty {
            return ty;
        }
        if reading.absent {
            if presence {
                return DYN;
            }
            let node = reading.placed.and_then(|placed| self.nodes.as_ref().and_then(|nodes| nodes.member(&container, &placed)));
            self.diagnostics.push(CelCheckDiagnostic {
                code: CelCheckCode::UnknownField,
                message: format!(
                    "{} is declared absent here — its schema admits no value — so only a presence test (has(…), .?{field}) reads it",
                    json_quote(field)
                ),
                range,
                fix: None,
                schema_node: node.or(subject).map(|node| node.dependency()),
                absent: true,
            });
            return DYN;
        }
        let declared: Vec<&str> = record.fields.keys().collect();
        let patterns = record.patterns();
        let mut listing = if declared.is_empty() { String::new() } else { format!(" (declared: {})", declared.join(", ")) };
        if !patterns.is_empty() {
            listing.push_str(&format!("{} and matches none of its patterns ({})", if declared.is_empty() { "" } else { "," }, patterns.join(", ")));
        }
        self.report_at(
            CelCheckCode::UnknownField,
            format!("{} is not declared here{listing}", json_quote(field)),
            range,
            subject,
        );
        DYN
    }

    /// A record read by a key no literal names: any member it may hold, so the union of every
    /// field, pattern and undeclared member type — `dyn` where one is, or where it holds none —
    /// each read from its own node.
    fn computed_member_type(&mut self, record: &RecordType, branches: Option<&mut Vec<BranchRead>>) -> CelType {
        let container = CelType::Record(record.clone());
        if self.reads.is_some() {
            for edge in record_member_edges(record) {
                self.read_edge(&container, &edge);
            }
        }
        let members = record_members(record);
        if let (Some(branches), Some(nodes)) = (branches, &self.nodes) {
            for (edge, ty) in &members {
                branches.push(BranchRead { ty: (*ty).clone(), schema_node: nodes.member(&container, edge) });
            }
        }
        union_of(members.into_iter().map(|(_, ty)| ty.clone()).collect::<Vec<_>>())
    }

    /// An element of a list: a tuple's position where a literal index names one, its rest
    /// past them — refused where it has none, unless the read asks for presence — and the
    /// element for any other index.
    fn position_type(
        &mut self,
        ty: &CelType,
        list: &ListType,
        position: Option<usize>,
        presence: bool,
        range: SourceRange,
        subject: Option<SchemaNodeAt>,
    ) -> CelType {
        let Some(edge) = tuple_edge(list, position) else {
            self.read_member(ty, ELEMENT_EDGE);
            return (*list.element).clone();
        };
        self.read_edge(ty, &edge);
        let prefix = list.prefix_elements().expect("a tuple edge names a tuple");
        if let EdgeKey::Member(index) = &edge {
            return prefix[index.parse::<usize>().expect("a position's edge is its index")].clone();
        }
        if let Some(rest) = list.additional_elements() {
            return rest.clone();
        }
        if !presence {
            self.report_at(
                CelCheckCode::TypeError,
                format!(
                    "{} holds {} positions, and index {} is past them",
                    format_type(ty, false),
                    prefix.len(),
                    position.expect("a tuple edge names a position")
                ),
                range,
                subject,
            );
        }
        DYN
    }

    /// A field of a host's named type: the type its definition declares, and any other
    /// name is unknown.
    fn field_type(&mut self, ty: &NominalType, field: &str, range: SourceRange, subject: Option<SchemaNodeAt>) -> CelType {
        let fields = ty.fields.as_ref().expect("only a named type with fields is read by field");
        if let Some(held) = fields.get(field) {
            return held.clone();
        }
        self.report_at(CelCheckCode::UnknownField, unknown_field_message(ty, field), range, subject);
        DYN
    }

    fn finish_index(&mut self, node: &CelIndexNode, operand: CelType, index: CelType) -> CelType {
        let from = self.nodes.is_some().then(|| operand.clone());
        let guarded = self.check_nullable(&node.operand, operand, "[…]", node.range);
        let subject = from.and_then(|from| self.narrowed_node(&from, &guarded, self.node_at(&node.operand)));
        let mut branches = self.nodes.is_some().then(Vec::new);
        let held = self.element_type(&guarded, &index, node, node.optional, subject, branches.as_mut());
        let at = self.read_node(&guarded, literal_key(node), literal_position(node));
        self.locate(address(node), at);
        let wrapped = node.optional || matches!(guarded, CelType::Optional(_));
        if let (Some(nodes), Some(branches), false) = (&mut self.nodes, branches, wrapped) {
            nodes.union_read(address(node), branches);
        }
        if wrapped {
            optional_of(held)
        } else {
            held
        }
    }

    fn element_type(
        &mut self,
        operand: &CelType,
        index: &CelType,
        node: &CelIndexNode,
        presence: bool,
        subject: Option<SchemaNodeAt>,
        mut branches: Option<&mut Vec<BranchRead>>,
    ) -> CelType {
        // A visit carries whether the type is a member of a union read, whose branch the union records.
        enum Task<'t> {
            Visit(&'t CelType, bool, Option<SchemaNodeAt>, bool),
            Union(usize, Vec<&'t CelType>),
        }
        let literal_key = literal_key(node);
        let index_range = node.index.range();
        let index_node = self.node_at(&node.index);
        let mut results: Vec<CelType> = Vec::new();
        let mut tasks = vec![Task::Visit(operand, false, subject.clone(), false)];
        while let Some(task) = tasks.pop() {
            let (ty, layered, at, branch) = match task {
                Task::Union(count, read) => {
                    let members = results.split_off(results.len() - count);
                    if let Some(branches) = branches.as_deref_mut() {
                        for (branch, ty) in read.into_iter().zip(&members) {
                            branches.push(BranchRead {
                                ty: ty.clone(),
                                schema_node: self.read_node(branch, literal_key, literal_position(node)),
                            });
                        }
                    }
                    let joined = self.joined(members);
                    results.push(joined);
                    continue;
                }
                Task::Visit(ty, layered, at, branch) => (ty, layered, at, branch),
            };
            let answer = match ty {
                CelType::Dyn | CelType::Parameter(_) => DYN,
                // Exactly one optional layer is read through, as at runtime.
                CelType::Optional(optional) => {
                    if layered || matches!(&*optional.value, CelType::Optional(_)) {
                        self.report_at(CelCheckCode::TypeError, nested_optional_message(operand), node.range, subject.clone());
                        results.push(DYN);
                    } else {
                        tasks.push(Task::Visit(&optional.value, true, at, branch));
                    }
                    continue;
                }
                CelType::Union(union) => {
                    let held = match literal_key {
                        Some(key) => self.partly_declared(union, key, true, layered, presence, index_range, &at, Some(&node.operand)),
                        None => presence_branches(union, true, presence, layered),
                    };
                    let read = if branches.is_some() { held.clone() } else { Vec::new() };
                    tasks.push(Task::Union(held.len(), read));
                    let visits: Vec<Task<'_>> = held
                        .into_iter()
                        .map(|member| Task::Visit(member, layered, self.branch_node(ty, member, &at), true))
                        .collect();
                    tasks.extend(visits.into_iter().rev());
                    continue;
                }
                CelType::List(list) => {
                    if !assignable(index, &INT) && !is_dyn(index) {
                        self.report_at(
                            CelCheckCode::TypeError,
                            format!("a list is indexed by int, and this index is {}", format_type(index, false)),
                            index_range,
                            index_node.clone(),
                        );
                    }
                    self.position_type(ty, list, literal_position(node), presence, index_range, at)
                }
                CelType::Map(map) => {
                    if !assignable(index, &map.key) && !is_dyn(index) {
                        self.report_at(
                            CelCheckCode::TypeError,
                            format!(
                                "{} is indexed by {}, and this index is {}",
                                format_type(ty, false),
                                format_type(&map.key, false),
                                format_type(index, false)
                            ),
                            index_range,
                            index_node.clone(),
                        );
                    }
                    self.read_member(ty, ELEMENT_EDGE);
                    (*map.value).clone()
                }
                CelType::Record(record) => match literal_key {
                    Some(key) => self.record_member_type(record, key, index_range, presence, at),
                    None => {
                        let branches = if branch { None } else { branches.as_deref_mut() };
                        self.computed_member_type(record, branches)
                    }
                },
                CelType::Nominal(nominal) if nominal.fields.is_some() => match literal_key {
                    Some(key) => self.field_type(nominal, key, index_range, at),
                    None => {
                        if !assignable(index, &STRING) && !is_dyn(index) {
                            self.report_at(
                                CelCheckCode::TypeError,
                                format!(
                                    "{} is read by field name, and this index is {}",
                                    format_type(ty, false),
                                    format_type(index, false)
                                ),
                                index_range,
                                index_node.clone(),
                            );
                        }
                        DYN
                    }
                },
                _ => {
                    self.report_at(
                        CelCheckCode::TypeError,
                        format!("{} holds no elements", format_type(ty, false)),
                        node.range,
                        at,
                    );
                    DYN
                }
            };
            results.push(answer);
        }
        results.pop().expect("the operand is answered last")
    }

    /// The branches of a union a read of a named member is judged against. A member only some
    /// shapes declare is absent from the closed shapes lacking it: a presence read asks that,
    /// and any other read of it is one refusal in their place, at the node holding the union.
    #[allow(clippy::too_many_arguments)]
    fn partly_declared<'t>(
        &mut self,
        union: &'t UnionType,
        member: &str,
        elements: bool,
        layered: bool,
        presence: bool,
        range: SourceRange,
        subject: &Option<SchemaNodeAt>,
        operand_node: Option<&CelNode>,
    ) -> Vec<&'t CelType> {
        let judged = presence_branches(union, elements, presence, layered);
        if !union.members().iter().any(|branch| can_hold_member(branch, member, layered))
            || !union.members().iter().any(|branch| lacks_member(branch, member, layered))
        {
            return judged;
        }
        if !presence {
            let message = partly_declared_message(member) + &discriminant_hint(union, member, operand_node);
            self.report_at(CelCheckCode::UnknownField, message, range, subject.clone());
        }
        judged.into_iter().filter(|branch| !lacks_member(branch, member, layered)).collect()
    }

    /// A dereference of something that may be null. The type is answered with null taken
    /// out either way, so one missing guard is one diagnostic.
    fn check_nullable(&mut self, operand: &CelNode, ty: CelType, access: &str, range: SourceRange) -> CelType {
        if !admits_null(&ty) {
            return ty;
        }
        let Some(chain) = chain_text(operand) else { return without_null(&ty) };
        if self.proven_non_null(&chain) {
            return without_null(&ty);
        }
        let at = self.node_at(operand);
        if matches!(ty, CelType::Primitive(_)) {
            self.report_at(CelCheckCode::TypeError, "null holds no members".into(), range, at);
            return DYN;
        }
        self.report_at(
            CelCheckCode::NullableAccess,
            format!(
                "{} may be null — guard it (e.g. '{chain} != null && …' or '{chain} == null ? … : {chain}{access}') before reading {access}",
                json_quote(&chain)
            ),
            range,
            at,
        );
        without_null(&ty)
    }

    // --- operators ----------------------------------------------------------------

    fn start_operator(
        &mut self,
        operator: &'static str,
        operands: Vec<&'a CelNode>,
        range: SourceRange,
        comparison: Option<&'a CelNode>,
        stack: &mut Vec<Cont<'a>>,
    ) -> Step<'a> {
        let first = operands[0];
        stack.push(Cont::Operator { operator, operands, args: Vec::new(), range, comparison });
        Step::Eval(first, false)
    }

    fn finish_operator(
        &mut self,
        operator: &str,
        operands: &[&CelNode],
        args: &[CelType],
        range: SourceRange,
        comparison: Option<&CelNode>,
    ) -> CelType {
        let equality = operator == "==" || operator == "!=";
        if let Some(comparison) = comparison.filter(|_| equality && operands.iter().any(|operand| is_type_call(operand))) {
            self.record_type_test(comparison, operands, args);
        }
        // Null is comparable with every type.
        if equality && args.iter().any(is_null_type) {
            return BOOL;
        }
        let failure = match self.context.registry.resolve(operator, CallForm::Global, args, None) {
            Ok(resolution) => return resolution.returns,
            Err(failure) => failure,
        };
        // An equality, or membership in a list, is defined when either side holds a null, so
        // it is resolved on the values besides null.
        if let Some(compared) = without_null_compared(operator, args) {
            if let Ok(resolution) = self.context.registry.resolve(operator, CallForm::Global, &compared, None) {
                return resolution.returns;
            }
        }
        if equality {
            if let Some(returns) = self.overlapping(operator, args) {
                return returns;
            }
        }
        // An equality is judged by overlap alone; membership expands its container.
        let expansion = if equality {
            None
        } else if let ("in", [element, container]) = (operator, args) {
            self.membership(element, container)
        } else {
            self.context.registry.resolve_expanded(operator, CallForm::Global, args, None)
        };
        if let Some(Expansion::Resolved { returns, .. }) = expansion {
            return returns;
        }
        let mut types: Vec<&CelType> = args.iter().collect();
        types.extend(candidate_types(&failure));
        let (code, message, at) = match type_argument_mismatch(&types) {
            Some(mismatch) => (CelCheckCode::TypeArgumentMismatch, mismatch, None),
            None => {
                let described = describe_arguments(args);
                let message = expansion_message(
                    format!("no {} is declared over {described}", json_quote(operator)),
                    &format!("{} over {described}", json_quote(operator)),
                    expansion.as_ref(),
                    |combination| describe_arguments(combination),
                );
                let at = self.expansion_node(expansion.as_ref(), args, operands).or_else(|| self.first_node(operands));
                (CelCheckCode::TypeError, message, at)
            }
        };
        self.report_at(code, message, range, at);
        DYN
    }

    /// An equality whose sides share a type: some member of one side and some member of the
    /// other resolve it.
    fn overlapping(&self, operator: &str, args: &[CelType]) -> Option<CelType> {
        let [left_type, right_type] = args else { return None };
        for left in expanded_members(left_type) {
            for right in expanded_members(right_type) {
                if std::ptr::eq(left, left_type) && std::ptr::eq(right, right_type) {
                    continue;
                }
                let pair = [left.clone(), right.clone()];
                if let Ok(resolution) = self.context.registry.resolve(operator, CallForm::Global, &pair, None) {
                    return Some(resolution.returns);
                }
            }
        }
        None
    }

    /// Membership over each member of the container: every one must take the element, as a
    /// call over a union does, and each judges it by overlap against what it holds.
    fn membership(&self, element: &CelType, container: &CelType) -> Option<Expansion> {
        let containers = expanded_members(container);
        if containers.len() > UNION_EXPANSION_LIMIT {
            return Some(Expansion::Limit);
        }
        let mut returns: Vec<CelType> = Vec::new();
        for (at, held) in containers.iter().enumerate() {
            match self.member_in(element, held) {
                Some(returned) => returns.push(returned),
                None if matches!(container, CelType::Union(_)) => {
                    return Some(Expansion::Untaken { combination: vec![element.clone(), held.clone()], members: vec![0, at] });
                }
                None => return None,
            }
        }
        let returns = if returns.iter().any(is_dyn) { DYN } else { union_of(returns) };
        Some(Expansion::Resolved { overloads: Vec::new(), returns })
    }

    /// `in` over one container: as written, else by overlap of the element's members with
    /// what it holds — a list's element members, a map's key members.
    fn member_in(&self, element: &CelType, container: &CelType) -> Option<CelType> {
        let registry = self.context.registry;
        if let Ok(resolution) = registry.resolve("in", CallForm::Global, &[element.clone(), container.clone()], None) {
            return Some(resolution.returns);
        }
        let held: Vec<CelType> = match container {
            CelType::List(list) => expanded_members(&list.element).iter().cloned().map(list_of).collect(),
            CelType::Map(map) => expanded_members(&map.key).iter().map(|key| map_of(key.clone(), (*map.value).clone())).collect(),
            other => vec![other.clone()],
        };
        for member in expanded_members(element) {
            for holding in &held {
                if let Ok(resolution) = registry.resolve("in", CallForm::Global, &[member.clone(), holding.clone()], None) {
                    return Some(resolution.returns);
                }
            }
        }
        None
    }

    /// The node a refusal over a union's combination names: that of the first member the
    /// failing combination took, else of the operand holding it.
    fn expansion_node(&self, expansion: Option<&Expansion>, positions: &[CelType], operands: &[&CelNode]) -> Option<SchemaNodeAt> {
        let nodes = self.nodes.as_ref()?;
        let Some(Expansion::Untaken { combination, members }) = expansion else { return None };
        for (at, position) in positions.iter().enumerate() {
            if !matches!(position, CelType::Union(_)) || combination[at] == *position {
                continue;
            }
            return nodes.union_member(position, members[at]).or_else(|| self.node_at(operands[at]));
        }
        None
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
        if is_type_call(node) {
            self.type_arguments.insert(node_key(node), args[0].clone());
        }
        match self.context.registry.resolve(name, form, &args, receiver.as_ref()) {
            Ok(resolution) => {
                self.push_dispatched(node, &resolution.resolved, &resolution.returns, args.len());
                self.check_literal_arguments(node, &resolution.resolved);
                resolution.returns
            }
            Err(failure) => {
                let expansion = (failure.reason == ResolutionFailureReason::NoOverload)
                    .then(|| self.context.registry.resolve_expanded(name, form, &args, receiver.as_ref()))
                    .flatten();
                if let Some(Expansion::Resolved { overloads, returns }) = &expansion {
                    // Each distinct overload is listed once, in combination order; one literal
                    // refusal is enough.
                    for overload in overloads {
                        self.push_dispatched(node, &overload.resolved, &overload.returns, args.len());
                    }
                    for overload in overloads {
                        if self.check_literal_arguments(node, &overload.resolved) {
                            break;
                        }
                    }
                    return returns.clone();
                }
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
                    argument_type_names: None,
                });
                self.report_call_failure(node, form, &args, receiver.as_ref(), &failure, expansion.as_ref());
                DYN
            }
        }
    }

    fn push_dispatched(&mut self, node: &CelNode, resolved: &RegisteredFunction, returns: &CelType, arity: usize) {
        let (name, form, range) = call_parts(node);
        let metadata = &resolved.metadata;
        self.calls.push(ResolvedCall {
            name: name.into(),
            form,
            namespace: None,
            arity,
            range,
            signature: Some(format_signature(&resolved.signature)),
            returns: Some(format_type(&without_parameters(returns), false)),
            deterministic: Some(metadata.deterministic),
            host_backed: Some(metadata.host_backed),
            throws: metadata.throws.clone(),
            argument_types: None,
            argument_type_names: None,
        });
    }

    /// A registration's own guard over the arguments written as literals, asked where the
    /// call has just resolved and nowhere else.
    fn check_literal_arguments(&mut self, node: &CelNode, resolved: &RegisteredFunction) -> bool {
        let Some(check) = &resolved.metadata.check_arguments else { return false };
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
        let Some(refusal) = check(&values) else { return false };
        let range = node.range();
        let expression = self.expression;
        let units = self.source_units.get_or_insert_with(|| expression.source.encode_utf16().collect());
        let source = utf16_slice(units, range.start, range.end);
        self.report(CelCheckCode::InvalidArgument, format!("{refusal} (in `{source}`)"), range);
        true
    }

    fn report_call_failure(
        &mut self,
        node: &CelNode,
        form: CallForm,
        args: &[CelType],
        receiver: Option<&CelType>,
        failure: &ResolutionFailure,
        expansion: Option<&Expansion>,
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
                let (code, message, at) = match type_argument_mismatch(&types) {
                    Some(mismatch) => (CelCheckCode::TypeArgumentMismatch, mismatch, None),
                    None => {
                        let mut written: Vec<&CelNode> = Vec::new();
                        if let CelNode::ReceiverCall(call) = node {
                            written.push(&call.receiver);
                        }
                        written.extend(call_arguments(node).iter().map(|argument| &**argument));
                        let positions: Vec<CelType> = receiver.into_iter().chain(args).cloned().collect();
                        let at = self.expansion_node(expansion, &positions, &written).or_else(|| self.first_node(&written));
                        let on = if form == CallForm::Receiver {
                            format!("{}.", format_type(receiver.unwrap_or(&DYN), false))
                        } else {
                            String::new()
                        };
                        let call = format!("{on}{name}({})", describe_arguments(args));
                        let message = expansion_message(
                            format!(
                                "no overload of {} takes {call}: {}",
                                json_quote(name),
                                describe_candidates(&failure.candidates)
                            ),
                            &call,
                            expansion,
                            |combination| match receiver {
                                None => format!("{name}({})", describe_arguments(combination)),
                                Some(_) => format!(
                                    "{}.{name}({})",
                                    format_type(&combination[0], false),
                                    describe_arguments(&combination[1..])
                                ),
                            },
                        );
                        (CelCheckCode::TypeError, message, at)
                    }
                };
                self.report_at(code, message, range, at);
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
        let wanted = es_to_lower_case(name);
        let mut candidates: Vec<String> = Vec::new();
        for entry in self.context.registry.list() {
            let signature = &entry.signature;
            if signature.form() == form
                && signature.parameters.len() == arity
                && es_to_lower_case(&signature.name) == wanted
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
        let argument_types: Vec<CelType> = args.iter().map(without_parameters).collect();
        let argument_type_names: Vec<String> = argument_types.iter().map(|ty| format_type(ty, false)).collect();
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
                argument_type_names: Some(argument_type_names),
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
            argument_type_names: Some(argument_type_names),
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
        let provenance = (self.context.namespace_result_provenance)(&node.namespace, &node.name);
        if let Some(reads) = &mut self.reads {
            reads.read_registration(provenance);
        }
        let at = self.nodes.as_mut().and_then(|nodes| nodes.registration(provenance));
        self.locate(address(node), at);
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

/// The member an index names when it is written as a string literal.
/// The position an index names when it is written as an int literal at or past zero.
fn literal_position(node: &CelIndexNode) -> Option<usize> {
    match &*node.index {
        CelNode::Literal(literal) => match &literal.literal {
            CelLiteral::Int(value) if *value >= 0 && *value <= 9_007_199_254_740_991 => Some(*value as usize),
            _ => None,
        },
        _ => None,
    }
}

/// The member edge a literal position reads of a tuple: the position's, or the rest's past them.
fn tuple_edge(list: &ListType, position: Option<usize>) -> Option<EdgeKey> {
    let (prefix, position) = (list.prefix_elements()?, position?);
    Some(if position < prefix.len() { EdgeKey::Member(position.to_string()) } else { EdgeKey::Additional })
}

fn literal_key(node: &CelIndexNode) -> Option<&str> {
    match &*node.index {
        CelNode::Literal(literal) => match &literal.literal {
            CelLiteral::String(key) => Some(key.as_str()),
            _ => None,
        },
        _ => None,
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

/// The operands of an equality, or of membership in a list, with null taken out at every
/// depth, when either may hold a null; nothing for any other operator. Both are defined
/// whatever null either side holds.
fn without_null_compared(operator: &str, args: &[CelType]) -> Option<Vec<CelType>> {
    let [left, right] = args else { return None };
    let list = matches!(right, CelType::List(_));
    if operator != "==" && operator != "!=" && !(operator == "in" && list) {
        return None;
    }
    match (without_null_at_depth(left), without_null_at_depth(right)) {
        (None, None) => None,
        (left_held, right_held) => Some(vec![left_held.unwrap_or_else(|| left.clone()), right_held.unwrap_or_else(|| right.clone())]),
    }
}

/// The type with null taken out of every union in it, through lists, maps and optionals;
/// nothing when it holds none.
fn without_null_at_depth(ty: &CelType) -> Option<CelType> {
    enum Task<'t> {
        Visit(&'t CelType),
        /// Joins the last `count` answers into the union `whole` was, `dropped` when a null left it.
        Union(&'t CelType, usize, bool),
        List(&'t CelType),
        Map(&'t CelType),
        Optional(&'t CelType),
    }
    let mut tasks = vec![Task::Visit(ty)];
    let mut results: Vec<(CelType, bool)> = Vec::new();
    // Each type object is answered once per call, so a shared part is walked once.
    let mut answered: HashMap<WalkKey, (CelType, bool)> = HashMap::new();
    fn remember(answered: &mut HashMap<WalkKey, (CelType, bool)>, whole: &CelType, results: &[(CelType, bool)]) {
        if let Some(key) = walk_key(whole) {
            answered.insert(key, results.last().expect("the type was answered").clone());
        }
    }
    while let Some(task) = tasks.pop() {
        if let Task::Visit(at) = &task {
            count_type_visit();
            if let Some(held) = walk_key(at).and_then(|key| answered.get(&key)) {
                results.push(held.clone());
                continue;
            }
        }
        match task {
            Task::Visit(at) => match at {
                CelType::Union(union) => {
                    let kept: Vec<&CelType> =
                        union.members().iter().filter(|member| !matches!(member, CelType::Primitive(PrimitiveName::Null))).collect();
                    if kept.is_empty() {
                        results.push((at.clone(), false));
                        continue;
                    }
                    tasks.push(Task::Union(at, kept.len(), kept.len() < union.members().len()));
                    tasks.extend(kept.into_iter().rev().map(Task::Visit));
                }
                CelType::List(list) => {
                    tasks.push(Task::List(at));
                    tasks.push(Task::Visit(&list.element));
                }
                CelType::Map(map) => {
                    tasks.push(Task::Map(at));
                    tasks.push(Task::Visit(&map.value));
                    tasks.push(Task::Visit(&map.key));
                }
                CelType::Optional(optional) => {
                    tasks.push(Task::Optional(at));
                    tasks.push(Task::Visit(&optional.value));
                }
                other => results.push((other.clone(), false)),
            },
            Task::Union(whole, count, dropped) => {
                let members = results.split_off(results.len() - count);
                let changed = dropped || members.iter().any(|(_, changed)| *changed);
                results.push(if changed {
                    (union_of(members.into_iter().map(|(member, _)| member)), true)
                } else {
                    (whole.clone(), false)
                });
                remember(&mut answered, whole, &results);
            }
            Task::List(whole) => {
                let (element, changed) = results.pop().expect("the element was answered");
                results.push(if changed { (list_of(element), true) } else { (whole.clone(), false) });
                remember(&mut answered, whole, &results);
            }
            Task::Map(whole) => {
                let (value, value_changed) = results.pop().expect("the value was answered");
                let (key, key_changed) = results.pop().expect("the key was answered");
                let changed = key_changed || value_changed;
                results.push(if changed { (map_of(key, value), true) } else { (whole.clone(), false) });
                remember(&mut answered, whole, &results);
            }
            Task::Optional(whole) => {
                let (value, changed) = results.pop().expect("the value was answered");
                results.push(if changed { (optional_of(value), true) } else { (whole.clone(), false) });
                remember(&mut answered, whole, &results);
            }
        }
    }
    let (answer, changed) = results.pop().expect("the type is answered last");
    changed.then_some(answer)
}

fn partly_declared_message(field: &str) -> String {
    format!(
        "{} is declared by only some of the shapes this value may have — read it as '.?{field}' to handle the others",
        json_quote(field)
    )
}

/// Whether a value of the type may equal one of the values: by the runtime type each value has.
fn may_equal_any(ty: &CelType, values: &[CelValue]) -> bool {
    values.iter().any(|value| may_equal(ty, value))
}

fn may_equal(ty: &CelType, value: &CelValue) -> bool {
    match ty {
        CelType::Dyn | CelType::Parameter(_) => true,
        CelType::Union(union) => union.members().iter().any(|member| may_equal(member, value)),
        CelType::Primitive(name) => match value {
            CelValue::Null => *name == PrimitiveName::Null,
            CelValue::Bool(_) => *name == PrimitiveName::Bool,
            CelValue::String(_) => *name == PrimitiveName::String,
            _ => is_numeric(ty),
        },
        _ => false,
    }
}

/// A value of a field's set as the value domain holds it.
fn enum_value(value: &FieldEnumValue) -> CelValue {
    match value {
        FieldEnumValue::Null => CelValue::Null,
        FieldEnumValue::Bool(value) => CelValue::Bool(*value),
        FieldEnumValue::Int(value) => CelValue::Int(*value),
        FieldEnumValue::Double(value) => CelValue::Double(*value),
        FieldEnumValue::String(value) => CelValue::String(Arc::clone(value)),
    }
}

/// Whether a member of a union stays where `<chain>.<member>` equals one of the values
/// (`holds`) or none of them: a shape declaring the member by its finite set — a value the
/// runtime's `==` finds equal to a listed one, or one outside them — or, with none, where the
/// test holds by whether its type can have a listed value's; a shape that cannot hold the
/// member, or holds no members, dropped; an open record not declaring it, a map, an optional
/// and `dyn` kept.
fn discriminant_keeps(ty: &CelType, member: &str, equals: &EqualityProof) -> bool {
    let listed = |value: &FieldEnumValue| {
        let value = enum_value(value);
        equals.values.iter().any(|other| cel_equal(&value, other, None))
    };
    match ty {
        CelType::Record(record) => {
            let reading = read_record_member(record, member);
            if reading.absent {
                return false;
            }
            let declared = record.fields.contains_key(member);
            if !declared && record.additional_fields().is_some() {
                return true;
            }
            let Some(field) = reading.ty.as_ref() else { return false };
            match declared.then(|| record.field_enum(member)).flatten() {
                Some(set) if equals.holds => set.iter().any(listed),
                Some(set) => set.iter().any(|value| !listed(value)),
                None => !equals.holds || may_equal_any(field, &equals.values),
            }
        }
        CelType::Nominal(nominal) => match nominal.fields.as_ref().and_then(|fields| fields.get(member)) {
            Some(field) => !equals.holds || may_equal_any(field, &equals.values),
            None => false,
        },
        CelType::Primitive(_) | CelType::List(_) => false,
        _ => true,
    }
}

/// The test telling the shapes of a union holding a member from the others, where a field
/// every shape declares with a finite set does — the first such in the first shape's written
/// order — as the tail of the refusal naming `.?<member>`.
fn discriminant_hint(union: &UnionType, member: &str, operand: Option<&CelNode>) -> String {
    let (Some(operand), Some(read)) = (operand, member_name_source(member)) else { return String::new() };
    if chain_text(operand).is_none() {
        return String::new();
    }
    let shapes: Vec<&RecordType> = union
        .members()
        .iter()
        .filter_map(|shape| match shape {
            CelType::Record(record) => Some(record),
            _ => None,
        })
        .collect();
    if shapes.len() != union.members().len() {
        return String::new();
    }
    let (holding, others): (Vec<&RecordType>, Vec<&RecordType>) = shapes
        .iter()
        .partition(|shape| read_record_member(shape, member).ty.is_some());
    if holding.is_empty() || others.is_empty() {
        return String::new();
    }
    for field in shapes[0].fields.keys() {
        let Some(tested) = member_name_source(field) else { continue };
        if field == member || !shapes.iter().all(|shape| shape.field_enum(field).is_some()) {
            continue;
        }
        let held = united_sets(&holding, field);
        let rest = united_sets(&others, field);
        if held.iter().any(|value| rest.iter().any(|other| cel_equal(&enum_value(value), &enum_value(other), None))) {
            continue;
        }
        let chain = serialize_tree(operand).expect("a plain chain is written");
        let values: Vec<String> = held.iter().map(enum_value_source).collect();
        let test = match values.as_slice() {
            [one] => format!("{chain}.{tested} == {one}"),
            _ => format!("{chain}.{tested} in [{}]", values.join(", ")),
        };
        return format!(", or read it behind the test that tells the shapes apart ({test} ? {chain}.{read} : …)");
    }
    String::new()
}

/// Every value the shapes' sets of a field hold, each once, in canonical order.
fn united_sets(shapes: &[&RecordType], field: &str) -> Vec<FieldEnumValue> {
    let mut values: Vec<FieldEnumValue> =
        shapes.iter().flat_map(|shape| shape.field_enum(field).expect("every shape carries the set").iter().cloned()).collect();
    values.sort();
    values.dedup();
    values
}

fn enum_value_source(value: &FieldEnumValue) -> String {
    literal_source(&match value {
        FieldEnumValue::Null => CelLiteral::Null,
        FieldEnumValue::Bool(value) => CelLiteral::Bool(*value),
        FieldEnumValue::Int(value) => CelLiteral::Int(*value),
        FieldEnumValue::Double(value) => CelLiteral::Double(*value),
        FieldEnumValue::String(value) => CelLiteral::String(value.to_string()),
    })
}

/// Whether a value of this type can hold the named member: a record declaring it, a pattern of it matching it or open
/// and not declaring it absent, a string-keyed map, a named type with that field, or `dyn`. It is what `has()` proves.
fn can_hold_member(ty: &CelType, member: &str, layered: bool) -> bool {
    match ty {
        CelType::Dyn | CelType::Parameter(_) => true,
        CelType::Record(record) => read_record_member(record, member).ty.is_some(),
        CelType::Map(map) => assignable(&STRING, &map.key),
        CelType::Nominal(nominal) => nominal.fields.as_ref().is_some_and(|fields| fields.get(member).is_some()),
        CelType::Optional(optional) => {
            !layered && !matches!(&*optional.value, CelType::Optional(_)) && can_hold_member(&optional.value, member, true)
        }
        _ => false,
    }
}

/// Whether a type holds named members, but not this one: a closed shape not declaring it.
fn lacks_member(ty: &CelType, member: &str, layered: bool) -> bool {
    match ty {
        CelType::Record(record) => read_record_member(record, member).ty.is_none(),
        CelType::Nominal(nominal) => nominal.fields.as_ref().is_some_and(|fields| fields.get(member).is_none()),
        CelType::Optional(optional) => {
            !layered && !matches!(&*optional.value, CelType::Optional(_)) && lacks_member(&optional.value, member, true)
        }
        _ => false,
    }
}

/// Whether a comparison is a test against null of something that may be null.
/// Whether a type is null itself.
fn is_null_type(ty: &CelType) -> bool {
    matches!(ty, CelType::Primitive(PrimitiveName::Null))
}

/// A value whose `type()` answers a type, as `string` or `type(1)` does.
fn is_type_value(ty: &CelType) -> bool {
    matches!(ty, CelType::Primitive(PrimitiveName::Type))
}

/// What `type()` answers for a value of a type, where one answer holds for all of them:
/// `list` for any list, `map` for any map or record, the primitive or well-known type, a
/// registered type's name. Nothing for `dyn`, a bare parameter or a union.
fn runtime_type_key(ty: &CelType) -> Option<String> {
    Some(match ty {
        CelType::Primitive(name) => name.as_str().to_string(),
        CelType::List(_) => "list".into(),
        CelType::Map(_) | CelType::Record(_) => "map".into(),
        CelType::Optional(_) => "optional".into(),
        CelType::Nominal(nominal) => format!("nominal:{}", nominal.name),
        _ => return None,
    })
}

/// A refusal over a union's combinations: past the limit its own sentence, a combination no
/// overload takes named after the refusal as written.
fn expansion_message(
    written: String,
    call: &str,
    expansion: Option<&Expansion>,
    combination_text: impl FnOnce(&[CelType]) -> String,
) -> String {
    match expansion {
        Some(Expansion::Limit) => format!(
            "{call} holds more than {UNION_EXPANSION_LIMIT} combinations of its arguments' types; narrow one with a type test"
        ),
        Some(Expansion::Untaken { combination, .. }) => format!("{written}; {} is taken by none", combination_text(combination)),
        _ => written,
    }
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

/// Whether two named types' arguments are the same types: they are invariant, compared as types and never by their text.
fn same_arguments(left: &[CelType], right: &[CelType]) -> bool {
    left.len() == right.len() && left.iter().zip(right).all(|(left, right)| types_equal(left, right))
}

/// Which branches of a union a read is judged against. A presence-shaped read judges only
/// the branches that can hold the member or element, when any can.
fn presence_branches(union: &UnionType, elements: bool, presence: bool, layered: bool) -> Vec<&CelType> {
    if !presence {
        return union.members().iter().collect();
    }
    let holding: Vec<&CelType> = union.members().iter().filter(|member| holds(member, elements, layered)).collect();
    if holding.is_empty() {
        union.members().iter().collect()
    } else {
        holding
    }
}

fn nested_optional_message(whole: &CelType) -> String {
    format!(
        "{} is read through one optional only; unwrap the inner optional (.value(), .orValue(…) or optFlatMap) first",
        format_type(whole, false)
    )
}

/// Whether a type can hold a named member (or, for `elements`, an element) at all.
fn holds(ty: &CelType, elements: bool, layered: bool) -> bool {
    let mut pending = vec![(ty, layered)];
    while let Some((ty, layered)) = pending.pop() {
        match ty {
            CelType::Dyn | CelType::Parameter(_) | CelType::Record(_) | CelType::Map(_) => return true,
            CelType::List(_) if elements => return true,
            CelType::Nominal(nominal) if nominal.fields.is_some() => return true,
            CelType::Optional(optional) if !layered && !matches!(&*optional.value, CelType::Optional(_)) => {
                pending.push((&optional.value, true))
            }
            CelType::Union(union) => pending.extend(union.members().iter().map(|member| (member, layered))),
            _ => {}
        }
    }
    false
}

/// `source.slice(start, end)` over UTF-16 code units, as ECMAScript slices a string.
fn utf16_slice(units: &[u16], start: u32, end: u32) -> String {
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
        CelNode::Struct(node) => node.entries.get(at).map(|entry| &entry.value),
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
        CelNode::Struct(node) => node.entries[at].value = child,
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
