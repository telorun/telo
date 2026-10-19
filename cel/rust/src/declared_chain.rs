//! Splitting a dotted chain over the names a host declared — `declared-chain.ts`.
//!
//! A host may declare `a.b.c`, or `a.b` holding a map, or both. `a.b.c` then reads the
//! variable of that name where it is declared and the map's entry where only `a.b` is: the
//! longest declared prefix wins, the root counting as one. The checker asks the question
//! here, and evaluation will ask it of the same function, so the two cannot read different
//! names out of one chain.
//!
//! The chain is joined once; each prefix is a slice of that text, so asking costs the
//! chain's length plus what the predicate costs per prefix.
//!
//! Node items with no twin in this file: none.

/// Where a chain splits: the declared name, and the members read off its value.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct DeclaredChain {
    pub name: String,
    pub rest: Vec<String>,
}

/// The longest declared prefix of a chain, or nothing when no declaration covers one.
/// `declared` is asked of each prefix, longest first, until it answers yes.
pub fn split_declared_chain<S: AsRef<str>>(segments: &[S], mut declared: impl FnMut(&str) -> bool) -> Option<DeclaredChain> {
    let mut joined = String::new();
    let mut ends = Vec::with_capacity(segments.len());
    for (at, segment) in segments.iter().enumerate() {
        if at > 0 {
            joined.push('.');
        }
        joined.push_str(segment.as_ref());
        ends.push(joined.len());
    }
    for length in (1..=segments.len()).rev() {
        let name = &joined[..ends[length - 1]];
        if declared(name) {
            return Some(DeclaredChain {
                name: name.into(),
                rest: segments[length..].iter().map(|segment| segment.as_ref().to_string()).collect(),
            });
        }
    }
    None
}
