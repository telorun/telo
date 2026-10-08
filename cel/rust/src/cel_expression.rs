//! One CEL expression, read and resolved — `cel-expression.ts`.
//!
//! This is the front end's whole answer: the source as written, the canonical tree,
//! the namespace set the tree was resolved under, and at most one syntax diagnostic.
//! Every expression handed out here is already resolved, and `namespaces` records what
//! it was resolved under, so a consumer checking it against a different set can refuse
//! rather than quietly answer the wrong question.
//!
//! Reading never fails on the source: one it cannot read gives a tree for the longest
//! prefix it could, plus the diagnostic saying where it stopped. The only refusal is of
//! a namespace set no host can have.
//!
//! Declared differently from the Node file:
//! - `CelExpression::diagnostic` — Node's `diagnostics` is a list of at most one entry;
//!   here it is an `Option`.
//! - `CelExpression::source`, `root` and `namespaces` are shared, so a clone of an
//!   expression copies no text and no tree.
//! - `ParseExpressionOptions` holds the reader's options whole, as `parse`, where
//!   Node's extends them.
//! - A refused namespace set is the `Err` of `parse_expression` and `resolved_under`,
//!   where Node throws it.

use std::sync::Arc;

use crate::namespace_resolution::{namespace_sets_equal, normalize_namespaces, resolve_namespaces, CelNamespaceError};
use crate::parser::{parse_syntax, ParseOptions};
use crate::syntax_diagnostic::CelSyntaxDiagnostic;
use crate::syntax_tree::CelNode;

#[derive(Clone, PartialEq, Debug)]
pub struct CelExpression {
    pub source: Arc<str>,
    pub root: Arc<CelNode>,
    /// The namespace set the tree was resolved under, in canonical order.
    pub namespaces: Arc<[String]>,
    /// The first thing that could not be read, held exactly when the whole source
    /// could not be.
    pub diagnostic: Option<CelSyntaxDiagnostic>,
}

const _: () = {
    const fn shared_across_threads<T: Send + Sync>() {}
    shared_across_threads::<CelExpression>();
};

#[derive(Clone, PartialEq, Eq, Debug, Default)]
pub struct ParseExpressionOptions {
    /// The reader's own options, handed to it unchanged.
    pub parse: ParseOptions,
    /// The names that denote namespaces rather than values at this site.
    pub namespaces: Vec<String>,
}

pub fn parse_expression(source: &str, options: &ParseExpressionOptions) -> Result<CelExpression, CelNamespaceError> {
    let namespaces = normalize_namespaces(&options.namespaces)?;
    let parsed = parse_syntax(source, &options.parse);
    Ok(CelExpression {
        root: resolve_namespaces(&parsed.root, &namespaces),
        source: parsed.source,
        namespaces: namespaces.into(),
        diagnostic: parsed.diagnostic,
    })
}

/// Whether the expression was resolved under exactly these namespaces.
pub fn resolved_under<I>(expression: &CelExpression, namespaces: I) -> Result<bool, CelNamespaceError>
where
    I: IntoIterator,
    I::Item: AsRef<str>,
{
    Ok(namespace_sets_equal(&expression.namespaces, &normalize_namespaces(namespaces)?))
}
