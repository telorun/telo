//! CEL's grammar, read into the canonical tree — `parser.ts`.
//!
//! **Error recovery is the point.** Reading never fails and never discards what it
//! read: the first thing it cannot read becomes one ranged diagnostic, the reader stops
//! there, and the tree holds what it understood with an `Unparsed` node where the rest
//! would have been. A member left unnamed (`request.`) is a select with an empty field
//! name; an aggregate or a call left open keeps the elements it read.
//!
//! **Nothing is expanded.** A macro call is an ordinary call node, and a qualified call
//! is not produced here.
//!
//! **A unary minus directly on a numeric literal folds into the literal.** That is how
//! the int64 minimum is written, and it keeps `-0.0` a value rather than a negation.
//!
//! **Why this file is not shaped like `parser.ts`.** Node reads by recursive descent,
//! one function per grammar position, and its call stack is what remembers where it
//! was. A stack overflow aborts a Rust process, so here the same grammar positions are
//! held as data: each place Node's reader waits for a sub-expression is a `Frame` on a
//! heap stack, entering a rule pushes one, and a finished sub-expression resumes the
//! frame on top. Stack use is constant whatever the nesting, and `max_depth` bounds
//! heap. The answers are identical — the same tree, the same diagnostic, the same
//! node and depth counts in the same order — because every frame resumes exactly
//! where the Node function continues after its call.
//!
//! Declared differently from the Node file:
//! - `ParseResult::diagnostic` — Node's `diagnostics` is a list of at most one entry;
//!   here it is an `Option`.
//! - `ParseResult::source` — the text is copied once, when it is read, into an
//!   `Arc<str>` that every later holder shares.

use std::sync::Arc;

use telorun_cel_value::json_quote;

use crate::lexer::{tokenize, Decoded, Token, TokenKind};
use crate::parse_limits::CelParseLimits;
use crate::syntax_diagnostic::{CelSyntaxCode, CelSyntaxDiagnostic, FirstSyntaxDiagnostic};
use crate::syntax_tree::{
    CelBinaryNode, CelBinaryOperator, CelCallNode, CelConditionalNode, CelIdentNode, CelIndexNode, CelListElement,
    CelListNode, CelLiteral, CelLiteralNode, CelMapEntry, CelMapNode, CelNode, CelReceiverCallNode, CelSelectNode,
    CelUnaryNode, CelUnaryOperator, CelUnparsedNode, SourceRange,
};

#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub struct ParseOptions {
    pub limits: CelParseLimits,
    /// Whether the optional library's own syntax is read: `[?x]` and `{?k: v}`. It
    /// follows the environment's optional types, because a syntax for a type that does
    /// not exist would read to a tree nothing can check.
    pub optional_syntax: bool,
}

#[derive(Clone, PartialEq, Debug)]
pub struct ParseResult {
    pub source: Arc<str>,
    pub root: Arc<CelNode>,
    /// The first thing that could not be read, held exactly when the whole source
    /// could not be.
    pub diagnostic: Option<CelSyntaxDiagnostic>,
}

const _: () = {
    const fn shared_across_threads<T: Send + Sync>() {}
    shared_across_threads::<ParseResult>();
};

/// The binary levels, lowest first: `||`, `&&`, the relations, `+ -`, `* / %`.
const HIGHEST_BINARY_LEVEL: u8 = 4;

fn range(start: u32, end: u32) -> SourceRange {
    SourceRange { start, end }
}

/// A rule to begin reading.
enum Rule {
    Conditional,
    Unary,
}

/// What the reader does next: begin a rule, or hand a finished node to the frame
/// waiting for it.
enum Step {
    Enter(Rule),
    Return(Arc<CelNode>),
}

/// The call whose arguments are being read. `name` is its name's token.
enum Callee {
    Global { name: usize },
    Receiver { receiver: Arc<CelNode>, name: usize },
}

/// A call after its opening paren: finished, or waiting on a frame for an argument.
enum Arguments {
    Closed(Arc<CelNode>),
    Waiting,
}

/// One place the grammar waits for a sub-expression, with what it has read so far.
enum Frame {
    /// A conditional waits for its condition.
    Condition,
    WhenTrue { condition: Arc<CelNode> },
    WhenFalse { condition: Arc<CelNode>, when_true: Arc<CelNode> },
    /// Every binary level from `lowest` up waits for its left operand.
    BinaryLeft { lowest: u8 },
    /// `level` waits for its right operand; the levels from `lowest` up to it wait for
    /// what it answers.
    BinaryRight { lowest: u8, level: u8, operator: CelBinaryOperator, left: Arc<CelNode> },
    UnaryOperand { operator: CelUnaryOperator, start: u32 },
    Parenthesized,
    /// `open` is the opening bracket's token, here and below.
    ListElement { open: usize, elements: Vec<CelListElement>, optional: bool },
    MapKey { open: usize, entries: Vec<CelMapEntry>, optional: bool },
    MapValue { open: usize, entries: Vec<CelMapEntry>, optional: bool, key: Arc<CelNode> },
    CallArgument { open: usize, arguments: Vec<Arc<CelNode>>, callee: Callee },
    Index { operand: Arc<CelNode>, optional: bool },
}

struct Parser<'s> {
    source: &'s str,
    tokens: Vec<Token>,
    diagnostics: FirstSyntaxDiagnostic,
    limits: CelParseLimits,
    optional_syntax: bool,
    at: usize,
    nodes: usize,
    depth: usize,
    stopped: bool,
    frames: Vec<Frame>,
}

impl<'s> Parser<'s> {
    fn parse(mut self) -> (Arc<CelNode>, FirstSyntaxDiagnostic) {
        let mut step = Step::Enter(Rule::Conditional);
        let root = loop {
            step = match step {
                Step::Enter(Rule::Conditional) => self.conditional(),
                Step::Enter(Rule::Unary) => self.unary(),
                Step::Return(node) => match self.frames.pop() {
                    Some(frame) => self.resume(frame, node),
                    None => break node,
                },
            };
        };
        if !self.stopped && self.kind(self.at) != TokenKind::Eof {
            self.unexpected(self.at, None);
        }
        (root, self.diagnostics)
    }

    // --- token access ---------------------------------------------------------

    fn peek(&self, ahead: usize) -> usize {
        (self.at + ahead).min(self.tokens.len() - 1)
    }

    fn kind(&self, token: usize) -> TokenKind {
        self.tokens[token].kind
    }

    fn span(&self, token: usize) -> (u32, u32) {
        (self.tokens[token].start, self.tokens[token].end)
    }

    /// The lexeme of a token; for a quoted name, the text between its backticks.
    fn text(&self, token: usize) -> &'s str {
        let token = &self.tokens[token];
        match token.kind {
            TokenKind::QuotedIdent => &self.source[token.byte_start + 1..token.byte_end - 1],
            _ => &self.source[token.byte_start..token.byte_end],
        }
    }

    fn advance(&mut self) -> usize {
        let token = self.at;
        if self.at < self.tokens.len() - 1 {
            self.at += 1;
        }
        token
    }

    fn is_punct(&self, text: &str) -> bool {
        matches!(self.kind(self.at), TokenKind::Punct(punct) if punct == text)
    }

    fn take_punct(&mut self, text: &str) -> bool {
        if !self.is_punct(text) {
            return false;
        }
        self.advance();
        true
    }

    fn expect_punct(&mut self, text: &str) -> bool {
        if self.take_punct(text) {
            return true;
        }
        self.unexpected(self.at, Some(text));
        false
    }

    // --- diagnostics and budgets -----------------------------------------------

    fn unexpected(&mut self, token: usize, expected: Option<&str>) {
        let wanted = expected.map(|expected| format!(", expected {}", json_quote(expected))).unwrap_or_default();
        let (start, end) = self.span(token);
        if self.kind(token) == TokenKind::Eof {
            self.diagnostics.report(
                CelSyntaxCode::UnexpectedEnd,
                format!("the expression ends before it is complete{wanted}"),
                start,
                end,
            );
        } else {
            let token = &self.tokens[token];
            let written = json_quote(&self.source[token.byte_start..token.byte_end]);
            self.diagnostics.report(
                CelSyntaxCode::UnexpectedToken,
                format!("{written} cannot stand here{wanted}"),
                start,
                end,
            );
        }
        self.stopped = true;
    }

    fn limit(&mut self, what: &str, max: usize, start: u32, end: u32) {
        self.diagnostics.report(
            CelSyntaxCode::LimitExceeded,
            format!("the expression has more {what} than the limit of {max}"),
            start,
            end,
        );
        self.stopped = true;
    }

    /// Counts a node against the node budget.
    fn keep(&mut self, node: CelNode) -> Arc<CelNode> {
        self.nodes += 1;
        if self.nodes > self.limits.max_nodes && !self.stopped {
            let range = node.range();
            self.limit("nodes", self.limits.max_nodes, range.start, range.end);
        }
        Arc::new(node)
    }

    fn enter(&mut self, start: u32) -> bool {
        self.depth += 1;
        if self.depth <= self.limits.max_depth {
            return true;
        }
        if !self.stopped {
            self.limit("nesting", self.limits.max_depth, start, start);
        }
        false
    }

    fn leave(&mut self) {
        self.depth -= 1;
    }

    fn unparsed(&mut self, start: u32, end: u32) -> Arc<CelNode> {
        self.keep(CelNode::Unparsed(CelUnparsedNode { range: range(start, end) }))
    }

    // --- the grammar ------------------------------------------------------------

    fn conditional(&mut self) -> Step {
        let start = self.span(self.at).0;
        if !self.enter(start) {
            return Step::Return(self.unparsed(start, start));
        }
        self.frames.push(Frame::Condition);
        self.binary(0)
    }

    /// Begins the binary levels from `lowest` up, each of which reads its left operand
    /// from the level above it.
    fn binary(&mut self, lowest: u8) -> Step {
        if lowest <= HIGHEST_BINARY_LEVEL {
            self.frames.push(Frame::BinaryLeft { lowest });
        }
        Step::Enter(Rule::Unary)
    }

    /// Continues the loop of `level` with `left` in hand, then hands what it answers to
    /// each level beneath, down to `lowest`. One loop per level, each left-associative,
    /// so a long chain costs no depth.
    fn binary_chain(&mut self, lowest: u8, mut level: u8, left: Arc<CelNode>) -> Step {
        loop {
            if !self.stopped {
                if let Some(operator) = self.binary_operator_at(level) {
                    self.advance();
                    self.frames.push(Frame::BinaryRight { lowest, level, operator, left });
                    return self.binary(level + 1);
                }
            }
            if level == lowest {
                return Step::Return(left);
            }
            level -= 1;
        }
    }

    fn binary_operator_at(&self, level: u8) -> Option<CelBinaryOperator> {
        use CelBinaryOperator::*;
        let operator = match self.kind(self.at) {
            TokenKind::Keyword if self.text(self.at) == "in" => In,
            TokenKind::Punct(text) => match text {
                "||" => Or,
                "&&" => And,
                "==" => Equal,
                "!=" => NotEqual,
                "<" => Less,
                "<=" => LessEqual,
                ">" => Greater,
                ">=" => GreaterEqual,
                "+" => Add,
                "-" => Subtract,
                "*" => Multiply,
                "/" => Divide,
                "%" => Modulo,
                _ => return None,
            },
            _ => return None,
        };
        let at = match operator {
            Or => 0,
            And => 1,
            Equal | NotEqual | Less | LessEqual | Greater | GreaterEqual | In => 2,
            Add | Subtract => 3,
            Multiply | Divide | Modulo => 4,
        };
        (at == level).then_some(operator)
    }

    fn unary(&mut self) -> Step {
        let token = self.at;
        let operator = match self.kind(token) {
            TokenKind::Punct("!") => CelUnaryOperator::Not,
            TokenKind::Punct("-") => CelUnaryOperator::Negate,
            _ => return self.primary(),
        };
        if operator == CelUnaryOperator::Negate {
            if let Some(folded) = self.folded_number(token) {
                return self.postfix(folded);
            }
        }
        let start = self.span(token).0;
        if !self.enter(start) {
            return Step::Return(self.unparsed(start, start));
        }
        self.advance();
        self.frames.push(Frame::UnaryOperand { operator, start });
        Step::Enter(Rule::Unary)
    }

    /// `-` directly on an int or double literal is part of the literal.
    fn folded_number(&mut self, minus: usize) -> Option<Arc<CelNode>> {
        let number = self.peek(1);
        let literal = match self.kind(number) {
            // The magnitude reaches 2^63, whose negation is the int64 minimum.
            TokenKind::Int { magnitude, .. } => CelLiteral::Int(0u64.wrapping_sub(magnitude) as i64),
            TokenKind::Double(value) => CelLiteral::Double(-value),
            _ => return None,
        };
        self.advance();
        self.advance();
        let node = CelLiteralNode { literal, range: range(self.span(minus).0, self.span(number).1) };
        Some(self.keep(CelNode::Literal(node)))
    }

    fn postfix(&mut self, operand: Arc<CelNode>) -> Step {
        let mut node = operand;
        while !self.stopped {
            if self.take_punct(".") {
                let optional = self.take_punct("?");
                let name = self.at;
                let (name_start, name_end) = self.span(name);
                let quoted = self.kind(name) == TokenKind::QuotedIdent;
                let start = node.range().start;
                if !self.expect_member_name(name) {
                    // The member is unnamed: the select stands with an empty field, which is
                    // what an editor reads to complete a member after the dot.
                    return Step::Return(self.keep(CelNode::Select(CelSelectNode {
                        operand: node,
                        field: String::new(),
                        field_range: range(name_start, name_start),
                        optional,
                        quoted: false,
                        range: range(start, name_start),
                    })));
                }
                self.advance();
                let select = |operand: Arc<CelNode>, field: &str| {
                    CelNode::Select(CelSelectNode {
                        operand,
                        field: field.to_string(),
                        field_range: range(name_start, name_end),
                        optional,
                        quoted,
                        range: range(start, name_end),
                    })
                };
                if quoted && self.is_punct("(") {
                    // cel-spec admits a quoted name where a field is read and nowhere else: a
                    // called function is always an identifier.
                    self.unexpected(self.at, Some("a member read — a quoted name is a field, not a call"));
                    return Step::Return(self.keep(select(node, self.text(name))));
                }
                if self.is_punct("(") {
                    match self.call_arguments(Callee::Receiver { receiver: node, name }) {
                        Arguments::Closed(call) => node = call,
                        Arguments::Waiting => return Step::Enter(Rule::Conditional),
                    }
                    continue;
                }
                node = self.keep(select(node, self.text(name)));
                continue;
            }
            if self.is_punct("[") {
                self.advance();
                let optional = self.take_punct("?");
                self.frames.push(Frame::Index { operand: node, optional });
                return Step::Enter(Rule::Conditional);
            }
            return Step::Return(node);
        }
        Step::Return(node)
    }

    /// A field or a called function may be named by any word, however that word is read
    /// elsewhere, and by a name between backticks. A member names a value's entry, not
    /// a name in the expression's scope.
    fn expect_member_name(&mut self, token: usize) -> bool {
        matches!(
            self.kind(token),
            TokenKind::Ident | TokenKind::Reserved | TokenKind::Keyword | TokenKind::QuotedIdent
        ) || self.expect_identifier(token)
    }

    fn expect_identifier(&mut self, token: usize) -> bool {
        match self.kind(token) {
            TokenKind::Ident => true,
            TokenKind::Reserved => {
                let (start, end) = self.span(token);
                self.diagnostics.report(
                    CelSyntaxCode::ReservedIdentifier,
                    format!("{} is a reserved word and cannot be used as a name", json_quote(self.text(token))),
                    start,
                    end,
                );
                self.stopped = true;
                false
            }
            _ => {
                self.unexpected(token, Some("a name"));
                false
            }
        }
    }

    fn primary(&mut self) -> Step {
        let token = self.at;
        let (start, end) = self.span(token);
        let literal = match self.kind(token) {
            TokenKind::Int { at_boundary: true, .. } => {
                self.advance();
                // 2^63 is a magnitude, not a value: it is only the int64 minimum, which the
                // fold under a unary minus has already taken.
                self.diagnostics.report(
                    CelSyntaxCode::InvalidInteger,
                    format!("{} is outside the range of a 64-bit integer", self.text(token)),
                    start,
                    end,
                );
                self.stopped = true;
                let hole = self.unparsed(start, end);
                return self.postfix(hole);
            }
            TokenKind::Int { magnitude, .. } => CelLiteral::Int(magnitude as i64),
            TokenKind::Uint(value) => CelLiteral::Uint(value),
            TokenKind::Double(value) => CelLiteral::Double(value),
            TokenKind::String | TokenKind::Bytes => match std::mem::replace(&mut self.tokens[token].decoded, Decoded::Nothing) {
                Decoded::Text(text) => CelLiteral::String(text),
                Decoded::Bytes(bytes) => CelLiteral::Bytes(bytes),
                Decoded::Nothing => unreachable!("a string or bytes token is read once and carries what it decoded"),
            },
            TokenKind::Reserved => {
                self.expect_identifier(token);
                let hole = self.unparsed(start, end);
                return self.postfix(hole);
            }
            TokenKind::Keyword => {
                // An operator written as a word, where an expression must begin.
                return self.misplaced(token, None);
            }
            TokenKind::QuotedIdent => {
                // A quoted name reads a member; nothing else in the language is written that way.
                return self.misplaced(token, Some("a member read, as in a.`b`"));
            }
            TokenKind::Ident => return self.word(token),
            TokenKind::Punct("(") => {
                self.advance();
                self.frames.push(Frame::Parenthesized);
                return Step::Enter(Rule::Conditional);
            }
            TokenKind::Punct("[") => {
                self.advance();
                return self.list(token, Vec::new());
            }
            TokenKind::Punct("{") => {
                self.advance();
                return self.map(token, Vec::new());
            }
            TokenKind::Punct(".") => {
                let name = self.absolute_name(token);
                return self.postfix(name);
            }
            TokenKind::Punct(_) | TokenKind::Eof => return self.misplaced(token, None),
        };
        self.advance();
        let node = self.keep(CelNode::Literal(CelLiteralNode { literal, range: range(start, end) }));
        self.postfix(node)
    }

    /// A token no expression begins with: the hole stands where it is.
    fn misplaced(&mut self, token: usize, expected: Option<&str>) -> Step {
        let (start, end) = self.span(token);
        self.unexpected(token, expected);
        let hole = self.unparsed(start, end);
        self.postfix(hole)
    }

    /// `.y` — a name resolved against the environment alone. A name, not a member:
    /// neither a reserved word nor a quoted name opens one.
    fn absolute_name(&mut self, dot: usize) -> Arc<CelNode> {
        self.advance();
        let name = self.at;
        let start = self.span(dot).0;
        if !self.expect_identifier(name) {
            return self.unparsed(start, self.span(name).0);
        }
        self.advance();
        self.keep(CelNode::Ident(CelIdentNode {
            name: self.text(name).to_string(),
            absolute: true,
            range: range(start, self.span(name).1),
        }))
    }

    fn word(&mut self, token: usize) -> Step {
        self.advance();
        let (start, end) = self.span(token);
        let text = self.text(token);
        let literal = match text {
            "true" => Some(CelLiteral::Bool(true)),
            "false" => Some(CelLiteral::Bool(false)),
            "null" => Some(CelLiteral::Null),
            _ => None,
        };
        let node = match literal {
            Some(literal) => CelNode::Literal(CelLiteralNode { literal, range: range(start, end) }),
            None if self.is_punct("(") => {
                return match self.call_arguments(Callee::Global { name: token }) {
                    Arguments::Closed(call) => self.postfix(call),
                    Arguments::Waiting => Step::Enter(Rule::Conditional),
                };
            }
            None => CelNode::Ident(CelIdentNode { name: text.to_string(), absolute: false, range: range(start, end) }),
        };
        let node = self.keep(node);
        self.postfix(node)
    }

    /// The arguments of a call, the open paren being the current token.
    fn call_arguments(&mut self, callee: Callee) -> Arguments {
        let open = self.advance();
        self.next_argument(open, Vec::new(), callee)
    }

    fn next_argument(&mut self, open: usize, arguments: Vec<Arc<CelNode>>, callee: Callee) -> Arguments {
        if !self.stopped && !self.is_punct(")") {
            self.frames.push(Frame::CallArgument { open, arguments, callee });
            return Arguments::Waiting;
        }
        Arguments::Closed(self.close_call(open, arguments, callee))
    }

    fn close_call(&mut self, open: usize, arguments: Vec<Arc<CelNode>>, callee: Callee) -> Arc<CelNode> {
        let end = if self.stopped {
            arguments.last().map_or(self.span(open).1, |last| last.range().end)
        } else {
            let close = self.at;
            self.expect_punct(")");
            self.span(close).1
        };
        let node = match callee {
            Callee::Global { name } => {
                let (start, name_end) = self.span(name);
                CelNode::Call(CelCallNode {
                    name: self.text(name).to_string(),
                    name_range: range(start, name_end),
                    args: arguments,
                    range: range(start, end),
                })
            }
            Callee::Receiver { receiver, name } => {
                let (name_start, name_end) = self.span(name);
                let start = receiver.range().start;
                CelNode::ReceiverCall(CelReceiverCallNode {
                    receiver,
                    name: self.text(name).to_string(),
                    name_range: range(name_start, name_end),
                    args: arguments,
                    range: range(start, end),
                })
            }
        };
        self.keep(node)
    }

    fn list(&mut self, open: usize, elements: Vec<CelListElement>) -> Step {
        if !self.stopped && !self.is_punct("]") {
            let optional = self.optional_syntax && self.take_punct("?");
            self.frames.push(Frame::ListElement { open, elements, optional });
            return Step::Enter(Rule::Conditional);
        }
        self.close_list(open, elements)
    }

    fn close_list(&mut self, open: usize, elements: Vec<CelListElement>) -> Step {
        let last_read = elements.last().map(|element| element.value.range().end);
        let end = self.closing_end("]", open, last_read);
        let node = self.keep(CelNode::List(CelListNode { elements, range: range(self.span(open).0, end) }));
        self.postfix(node)
    }

    fn map(&mut self, open: usize, entries: Vec<CelMapEntry>) -> Step {
        if !self.stopped && !self.is_punct("}") {
            let optional = self.optional_syntax && self.take_punct("?");
            self.frames.push(Frame::MapKey { open, entries, optional });
            return Step::Enter(Rule::Conditional);
        }
        self.close_map(open, entries)
    }

    fn close_map(&mut self, open: usize, entries: Vec<CelMapEntry>) -> Step {
        let last_read = entries.last().map(|entry| entry.value.range().end);
        let end = self.closing_end("}", open, last_read);
        let node = self.keep(CelNode::Map(CelMapNode { entries, range: range(self.span(open).0, end) }));
        self.postfix(node)
    }

    /// Where an aggregate ends: at its closing bracket, or at what it did read.
    fn closing_end(&mut self, bracket: &str, open: usize, last_read: Option<u32>) -> u32 {
        if !self.stopped && self.expect_punct(bracket) {
            return self.span(self.at - 1).1;
        }
        last_read.unwrap_or(self.span(open).1)
    }

    /// Continues the position `frame` holds with the sub-expression it waited for.
    fn resume(&mut self, frame: Frame, node: Arc<CelNode>) -> Step {
        match frame {
            Frame::Condition => {
                if self.stopped || !self.is_punct("?") {
                    self.leave();
                    return Step::Return(node);
                }
                self.advance();
                self.frames.push(Frame::WhenTrue { condition: node });
                Step::Enter(Rule::Conditional)
            }
            Frame::WhenTrue { condition } => {
                if self.stopped || !self.expect_punct(":") {
                    let end = node.range().end;
                    let when_false = self.unparsed(end, end);
                    return self.close_conditional(condition, node, when_false);
                }
                self.frames.push(Frame::WhenFalse { condition, when_true: node });
                Step::Enter(Rule::Conditional)
            }
            Frame::WhenFalse { condition, when_true } => self.close_conditional(condition, when_true, node),
            Frame::BinaryLeft { lowest } => self.binary_chain(lowest, HIGHEST_BINARY_LEVEL, node),
            Frame::BinaryRight { lowest, level, operator, left } => {
                let open = matches!(*node, CelNode::Unparsed(_));
                let range = range(left.range().start, node.range().end);
                let left = self.keep(CelNode::Binary(CelBinaryNode { operator, left, right: node, range }));
                if !open {
                    self.binary_chain(lowest, level, left)
                } else if level == lowest {
                    Step::Return(left)
                } else {
                    self.binary_chain(lowest, level - 1, left)
                }
            }
            Frame::UnaryOperand { operator, start } => {
                let range = range(start, node.range().end);
                let node = self.keep(CelNode::Unary(CelUnaryNode { operator, operand: node, range }));
                self.leave();
                Step::Return(node)
            }
            Frame::Parenthesized => {
                if !self.stopped {
                    self.expect_punct(")");
                }
                self.postfix(node)
            }
            Frame::ListElement { open, mut elements, optional } => {
                let end = node.range().end;
                elements.push(CelListElement { value: node, optional });
                if elements.len() > self.limits.max_list_elements {
                    self.limit("list elements", self.limits.max_list_elements, self.span(open).0, end);
                    return self.close_list(open, elements);
                }
                if !self.take_punct(",") {
                    return self.close_list(open, elements);
                }
                self.list(open, elements)
            }
            Frame::MapKey { open, mut entries, optional } => {
                if self.stopped || !self.expect_punct(":") {
                    let end = node.range().end;
                    let value = self.unparsed(end, end);
                    entries.push(CelMapEntry { key: node, value, optional });
                    return self.close_map(open, entries);
                }
                self.frames.push(Frame::MapValue { open, entries, optional, key: node });
                Step::Enter(Rule::Conditional)
            }
            Frame::MapValue { open, mut entries, optional, key } => {
                let end = node.range().end;
                entries.push(CelMapEntry { key, value: node, optional });
                if entries.len() > self.limits.max_map_entries {
                    self.limit("map entries", self.limits.max_map_entries, self.span(open).0, end);
                    return self.close_map(open, entries);
                }
                if !self.take_punct(",") {
                    return self.close_map(open, entries);
                }
                self.map(open, entries)
            }
            Frame::CallArgument { open, mut arguments, callee } => {
                let end = node.range().end;
                arguments.push(node);
                let over = arguments.len() > self.limits.max_call_arguments;
                if over {
                    self.limit("call arguments", self.limits.max_call_arguments, self.span(open).0, end);
                }
                let call = if over || !self.take_punct(",") {
                    self.close_call(open, arguments, callee)
                } else {
                    match self.next_argument(open, arguments, callee) {
                        Arguments::Closed(call) => call,
                        Arguments::Waiting => return Step::Enter(Rule::Conditional),
                    }
                };
                self.postfix(call)
            }
            Frame::Index { operand, optional } => {
                let closed = !self.stopped && self.expect_punct("]");
                let end = if closed { self.span(self.at - 1).1 } else { node.range().end };
                let range = range(operand.range().start, end);
                let node = self.keep(CelNode::Index(CelIndexNode { operand, index: node, optional, range }));
                if !closed {
                    return Step::Return(node);
                }
                self.postfix(node)
            }
        }
    }

    fn close_conditional(&mut self, condition: Arc<CelNode>, when_true: Arc<CelNode>, when_false: Arc<CelNode>) -> Step {
        let range = range(condition.range().start, when_false.range().end);
        let node = self.keep(CelNode::Conditional(CelConditionalNode { condition, when_true, when_false, range }));
        self.leave();
        Step::Return(node)
    }
}

/// Reads one CEL expression. Always answers a tree; `diagnostic` holds the first thing
/// that could not be read, exactly when the whole source could not be.
pub fn parse_syntax(source: &str, options: &ParseOptions) -> ParseResult {
    let (tokens, diagnostics) = tokenize(source);
    let stopped = diagnostics.reported();
    let parser = Parser {
        source,
        tokens,
        diagnostics,
        limits: options.limits,
        optional_syntax: options.optional_syntax,
        at: 0,
        nodes: 0,
        depth: 0,
        stopped,
        frames: Vec::new(),
    };
    let (root, diagnostics) = parser.parse();
    ParseResult { source: Arc::from(source), root, diagnostic: diagnostics.first() }
}
