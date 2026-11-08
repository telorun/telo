//! What a module call's argument is when it is written as literals alone — read off the
//! tree, never evaluated — `literal-argument.ts`.
//!
//! A host asks because some parameters accept only a value fixed where the call is
//! written (a `Text` parameter), and the same reading gives the keys of a map literal and
//! what each holds.
//!
//! Where this file answers otherwise than Node: a `uint` literal is the value
//! `CelValue::Uint`, where Node reads it as a bare bigint, indistinguishable from an `int`;
//! and negating the most negative `int` literal is not a literal here, where Node answers
//! an integer outside int64.

use telorun_cel::{qualified_calls, CelLiteral, CelNode, CelUnaryOperator};
use telorun_cel_value::{CelRecord, CelValue};

use crate::cel::compile::CompiledCall;
use crate::cel::module_call::module_call_nodes;

/// The value `node` is written as, when it is literals alone: a scalar, bytes, null, or a
/// list or string-keyed map of them.
pub fn literal_value_of(node: &CelNode) -> Option<CelValue> {
    match node {
        CelNode::Literal(literal) => Some(literal_value(&literal.literal)),
        CelNode::Unary(unary) if unary.operator == CelUnaryOperator::Negate => match &*unary.operand {
            CelNode::Literal(operand) => match operand.literal {
                CelLiteral::Int(value) => value.checked_neg().map(CelValue::Int),
                CelLiteral::Double(value) => Some(CelValue::Double(-value)),
                _ => None,
            },
            _ => None,
        },
        CelNode::List(list) => list
            .elements
            .iter()
            .map(|element| if element.optional { None } else { literal_value_of(&element.value) })
            .collect::<Option<Vec<_>>>()
            .map(|items| CelValue::List(items.into())),
        CelNode::Map(map) => {
            let mut out = CelRecord::new();
            for entry in &map.entries {
                let key = string_key(entry)?;
                out.insert(key, literal_value_of(&entry.value)?);
            }
            Some(CelValue::Record(out))
        }
        _ => None,
    }
}

fn literal_value(literal: &CelLiteral) -> CelValue {
    match literal {
        CelLiteral::Int(value) => CelValue::Int(*value),
        CelLiteral::Uint(value) => CelValue::Uint(*value),
        CelLiteral::Double(value) => CelValue::Double(*value),
        CelLiteral::String(value) => CelValue::String(value.as_str().into()),
        CelLiteral::Bytes(value) => CelValue::Bytes(value.as_slice().into()),
        CelLiteral::Bool(value) => CelValue::Bool(*value),
        CelLiteral::Null => CelValue::Null,
    }
}

/// The name Node's tree gives a literal's type.
fn literal_type_name(literal: &CelLiteral) -> &'static str {
    match literal {
        CelLiteral::Int(_) => "int",
        CelLiteral::Uint(_) => "uint",
        CelLiteral::Double(_) => "double",
        CelLiteral::String(_) => "string",
        CelLiteral::Bytes(_) => "bytes",
        CelLiteral::Bool(_) => "bool",
        CelLiteral::Null => "null",
    }
}

/// The CEL type a literal node is written as: a literal's own (`null_type` for null), or a
/// negated literal's operand's, as the tree names it.
pub fn literal_type_of(node: &CelNode) -> Option<&'static str> {
    match node {
        CelNode::Literal(literal) => Some(match literal.literal {
            CelLiteral::Null => "null_type",
            ref other => literal_type_name(other),
        }),
        CelNode::Unary(unary) if unary.operator == CelUnaryOperator::Negate => match &*unary.operand {
            CelNode::Literal(operand) => Some(literal_type_name(&operand.literal)),
            _ => None,
        },
        _ => None,
    }
}

/// One entry of a map literal whose key is a string literal.
pub struct MapLiteralEntry<'a> {
    pub key: &'a str,
    pub value: &'a CelNode,
}

/// The entries of a map literal keyed by string literals, or `None` for any other node.
pub fn map_literal_entries(node: &CelNode) -> Option<Vec<MapLiteralEntry<'_>>> {
    let CelNode::Map(map) = node else { return None };
    map.entries.iter().map(|entry| Some(MapLiteralEntry { key: string_key(entry)?, value: &entry.value })).collect()
}

fn string_key(entry: &telorun_cel::CelMapEntry) -> Option<&str> {
    match &*entry.key {
        CelNode::Literal(key) if !entry.optional => match &key.literal {
            CelLiteral::String(text) => Some(text),
            _ => None,
        },
        _ => None,
    }
}

/// One argument of a module call as written: its value when it is literals alone.
#[derive(Clone, PartialEq, Debug)]
pub enum WrittenArgument {
    Literal(CelValue),
    NotLiteral,
}

/// Every qualified call in `root` with how each argument is written, outermost first.
pub fn written_calls(root: &CelNode) -> Vec<CompiledCall> {
    if qualified_calls(root).is_empty() {
        return Vec::new();
    }
    module_call_nodes(root)
        .into_iter()
        .map(|(_, call)| CompiledCall {
            qualified: call.qualified,
            arguments: call
                .args
                .iter()
                .map(|arg| literal_value_of(arg).map_or(WrittenArgument::NotLiteral, WrittenArgument::Literal))
                .collect(),
        })
        .collect()
}
