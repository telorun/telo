//! What the front end refuses to read because it is too big — `parse-limits.ts`.
//!
//! An expression arrives from a manifest, an editor buffer or a wire, so the reader is
//! a hostile-input boundary. Each limit is reported as an ordinary ranged diagnostic,
//! so an editor keeps the prefix that was read.
//!
//! Reading uses a constant amount of stack whatever the limits are: the parser holds
//! its pending grammar positions on the heap, and nothing that walks a tree recurses.
//! `max_depth` therefore bounds heap, not stack, and raising it costs memory only.
//!
//! Node exports with no twin in this file:
//! - `resolveParseLimits` — the limits are one struct whose `Default` is Node's
//!   defaults, and a partial override is a struct update
//!   (`CelParseLimits { max_depth: 500, ..Default::default() }`).

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct CelParseLimits {
    /// Nodes in the tree.
    pub max_nodes: usize,
    /// Nesting depth of the expression grammar.
    pub max_depth: usize,
    /// Elements in one list literal.
    pub max_list_elements: usize,
    /// Entries in one map literal.
    pub max_map_entries: usize,
    /// Arguments at one call.
    pub max_call_arguments: usize,
}

/// The limits every already-written manifest was accepted under.
pub const DEFAULT_PARSE_LIMITS: CelParseLimits = CelParseLimits {
    max_nodes: 100000,
    max_depth: 250,
    max_list_elements: 1000,
    max_map_entries: 1000,
    max_call_arguments: 32,
};

impl Default for CelParseLimits {
    fn default() -> Self {
        DEFAULT_PARSE_LIMITS
    }
}
