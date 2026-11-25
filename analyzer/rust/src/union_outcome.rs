//! What a failed `anyOf` / `oneOf` reports, decided from the STATE of each of its
//! branches — never from the findings' depth or count. Mirrors
//! `../../nodejs/src/union-outcome.ts`.
//!
//! - `Valid` — nothing stands against the value;
//! - `TypeRefused` — the branch is no candidate: its own schema refuses the value's JSON
//!   type at the union's node (`union_tags`);
//! - `Failing` — a candidate accepting the value's shape at the node and refusing
//!   something further in;
//! - `ShapeRefused` — a candidate a shape keyword refuses at the node itself, or a
//!   `const` / `enum` refuses at one of the union's selectors;
//! - `TagRefused` — a candidate a `const` / `enum` refuses at one of the union's tags.

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BranchState {
    Valid,
    Failing,
    ShapeRefused,
    TypeRefused,
    /// Every tag a `const` / `enum` refused the value at, as JSON Pointers, in the order
    /// the branch raised them.
    TagRefused(Vec<String>),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum UnionOutcome {
    /// The union holds.
    Pass,
    /// A `oneOf` several branches match: the union's own finding.
    Ambiguous,
    /// The findings of these branches, in declaration order.
    Branches(Vec<usize>),
    /// Every branch refuses the tag at `at`: one finding there listing what these
    /// branches allow.
    Tag { at: String, branches: Vec<usize> },
    /// No branch is a reading of the value: one finding at the node listing the
    /// alternatives.
    Alternatives,
}

impl UnionOutcome {
    /// The outcome's kind, as an enclosing branch reads it.
    pub fn kind(&self) -> &'static str {
        match self {
            UnionOutcome::Pass => "pass",
            UnionOutcome::Ambiguous => "ambiguous",
            UnionOutcome::Branches(_) => "branches",
            UnionOutcome::Tag { .. } => "tag",
            UnionOutcome::Alternatives => "alternatives",
        }
    }
}

/// The verdict of a union over its branches' states, in declaration order.
///
/// 1. `anyOf`: a valid branch → pass. `oneOf`: exactly one → pass; several → ambiguous.
/// 2. When some candidate is tag-refused: exactly one candidate accepting the tag → that
///    branch; none accepting, and a tag every candidate refuses → the tag finding there;
///    several accepting → the decision continues among those alone.
/// 3. Every failing candidate, when there is one.
/// 4. Otherwise the alternatives.
pub fn union_outcome(one_of: bool, states: &[BranchState]) -> UnionOutcome {
    let valid = states.iter().filter(|s| **s == BranchState::Valid).count();
    if if one_of { valid == 1 } else { valid > 0 } {
        return UnionOutcome::Pass;
    }
    if valid > 1 {
        return UnionOutcome::Ambiguous;
    }
    let candidates: Vec<usize> = (0..states.len()).filter(|i| states[*i] != BranchState::TypeRefused).collect();
    let places_of = |i: usize| match &states[i] {
        BranchState::TagRefused(at) => at.as_slice(),
        _ => &[],
    };
    let refused: Vec<usize> = candidates.iter().copied().filter(|i| matches!(states[*i], BranchState::TagRefused(_))).collect();
    let mut considered = candidates.clone();
    if !refused.is_empty() {
        let accepting: Vec<usize> = candidates.iter().copied().filter(|i| !matches!(states[*i], BranchState::TagRefused(_))).collect();
        if accepting.len() == 1 {
            return UnionOutcome::Branches(accepting);
        }
        if accepting.is_empty() {
            let at = places_of(refused[0]).iter().find(|place| refused.iter().all(|i| places_of(*i).contains(place)));
            if let Some(at) = at {
                return UnionOutcome::Tag { at: at.clone(), branches: refused };
            }
        } else {
            considered = accepting;
        }
    }
    let failing: Vec<usize> = considered.into_iter().filter(|i| states[*i] == BranchState::Failing).collect();
    if !failing.is_empty() {
        return UnionOutcome::Branches(failing);
    }
    UnionOutcome::Alternatives
}
