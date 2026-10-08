//! The CEL language for Rust — `index.ts`, the entry of `cel/nodejs` (`@telorun/cel`).
//!
//! The crate is the engine's front end: reading an expression into the ranged syntax
//! tree, with the input limits and error recovery; resolving namespace-qualified calls;
//! writing a tree back as source; and the two questions a consumer asks of a tree — what
//! it reads, and which namespaced functions it calls. It answers as the Node engine's
//! front end answers.
//!
//! Three rules hold for every file here: one dependency, the value crate, by path; no
//! host vocabulary; and nothing recurses with the depth of its input.
//!
//! Each file twins the `cel/nodejs/src` file of its name, and each header lists the
//! Node items with no twin. The exports below are the front-end block of Node's entry
//! and its comprehension-binding table; `declared-chain.ts`, which Node lists in that
//! block, arrives with the checker that supplies its predicate.
//!
//! - `reserved_words.rs`         — `reserved-words.ts`
//! - `syntax_diagnostic.rs`      — `syntax-diagnostic.ts`
//! - `parse_limits.rs`           — `parse-limits.ts`
//! - `syntax_tree.rs`            — `syntax-tree.ts`
//! - `tree_equality.rs`          — `tree-equality.ts`
//! - `lexer.rs`                  — `lexer.ts`
//! - `parser.rs`                 — `parser.ts`
//! - `namespace_resolution.rs`   — `namespace-resolution.ts`
//! - `cel_expression.rs`         — `cel-expression.ts`
//! - `serializer.rs`             — `serializer.ts`
//! - `comprehension_bindings.rs` — `comprehension-bindings.ts`
//! - `qualified_calls.rs`        — `qualified-calls.ts`
//! - `root_references.rs`        — `root-references.ts`

mod cel_expression;
mod comprehension_bindings;
mod lexer;
mod namespace_resolution;
mod parse_limits;
mod parser;
mod qualified_calls;
mod reserved_words;
mod root_references;
mod serializer;
mod syntax_diagnostic;
mod syntax_tree;
mod tree_equality;

pub use cel_expression::{parse_expression, resolved_under, CelExpression, ParseExpressionOptions};
pub use comprehension_bindings::{
    namespace_macro_binding, receiver_macro_binding, ComprehensionBinding, BINDING_FORMS,
};
pub use namespace_resolution::{
    namespace_sets_equal, normalize_namespaces, resolve_namespaces, CelNamespaceError, RESERVED_NAMESPACES,
};
pub use parse_limits::{CelParseLimits, DEFAULT_PARSE_LIMITS};
pub use parser::{parse_syntax, ParseOptions, ParseResult};
pub use qualified_calls::{qualified_calls, QualifiedCall};
pub use reserved_words::{is_identifier_spelling, is_reserved_word, LITERAL_WORDS, OPERATOR_WORDS, RESERVED_WORDS};
pub use root_references::root_references;
pub use serializer::{serialize_tree, CelSerializeError};
pub use syntax_diagnostic::{CelSyntaxCode, CelSyntaxDiagnostic};
pub use syntax_tree::{
    child_nodes, has_unparsed, walk_tree, CelBinaryNode, CelBinaryOperator, CelCallNode, CelConditionalNode,
    CelIdentNode, CelIndexNode, CelListElement, CelListNode, CelLiteral, CelLiteralNode, CelMapEntry, CelMapNode,
    CelNode, CelQualifiedCallNode, CelReceiverCallNode, CelSelectNode, CelUnaryNode, CelUnaryOperator,
    CelUnparsedNode, SourceRange, TreeWalk,
};
pub use tree_equality::trees_equal;
