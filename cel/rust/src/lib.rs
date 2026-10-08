//! The CEL language for Rust — `index.ts`, the entry of `cel/nodejs` (`@telorun/cel`).
//!
//! Today the crate is the engine's reader: source text into the ranged syntax tree,
//! with the input limits and error recovery. It answers as the Node engine's reader
//! answers — the same tree, the same diagnostic code, message and range.
//!
//! Three rules hold for every file here: one dependency, the value crate, by path; no
//! host vocabulary; and nothing recurses with the depth of its input.
//!
//! Each file twins the `cel/nodejs/src` file of its name, and each header lists the
//! Node items with no twin.
//!
//! - `reserved_words.rs`    — `reserved-words.ts`
//! - `syntax_diagnostic.rs` — `syntax-diagnostic.ts`
//! - `parse_limits.rs`      — `parse-limits.ts`
//! - `syntax_tree.rs`       — `syntax-tree.ts`
//! - `tree_equality.rs`     — `tree-equality.ts`
//! - `lexer.rs`             — `lexer.ts`
//! - `parser.rs`            — `parser.ts`

mod lexer;
mod parse_limits;
mod parser;
mod reserved_words;
mod syntax_diagnostic;
mod syntax_tree;
mod tree_equality;

pub use parse_limits::{CelParseLimits, DEFAULT_PARSE_LIMITS};
pub use parser::{parse_syntax, ParseOptions, ParseResult};
pub use reserved_words::{is_identifier_spelling, is_reserved_word, LITERAL_WORDS, OPERATOR_WORDS, RESERVED_WORDS};
pub use syntax_diagnostic::{CelSyntaxCode, CelSyntaxDiagnostic};
pub use syntax_tree::{
    child_nodes, has_unparsed, walk_tree, CelBinaryNode, CelBinaryOperator, CelCallNode, CelConditionalNode,
    CelIdentNode, CelIndexNode, CelListElement, CelListNode, CelLiteral, CelLiteralNode, CelMapEntry, CelMapNode,
    CelNode, CelQualifiedCallNode, CelReceiverCallNode, CelSelectNode, CelUnaryNode, CelUnaryOperator,
    CelUnparsedNode, SourceRange, TreeWalk,
};
pub use tree_equality::trees_equal;
