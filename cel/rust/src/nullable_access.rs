//! What a guard proves about the chains it names — `nullable-access.ts`.
//!
//! A value whose declared type admits null is only safely dereferenced where something has
//! proven it is not null, and what counts as proof is three constructs: a conditional, `&&`
//! and `||`, over three tests — a comparison of a chain against `null`, `has(chain.member)`,
//! and a type test `type(chain) == T`. A guard written as any other call is not proof. Over a
//! condition `c`:
//!
//! - `chain != null` proves `chain` non-null where `c` holds; `chain == null` proves it
//!   where `c` fails. `null` may stand on either side.
//! - `has(chain.m)` proves, where it holds, that `chain` holds `m`: it is narrowed to the
//!   shapes that can hold that member.
//! - `type(chain) == T` (or `T == type(chain)`) proves, where it holds, that `chain` is one of
//!   the members whose runtime type is `T`, and where it fails one of the others; `!=` swaps
//!   them. Whether `T` names a type, and which, the checker decides once the comparison is typed.
//! - `chain.m == lit` (either order) and `chain.m in [lit, …]`, every element a literal,
//!   prove where they hold that `chain` is of the members whose `m` can equal a listed
//!   literal, and where they fail of those whose `m` can hold a value outside them; `!=` swaps
//!   them. Where the test holds the compared chain itself is of the members whose type a
//!   listed literal can have (`x == 'a'`), unless null is listed. `m` is read by a literal
//!   name, `.m` or `['m']`; a literal is a string, int, uint, double, bool or null literal, a
//!   negated number included.
//! - `!c` swaps the two.
//! - `a && b` proves, where it holds, what `a` and `b` prove; where it fails, nothing.
//! - `a || b` is the mirror: where it fails, both arms' negative proofs hold.
//!
//! A chain is a plain path of named members over a name (`error.code`): nothing proves
//! anything about `xs[i].code`. A proof is about the name its chain is rooted at, so it does
//! not hold where a macro or `cel.bind` binds that name again — unless the root is absolute
//! (`.x.a`), which names the declaration wherever it is read. Every function here walks the
//! tree on a heap list.
//!
//! Everything here is private to the crate, as on Node's entry.

use crate::cel_value::{literal_value, CelValue};
use crate::schema_nodes::node_key;
use crate::syntax_tree::{CelBinaryOperator, CelLiteral, CelNode, CelSelectNode, CelUnaryOperator};

/// What a guard proves about one chain: that it is not null (`member`, `type_test` and
/// `equals` nothing), that it holds `member`, that the type test `type_test` — the
/// comparison's node key and whether it held — came out so, or what an equality or
/// membership test says of it.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Proof {
    pub(crate) chain: String,
    pub(crate) member: Option<String>,
    pub(crate) type_test: Option<(usize, bool)>,
    pub(crate) equals: Option<EqualityProof>,
}

/// An equality or membership test: the chain's member `member` — or, with none, the chain
/// itself — equals one of `values` (`holds`) or none of them.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct EqualityProof {
    pub(crate) member: Option<String>,
    pub(crate) values: Vec<CelValue>,
    pub(crate) holds: bool,
}

/// The name a chain's text is rooted at, or `None` for an absolute chain, which no binding
/// names.
pub(crate) fn chain_text_root(chain: &str) -> Option<&str> {
    if chain.starts_with('.') {
        return None;
    }
    Some(chain.split_once('.').map_or(chain, |(root, _)| root))
}

/// The plain chain of named members a node spells, innermost name first, with its root and
/// whether the root is absolute.
fn chain_parts(node: &CelNode) -> Option<(&str, bool, Vec<&str>)> {
    let mut fields = Vec::new();
    let mut at = node;
    loop {
        match at {
            CelNode::Ident(ident) => {
                fields.reverse();
                return Some((&ident.name, ident.absolute, fields));
            }
            CelNode::Select(select) if !select.optional && !select.field.is_empty() => {
                fields.push(select.field.as_str());
                at = &select.operand;
            }
            _ => return None,
        }
    }
}

/// The dotted path a node spells, if it is a plain chain of named members. An absolute root is
/// spelled with its dot (`.x.a`): it names the declaration, never a name the expression bound.
pub(crate) fn chain_text(node: &CelNode) -> Option<String> {
    let (root, absolute, fields) = chain_parts(node)?;
    let mut text = if absolute { format!(".{root}") } else { root.to_string() };
    for field in fields {
        text.push('.');
        text.push_str(field);
    }
    Some(text)
}

/// The dotted path a select spells, if it is a plain chain of named members.
pub(crate) fn select_chain_text(select: &CelSelectNode) -> Option<String> {
    if select.optional || select.field.is_empty() {
        return None;
    }
    let mut text = chain_text(&select.operand)?;
    text.push('.');
    text.push_str(&select.field);
    Some(text)
}

/// What the condition proves where it holds.
pub(crate) fn proven_where_true(condition: &CelNode) -> Vec<Proof> {
    proven(condition, true)
}

/// What the condition proves where it fails.
pub(crate) fn proven_where_false(condition: &CelNode) -> Vec<Proof> {
    proven(condition, false)
}

/// The proofs of a condition where it holds (`holds`) or fails, in Node's order.
fn proven(condition: &CelNode, holds: bool) -> Vec<Proof> {
    let mut proofs = Vec::new();
    let mut pending = vec![(condition, holds)];
    while let Some((node, holds)) = pending.pop() {
        match node {
            CelNode::Binary(binary) => match (binary.operator, holds) {
                (CelBinaryOperator::NotEqual, true) | (CelBinaryOperator::Equal, false) => {
                    proofs.extend(null_test(&binary.left, &binary.right));
                    proofs.extend(type_test(node, &binary.left, &binary.right, false));
                    proofs.extend(equality_test(&binary.left, &binary.right, false));
                }
                (CelBinaryOperator::Equal, true) | (CelBinaryOperator::NotEqual, false) => {
                    proofs.extend(type_test(node, &binary.left, &binary.right, true));
                    proofs.extend(equality_test(&binary.left, &binary.right, true));
                }
                (CelBinaryOperator::In, holds) => proofs.extend(membership_test(&binary.left, &binary.right, holds)),
                (CelBinaryOperator::And, true) | (CelBinaryOperator::Or, false) => {
                    pending.push((&binary.right, holds));
                    pending.push((&binary.left, holds));
                }
                _ => {}
            },
            CelNode::Unary(unary) if unary.operator == CelUnaryOperator::Not => pending.push((&unary.operand, !holds)),
            CelNode::Call(call) if holds && call.name == "has" && call.args.len() == 1 => {
                if let CelNode::Select(argument) = &*call.args[0] {
                    if !argument.optional && !argument.field.is_empty() {
                        if let Some(chain) = chain_text(&argument.operand) {
                            proofs.push(Proof { chain, member: Some(argument.field.clone()), type_test: None, equals: None });
                        }
                    }
                }
            }
            _ => {}
        }
    }
    proofs
}

/// The chain a comparison against `null` is about, either way round.
fn null_test(left: &CelNode, right: &CelNode) -> Option<Proof> {
    let tested = if is_null_literal(right) {
        left
    } else if is_null_literal(left) {
        right
    } else {
        return None;
    };
    chain_text(tested).map(|chain| Proof { chain, member: None, type_test: None, equals: None })
}

/// The chains a comparison tests the type of, `type(chain)` on either side, left first.
fn type_test(comparison: &CelNode, left: &CelNode, right: &CelNode, holds: bool) -> Vec<Proof> {
    let key = node_key(comparison);
    [left, right]
        .into_iter()
        .filter_map(type_tested_chain)
        .map(|chain| Proof { chain, member: None, type_test: Some((key, holds)), equals: None })
        .collect()
}

/// The chain `type(chain)` tests, where the node is that call.
pub(crate) fn type_tested_chain(node: &CelNode) -> Option<String> {
    if !is_type_call(node) {
        return None;
    }
    let CelNode::Call(call) = node else { return None };
    chain_text(&call.args[0])
}

/// Whether a node is a call of `type` on one argument.
pub(crate) fn is_type_call(node: &CelNode) -> bool {
    matches!(node, CelNode::Call(call) if call.name == "type" && call.args.len() == 1)
}

/// What `x == lit` (either order) proves where it holds (`holds`) or fails.
fn equality_test(left: &CelNode, right: &CelNode, holds: bool) -> Vec<Proof> {
    if let Some(value) = literal_of(right) {
        return compared_proofs(left, vec![value], holds);
    }
    match literal_of(left) {
        Some(value) => compared_proofs(right, vec![value], holds),
        None => Vec::new(),
    }
}

/// What `x in [lit, …]` proves, every element a literal written plainly.
fn membership_test(element: &CelNode, list: &CelNode, holds: bool) -> Vec<Proof> {
    let CelNode::List(list) = list else { return Vec::new() };
    let mut values = Vec::with_capacity(list.elements.len());
    for held in &list.elements {
        match (held.optional, literal_of(&held.value)) {
            (false, Some(value)) => values.push(value),
            _ => return Vec::new(),
        }
    }
    compared_proofs(element, values, holds)
}

/// The proofs about a compared node: its operand's member, and where the test holds, the node
/// itself — unless null is listed, since what a test against null proves of its own chain is
/// the null test's, a dereference staying the nullable read it was.
fn compared_proofs(compared: &CelNode, values: Vec<CelValue>, holds: bool) -> Vec<Proof> {
    let mut proofs = Vec::new();
    if let Some((operand, member)) = member_by_name(compared) {
        if let Some(chain) = chain_text(operand) {
            let equals = EqualityProof { member: Some(member.to_string()), values: values.clone(), holds };
            proofs.push(Proof { chain, member: None, type_test: None, equals: Some(equals) });
        }
    }
    if holds && !values.iter().any(|value| matches!(value, CelValue::Null)) {
        if let Some(chain) = chain_text(compared) {
            proofs.push(Proof { chain, member: None, type_test: None, equals: Some(EqualityProof { member: None, values, holds }) });
        }
    }
    proofs
}

/// A member read by a literal name: `.m`, or `['m']`.
fn member_by_name(node: &CelNode) -> Option<(&CelNode, &str)> {
    match node {
        CelNode::Select(select) if !select.optional && !select.field.is_empty() => Some((&select.operand, &select.field)),
        CelNode::Index(index) if !index.optional => match &*index.index {
            CelNode::Literal(literal) => match &literal.literal {
                CelLiteral::String(member) => Some((&index.operand, member)),
                _ => None,
            },
            _ => None,
        },
        _ => None,
    }
}

/// The value a literal node writes, for every literal kind but bytes.
fn literal_of(node: &CelNode) -> Option<CelValue> {
    match node {
        CelNode::Literal(literal) if !matches!(literal.literal, CelLiteral::Bytes(_)) => Some(literal_value(&literal.literal)),
        _ => None,
    }
}

fn is_null_literal(node: &CelNode) -> bool {
    matches!(node, CelNode::Literal(literal) if literal.literal == CelLiteral::Null)
}
