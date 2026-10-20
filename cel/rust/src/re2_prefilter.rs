//! The literals an RE2 pattern requires, checked before a search. No Node twin: this is the
//! role of re2js 2.8.3's `Prefilter`, `PrefilterTree` and `AhoCorasick`, files of a
//! dependency.
//!
//! This is those, twinned. The simplified tree is read into a condition over literals:
//! a literal not folded for case must occur (EXACT), a concatenation requires all of its
//! parts (AND), an alternation one of its branches (OR), a capture or a plus loop what its
//! operand requires, and everything else nothing (NONE). The condition is simplified as
//! re2js simplifies it — NONE dropped from an AND, an OR with a NONE branch is NONE, nested
//! ANDs and ORs flattened, an OR's repeated literals kept once — and an OR of two or more
//! literals and nothing else is checked by one Aho-Corasick automaton over UTF-8 bytes. A
//! literal must occur at or after the search's start, since a match lies there. A text that
//! fails the condition holds no match; one that passes is searched.
//!
//! re2js builds and simplifies recursively; here both are one bottom-up walk on a heap
//! stack, the answer for a subexpression shared by the copies of a repetition kept once,
//! and the condition lives in one flat arena that is checked on a heap stack too.

use std::collections::{HashMap, HashSet};

use crate::re2_program::Re2Literal;
use crate::re2_syntax::{NodeId, Op, Regexp, FOLD_CASE};

enum Condition {
    None,
    Exact(Re2Literal),
    And(Vec<u32>),
    Or { subs: Vec<u32>, any: Option<AhoCorasick> },
}

/// A pattern's required literals: a condition other than NONE.
pub(crate) struct Prefilter {
    conditions: Vec<Condition>,
    root: u32,
}

/// The condition every arena starts with, shared by every NONE.
const NONE: u32 = 0;

impl Prefilter {
    /// re2js's `PrefilterTree.build` over the simplified tree, or nothing when the pattern
    /// requires no literal.
    pub(crate) fn build(nodes: &[Regexp], root: NodeId) -> Option<Prefilter> {
        let mut built = vec![Condition::None];
        let mut answers: HashMap<NodeId, u32> = HashMap::new();
        let mut pending: HashSet<NodeId> = HashSet::new();
        let mut tasks = vec![(root, false)];
        while let Some((id, ready)) = tasks.pop() {
            if answers.contains_key(&id) {
                continue;
            }
            let node = &nodes[id as usize];
            let operands: &[NodeId] = match node.op {
                Op::Capture | Op::Plus => &node.subs[..1],
                Op::Repeat if node.min >= 1 => &node.subs[..1],
                Op::Concat | Op::Alternate => &node.subs,
                _ => &[],
            };
            if !ready && !operands.is_empty() {
                tasks.push((id, true));
                // The copies of a repetition share one operand: it is visited once.
                pending.clear();
                for &sub in operands.iter().rev() {
                    if !answers.contains_key(&sub) && pending.insert(sub) {
                        tasks.push((sub, false));
                    }
                }
                continue;
            }
            let answer = match node.op {
                Op::Literal if node.runes.is_empty() || node.flags & FOLD_CASE != 0 => NONE,
                Op::Literal => push(&mut built, Condition::Exact(Re2Literal::from_code_points(&node.runes))),
                Op::Capture | Op::Plus => answers[&node.subs[0]],
                Op::Repeat if node.min >= 1 => answers[&node.subs[0]],
                Op::Concat => simplify_and(&mut built, node.subs.iter().map(|sub| answers[sub])),
                Op::Alternate => simplify_or(&mut built, node.subs.iter().map(|sub| answers[sub])),
                _ => NONE,
            };
            answers.insert(id, answer);
        }
        let root = answers[&root];
        (root != NONE).then(|| compact(built, root))
    }

    /// The type of the condition, re2js's `Prefilter.Type`: 1 EXACT, 2 AND, 3 OR.
    #[cfg(test)]
    pub(crate) fn kind(&self) -> u8 {
        match self.conditions[self.root as usize] {
            Condition::None => 0,
            Condition::Exact(_) => 1,
            Condition::And(_) => 2,
            Condition::Or { .. } => 3,
        }
    }

    /// re2js's `Prefilter.eval`: whether `text` from byte `pos` on holds what the pattern
    /// requires.
    pub(crate) fn passes(&self, text: &str, pos: usize) -> bool {
        enum Task {
            Check(u32),
            /// The next operand of an AND or OR to check, the answer so far in hand.
            Continue(u32, usize),
        }
        let mut answer = true;
        let mut tasks = vec![Task::Check(self.root)];
        while let Some(task) = tasks.pop() {
            match task {
                Task::Check(id) => match &self.conditions[id as usize] {
                    Condition::None => answer = true,
                    Condition::Exact(literal) => answer = literal.find(text, pos).is_some(),
                    Condition::Or { any: Some(automaton), .. } => answer = automaton.occurs_in(&text.as_bytes()[pos..]),
                    Condition::And(_) | Condition::Or { any: None, .. } => tasks.push(Task::Continue(id, 0)),
                },
                Task::Continue(id, next) => {
                    let (subs, decided_by) = match &self.conditions[id as usize] {
                        Condition::And(subs) => (subs, false),
                        Condition::Or { subs, .. } => (subs, true),
                        _ => unreachable!("only an AND or an OR checks its operands in turn"),
                    };
                    if next > 0 && answer == decided_by {
                        continue;
                    }
                    if next == subs.len() {
                        answer = !decided_by;
                        continue;
                    }
                    tasks.push(Task::Continue(id, next + 1));
                    tasks.push(Task::Check(subs[next]));
                }
            }
        }
        answer
    }
}

fn push(built: &mut Vec<Condition>, condition: Condition) -> u32 {
    built.push(condition);
    (built.len() - 1) as u32
}

/// re2js's `PrefilterTree.simplify` of an AND whose operands are simplified.
fn simplify_and(built: &mut Vec<Condition>, subs: impl Iterator<Item = u32>) -> u32 {
    let mut kept = Vec::new();
    for sub in subs {
        match &built[sub as usize] {
            Condition::None => {}
            Condition::And(inner) => kept.extend_from_slice(inner),
            _ => kept.push(sub),
        }
    }
    match kept.len() {
        0 => NONE,
        1 => kept[0],
        _ => push(built, Condition::And(kept)),
    }
}

/// re2js's `PrefilterTree.simplify` of an OR whose operands are simplified; its automaton is
/// built once the whole condition is known.
fn simplify_or(built: &mut Vec<Condition>, subs: impl Iterator<Item = u32>) -> u32 {
    let mut kept = Vec::new();
    for sub in subs {
        match &built[sub as usize] {
            Condition::None => return NONE,
            Condition::Or { subs: inner, .. } => kept.extend_from_slice(inner),
            _ => kept.push(sub),
        }
    }
    match kept.len() {
        0 => return NONE,
        1 => return kept[0],
        _ => {}
    }
    let mut seen: HashSet<&[u8]> = HashSet::new();
    let mut unique = Vec::with_capacity(kept.len());
    for &sub in &kept {
        match &built[sub as usize] {
            Condition::Exact(literal) if !seen.insert(literal.bytes()) => {}
            _ => unique.push(sub),
        }
    }
    push(built, Condition::Or { subs: unique, any: None })
}

/// The conditions `root` reaches, in an arena of their own, each OR of two or more
/// literals and nothing else given its automaton.
fn compact(mut built: Vec<Condition>, root: u32) -> Prefilter {
    let mut renumbered: HashMap<u32, u32> = HashMap::new();
    let mut order = Vec::new();
    let mut pending = vec![root];
    while let Some(id) = pending.pop() {
        if renumbered.contains_key(&id) {
            continue;
        }
        renumbered.insert(id, order.len() as u32);
        order.push(id);
        if let Condition::And(subs) | Condition::Or { subs, .. } = &built[id as usize] {
            pending.extend(subs.iter().rev().copied());
        }
    }
    let automata: Vec<Option<AhoCorasick>> = order
        .iter()
        .map(|&id| {
            let Condition::Or { subs, .. } = &built[id as usize] else {
                return None;
            };
            let words: Option<Vec<&[u8]>> = subs
                .iter()
                .map(|&sub| match &built[sub as usize] {
                    Condition::Exact(literal) => Some(literal.bytes()),
                    _ => None,
                })
                .collect();
            words.filter(|words| words.len() > 1).map(|words| AhoCorasick::new(&words))
        })
        .collect();
    let mut conditions = Vec::with_capacity(order.len());
    for (id, any) in order.into_iter().zip(automata) {
        let condition = match std::mem::replace(&mut built[id as usize], Condition::None) {
            Condition::And(subs) => Condition::And(subs.iter().map(|sub| renumbered[sub]).collect()),
            Condition::Or { subs, .. } => Condition::Or { subs: subs.iter().map(|sub| renumbered[sub]).collect(), any },
            other => other,
        };
        conditions.push(condition);
    }
    Prefilter { conditions, root: 0 }
}

/// re2js's `AhoCorasick` over bytes: a trie of the words, each node's longest proper suffix
/// that is also a trie node, and whether a word ends at the node or at a suffix of it.
struct AhoCorasick {
    /// Each node's children, ordered by byte.
    next: Vec<Vec<(u8, u32)>>,
    fail: Vec<u32>,
    ends: Vec<bool>,
}

impl AhoCorasick {
    fn new(words: &[&[u8]]) -> Self {
        let mut automaton = Self { next: vec![Vec::new()], fail: vec![0], ends: vec![false] };
        for word in words {
            let mut node = 0u32;
            for &byte in word.iter() {
                node = match automaton.child(node, byte) {
                    Some(child) => child,
                    None => {
                        let child = automaton.next.len() as u32;
                        automaton.next.push(Vec::new());
                        automaton.fail.push(0);
                        automaton.ends.push(false);
                        let edges = &mut automaton.next[node as usize];
                        let at = edges.partition_point(|&(edge, _)| edge < byte);
                        edges.insert(at, (byte, child));
                        child
                    }
                };
            }
            automaton.ends[node as usize] = true;
        }
        let mut queue: std::collections::VecDeque<u32> = automaton.next[0].iter().map(|&(_, child)| child).collect();
        while let Some(current) = queue.pop_front() {
            for index in 0..automaton.next[current as usize].len() {
                let (byte, child) = automaton.next[current as usize][index];
                let mut fail = automaton.fail[current as usize];
                while fail != 0 && automaton.child(fail, byte).is_none() {
                    fail = automaton.fail[fail as usize];
                }
                let target = automaton.child(fail, byte).unwrap_or(0);
                automaton.fail[child as usize] = target;
                automaton.ends[child as usize] = automaton.ends[child as usize] || automaton.ends[target as usize];
                queue.push_back(child);
            }
        }
        automaton
    }

    fn child(&self, node: u32, byte: u8) -> Option<u32> {
        let edges = &self.next[node as usize];
        edges.binary_search_by_key(&byte, |&(edge, _)| edge).ok().map(|at| edges[at].1)
    }

    /// re2js's `searchUTF8`: whether any word occurs in `bytes`.
    fn occurs_in(&self, bytes: &[u8]) -> bool {
        let mut node = 0u32;
        for &byte in bytes {
            while node != 0 && self.child(node, byte).is_none() {
                node = self.fail[node as usize];
            }
            if let Some(child) = self.child(node, byte) {
                node = child;
            }
            if self.ends[node as usize] {
                return true;
            }
        }
        false
    }
}
