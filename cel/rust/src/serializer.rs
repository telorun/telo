//! The tree back to CEL source — `serializer.ts`.
//!
//! The contract is round-trip: the text written for a tree the reader produced reads
//! back, under the options the tree was read with, to an equal tree (`tree_equality.rs`),
//! and a qualified call writes back as the `Alias.fn(x)` it was read from. That is what
//! makes a tree, rather than the author's text, something a tool may hold and hand back.
//!
//! "Under the options the tree was read with" is the whole of it: an optional entry
//! (`[?x]`, `{?k: v}`) is written wherever the tree holds one, and reads back only
//! where the optional syntax is on; a qualified call reads back as one only under its
//! namespace.
//!
//! Parentheses are placed from precedence alone, never kept from the source, and a
//! string is always written between double quotes: the tree records structure and
//! values, and the source's own formatting is neither.
//!
//! It refuses rather than guesses. A tree that cannot be written as CEL — an unparsed
//! hole, a double that is not a number, a name that is not a name — is an error,
//! because text that does not read back would make every later answer about it wrong.
//! A tree with several such faults reports the one Node reports: the first in the order
//! the text is written.
//!
//! A double is written as ECMAScript writes a number, so the digits are the ones Node
//! writes.
//!
//! The writer runs on a heap work list and costs no stack, whatever the depth of the
//! tree.
//!
//! Declared differently from the Node file:
//! - `CelSerializeError` is the `Err` of `serialize_tree`, where Node throws it.
//!
//! Node items with no twin:
//! - The two integer-range refusals (`… is outside the range of a 64-bit integer`,
//!   `… of an unsigned 64-bit integer`). A literal here holds an `i64` or a `u64`, so
//!   no tree can hold the value they refuse: the range is the type.

use std::fmt;
use std::sync::Arc;

use telorun_cel_value::{es_number, json_quote};

use crate::reserved_words::{is_identifier_spelling, is_reserved_word};
use crate::syntax_tree::{CelBinaryOperator, CelLiteral, CelNode, CelUnaryOperator};

/// A tree that has no CEL source.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct CelSerializeError {
    pub message: String,
}

impl fmt::Display for CelSerializeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for CelSerializeError {}

fn refusal(message: impl Into<String>) -> CelSerializeError {
    CelSerializeError { message: message.into() }
}

/// Binding strength, loosest first; a child is wrapped when it binds more loosely than
/// its slot needs.
mod precedence {
    pub const CONDITIONAL: u8 = 0;
    pub const OR: u8 = 1;
    pub const AND: u8 = 2;
    pub const RELATION: u8 = 3;
    pub const ADDITIVE: u8 = 4;
    pub const MULTIPLICATIVE: u8 = 5;
    pub const UNARY: u8 = 6;
    pub const POSTFIX: u8 = 7;
    pub const PRIMARY: u8 = 8;
}

fn binary_precedence(operator: CelBinaryOperator) -> u8 {
    use CelBinaryOperator::*;
    match operator {
        Or => precedence::OR,
        And => precedence::AND,
        Equal | NotEqual | Less | LessEqual | Greater | GreaterEqual | In => precedence::RELATION,
        Add | Subtract => precedence::ADDITIVE,
        Multiply | Divide | Modulo => precedence::MULTIPLICATIVE,
    }
}

fn is_negative_number(literal: &CelLiteral) -> bool {
    match literal {
        CelLiteral::Int(value) => *value < 0,
        CelLiteral::Double(value) => *value < 0.0 || (*value == 0.0 && value.is_sign_negative()),
        _ => false,
    }
}

const UNPARSED: &str = "an unparsed expression has no source to write";

/// A literal written with a leading `-` binds as loosely as a negation does.
fn precedence_of(node: &CelNode) -> Result<u8, CelSerializeError> {
    Ok(match node {
        CelNode::Literal(node) if is_negative_number(&node.literal) => precedence::UNARY,
        CelNode::Literal(_) | CelNode::Ident(_) | CelNode::List(_) | CelNode::Map(_) => precedence::PRIMARY,
        CelNode::Select(_)
        | CelNode::Index(_)
        | CelNode::Call(_)
        | CelNode::ReceiverCall(_)
        | CelNode::QualifiedCall(_) => precedence::POSTFIX,
        CelNode::Unary(_) => precedence::UNARY,
        CelNode::Binary(node) => binary_precedence(node.operator),
        CelNode::Conditional(_) => precedence::CONDITIONAL,
        CelNode::Unparsed(_) => return Err(refusal(UNPARSED)),
    })
}

fn not_a_name(text: &str, what: &str) -> CelSerializeError {
    refusal(format!("{} is not a name, so it cannot be written as a {what}", json_quote(text)))
}

fn name<'a>(text: &'a str, what: &str) -> Result<&'a str, CelSerializeError> {
    if !is_identifier_spelling(text) || is_reserved_word(text) {
        return Err(not_a_name(text, what));
    }
    Ok(text)
}

/// A member or a called function may be named by any word, reserved or not.
fn member_name<'a>(text: &'a str, what: &str) -> Result<&'a str, CelSerializeError> {
    if !is_identifier_spelling(text) {
        return Err(not_a_name(text, what));
    }
    Ok(text)
}

/// A member name, between backticks where it needs them. A name that is not spelled as
/// an identifier is quoted whether or not it was written that way, because that is the
/// only spelling it has; a backtick inside one has none at all, so it is refused.
fn write_field_name(out: &mut String, text: &str, quoted: bool) -> Result<(), CelSerializeError> {
    if !quoted && is_identifier_spelling(text) {
        out.push_str(text);
        return Ok(());
    }
    if text.contains('`') || text.contains('\n') || text.is_empty() {
        return Err(refusal(format!("{} cannot be written as a member name", json_quote(text))));
    }
    out.push('`');
    out.push_str(text);
    out.push('`');
    Ok(())
}

fn write_double(out: &mut String, value: f64) -> Result<(), CelSerializeError> {
    if value.is_nan() {
        return Err(refusal("a double that is not a number cannot be written as a literal"));
    }
    if value == f64::INFINITY {
        out.push_str("1e999");
        return Ok(());
    }
    if value == f64::NEG_INFINITY {
        out.push_str("-1e999");
        return Ok(());
    }
    if is_negative_number(&CelLiteral::Double(value)) {
        out.push('-');
    }
    let text = es_number(value.abs());
    out.push_str(&text);
    if !text.contains(['.', 'e']) {
        out.push_str(".0");
    }
    Ok(())
}

fn push_hex_escape(out: &mut String, code: u32) {
    out.push_str(&format!("\\x{code:02x}"));
}

/// A string literal, always in double quotes: the tree records a string's value and
/// not the quote the author typed.
fn write_string(out: &mut String, value: &str) {
    out.push('"');
    for character in value.chars() {
        match character {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            control if (control as u32) < 0x20 || control as u32 == 0x7f => push_hex_escape(out, control as u32),
            other => out.push(other),
        }
    }
    out.push('"');
}

fn write_bytes(out: &mut String, value: &[u8]) {
    out.push_str("b\"");
    for byte in value {
        match byte {
            0x5c => out.push_str("\\\\"),
            0x22 => out.push_str("\\\""),
            0x20..=0x7e => out.push(char::from(*byte)),
            other => push_hex_escape(out, u32::from(*other)),
        }
    }
    out.push('"');
}

fn write_literal(out: &mut String, literal: &CelLiteral) -> Result<(), CelSerializeError> {
    match literal {
        CelLiteral::Int(value) => out.push_str(&value.to_string()),
        CelLiteral::Uint(value) => {
            out.push_str(&value.to_string());
            out.push('u');
        }
        CelLiteral::Double(value) => write_double(out, *value)?,
        CelLiteral::String(value) => write_string(out, value),
        CelLiteral::Bytes(value) => write_bytes(out, value),
        CelLiteral::Bool(value) => out.push_str(if *value { "true" } else { "false" }),
        CelLiteral::Null => out.push_str("null"),
    }
    Ok(())
}

/// What is left to write, the next piece last. A name is judged when it is written and
/// not before, so the first fault met is the first in the text.
enum Piece<'a> {
    Text(&'static str),
    /// A node for a slot that binds at least as tightly as the number.
    Node(&'a CelNode, u8),
    Name(&'a str, &'static str),
    MemberName(&'a str, &'static str),
    FieldName(&'a str, bool),
    Literal(&'a CelLiteral),
}

fn push_pieces<'a, const N: usize>(pending: &mut Vec<Piece<'a>>, pieces: [Piece<'a>; N]) {
    pending.extend(pieces.into_iter().rev());
}

/// `a, b` — each item's own pieces, by `pieces`, the items written in order.
fn push_separated<'a, T>(pending: &mut Vec<Piece<'a>>, items: &'a [T], pieces: impl Fn(&mut Vec<Piece<'a>>, &'a T)) {
    for (at, item) in items.iter().enumerate().rev() {
        pieces(pending, item);
        if at > 0 {
            pending.push(Piece::Text(", "));
        }
    }
}

fn optional_mark(optional: bool) -> Piece<'static> {
    Piece::Text(if optional { "?" } else { "" })
}

fn push_arguments<'a>(pending: &mut Vec<Piece<'a>>, args: &'a [Arc<CelNode>]) {
    pending.push(Piece::Text(")"));
    push_separated(pending, args, |pending, argument| pending.push(Piece::Node(argument, precedence::CONDITIONAL)));
    pending.push(Piece::Text("("));
}

fn push_node<'a>(pending: &mut Vec<Piece<'a>>, node: &'a CelNode) -> Result<(), CelSerializeError> {
    use Piece::{FieldName, MemberName, Name, Node, Text};
    match node {
        CelNode::Literal(node) => pending.push(Piece::Literal(&node.literal)),
        CelNode::Ident(node) => {
            push_pieces(pending, [Text(if node.absolute { "." } else { "" }), Name(&node.name, "name")]);
        }
        CelNode::List(node) => {
            pending.push(Text("]"));
            push_separated(pending, &node.elements, |pending, element| {
                push_pieces(pending, [optional_mark(element.optional), Node(&element.value, precedence::CONDITIONAL)]);
            });
            pending.push(Text("["));
        }
        CelNode::Map(node) => {
            pending.push(Text("}"));
            push_separated(pending, &node.entries, |pending, entry| {
                push_pieces(
                    pending,
                    [
                        optional_mark(entry.optional),
                        Node(&entry.key, precedence::CONDITIONAL),
                        Text(": "),
                        Node(&entry.value, precedence::CONDITIONAL),
                    ],
                );
            });
            pending.push(Text("{"));
        }
        CelNode::Select(node) => push_pieces(
            pending,
            [
                Node(&node.operand, precedence::POSTFIX),
                Text("."),
                optional_mark(node.optional),
                FieldName(&node.field, node.quoted),
            ],
        ),
        CelNode::Index(node) => push_pieces(
            pending,
            [
                Node(&node.operand, precedence::POSTFIX),
                Text("["),
                optional_mark(node.optional),
                Node(&node.index, precedence::CONDITIONAL),
                Text("]"),
            ],
        ),
        CelNode::Call(node) => {
            push_arguments(pending, &node.args);
            pending.push(Name(&node.name, "function name"));
        }
        CelNode::ReceiverCall(node) => {
            push_arguments(pending, &node.args);
            push_pieces(
                pending,
                [Node(&node.receiver, precedence::POSTFIX), Text("."), MemberName(&node.name, "function name")],
            );
        }
        CelNode::QualifiedCall(node) => {
            push_arguments(pending, &node.args);
            push_pieces(pending, [Name(&node.namespace, "namespace"), Text("."), MemberName(&node.name, "function name")]);
        }
        CelNode::Unary(node) => {
            // A minus directly on a non-negative numeric literal would read back as part
            // of the literal, so it is parenthesized: `-(1)` stays a negation of one.
            match &*node.operand {
                CelNode::Literal(operand)
                    if node.operator == CelUnaryOperator::Negate
                        && matches!(operand.literal, CelLiteral::Int(_) | CelLiteral::Double(_))
                        && !is_negative_number(&operand.literal) =>
                {
                    push_pieces(pending, [Text("-("), Piece::Literal(&operand.literal), Text(")")]);
                }
                operand => push_pieces(pending, [Text(node.operator.as_str()), Node(operand, precedence::UNARY)]),
            }
        }
        CelNode::Binary(node) => {
            let level = binary_precedence(node.operator);
            push_pieces(
                pending,
                [Node(&node.left, level), Text(" "), Text(node.operator.as_str()), Text(" "), Node(&node.right, level + 1)],
            );
        }
        CelNode::Conditional(node) => push_pieces(
            pending,
            [
                Node(&node.condition, precedence::OR),
                Text(" ? "),
                Node(&node.when_true, precedence::CONDITIONAL),
                Text(" : "),
                Node(&node.when_false, precedence::CONDITIONAL),
            ],
        ),
        CelNode::Unparsed(_) => return Err(refusal(UNPARSED)),
    }
    Ok(())
}

/// The CEL source of a tree, or why it has none.
pub fn serialize_tree(root: &CelNode) -> Result<String, CelSerializeError> {
    let mut out = String::new();
    let mut pending = vec![Piece::Node(root, precedence::CONDITIONAL)];
    while let Some(piece) = pending.pop() {
        match piece {
            Piece::Text(text) => out.push_str(text),
            Piece::Name(text, what) => out.push_str(name(text, what)?),
            Piece::MemberName(text, what) => out.push_str(member_name(text, what)?),
            Piece::FieldName(text, quoted) => write_field_name(&mut out, text, quoted)?,
            Piece::Literal(literal) => write_literal(&mut out, literal)?,
            Piece::Node(node, needs) => {
                if precedence_of(node)? < needs {
                    out.push('(');
                    pending.push(Piece::Text(")"));
                }
                push_node(&mut pending, node)?;
            }
        }
    }
    Ok(out)
}
