//! Literal trees for tests, and a source read against the Node build's answer.
//!
//! One builder per node kind, each answering a shared node, with ranges last as
//! `start, end` in UTF-16 code units. A table row of `reading(…)` is the Node build's
//! whole answer for one source: the tree and the diagnostic. A row of `resolved(…)` is
//! its whole answer for one source read as an expression: the namespace set as well.

#![allow(dead_code)]

use std::sync::Arc;

use telorun_cel::{
    parse_expression, parse_syntax, serialize_tree, CelBinaryNode, CelBinaryOperator, CelCallNode, CelConditionalNode, CelIdentNode, CelIndexNode,
    CelListElement, CelListNode, CelLiteral, CelLiteralNode, CelMapEntry, CelMapNode, CelNode, CelParseLimits,
    CelQualifiedCallNode, CelReceiverCallNode, CelSelectNode, CelSyntaxCode, CelSyntaxDiagnostic, CelUnaryNode,
    CelUnaryOperator, CelUnparsedNode, ParseExpressionOptions, ParseOptions, ParseResult, QualifiedCall, SourceRange,
};

pub fn range(start: u32, end: u32) -> SourceRange {
    SourceRange { start, end }
}

fn literal(literal: CelLiteral, start: u32, end: u32) -> Arc<CelNode> {
    Arc::new(CelNode::Literal(CelLiteralNode { literal, range: range(start, end) }))
}

pub fn literal_int(value: i64, start: u32, end: u32) -> Arc<CelNode> {
    literal(CelLiteral::Int(value), start, end)
}

pub fn literal_uint(value: u64, start: u32, end: u32) -> Arc<CelNode> {
    literal(CelLiteral::Uint(value), start, end)
}

/// A double by its bits, so a table row is exact.
pub fn literal_double(bits: u64, start: u32, end: u32) -> Arc<CelNode> {
    literal(CelLiteral::Double(f64::from_bits(bits)), start, end)
}

pub fn literal_string(value: &str, start: u32, end: u32) -> Arc<CelNode> {
    literal(CelLiteral::String(value.to_string()), start, end)
}

pub fn literal_bytes(value: &[u8], start: u32, end: u32) -> Arc<CelNode> {
    literal(CelLiteral::Bytes(value.to_vec()), start, end)
}

pub fn literal_bool(value: bool, start: u32, end: u32) -> Arc<CelNode> {
    literal(CelLiteral::Bool(value), start, end)
}

pub fn literal_null(start: u32, end: u32) -> Arc<CelNode> {
    literal(CelLiteral::Null, start, end)
}

pub fn ident(name: &str, absolute: bool, start: u32, end: u32) -> Arc<CelNode> {
    Arc::new(CelNode::Ident(CelIdentNode { name: name.to_string(), absolute, range: range(start, end) }))
}

pub fn element(value: Arc<CelNode>, optional: bool) -> CelListElement {
    CelListElement { value, optional }
}

pub fn list(elements: Vec<CelListElement>, start: u32, end: u32) -> Arc<CelNode> {
    Arc::new(CelNode::List(CelListNode { elements, range: range(start, end) }))
}

pub fn entry(key: Arc<CelNode>, value: Arc<CelNode>, optional: bool) -> CelMapEntry {
    CelMapEntry { key, value, optional }
}

pub fn map(entries: Vec<CelMapEntry>, start: u32, end: u32) -> Arc<CelNode> {
    Arc::new(CelNode::Map(CelMapNode { entries, range: range(start, end) }))
}

pub fn select(
    operand: Arc<CelNode>,
    field: &str,
    field_range: (u32, u32),
    optional: bool,
    quoted: bool,
    start: u32,
    end: u32,
) -> Arc<CelNode> {
    Arc::new(CelNode::Select(CelSelectNode {
        operand,
        field: field.to_string(),
        field_range: range(field_range.0, field_range.1),
        optional,
        quoted,
        range: range(start, end),
    }))
}

pub fn index(operand: Arc<CelNode>, index: Arc<CelNode>, optional: bool, start: u32, end: u32) -> Arc<CelNode> {
    Arc::new(CelNode::Index(CelIndexNode { operand, index, optional, range: range(start, end) }))
}

pub fn call(name: &str, name_range: (u32, u32), args: Vec<Arc<CelNode>>, start: u32, end: u32) -> Arc<CelNode> {
    Arc::new(CelNode::Call(CelCallNode {
        name: name.to_string(),
        name_range: range(name_range.0, name_range.1),
        args,
        range: range(start, end),
    }))
}

pub fn receiver_call(
    receiver: Arc<CelNode>,
    name: &str,
    name_range: (u32, u32),
    args: Vec<Arc<CelNode>>,
    start: u32,
    end: u32,
) -> Arc<CelNode> {
    Arc::new(CelNode::ReceiverCall(CelReceiverCallNode {
        receiver,
        name: name.to_string(),
        name_range: range(name_range.0, name_range.1),
        args,
        range: range(start, end),
    }))
}

pub fn qualified_call(
    namespace: &str,
    namespace_range: (u32, u32),
    name: &str,
    name_range: (u32, u32),
    args: Vec<Arc<CelNode>>,
    start: u32,
    end: u32,
) -> Arc<CelNode> {
    Arc::new(CelNode::QualifiedCall(CelQualifiedCallNode {
        namespace: namespace.to_string(),
        namespace_range: range(namespace_range.0, namespace_range.1),
        name: name.to_string(),
        name_range: range(name_range.0, name_range.1),
        args,
        range: range(start, end),
    }))
}

/// The operator as CEL writes it: `!` or `-`.
pub fn unary_operator(written: &str) -> CelUnaryOperator {
    [CelUnaryOperator::Not, CelUnaryOperator::Negate]
        .into_iter()
        .find(|operator| operator.as_str() == written)
        .unwrap_or_else(|| panic!("{written} is not a unary operator"))
}

/// The operator as CEL writes it: `+`, `in`, `&&` …
pub fn binary_operator(written: &str) -> CelBinaryOperator {
    use CelBinaryOperator::*;
    [Or, And, Equal, NotEqual, Less, LessEqual, Greater, GreaterEqual, In, Add, Subtract, Multiply, Divide, Modulo]
        .into_iter()
        .find(|operator| operator.as_str() == written)
        .unwrap_or_else(|| panic!("{written} is not a binary operator"))
}

pub fn unary(operator: &str, operand: Arc<CelNode>, start: u32, end: u32) -> Arc<CelNode> {
    Arc::new(CelNode::Unary(CelUnaryNode { operator: unary_operator(operator), operand, range: range(start, end) }))
}

pub fn binary(operator: &str, left: Arc<CelNode>, right: Arc<CelNode>, start: u32, end: u32) -> Arc<CelNode> {
    Arc::new(CelNode::Binary(CelBinaryNode {
        operator: binary_operator(operator),
        left,
        right,
        range: range(start, end),
    }))
}

pub fn conditional(
    condition: Arc<CelNode>,
    when_true: Arc<CelNode>,
    when_false: Arc<CelNode>,
    start: u32,
    end: u32,
) -> Arc<CelNode> {
    Arc::new(CelNode::Conditional(CelConditionalNode { condition, when_true, when_false, range: range(start, end) }))
}

pub fn unparsed(start: u32, end: u32) -> Arc<CelNode> {
    Arc::new(CelNode::Unparsed(CelUnparsedNode { range: range(start, end) }))
}

/// A tree's height as the depth limit counts it: a node with no child is 1 high, any
/// other one more than its tallest child.
pub fn tree_height(root: &CelNode) -> usize {
    let mut tallest = 0;
    let mut pending = vec![(root, 1)];
    while let Some((node, height)) = pending.pop() {
        tallest = tallest.max(height);
        pending.extend(telorun_cel::child_nodes(node).into_iter().map(|child| (child, height + 1)));
    }
    tallest
}

/// The kind as Node names it.
pub fn kind_name(node: &CelNode) -> &'static str {
    match node {
        CelNode::Literal(_) => "literal",
        CelNode::Ident(_) => "ident",
        CelNode::List(_) => "list",
        CelNode::Map(_) => "map",
        CelNode::Select(_) => "select",
        CelNode::Index(_) => "index",
        CelNode::Call(_) => "call",
        CelNode::ReceiverCall(_) => "receiverCall",
        CelNode::QualifiedCall(_) => "qcall",
        CelNode::Unary(_) => "unary",
        CelNode::Binary(_) => "binary",
        CelNode::Conditional(_) => "conditional",
        CelNode::Unparsed(_) => "unparsed",
    }
}

// --- options -------------------------------------------------------------------

pub fn defaults() -> ParseOptions {
    ParseOptions::default()
}

pub fn optional_syntax() -> ParseOptions {
    ParseOptions { optional_syntax: true, ..ParseOptions::default() }
}

/// Every limit, in the order `CelParseLimits` declares them.
pub fn limits(nodes: usize, depth: usize, list_elements: usize, map_entries: usize, call_arguments: usize) -> ParseOptions {
    ParseOptions {
        limits: CelParseLimits {
            max_nodes: nodes,
            max_depth: depth,
            max_list_elements: list_elements,
            max_map_entries: map_entries,
            max_call_arguments: call_arguments,
        },
        optional_syntax: false,
    }
}

// --- a source against its recorded answer ----------------------------------------

pub fn diagnostic(code: CelSyntaxCode, message: &str, start: u32, end: u32) -> CelSyntaxDiagnostic {
    CelSyntaxDiagnostic { code, message: message.to_string(), range: range(start, end) }
}

/// What the Node build answers for one source under one set of options.
pub struct NodeReading {
    pub source: &'static str,
    pub options: ParseOptions,
    pub root: Arc<CelNode>,
    pub diagnostic: Option<CelSyntaxDiagnostic>,
}

pub fn reading(
    source: &'static str,
    options: ParseOptions,
    root: Arc<CelNode>,
    diagnostic: Option<CelSyntaxDiagnostic>,
) -> NodeReading {
    NodeReading { source, options, root, diagnostic }
}

pub fn read(source: &str) -> ParseResult {
    parse_syntax(source, &ParseOptions::default())
}

/// The tree of a source that reads whole.
pub fn tree(source: &str) -> Arc<CelNode> {
    let parsed = read(source);
    assert_eq!(parsed.diagnostic, None, "{source}");
    parsed.root
}

/// Reads each source and holds the tree and the diagnostic to the recorded answer,
/// every field and every range.
pub fn assert_reads_as_node(readings: Vec<NodeReading>) {
    assert!(!readings.is_empty(), "the table holds no row");
    for expected in readings {
        let parsed = parse_syntax(expected.source, &expected.options);
        assert_eq!(&*parsed.source, expected.source);
        assert_eq!(parsed.diagnostic, expected.diagnostic, "the diagnostic of {:?}", expected.source);
        assert_eq!(parsed.root, expected.root, "the tree of {:?}", expected.source);
    }
}

// --- a source read as an expression ------------------------------------------------

pub fn expression_options(namespaces: &[&str], optional_syntax: bool) -> ParseExpressionOptions {
    ParseExpressionOptions {
        parse: ParseOptions { optional_syntax, ..ParseOptions::default() },
        namespaces: namespaces.iter().map(|name| name.to_string()).collect(),
    }
}

/// What the Node build's `parseExpression` answers for one source.
pub struct NodeExpression {
    pub source: &'static str,
    pub namespaces: &'static [&'static str],
    pub optional_syntax: bool,
    /// The set the expression records, in canonical order.
    pub recorded: &'static [&'static str],
    pub root: Arc<CelNode>,
    pub diagnostic: Option<CelSyntaxDiagnostic>,
}

pub fn resolved(
    source: &'static str,
    namespaces: &'static [&'static str],
    optional_syntax: bool,
    recorded: &'static [&'static str],
    root: Arc<CelNode>,
    diagnostic: Option<CelSyntaxDiagnostic>,
) -> NodeExpression {
    NodeExpression { source, namespaces, optional_syntax, recorded, root, diagnostic }
}

/// Reads each source as an expression and holds the recorded set, the tree and the
/// diagnostic to the recorded answer.
pub fn assert_resolves_as_node(rows: Vec<NodeExpression>) {
    assert!(!rows.is_empty(), "the table holds no row");
    for expected in rows {
        let options = expression_options(expected.namespaces, expected.optional_syntax);
        let expression = parse_expression(expected.source, &options).expect(expected.source);
        assert_eq!(&*expression.source, expected.source);
        assert_eq!(&*expression.namespaces, expected.recorded, "the set of {:?}", expected.source);
        assert_eq!(expression.diagnostic, expected.diagnostic, "the diagnostic of {:?}", expected.source);
        assert_eq!(expression.root, expected.root, "the tree of {:?}", expected.source);
    }
}

// --- a tree against what the writer answers for it ------------------------------------

/// Holds the writer to the recorded answer for each tree: its text, or the message of
/// its refusal.
pub fn assert_writes_as_node(rows: Vec<(Arc<CelNode>, Result<&str, &str>)>) {
    assert!(!rows.is_empty(), "the table holds no row");
    for (tree, expected) in rows {
        let written = serialize_tree(&tree);
        let answer = match &written {
            Ok(text) => Ok(text.as_str()),
            Err(refusal) => Err(refusal.message.as_str()),
        };
        assert_eq!(answer, expected, "{tree:?}");
    }
}

pub fn qualified(
    namespace: &str,
    name: &str,
    qualified_name: &str,
    arity: usize,
    call_range: (u32, u32),
    name_range: (u32, u32),
) -> QualifiedCall {
    QualifiedCall {
        namespace: namespace.to_string(),
        name: name.to_string(),
        qualified_name: qualified_name.to_string(),
        arity,
        range: range(call_range.0, call_range.1),
        name_range: range(name_range.0, name_range.1),
    }
}
