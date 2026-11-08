//! What an expression reads, and whether a context schema allows it — `analyze.ts`.
//!
//! - Member-access chains (`request.query.name`), with a comprehension's or `cel.bind`'s
//!   bound name dropped, a resolved module call's receiver skipped, and an optional read
//!   ending the chain; the read chains, which follow a comprehension variable instead.
//! - Each module call's argument chains, and member reads off a module call's result.
//! - Nullable access: a member read on a value whose schema admits null, unguarded by a
//!   `!= null` / `== null` test flowing through `?:`, `&&` and `||`.
//! - A chain judged against a context schema: `allOf` conjuncts, document-local `$ref`s
//!   followed against the nearest node on the walk holding the target, unions read in every
//!   alternative, a value type's members as its closed fields, and no member read past a
//!   live value.
//!
//! The walks recurse over the tree, whose height the reader bounds (250 by default), and
//! over the schema, whose nesting the JSON reader bounds.
//!
//! Where this file answers otherwise than Node, each a Node defect:
//! - A member is declared when the `properties` object holds it as its own key. Node tests
//!   `key in props`, which also finds an object's prototype members, so a member named
//!   `constructor` or `toString` reads as declared there.
//! - A reference whose pointer holds a malformed percent escape cannot be read, so the chain
//!   is unjudged. Node's `decodeURIComponent` throws out of the analysis there.
//! - A schema node that is a JSON array is a node that cannot be read, as a scalar is; Node
//!   reads an array as an object with no keywords.

use std::collections::HashSet;

use serde_json::{Map, Value};
use telorun_cel::{
    child_nodes, namespace_macro_binding, receiver_macro_binding, CelBinaryOperator, CelLiteral, CelNode,
    CelUnaryOperator, SourceRange,
};
use telorun_sdk_core::value_type::{is_live_slot, members_of};

use crate::cel::module_call::{module_call_of, ModuleCall};

/// The chain segment for index access (`obj[expr]`), a member no static name resolves.
pub const INDEX_SEGMENT: &str = "[*]";

/// The chain segment for "each element of the collection reached so far".
pub const EACH_SEGMENT: &str = "[]";

/// The chain segment for "whether the member exists": the last segment of a chain a
/// presence test (`has(a.b)`) reads.
pub const PRESENCE_SEGMENT: &str = "?";

/// Every member-access chain of the tree, in walk order. A chain rooted at a call or a
/// non-identifier is not one; a name a comprehension or `cel.bind` binds is not a root
/// inside what it scopes; a resolved module call's receiver is not a root.
pub fn extract_access_chains(node: &CelNode) -> Vec<Vec<String>> {
    let mut chains = Vec::new();
    visit_node(node, &mut chains, &HashSet::new(), &mut |_, _, _| {});
    chains
}

/// Each resolved module call's arguments as plain member chains, keyed by the call's range:
/// `None` for an argument that is not one, or that is rooted at a name the expression binds.
pub fn module_call_argument_chains(node: &CelNode) -> Vec<(SourceRange, Vec<Option<Vec<String>>>)> {
    let mut out = Vec::new();
    visit_node(node, &mut Vec::new(), &HashSet::new(), &mut |call, call_node, bound| {
        out.push((call_node.range(), call.args.iter().map(|arg| extract_chain(arg, bound)).collect()));
    });
    out
}

type ModuleCallVisitor<'v> = dyn FnMut(&ModuleCall<'_>, &CelNode, &HashSet<String>) + 'v;

/// `cel.bind(name, init, body)`: a receiver call on the identifier `cel`, the reserved
/// namespace no host can claim. The receiver contributes no chain.
struct Bind<'a> {
    name: &'a str,
    init: &'a CelNode,
    body: &'a CelNode,
}

fn bind_call(node: &CelNode) -> Option<Bind<'_>> {
    let CelNode::ReceiverCall(call) = node else { return None };
    let CelNode::Ident(receiver) = &*call.receiver else { return None };
    if receiver.name != "cel" {
        return None;
    }
    let binding = namespace_macro_binding("cel", &call.name, call.args.len())?;
    let CelNode::Ident(name) = &**call.args.get(binding.variable_argument)? else { return None };
    let scoped = binding.scoped_arguments;
    let body = call.args.get(*scoped.last()?)?;
    let init = call
        .args
        .iter()
        .enumerate()
        .find(|(at, _)| *at != binding.variable_argument && !scoped.contains(at))
        .map(|(_, arg)| arg)?;
    Some(Bind { name: &name.name, init, body })
}

/// A comprehension macro's receiver, its iteration variable and the arguments it scopes,
/// from the engine's binding table.
struct Comprehension<'a> {
    receiver: &'a CelNode,
    bound: &'a str,
    scoped: Vec<&'a CelNode>,
}

fn comprehension(node: &CelNode) -> Option<Comprehension<'_>> {
    let CelNode::ReceiverCall(call) = node else { return None };
    if matches!(&*call.receiver, CelNode::Ident(receiver) if receiver.name == "cel") {
        return None;
    }
    let binding = receiver_macro_binding(&call.name, call.args.len())?;
    let CelNode::Ident(name) = &**call.args.get(binding.variable_argument)? else { return None };
    Some(Comprehension {
        receiver: &call.receiver,
        bound: &name.name,
        scoped: binding.scoped_arguments.iter().filter_map(|at| call.args.get(*at).map(|arg| &**arg)).collect(),
    })
}

fn with_bound(bound: &HashSet<String>, name: &str) -> HashSet<String> {
    let mut inner = bound.clone();
    inner.insert(name.into());
    inner
}

fn visit_node(
    node: &CelNode,
    chains: &mut Vec<Vec<String>>,
    bound: &HashSet<String>,
    on_module_call: &mut ModuleCallVisitor<'_>,
) {
    if let Some(chain) = extract_chain(node, bound) {
        chains.push(chain);
        return;
    }
    if let Some(call) = module_call_of(node) {
        on_module_call(&call, node, bound);
        for arg in call.args {
            visit_node(arg, chains, bound, on_module_call);
        }
        return;
    }
    // The bound name is in scope for the body only; `init` is read in the enclosing scope.
    if let Some(bind) = bind_call(node) {
        visit_node(bind.init, chains, bound, on_module_call);
        visit_node(bind.body, chains, &with_bound(bound, bind.name), on_module_call);
        return;
    }
    if let Some(macro_call) = comprehension(node) {
        // The receiver is evaluated outside the binding; only the scoped arguments see it.
        visit_node(macro_call.receiver, chains, bound, on_module_call);
        let inner = with_bound(bound, macro_call.bound);
        for arg in macro_call.scoped {
            visit_node(arg, chains, &inner, on_module_call);
        }
        return;
    }
    for child in child_nodes(node) {
        visit_node(child, chains, bound, on_module_call);
    }
}

/// The chain a node is, or `None`. An absolute name (`.y`) is never a bound one; an
/// optional read (`a.?b`, `a[?0]`) ends the chain, the author having said the member may be
/// absent.
fn extract_chain(node: &CelNode, bound: &HashSet<String>) -> Option<Vec<String>> {
    match node {
        CelNode::Ident(ident) => {
            if !ident.absolute && bound.contains(&ident.name) {
                return None;
            }
            Some(vec![ident.name.clone()])
        }
        CelNode::Select(select) if !select.optional => {
            let mut chain = extract_chain(&select.operand, bound)?;
            chain.push(select.field.clone());
            Some(chain)
        }
        CelNode::Index(index) if !index.optional => {
            let mut chain = extract_chain(&index.operand, bound)?;
            chain.push(INDEX_SEGMENT.into());
            Some(chain)
        }
        _ => None,
    }
}

/// What an expression reads of the values its roots name, as member chains —
/// [`extract_access_chains`] with a comprehension's iteration variable followed instead of
/// dropped: a member read through it is a read on each element of the range
/// (`xs.[].path`), a range only iterated ends in [`EACH_SEGMENT`], a bare use of it reads the
/// range whole, and a presence test reads only whether the member exists
/// ([`PRESENCE_SEGMENT`]). A variable whose range is not a plain chain contributes nothing.
pub fn extract_read_chains(node: &CelNode) -> Vec<Vec<String>> {
    let mut chains = Vec::new();
    visit_reads(node, &mut chains, &Vec::new());
    chains
}

/// A bound name's range as a chain, or `None` where it has none; the innermost binding of a
/// name is the last.
type BoundRanges = Vec<(String, Option<Vec<String>>)>;

fn bound_range<'b>(bound: &'b BoundRanges, name: &str) -> Option<&'b Option<Vec<String>>> {
    bound.iter().rev().find(|(held, _)| held == name).map(|(_, range)| range)
}

fn with_range(bound: &BoundRanges, name: &str, range: Option<Vec<String>>) -> BoundRanges {
    let mut inner = bound.clone();
    inner.push((name.into(), range));
    inner
}

fn read_chain_of(node: &CelNode, bound: &BoundRanges) -> Option<Vec<String>> {
    match node {
        CelNode::Ident(ident) => {
            if !ident.absolute {
                if let Some(range) = bound_range(bound, &ident.name) {
                    let mut chain = range.clone()?;
                    chain.push(EACH_SEGMENT.into());
                    return Some(chain);
                }
            }
            Some(vec![ident.name.clone()])
        }
        CelNode::Select(select) if !select.optional => {
            let mut chain = read_chain_of(&select.operand, bound)?;
            chain.push(select.field.clone());
            Some(chain)
        }
        CelNode::Index(index) if !index.optional => {
            let mut chain = read_chain_of(&index.operand, bound)?;
            chain.push(INDEX_SEGMENT.into());
            Some(chain)
        }
        _ => None,
    }
}

fn visit_reads(node: &CelNode, chains: &mut Vec<Vec<String>>, bound: &BoundRanges) {
    if let Some(mut chain) = read_chain_of(node, bound) {
        // The variable itself, with no member read off it: the whole element.
        if chain.last().is_some_and(|segment| segment == EACH_SEGMENT) {
            chain.pop();
        }
        chains.push(chain);
        return;
    }
    if let Some(presence) = presence_operand(node) {
        if let Some(mut owner) = read_chain_of(presence, bound) {
            owner.push(PRESENCE_SEGMENT.into());
            chains.push(owner);
            return;
        }
    }
    if let Some(call) = module_call_of(node) {
        for arg in call.args {
            visit_reads(arg, chains, bound);
        }
        return;
    }
    if let Some(bind) = bind_call(node) {
        visit_reads(bind.init, chains, bound);
        visit_reads(bind.body, chains, &with_range(bound, bind.name, None));
        return;
    }
    if let Some(macro_call) = comprehension(node) {
        let range = read_chain_of(macro_call.receiver, bound);
        match &range {
            Some(range) => {
                let mut each = range.clone();
                each.push(EACH_SEGMENT.into());
                chains.push(each);
            }
            None => visit_reads(macro_call.receiver, chains, bound),
        }
        let inner = with_range(bound, macro_call.bound, range);
        for arg in macro_call.scoped {
            visit_reads(arg, chains, &inner);
        }
        return;
    }
    for child in child_nodes(node) {
        visit_reads(child, chains, bound);
    }
}

/// What a presence test `has(<operand>.<member>)` asks the keys of.
fn presence_operand(node: &CelNode) -> Option<&CelNode> {
    let CelNode::Call(call) = node else { return None };
    if call.name != "has" || call.args.len() != 1 {
        return None;
    }
    match &*call.args[0] {
        CelNode::Select(select) if !select.optional => Some(&select.operand),
        _ => None,
    }
}

/// A member access on a module call's result: the call, and the members read off it in
/// order (`Billing.total(xs).amount` → `amount`).
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct CallResultAccess {
    pub qualified: String,
    pub members: Vec<String>,
}

/// Every member access whose base is a module call, longest first.
pub fn extract_call_result_accesses(node: &CelNode) -> Vec<CallResultAccess> {
    let mut out = Vec::new();
    visit_access(node, &mut out);
    out
}

fn visit_access(node: &CelNode, out: &mut Vec<CallResultAccess>) {
    if matches!(node, CelNode::Select(_) | CelNode::Index(_)) {
        let mut members: Vec<String> = Vec::new();
        let mut base = node;
        loop {
            match base {
                CelNode::Select(select) => {
                    members.insert(0, select.field.clone());
                    base = &select.operand;
                }
                CelNode::Index(index) => {
                    members.insert(0, INDEX_SEGMENT.into());
                    // The index is its own expression and may read off a call's result.
                    visit_access(&index.index, out);
                    base = &index.operand;
                }
                _ => break,
            }
        }
        if let Some(call) = module_call_of(base) {
            out.push(CallResultAccess { qualified: call.qualified, members });
            for arg in call.args {
                visit_access(arg, out);
            }
            return;
        }
        visit_access(base, out);
        return;
    }
    for child in child_nodes(node) {
        visit_access(child, out);
    }
}

/// One unguarded dereference of a nullable value.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct NullableIssue {
    /// The dotted path of the nullable value (`error`).
    pub path: String,
    /// The member read on it (`code`, or `[index]`).
    pub member: String,
}

/// Whether a JSON Schema admits null: `type: null`, a type list holding it, or a union
/// with a branch that does.
fn schema_is_nullable(schema: Option<&Value>) -> bool {
    let Some(schema) = schema.filter(|schema| schema.is_object()) else { return false };
    match schema.get("type") {
        Some(Value::String(name)) if name == "null" => return true,
        Some(Value::Array(names)) if names.iter().any(|name| name == "null") => return true,
        _ => {}
    }
    branches(schema).is_some_and(|branches| branches.iter().any(|branch| schema_is_nullable(Some(branch))))
}

/// A node's union branches: its `anyOf` when it is a list, else its `oneOf` when it is one.
fn branches(schema: &Value) -> Option<&Vec<Value>> {
    schema.get("anyOf").and_then(Value::as_array).or_else(|| schema.get("oneOf").and_then(Value::as_array))
}

/// The schema node a member chain reaches through `properties`, or `None`.
fn schema_at_chain<'s>(chain: &[&str], schema: &'s Value) -> Option<&'s Value> {
    let mut current = schema;
    for key in chain {
        current = current.as_object()?.get("properties")?.as_object()?.get(*key)?;
    }
    Some(current)
}

/// The dotted chain an expression is, when it is a plain chain whose schema admits null —
/// a value that may itself be null.
pub fn nullable_value_chain(node: &CelNode, context_schema: &Value) -> Option<String> {
    let chain = dotted_chain(node, &HashSet::new())?;
    let segments: Vec<&str> = chain.split('.').collect();
    schema_is_nullable(schema_at_chain(&segments, context_schema)).then_some(chain)
}

fn is_null_literal(node: &CelNode) -> bool {
    matches!(node, CelNode::Literal(literal) if matches!(literal.literal, CelLiteral::Null))
}

/// The dotted form of a static chain rooted at a free identifier, or `None` (a call's
/// result, a bound name, an index).
fn dotted_chain(node: &CelNode, bound: &HashSet<String>) -> Option<String> {
    let chain = extract_chain(node, bound)?;
    if chain.iter().any(|segment| segment == INDEX_SEGMENT) {
        return None;
    }
    Some(chain.join("."))
}

/// The chains a condition proves non-null in its true and its false branch.
#[derive(Default)]
struct Narrowing {
    when_true: Vec<String>,
    when_false: Vec<String>,
}

fn derive_narrowing(node: &CelNode, bound: &HashSet<String>) -> Narrowing {
    match node {
        CelNode::Unary(unary) if unary.operator == CelUnaryOperator::Not => {
            let inner = derive_narrowing(&unary.operand, bound);
            Narrowing { when_true: inner.when_false, when_false: inner.when_true }
        }
        CelNode::Binary(binary) => match binary.operator {
            CelBinaryOperator::Equal | CelBinaryOperator::NotEqual => {
                let chain = if is_null_literal(&binary.right) {
                    dotted_chain(&binary.left, bound)
                } else if is_null_literal(&binary.left) {
                    dotted_chain(&binary.right, bound)
                } else {
                    None
                };
                let Some(chain) = chain else { return Narrowing::default() };
                if binary.operator == CelBinaryOperator::NotEqual {
                    Narrowing { when_true: vec![chain], when_false: Vec::new() }
                } else {
                    Narrowing { when_true: Vec::new(), when_false: vec![chain] }
                }
            }
            CelBinaryOperator::And => {
                let left = derive_narrowing(&binary.left, bound);
                let right = derive_narrowing(&binary.right, bound);
                Narrowing { when_true: union(&left.when_true, &right.when_true), when_false: Vec::new() }
            }
            CelBinaryOperator::Or => {
                let left = derive_narrowing(&binary.left, bound);
                let right = derive_narrowing(&binary.right, bound);
                Narrowing { when_true: Vec::new(), when_false: union(&left.when_false, &right.when_false) }
            }
            _ => Narrowing::default(),
        },
        _ => Narrowing::default(),
    }
}

fn union(left: &[String], right: &[String]) -> Vec<String> {
    let mut out = left.to_vec();
    for chain in right {
        if !out.contains(chain) {
            out.push(chain.clone());
        }
    }
    out
}

/// Every member read on a value whose context schema admits null and that no guard around
/// it proves non-null — `x == null` / `x != null` flowing through `?:`, `&&` and `||`. One
/// issue per unguarded dereference, in walk order.
pub fn find_nullable_access_issues(node: &CelNode, context_schema: &Value) -> Vec<NullableIssue> {
    let mut issues = Vec::new();
    walk_nullable(node, &[], &HashSet::new(), &mut issues, context_schema);
    issues
}

fn walk_nullable(
    node: &CelNode,
    non_null: &[String],
    bound: &HashSet<String>,
    issues: &mut Vec<NullableIssue>,
    schema: &Value,
) {
    match node {
        CelNode::Select(_) | CelNode::Index(_) => {
            let (operand, member) = match node {
                CelNode::Select(select) => (&select.operand, select.field.clone()),
                CelNode::Index(index) => (&index.operand, "[index]".into()),
                _ => unreachable!("a select or an index"),
            };
            if let Some(chain) = dotted_chain(operand, bound) {
                if !non_null.contains(&chain) {
                    let segments: Vec<&str> = chain.split('.').collect();
                    if schema_is_nullable(schema_at_chain(&segments, schema)) {
                        issues.push(NullableIssue { path: chain, member });
                    }
                }
            }
            walk_nullable(operand, non_null, bound, issues, schema);
            // An index expression is evaluated too, so a nullable read used as one is caught.
            if let CelNode::Index(index) = node {
                walk_nullable(&index.index, non_null, bound, issues, schema);
            }
            return;
        }
        CelNode::Conditional(conditional) => {
            walk_nullable(&conditional.condition, non_null, bound, issues, schema);
            let narrowed = derive_narrowing(&conditional.condition, bound);
            walk_nullable(&conditional.when_true, &union(non_null, &narrowed.when_true), bound, issues, schema);
            walk_nullable(&conditional.when_false, &union(non_null, &narrowed.when_false), bound, issues, schema);
            return;
        }
        CelNode::Binary(binary) if matches!(binary.operator, CelBinaryOperator::And | CelBinaryOperator::Or) => {
            walk_nullable(&binary.left, non_null, bound, issues, schema);
            let narrowed = derive_narrowing(&binary.left, bound);
            let carried =
                if binary.operator == CelBinaryOperator::And { narrowed.when_true } else { narrowed.when_false };
            walk_nullable(&binary.right, &union(non_null, &carried), bound, issues, schema);
            return;
        }
        _ => {}
    }
    // A module call's receiver names a module, not a value.
    if let Some(call) = module_call_of(node) {
        for arg in call.args {
            walk_nullable(arg, non_null, bound, issues, schema);
        }
        return;
    }
    if let Some(bind) = bind_call(node) {
        walk_nullable(bind.init, non_null, bound, issues, schema);
        walk_nullable(bind.body, non_null, &with_bound(bound, bind.name), issues, schema);
        return;
    }
    if let Some(macro_call) = comprehension(node) {
        walk_nullable(macro_call.receiver, non_null, bound, issues, schema);
        let inner = with_bound(bound, macro_call.bound);
        for arg in macro_call.scoped {
            walk_nullable(arg, non_null, &inner, issues, schema);
        }
        return;
    }
    for child in child_nodes(node) {
        walk_nullable(child, non_null, bound, issues, schema);
    }
}

/// The message for a chain that reads a member its context schema does not declare, or
/// past a live value; `None` when the chain is valid or the schema too open to judge.
pub fn validate_chain_against_schema(chain: &[String], schema: &Value) -> Option<String> {
    chain_failure_against_schema(chain, schema).map(|failure| failure.message)
}

/// The member chains, joined with `.`, whose last read the type checker already refused —
/// the selects whose member range is one of `ranges`.
pub fn chains_refused_at(node: &CelNode, ranges: &[SourceRange]) -> HashSet<String> {
    let mut refused = HashSet::new();
    if ranges.is_empty() {
        return refused;
    }
    for current in telorun_cel::walk_tree(node) {
        if let CelNode::Select(select) = current {
            if ranges.contains(&select.field_range) {
                if let Some(chain) = extract_chain(current, &HashSet::new()) {
                    refused.insert(chain.join("."));
                }
            }
        }
    }
    refused
}

/// A chain's failure against a schema: the path of the read that failed and its message.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct ChainFailure {
    pub path: String,
    pub message: String,
}

/// [`validate_chain_against_schema`], with the path of the read that failed.
pub fn chain_failure_against_schema(chain: &[String], schema: &Value) -> Option<ChainFailure> {
    let mut walked: Vec<&Value> = Vec::new();
    let mut current: Vec<&Value> = vec![schema];
    for (at, key) in chain.iter().enumerate() {
        let holds: fn(&Value) -> bool = if key == INDEX_SEGMENT { holds_collection } else { holds_object };
        let alternatives = alternatives_of(&current, &walked, holds)?;
        if alternatives.is_empty() {
            return None;
        }
        walked.extend(alternatives.iter().copied());
        // An index reads an element: an array's `items`, or a map's value schema. An object
        // that also declares `properties` may be indexed by one of those names, so nothing
        // below it is judged.
        if key == INDEX_SEGMENT {
            let mut elements = Vec::new();
            for alternative in &alternatives {
                let items = alternative.get("items").filter(|items| items.is_object());
                let element = items.or_else(|| {
                    if truthy(alternative.get("properties")) {
                        return None;
                    }
                    alternative.get("additionalProperties").filter(|values| values.is_object())
                })?;
                elements.push(element);
            }
            current = elements;
            continue;
        }
        let mut found: Vec<&Value> = Vec::new();
        let mut declares = false;
        let mut available: Vec<String> = Vec::new();
        for alternative in &alternatives {
            let conjuncts = schema_conjuncts(
                *alternative,
                &|node: &&Value| *node,
                &|_: &&Value, raw: &Value| follow_local_ref(Some(raw), &walked),
            )?;
            let mut declared: Option<&Value> = None;
            let mut group_declares = false;
            for conjunct in conjuncts {
                // A value type declaring members is read by those members alone: they are its
                // fields, closed as the CEL type the type registers.
                let members: Option<&Map<String, Value>> = members_of(conjunct);
                let Some(props) = members.or_else(|| conjunct.get("properties").and_then(Value::as_object)) else {
                    continue;
                };
                group_declares = true;
                if let Some(member) = props.get(key.as_str()) {
                    declared = Some(member);
                    break;
                }
                if members.is_none() && conjunct.get("additionalProperties") == Some(&Value::Bool(true)) {
                    return None;
                }
                for name in own_keys(props) {
                    if !available.iter().any(|held| held == name) {
                        available.push(name.into());
                    }
                }
            }
            // An alternative saying nothing about its members could hold this one.
            if !group_declares {
                return None;
            }
            declares = true;
            if let Some(declared) = declared {
                found.push(declared);
            }
        }
        if !found.is_empty() {
            if at < chain.len() - 1 && found.iter().any(|node| is_live_slot(node)) {
                let path = chain[..=at].join(".");
                return Some(ChainFailure {
                    message: format!(
                        "'{path}' yields a stream — pipe it through an Encoder or iterate in a JS.Script step (no member access on stream-typed values)"
                    ),
                    path,
                });
            }
            current = found;
            continue;
        }
        if !declares {
            return None;
        }
        let path = chain[..=at].join(".");
        return Some(ChainFailure {
            message: format!("'{path}' is not defined (available: {})", available.join(", ")),
            path,
        });
    }
    None
}

/// An object's own keys in ECMAScript's order: array indices ascending, then every other
/// key in the order written — the order Node's `Object.keys` lists them in.
fn own_keys(map: &Map<String, Value>) -> Vec<&str> {
    let mut indices: Vec<(u32, &str)> =
        map.keys().filter_map(|key| array_index(key).map(|index| (index, key.as_str()))).collect();
    indices.sort_unstable();
    let mut keys: Vec<&str> = indices.into_iter().map(|(_, key)| key).collect();
    keys.extend(map.keys().filter(|key| array_index(key).is_none()).map(String::as_str));
    keys
}

fn array_index(key: &str) -> Option<u32> {
    if key != "0" && (key.starts_with('0') || key.is_empty() || !key.bytes().all(|byte| byte.is_ascii_digit())) {
        return None;
    }
    key.parse::<u32>().ok().filter(|index| *index != u32::MAX)
}

/// The alternatives a value at `nodes` may be read through: each node with its references
/// followed and every union split into its branches, recursively, keeping only those
/// `holds` accepts. `None` when a reference or a branch cannot be read.
fn alternatives_of<'s>(
    nodes: &[&'s Value],
    walked: &[&'s Value],
    holds: fn(&Value) -> bool,
) -> Option<Vec<&'s Value>> {
    fn visit<'s>(
        raw: &'s Value,
        depth: usize,
        walked: &[&'s Value],
        out: &mut Vec<&'s Value>,
        holds: fn(&Value) -> bool,
    ) -> bool {
        if depth > 32 {
            return false;
        }
        let reach: Vec<&'s Value> = walked.iter().chain(out.iter()).copied().collect();
        let Some(node) = follow_local_ref(Some(raw), &reach).filter(|node| node.is_object()) else { return false };
        if let Some(branches) = branches(node) {
            if !truthy(node.get("properties")) && !truthy(node.get("allOf")) {
                return branches.iter().all(|branch| branch.is_object() && visit(branch, depth + 1, walked, out, holds));
            }
        }
        if holds(node) {
            out.push(node);
        }
        true
    }
    let mut out = Vec::new();
    for node in nodes {
        if !visit(node, 0, walked, &mut out, holds) {
            return None;
        }
    }
    Some(out)
}

/// The node's `type` keyword as a list of names, or `None` where it states none.
fn type_names(node: &Value) -> Option<Vec<&Value>> {
    match node.get("type") {
        None => None,
        Some(Value::Array(names)) => Some(names.iter().collect()),
        Some(name) => Some(vec![name]),
    }
}

fn names_type(names: &[&Value], name: &str) -> bool {
    names.iter().any(|held| held.as_str() == Some(name))
}

/// Whether a value at `node` can be a list or a map a chain indexes into.
fn holds_collection(node: &Value) -> bool {
    if node.get("x-telo-type").is_some() {
        return false;
    }
    type_names(node).is_none_or(|names| names_type(&names, "array") || names_type(&names, "object"))
}

/// Whether a value at `node` can be an object whose members a chain reads: a node typed as
/// no object (null, a scalar, a list) or a value type with no members cannot.
fn holds_object(node: &Value) -> bool {
    if members_of(node).is_some() {
        return true;
    }
    if node.get("x-telo-type").is_some() {
        return false;
    }
    if type_names(node).is_some_and(|names| !names_type(&names, "object")) {
        return false;
    }
    if let Some(constant) = node.get("const") {
        if !matches!(constant, Value::Object(_) | Value::Array(_)) {
            return false;
        }
    }
    true
}

/// A schema node and each of its `allOf` members, recursively — or `None` when a member
/// cannot be read, which leaves the node unjudged. `schema_of` reads the schema off what
/// the caller carries per node, and `member` reads one written member in its parent's
/// context, following its references. Shared by every walk reading a node as the
/// conjunction it is.
pub fn schema_conjuncts<'s, N: Clone>(
    node: N,
    schema_of: &dyn Fn(&N) -> &'s Value,
    member: &dyn Fn(&N, &'s Value) -> Option<N>,
) -> Option<Vec<N>> {
    let mut out = vec![node.clone()];
    let Some(all) = schema_of(&node).get("allOf").and_then(Value::as_array) else { return Some(out) };
    for raw in all {
        let read = member(&node, raw)?;
        out.extend(schema_conjuncts(read, schema_of, member)?);
    }
    Some(out)
}

/// `node` with every document-local `$ref` it is followed through resolved against the
/// nearest node of `walked` holding the target. A reference that is not local, or whose
/// target no walked node holds, yields `None`.
fn follow_local_ref<'s>(node: Option<&'s Value>, walked: &[&'s Value]) -> Option<&'s Value> {
    let mut seen: Vec<*const Value> = Vec::new();
    let mut current = node;
    while let Some(held) = current {
        let Some(reference) = held.get("$ref").and_then(Value::as_str) else { break };
        let identity = held as *const Value;
        if seen.contains(&identity) {
            return None;
        }
        seen.push(identity);
        let pointer = reference.strip_prefix('#')?;
        current = walked.iter().rev().find_map(|root| schema_at_pointer(root, pointer));
    }
    current
}

/// The node a JSON Pointer (the part of a reference after `#`) names in `root`.
fn schema_at_pointer<'s>(root: &'s Value, pointer: &str) -> Option<&'s Value> {
    if pointer.is_empty() {
        return Some(root);
    }
    let rest = pointer.strip_prefix('/')?;
    let mut current = root;
    for raw in rest.split('/') {
        let segment = decode_uri_component(raw)?.replace("~1", "/").replace("~0", "~");
        current = match current {
            Value::Object(map) => map.get(&segment)?,
            Value::Array(items) => items.get(array_index(&segment)? as usize)?,
            _ => return None,
        };
    }
    current.is_object().then_some(current)
}

/// ECMAScript's `decodeURIComponent`, or `None` where it would throw: a `%` not followed by
/// two hex digits, or escapes that are not UTF-8.
fn decode_uri_component(text: &str) -> Option<String> {
    if !text.contains('%') {
        return Some(text.into());
    }
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut at = 0;
    while at < bytes.len() {
        if bytes[at] == b'%' {
            let hex = text.get(at + 1..at + 3)?;
            out.push(u8::from_str_radix(hex, 16).ok().filter(|_| hex.bytes().all(|b| b.is_ascii_hexdigit()))?);
            at += 3;
        } else {
            out.push(bytes[at]);
            at += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// JavaScript truthiness of a keyword's value: absent, `null`, `false`, `0` and `""` are not.
fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) | Some(Value::Bool(false)) => false,
        Some(Value::Number(number)) => number.as_f64().is_some_and(|n| n != 0.0),
        Some(Value::String(text)) => !text.is_empty(),
        Some(_) => true,
    }
}
