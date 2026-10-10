//! The canonical CEL syntax tree — `syntax-tree.ts`.
//!
//! Every node carries `range`, the half-open `[start, end)` span of UTF-16 code units
//! it covers in the source it was read from. A tree built by hand carries ranges too.
//!
//! A tree is immutable and shared: a child is an `Arc`, so a subtree can be held by a
//! second tree without a copy. `Clone` is shallow.
//!
//! Nothing here recurses with a tree's depth. Walking, the hole test, `PartialEq`,
//! `Debug` and `Drop` each run on a heap work list, because a chain of a hundred
//! thousand operators is an ordinary tree and a hand-built one has no bound at all.
//! The hand-written `Drop` is why a field cannot be moved out of an owned `CelNode`:
//! match by reference, or clone the `Arc`.
//!
//! `PartialEq` is identity of the tree as data — every field, ranges and `quoted`
//! included, a double compared as the value domain compares one. Whether two trees are
//! the same expression is `trees_equal`.
//!
//! `QualifiedCall` is the one node the parser never produces.
//!
//! Declared here and not in the Node file:
//! - `CelNode::range` — Node reads the `range` field every member of its union shares.
//! - `TreeWalk` — the iterator `walk_tree` answers, which Node writes as a generator.
//! - `as_str` on the two operator types, which Node holds as the strings themselves.

use std::fmt;
use std::sync::Arc;

pub use telorun_cel_value::SourceRange;

/// A literal's decoded value. `1` and `1u` are different expressions, so the type is
/// part of it.
#[derive(Clone, Debug)]
pub enum CelLiteral {
    Int(i64),
    Uint(u64),
    Double(f64),
    String(String),
    Bytes(Vec<u8>),
    Bool(bool),
    Null,
}

impl PartialEq for CelLiteral {
    /// A double is itself and nothing else: NaN is NaN, a negative zero is not a zero.
    fn eq(&self, other: &Self) -> bool {
        use CelLiteral::*;
        match (self, other) {
            (Int(a), Int(b)) => a == b,
            (Uint(a), Uint(b)) => a == b,
            (Double(a), Double(b)) => (a.is_nan() && b.is_nan()) || a.to_bits() == b.to_bits(),
            (String(a), String(b)) => a == b,
            (Bytes(a), Bytes(b)) => a == b,
            (Bool(a), Bool(b)) => a == b,
            (Null, Null) => true,
            _ => false,
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum CelUnaryOperator {
    Not,
    Negate,
}

impl CelUnaryOperator {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Not => "!",
            Self::Negate => "-",
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum CelBinaryOperator {
    Or,
    And,
    Equal,
    NotEqual,
    Less,
    LessEqual,
    Greater,
    GreaterEqual,
    In,
    Add,
    Subtract,
    Multiply,
    Divide,
    Modulo,
}

impl CelBinaryOperator {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Or => "||",
            Self::And => "&&",
            Self::Equal => "==",
            Self::NotEqual => "!=",
            Self::Less => "<",
            Self::LessEqual => "<=",
            Self::Greater => ">",
            Self::GreaterEqual => ">=",
            Self::In => "in",
            Self::Add => "+",
            Self::Subtract => "-",
            Self::Multiply => "*",
            Self::Divide => "/",
            Self::Modulo => "%",
        }
    }
}

#[derive(Clone)]
pub struct CelLiteralNode {
    pub literal: CelLiteral,
    pub range: SourceRange,
}

#[derive(Clone)]
pub struct CelIdentNode {
    pub name: String,
    /// `.y` — the name is resolved against the environment's own declarations, never
    /// against a name something inside the expression bound.
    pub absolute: bool,
    pub range: SourceRange,
}

/// One element of a list literal. `optional` marks `[?x]`.
#[derive(Clone)]
pub struct CelListElement {
    pub value: Arc<CelNode>,
    pub optional: bool,
}

#[derive(Clone)]
pub struct CelListNode {
    pub elements: Vec<CelListElement>,
    pub range: SourceRange,
}

/// One entry of a map literal. `optional` marks `{?k: v}`.
#[derive(Clone)]
pub struct CelMapEntry {
    pub key: Arc<CelNode>,
    pub value: Arc<CelNode>,
    pub optional: bool,
}

#[derive(Clone)]
pub struct CelMapNode {
    pub entries: Vec<CelMapEntry>,
    pub range: SourceRange,
}

/// `operand.field`, `operand.?field` when `optional`, `` operand.`field` `` when `quoted`.
#[derive(Clone)]
pub struct CelSelectNode {
    pub operand: Arc<CelNode>,
    /// The member's name, decoded: the text between the backticks for a quoted one.
    pub field: String,
    pub field_range: SourceRange,
    pub optional: bool,
    /// Written between backticks. It changes nothing about what is read.
    pub quoted: bool,
    pub range: SourceRange,
}

/// `operand[index]`, and `operand[?index]` when `optional`.
#[derive(Clone)]
pub struct CelIndexNode {
    pub operand: Arc<CelNode>,
    pub index: Arc<CelNode>,
    pub optional: bool,
    pub range: SourceRange,
}

/// `name(args)`.
#[derive(Clone)]
pub struct CelCallNode {
    pub name: String,
    pub name_range: SourceRange,
    pub args: Vec<Arc<CelNode>>,
    pub range: SourceRange,
}

/// `receiver.name(args)`, including every macro call — nothing expands one.
#[derive(Clone)]
pub struct CelReceiverCallNode {
    pub receiver: Arc<CelNode>,
    pub name: String,
    pub name_range: SourceRange,
    pub args: Vec<Arc<CelNode>>,
    pub range: SourceRange,
}

/// `namespace.name(args)`, where `namespace` names a module rather than a value.
#[derive(Clone)]
pub struct CelQualifiedCallNode {
    pub namespace: String,
    pub namespace_range: SourceRange,
    pub name: String,
    pub name_range: SourceRange,
    pub args: Vec<Arc<CelNode>>,
    pub range: SourceRange,
}

#[derive(Clone)]
pub struct CelUnaryNode {
    pub operator: CelUnaryOperator,
    pub operand: Arc<CelNode>,
    pub range: SourceRange,
}

#[derive(Clone)]
pub struct CelBinaryNode {
    pub operator: CelBinaryOperator,
    pub left: Arc<CelNode>,
    pub right: Arc<CelNode>,
    pub range: SourceRange,
}

#[derive(Clone)]
pub struct CelConditionalNode {
    pub condition: Arc<CelNode>,
    pub when_true: Arc<CelNode>,
    pub when_false: Arc<CelNode>,
    pub range: SourceRange,
}

/// The hole error recovery leaves where an expression was expected and none could be
/// read. Never serializable and never evaluable.
#[derive(Clone)]
pub struct CelUnparsedNode {
    pub range: SourceRange,
}

#[derive(Clone)]
pub enum CelNode {
    Literal(CelLiteralNode),
    Ident(CelIdentNode),
    List(CelListNode),
    Map(CelMapNode),
    Select(CelSelectNode),
    Index(CelIndexNode),
    Call(CelCallNode),
    ReceiverCall(CelReceiverCallNode),
    QualifiedCall(CelQualifiedCallNode),
    Unary(CelUnaryNode),
    Binary(CelBinaryNode),
    Conditional(CelConditionalNode),
    Unparsed(CelUnparsedNode),
}

const _: () = {
    const fn shared_across_threads<T: Send + Sync>() {}
    shared_across_threads::<CelNode>();
};

impl CelNode {
    pub fn range(&self) -> SourceRange {
        match self {
            Self::Literal(node) => node.range,
            Self::Ident(node) => node.range,
            Self::List(node) => node.range,
            Self::Map(node) => node.range,
            Self::Select(node) => node.range,
            Self::Index(node) => node.range,
            Self::Call(node) => node.range,
            Self::ReceiverCall(node) => node.range,
            Self::QualifiedCall(node) => node.range,
            Self::Unary(node) => node.range,
            Self::Binary(node) => node.range,
            Self::Conditional(node) => node.range,
            Self::Unparsed(node) => node.range,
        }
    }
}

/// One node of any kind, by reference: what lets a kind's own struct and the union
/// share one reader.
#[derive(Clone, Copy)]
enum NodeRef<'a> {
    Literal(&'a CelLiteralNode),
    Ident(&'a CelIdentNode),
    List(&'a CelListNode),
    Map(&'a CelMapNode),
    Select(&'a CelSelectNode),
    Index(&'a CelIndexNode),
    Call(&'a CelCallNode),
    ReceiverCall(&'a CelReceiverCallNode),
    QualifiedCall(&'a CelQualifiedCallNode),
    Unary(&'a CelUnaryNode),
    Binary(&'a CelBinaryNode),
    Conditional(&'a CelConditionalNode),
    Unparsed(&'a CelUnparsedNode),
}

impl<'a> From<&'a CelNode> for NodeRef<'a> {
    fn from(node: &'a CelNode) -> Self {
        match node {
            CelNode::Literal(node) => Self::Literal(node),
            CelNode::Ident(node) => Self::Ident(node),
            CelNode::List(node) => Self::List(node),
            CelNode::Map(node) => Self::Map(node),
            CelNode::Select(node) => Self::Select(node),
            CelNode::Index(node) => Self::Index(node),
            CelNode::Call(node) => Self::Call(node),
            CelNode::ReceiverCall(node) => Self::ReceiverCall(node),
            CelNode::QualifiedCall(node) => Self::QualifiedCall(node),
            CelNode::Unary(node) => Self::Unary(node),
            CelNode::Binary(node) => Self::Binary(node),
            CelNode::Conditional(node) => Self::Conditional(node),
            CelNode::Unparsed(node) => Self::Unparsed(node),
        }
    }
}

// --- traversal ---------------------------------------------------------------

/// The single reader of a node's shape for traversal: every child, in source order,
/// as the tree holds it.
pub(crate) fn each_shared_child<'a>(node: &'a CelNode, mut visit: impl FnMut(&'a Arc<CelNode>)) {
    match node {
        CelNode::Literal(_) | CelNode::Ident(_) | CelNode::Unparsed(_) => {}
        CelNode::List(node) => node.elements.iter().for_each(|element| visit(&element.value)),
        CelNode::Map(node) => node.entries.iter().for_each(|entry| {
            visit(&entry.key);
            visit(&entry.value);
        }),
        CelNode::Select(node) => visit(&node.operand),
        CelNode::Index(node) => {
            visit(&node.operand);
            visit(&node.index);
        }
        CelNode::Call(node) => node.args.iter().for_each(visit),
        CelNode::ReceiverCall(node) => {
            visit(&node.receiver);
            node.args.iter().for_each(visit);
        }
        CelNode::QualifiedCall(node) => node.args.iter().for_each(visit),
        CelNode::Unary(node) => visit(&node.operand),
        CelNode::Binary(node) => {
            visit(&node.left);
            visit(&node.right);
        }
        CelNode::Conditional(node) => {
            visit(&node.condition);
            visit(&node.when_true);
            visit(&node.when_false);
        }
    }
}

fn each_child<'a>(node: &'a CelNode, mut visit: impl FnMut(&'a CelNode)) {
    each_shared_child(node, |child| visit(child));
}

/// Every child node, in source order.
pub fn child_nodes(node: &CelNode) -> Vec<&CelNode> {
    let mut children = Vec::new();
    each_child(node, |child| children.push(child));
    children
}

/// A depth-first pre-order walk over a whole tree.
pub struct TreeWalk<'a> {
    pending: Vec<&'a CelNode>,
}

impl<'a> Iterator for TreeWalk<'a> {
    type Item = &'a CelNode;

    fn next(&mut self) -> Option<&'a CelNode> {
        let node = self.pending.pop()?;
        let from = self.pending.len();
        each_child(node, |child| self.pending.push(child));
        self.pending[from..].reverse();
        Some(node)
    }
}

/// Depth-first pre-order walk over the whole tree.
pub fn walk_tree(root: &CelNode) -> TreeWalk<'_> {
    TreeWalk { pending: vec![root] }
}

/// Whether any node of the tree is an unparsed hole.
pub fn has_unparsed(root: &CelNode) -> bool {
    walk_tree(root).any(|node| matches!(node, CelNode::Unparsed(_)))
}

// --- identity ----------------------------------------------------------------

type NodePairs<'a> = Vec<(&'a CelNode, &'a CelNode)>;

fn pair_lists<'a>(left: &'a [Arc<CelNode>], right: &'a [Arc<CelNode>], pending: &mut NodePairs<'a>) -> bool {
    left.len() == right.len() && {
        pending.extend(left.iter().zip(right).map(|(left, right)| (&**left, &**right)));
        true
    }
}

/// Whether two nodes hold the same data of their own, their children left on `pending`.
fn same_node<'a>(left: NodeRef<'a>, right: NodeRef<'a>, pending: &mut NodePairs<'a>) -> bool {
    use NodeRef::*;
    match (left, right) {
        (Literal(a), Literal(b)) => a.literal == b.literal && a.range == b.range,
        (Ident(a), Ident(b)) => a.name == b.name && a.absolute == b.absolute && a.range == b.range,
        (Unparsed(a), Unparsed(b)) => a.range == b.range,
        (List(a), List(b)) => {
            a.range == b.range
                && a.elements.len() == b.elements.len()
                && a.elements.iter().zip(&b.elements).all(|(a, b)| {
                    pending.push((&a.value, &b.value));
                    a.optional == b.optional
                })
        }
        (Map(a), Map(b)) => {
            a.range == b.range
                && a.entries.len() == b.entries.len()
                && a.entries.iter().zip(&b.entries).all(|(a, b)| {
                    pending.push((&a.key, &b.key));
                    pending.push((&a.value, &b.value));
                    a.optional == b.optional
                })
        }
        (Select(a), Select(b)) => {
            pending.push((&a.operand, &b.operand));
            a.field == b.field
                && a.field_range == b.field_range
                && a.optional == b.optional
                && a.quoted == b.quoted
                && a.range == b.range
        }
        (Index(a), Index(b)) => {
            pending.push((&a.operand, &b.operand));
            pending.push((&a.index, &b.index));
            a.optional == b.optional && a.range == b.range
        }
        (Call(a), Call(b)) => {
            a.name == b.name && a.name_range == b.name_range && a.range == b.range && pair_lists(&a.args, &b.args, pending)
        }
        (ReceiverCall(a), ReceiverCall(b)) => {
            pending.push((&a.receiver, &b.receiver));
            a.name == b.name && a.name_range == b.name_range && a.range == b.range && pair_lists(&a.args, &b.args, pending)
        }
        (QualifiedCall(a), QualifiedCall(b)) => {
            a.namespace == b.namespace
                && a.namespace_range == b.namespace_range
                && a.name == b.name
                && a.name_range == b.name_range
                && a.range == b.range
                && pair_lists(&a.args, &b.args, pending)
        }
        (Unary(a), Unary(b)) => {
            pending.push((&a.operand, &b.operand));
            a.operator == b.operator && a.range == b.range
        }
        (Binary(a), Binary(b)) => {
            pending.push((&a.left, &b.left));
            pending.push((&a.right, &b.right));
            a.operator == b.operator && a.range == b.range
        }
        (Conditional(a), Conditional(b)) => {
            pending.push((&a.condition, &b.condition));
            pending.push((&a.when_true, &b.when_true));
            pending.push((&a.when_false, &b.when_false));
            a.range == b.range
        }
        _ => false,
    }
}

fn same_pairs(mut pending: NodePairs<'_>) -> bool {
    while let Some((left, right)) = pending.pop() {
        if !std::ptr::eq(left, right) && !same_node(left.into(), right.into(), &mut pending) {
            return false;
        }
    }
    true
}

fn same_tree<'a>(left: NodeRef<'a>, right: NodeRef<'a>) -> bool {
    let mut pending = Vec::new();
    same_node(left, right, &mut pending) && same_pairs(pending)
}

impl PartialEq for CelNode {
    fn eq(&self, other: &Self) -> bool {
        same_pairs(vec![(self, other)])
    }
}

impl PartialEq for CelListElement {
    fn eq(&self, other: &Self) -> bool {
        self.optional == other.optional && same_pairs(vec![(&self.value, &other.value)])
    }
}

impl PartialEq for CelMapEntry {
    fn eq(&self, other: &Self) -> bool {
        self.optional == other.optional && same_pairs(vec![(&self.key, &other.key), (&self.value, &other.value)])
    }
}

// --- written for a reader ------------------------------------------------------

enum Piece<'a> {
    Text(&'static str),
    Quoted(&'a str),
    Flag(bool),
    Range(SourceRange),
    Literal(&'a CelLiteral),
    Node(NodeRef<'a>),
    Element(&'a CelListElement),
    Entry(&'a CelMapEntry),
}

fn push_pieces<'a, const N: usize>(pending: &mut Vec<Piece<'a>>, pieces: [Piece<'a>; N]) {
    pending.extend(pieces.into_iter().rev());
}

/// `[a, b]`, each item written by `piece`.
fn push_sequence<'a, T>(pending: &mut Vec<Piece<'a>>, items: &'a [T], piece: impl Fn(&'a T) -> Piece<'a>) {
    pending.push(Piece::Text("]"));
    for (at, item) in items.iter().enumerate().rev() {
        pending.push(piece(item));
        if at > 0 {
            pending.push(Piece::Text(", "));
        }
    }
    pending.push(Piece::Text("["));
}

fn node_piece(node: &Arc<CelNode>) -> Piece<'_> {
    Piece::Node(NodeRef::from(&**node))
}

fn push_node<'a>(pending: &mut Vec<Piece<'a>>, node: NodeRef<'a>) {
    use Piece::{Flag, Quoted, Range, Text};
    let range_label = || Text(", range: ");
    let close = || Text(" }");
    match node {
        NodeRef::Literal(node) => push_pieces(
            pending,
            [Text("CelLiteralNode { literal: "), Piece::Literal(&node.literal), range_label(), Range(node.range), close()],
        ),
        NodeRef::Ident(node) => push_pieces(
            pending,
            [
                Text("CelIdentNode { name: "),
                Quoted(&node.name),
                Text(", absolute: "),
                Flag(node.absolute),
                range_label(),
                Range(node.range),
                close(),
            ],
        ),
        NodeRef::List(node) => {
            push_pieces(pending, [range_label(), Range(node.range), close()]);
            push_sequence(pending, &node.elements, Piece::Element);
            pending.push(Text("CelListNode { elements: "));
        }
        NodeRef::Map(node) => {
            push_pieces(pending, [range_label(), Range(node.range), close()]);
            push_sequence(pending, &node.entries, Piece::Entry);
            pending.push(Text("CelMapNode { entries: "));
        }
        NodeRef::Select(node) => push_pieces(
            pending,
            [
                Text("CelSelectNode { operand: "),
                node_piece(&node.operand),
                Text(", field: "),
                Quoted(&node.field),
                Text(", field_range: "),
                Range(node.field_range),
                Text(", optional: "),
                Flag(node.optional),
                Text(", quoted: "),
                Flag(node.quoted),
                range_label(),
                Range(node.range),
                close(),
            ],
        ),
        NodeRef::Index(node) => push_pieces(
            pending,
            [
                Text("CelIndexNode { operand: "),
                node_piece(&node.operand),
                Text(", index: "),
                node_piece(&node.index),
                Text(", optional: "),
                Flag(node.optional),
                range_label(),
                Range(node.range),
                close(),
            ],
        ),
        NodeRef::Call(node) => {
            push_pieces(pending, [range_label(), Range(node.range), close()]);
            push_sequence(pending, &node.args, node_piece);
            push_pieces(
                pending,
                [
                    Text("CelCallNode { name: "),
                    Quoted(&node.name),
                    Text(", name_range: "),
                    Range(node.name_range),
                    Text(", args: "),
                ],
            );
        }
        NodeRef::ReceiverCall(node) => {
            push_pieces(pending, [range_label(), Range(node.range), close()]);
            push_sequence(pending, &node.args, node_piece);
            push_pieces(
                pending,
                [
                    Text("CelReceiverCallNode { receiver: "),
                    node_piece(&node.receiver),
                    Text(", name: "),
                    Quoted(&node.name),
                    Text(", name_range: "),
                    Range(node.name_range),
                    Text(", args: "),
                ],
            );
        }
        NodeRef::QualifiedCall(node) => {
            push_pieces(pending, [range_label(), Range(node.range), close()]);
            push_sequence(pending, &node.args, node_piece);
            push_pieces(
                pending,
                [
                    Text("CelQualifiedCallNode { namespace: "),
                    Quoted(&node.namespace),
                    Text(", namespace_range: "),
                    Range(node.namespace_range),
                    Text(", name: "),
                    Quoted(&node.name),
                    Text(", name_range: "),
                    Range(node.name_range),
                    Text(", args: "),
                ],
            );
        }
        NodeRef::Unary(node) => push_pieces(
            pending,
            [
                Text("CelUnaryNode { operator: "),
                Quoted(node.operator.as_str()),
                Text(", operand: "),
                node_piece(&node.operand),
                range_label(),
                Range(node.range),
                close(),
            ],
        ),
        NodeRef::Binary(node) => push_pieces(
            pending,
            [
                Text("CelBinaryNode { operator: "),
                Quoted(node.operator.as_str()),
                Text(", left: "),
                node_piece(&node.left),
                Text(", right: "),
                node_piece(&node.right),
                range_label(),
                Range(node.range),
                close(),
            ],
        ),
        NodeRef::Conditional(node) => push_pieces(
            pending,
            [
                Text("CelConditionalNode { condition: "),
                node_piece(&node.condition),
                Text(", when_true: "),
                node_piece(&node.when_true),
                Text(", when_false: "),
                node_piece(&node.when_false),
                range_label(),
                Range(node.range),
                close(),
            ],
        ),
        NodeRef::Unparsed(node) => push_pieces(pending, [Text("CelUnparsedNode { range: "), Range(node.range), close()]),
    }
}

fn write_pieces(f: &mut fmt::Formatter<'_>, mut pending: Vec<Piece<'_>>) -> fmt::Result {
    while let Some(piece) = pending.pop() {
        match piece {
            Piece::Text(text) => f.write_str(text)?,
            Piece::Quoted(text) => write!(f, "{text:?}")?,
            Piece::Flag(flag) => write!(f, "{flag}")?,
            Piece::Range(range) => write!(f, "{}..{}", range.start, range.end)?,
            Piece::Literal(literal) => write!(f, "{literal:?}")?,
            Piece::Node(node) => push_node(&mut pending, node),
            Piece::Element(element) => push_pieces(
                &mut pending,
                [
                    Piece::Text("CelListElement { value: "),
                    node_piece(&element.value),
                    Piece::Text(", optional: "),
                    Piece::Flag(element.optional),
                    Piece::Text(" }"),
                ],
            ),
            Piece::Entry(entry) => push_pieces(
                &mut pending,
                [
                    Piece::Text("CelMapEntry { key: "),
                    node_piece(&entry.key),
                    Piece::Text(", value: "),
                    node_piece(&entry.value),
                    Piece::Text(", optional: "),
                    Piece::Flag(entry.optional),
                    Piece::Text(" }"),
                ],
            ),
        }
    }
    Ok(())
}

impl fmt::Debug for CelNode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write_pieces(f, vec![Piece::Node(self.into())])
    }
}

impl fmt::Debug for CelListElement {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write_pieces(f, vec![Piece::Element(self)])
    }
}

impl fmt::Debug for CelMapEntry {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write_pieces(f, vec![Piece::Entry(self)])
    }
}

macro_rules! kind_struct {
    ($($kind:ident => $variant:ident),* $(,)?) => {$(
        impl PartialEq for $kind {
            fn eq(&self, other: &Self) -> bool {
                same_tree(NodeRef::$variant(self), NodeRef::$variant(other))
            }
        }

        impl fmt::Debug for $kind {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                write_pieces(f, vec![Piece::Node(NodeRef::$variant(self))])
            }
        }
    )*};
}

kind_struct! {
    CelLiteralNode => Literal,
    CelIdentNode => Ident,
    CelListNode => List,
    CelMapNode => Map,
    CelSelectNode => Select,
    CelIndexNode => Index,
    CelCallNode => Call,
    CelReceiverCallNode => ReceiverCall,
    CelQualifiedCallNode => QualifiedCall,
    CelUnaryNode => Unary,
    CelBinaryNode => Binary,
    CelConditionalNode => Conditional,
    CelUnparsedNode => Unparsed,
}

// --- release -----------------------------------------------------------------

/// The leaf a release puts where it took a child out: made the first time one release
/// needs it, cloned for every further swap of that release, and gone with it.
type Placeholder = Option<Arc<CelNode>>;

fn is_leaf(node: &CelNode) -> bool {
    matches!(node, CelNode::Literal(_) | CelNode::Ident(_) | CelNode::Unparsed(_))
}

/// Takes a child out of its field onto the list. A leaf stays where it is: releasing
/// one costs no depth.
fn unlink(child: &mut Arc<CelNode>, pending: &mut Vec<Arc<CelNode>>, placeholder: &mut Placeholder) {
    if is_leaf(child) {
        return;
    }
    let leaf = placeholder.get_or_insert_with(|| {
        Arc::new(CelNode::Unparsed(CelUnparsedNode { range: SourceRange { start: 0, end: 0 } }))
    });
    pending.push(std::mem::replace(child, Arc::clone(leaf)));
}

fn unlink_children(node: &mut CelNode, pending: &mut Vec<Arc<CelNode>>, placeholder: &mut Placeholder) {
    match node {
        CelNode::Literal(_) | CelNode::Ident(_) | CelNode::Unparsed(_) => {}
        CelNode::List(node) => pending.extend(std::mem::take(&mut node.elements).into_iter().map(|element| element.value)),
        CelNode::Map(node) => {
            for entry in std::mem::take(&mut node.entries) {
                pending.push(entry.key);
                pending.push(entry.value);
            }
        }
        CelNode::Select(node) => unlink(&mut node.operand, pending, placeholder),
        CelNode::Index(node) => {
            unlink(&mut node.operand, pending, placeholder);
            unlink(&mut node.index, pending, placeholder);
        }
        CelNode::Call(node) => pending.append(&mut node.args),
        CelNode::ReceiverCall(node) => {
            unlink(&mut node.receiver, pending, placeholder);
            pending.append(&mut node.args);
        }
        CelNode::QualifiedCall(node) => pending.append(&mut node.args),
        CelNode::Unary(node) => unlink(&mut node.operand, pending, placeholder),
        CelNode::Binary(node) => {
            unlink(&mut node.left, pending, placeholder);
            unlink(&mut node.right, pending, placeholder);
        }
        CelNode::Conditional(node) => {
            unlink(&mut node.condition, pending, placeholder);
            unlink(&mut node.when_true, pending, placeholder);
            unlink(&mut node.when_false, pending, placeholder);
        }
    }
}

impl Drop for CelNode {
    /// Unlinks every descendant this node alone owns onto a list, so releasing a deep
    /// tree costs no stack. A node taken off the list holds only leaves and empty
    /// lists by the time it is released itself, so its own release does nothing more.
    /// The release shares nothing with any other: at most one allocation, its own.
    fn drop(&mut self) {
        let mut pending = Vec::new();
        let mut placeholder = None;
        unlink_children(self, &mut pending, &mut placeholder);
        while let Some(child) = pending.pop() {
            if let Some(mut node) = Arc::into_inner(child) {
                unlink_children(&mut node, &mut pending, &mut placeholder);
            }
        }
    }
}
