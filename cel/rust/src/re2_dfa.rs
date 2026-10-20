//! The lazy DFA. No Node twin: this is the role of re2js 2.8.3's `DFA` and `DFAState`, files
//! of a dependency.
//!
//! This is those, twinned for the one mode a search reaches: unanchored, answering only
//! whether the program matches. A state is the set of instructions the program can stand at
//! — the closure of the instructions a step reaches, the program's start added at every
//! position — built the first time a step needs it and kept with its transitions: a table
//! of the 256 Latin-1 code points, and an open-addressed table beyond. The scan stops at the
//! first state that holds the match instruction. A closure reaching an empty-width
//! instruction declines, as re2js's does, and the search runs on another engine.
//!
//! The states are held within a budget of 8,388,608 bytes, re2js's, counted on the bytes
//! they hold here — their instructions, both transition tables, the index that finds them.
//! A state that would pass the budget first clears the cache down to half of it, keeping the
//! states used most recently, their transitions forgotten; the fifth clear fails the cache
//! for good, and so does a single state larger than the budget, and a failed cache declines
//! every search. `visits` counts each instruction a closure adds and each a step examines
//! while building a transition, and one for each transition already built: at most
//! 2 × (|program| + 1) × (n + 1).

use std::mem::size_of;

use crate::re2_program::{InstOp, Prog};

/// re2js's `maxMem`.
pub(crate) const DFA_BUDGET: usize = 8_388_608;

/// re2js's `MAX_CACHE_CLEARS`.
const MAX_CACHE_CLEARS: u32 = 5;

/// A transition not built yet, and an empty slot of an open-addressed table.
const UNBUILT: u32 = u32::MAX;

const LATIN1: usize = 256;

struct State {
    /// The closure, sorted.
    pcs: Box<[u32]>,
    is_match: bool,
    latin1: Box<[u32; LATIN1]>,
    /// Code points above Latin-1 and the state each reaches, open-addressed by code point.
    beyond: Vec<(u32, u32)>,
    beyond_len: usize,
    last_seen: u64,
}

impl State {
    fn bytes(&self) -> usize {
        size_of::<State>() + self.pcs.len() * size_of::<u32>() + size_of::<[u32; LATIN1]>() + self.beyond.len() * size_of::<(u32, u32)>()
    }

    fn transition(&self, r: u32) -> u32 {
        if r < LATIN1 as u32 {
            return self.latin1[r as usize];
        }
        if self.beyond.is_empty() {
            return UNBUILT;
        }
        let mask = self.beyond.len() - 1;
        let mut slot = hash32(r) as usize & mask;
        loop {
            let (key, value) = self.beyond[slot];
            if key == r {
                return value;
            }
            if key == UNBUILT {
                return UNBUILT;
            }
            slot = (slot + 1) & mask;
        }
    }

    /// How many bytes recording a transition over `r` grows the state by.
    fn growth(&self, r: u32) -> usize {
        if r < LATIN1 as u32 || (self.beyond_len + 1) * 2 <= self.beyond.len() {
            return 0;
        }
        ((self.beyond.len() * 2).max(8) - self.beyond.len()) * size_of::<(u32, u32)>()
    }

    fn record(&mut self, r: u32, next: u32) {
        if r < LATIN1 as u32 {
            self.latin1[r as usize] = next;
            return;
        }
        if (self.beyond_len + 1) * 2 > self.beyond.len() {
            let entries: Vec<(u32, u32)> = self.beyond.iter().copied().filter(|&(key, _)| key != UNBUILT).collect();
            self.beyond = vec![(UNBUILT, UNBUILT); (self.beyond.len() * 2).max(8)];
            self.beyond_len = 0;
            for (key, value) in entries {
                self.insert_beyond(key, value);
            }
        }
        self.insert_beyond(r, next);
    }

    fn insert_beyond(&mut self, r: u32, next: u32) {
        let mask = self.beyond.len() - 1;
        let mut slot = hash32(r) as usize & mask;
        while self.beyond[slot].0 != UNBUILT {
            slot = (slot + 1) & mask;
        }
        self.beyond[slot] = (r, next);
        self.beyond_len += 1;
    }

    fn forget_transitions(&mut self) {
        self.latin1.fill(UNBUILT);
        self.beyond = Vec::new();
        self.beyond_len = 0;
    }
}

fn hash32(value: u32) -> u32 {
    value.wrapping_mul(0x9E37_79B9) ^ (value >> 16)
}

/// re2js's `hashPCs`.
fn hash_pcs(pcs: &[u32]) -> u32 {
    let mut h: u32 = 0x811C_9DC5;
    for &pc in pcs {
        h ^= pc;
        h = h.wrapping_mul(16_777_619);
    }
    h
}

/// The lazy DFA's cache of states, kept between searches of one program.
#[derive(Default)]
pub(crate) struct Dfa {
    states: Vec<State>,
    /// The bytes the states hold, their transitions included.
    state_bytes: usize,
    /// State ids, open-addressed by the hash of their instructions; its length is
    /// `index_len` of the state count.
    index: Vec<u32>,
    start: Option<u32>,
    clears: u32,
    failed: bool,
    clock: u64,
    /// Bumped whenever the cache is cleared: a transition being built across a clear is not
    /// recorded, since the state it leaves may be gone.
    generation: u64,
    /// The closure's work: a sparse set over the program and a stack.
    sparse: Vec<u32>,
    dense: Vec<u32>,
    stack: Vec<u32>,
    #[cfg(test)]
    pub(crate) peak: usize,
}

/// How many slots the index has for `states` states: at least twice as many, a power of two.
fn index_len(states: usize) -> usize {
    (states * 2).next_power_of_two().max(16)
}

/// The bytes a cache of `states` states holding `state_bytes` holds, the index included.
fn held(states: usize, state_bytes: usize) -> usize {
    state_bytes + index_len(states) * size_of::<u32>()
}

impl Dfa {
    /// re2js's `DFA.match`, unanchored from `pos`: whether the program matches, or nothing
    /// when the DFA declines.
    pub(crate) fn matches(&mut self, prog: &Prog, text: &str, pos: usize, visits: &mut u64) -> Option<bool> {
        if self.failed {
            return None;
        }
        let start = match self.start {
            Some(start) => start,
            None => {
                let start = self.state_of(prog, &[prog.start], visits)?;
                self.start = Some(start);
                start
            }
        };
        let mut current = start;
        if self.states[current as usize].is_match {
            return Some(true);
        }
        for rune in text[pos..].chars() {
            let r = u32::from(rune);
            let cached = self.states[current as usize].transition(r);
            current = if cached != UNBUILT {
                *visits += 1;
                cached
            } else {
                self.step(prog, current, r, visits)?
            };
            self.clock += 1;
            let state = &mut self.states[current as usize];
            state.last_seen = self.clock;
            if state.is_match {
                return Some(true);
            }
        }
        Some(false)
    }

    /// re2js's `DFA.step`: the state `current` reaches over `r`, the program's start added.
    /// The transition is recorded when the budget has room for it.
    fn step(&mut self, prog: &Prog, current: u32, r: u32, visits: &mut u64) -> Option<u32> {
        let mut next = Vec::new();
        for &pc in self.states[current as usize].pcs.iter() {
            *visits += 1;
            let inst = prog.insts[pc as usize];
            if is_rune(inst.op) && prog.rune_matches(inst, r) {
                next.push(inst.out);
            }
        }
        next.push(prog.start);
        let generation = self.generation;
        let reached = self.state_of(prog, &next, visits)?;
        if self.generation == generation {
            let state = &self.states[current as usize];
            let growth = state.growth(r);
            if held(self.states.len(), self.state_bytes + growth) <= DFA_BUDGET {
                self.states[current as usize].record(r, reached);
                self.state_bytes += growth;
                self.note_peak();
            }
        }
        Some(reached)
    }

    /// re2js's `DFA.getState`: the state whose instructions are the closure of `pcs`, built
    /// when the cache holds none.
    fn state_of(&mut self, prog: &Prog, pcs: &[u32], visits: &mut u64) -> Option<u32> {
        let (closure, is_match) = self.closure(prog, pcs, visits)?;
        let hash = hash_pcs(&closure);
        if let Some(id) = self.find(hash, &closure) {
            self.clock += 1;
            self.states[id as usize].last_seen = self.clock;
            return Some(id);
        }
        if self.failed {
            return None;
        }
        let mut state = State {
            pcs: closure.into_boxed_slice(),
            is_match,
            latin1: Box::new([UNBUILT; LATIN1]),
            beyond: Vec::new(),
            beyond_len: 0,
            last_seen: 0,
        };
        let bytes = state.bytes();
        if held(1, bytes) > DFA_BUDGET {
            self.fail();
            return None;
        }
        if held(self.states.len() + 1, self.state_bytes + bytes) > DFA_BUDGET {
            self.clears += 1;
            if self.clears >= MAX_CACHE_CLEARS {
                self.fail();
                return None;
            }
            self.evict(bytes);
        }
        self.clock += 1;
        state.last_seen = self.clock;
        let id = self.states.len() as u32;
        self.state_bytes += bytes;
        self.states.push(state);
        self.index_state(hash, id);
        self.note_peak();
        Some(id)
    }

    /// The sorted closure of `pcs` and whether it holds a match, or nothing when it reaches
    /// an empty-width instruction.
    fn closure(&mut self, prog: &Prog, pcs: &[u32], visits: &mut u64) -> Option<(Vec<u32>, bool)> {
        if self.sparse.len() != prog.insts.len() {
            self.sparse = vec![0; prog.insts.len()];
        }
        self.dense.clear();
        self.stack.clear();
        self.stack.extend_from_slice(pcs);
        let mut is_match = false;
        while let Some(pc) = self.stack.pop() {
            let at = self.sparse[pc as usize] as usize;
            if at < self.dense.len() && self.dense[at] == pc {
                continue;
            }
            self.sparse[pc as usize] = self.dense.len() as u32;
            self.dense.push(pc);
            *visits += 1;
            let inst = prog.insts[pc as usize];
            match inst.op {
                InstOp::Match => is_match = true,
                InstOp::Alt => {
                    self.stack.push(inst.out);
                    self.stack.push(inst.arg);
                }
                InstOp::Nop | InstOp::Capture => self.stack.push(inst.out),
                InstOp::EmptyWidth => return None,
                InstOp::Fail | InstOp::Rune | InstOp::RuneFold | InstOp::Rune1 | InstOp::RuneAny | InstOp::RuneAnyNotNl => {}
            }
        }
        let mut closure = self.dense.clone();
        closure.sort_unstable();
        Some((closure, is_match))
    }

    fn find(&self, hash: u32, pcs: &[u32]) -> Option<u32> {
        if self.index.is_empty() {
            return None;
        }
        let mask = self.index.len() - 1;
        let mut slot = hash as usize & mask;
        loop {
            let id = self.index[slot];
            if id == UNBUILT {
                return None;
            }
            if *self.states[id as usize].pcs == *pcs {
                return Some(id);
            }
            slot = (slot + 1) & mask;
        }
    }

    /// Adds the state `id`, the last one, to the index, rebuilding the index at the length
    /// the state count calls for.
    fn index_state(&mut self, hash: u32, id: u32) {
        let wanted = index_len(self.states.len());
        if self.index.len() != wanted {
            self.index = vec![UNBUILT; wanted];
            for other in 0..id {
                self.place(hash_pcs(&self.states[other as usize].pcs), other);
            }
        }
        self.place(hash, id);
    }

    fn place(&mut self, hash: u32, id: u32) {
        let mask = self.index.len() - 1;
        let mut slot = hash as usize & mask;
        while self.index[slot] != UNBUILT {
            slot = (slot + 1) & mask;
        }
        self.index[slot] = id;
    }

    /// re2js's `evictCache`: keeps the states used most recently, their transitions
    /// forgotten, within half the budget and leaving room for a new state of `incoming`
    /// bytes.
    fn evict(&mut self, incoming: usize) {
        let start_pcs = self.start.map(|start| self.states[start as usize].pcs.clone());
        let mut states = std::mem::take(&mut self.states);
        states.sort_by_key(|state| std::cmp::Reverse(state.last_seen));
        let mut kept = Vec::new();
        let mut kept_bytes = 0;
        for mut state in states {
            state.forget_transitions();
            let bytes = state.bytes();
            let count = kept.len() + 1;
            if held(count, kept_bytes + bytes) > DFA_BUDGET / 2
                || held(count + 1, kept_bytes + bytes + incoming) > DFA_BUDGET
            {
                break;
            }
            kept_bytes += bytes;
            kept.push(state);
        }
        self.generation += 1;
        self.state_bytes = kept_bytes;
        self.index = vec![UNBUILT; index_len(kept.len())];
        self.states = kept;
        for id in 0..self.states.len() as u32 {
            self.place(hash_pcs(&self.states[id as usize].pcs), id);
        }
        self.start = start_pcs.and_then(|pcs| self.find(hash_pcs(&pcs), &pcs));
    }

    fn fail(&mut self) {
        self.failed = true;
        self.states = Vec::new();
        self.state_bytes = 0;
        self.index = Vec::new();
        self.start = None;
        self.generation += 1;
    }

    fn note_peak(&mut self) {
        #[cfg(test)]
        {
            self.peak = self.peak.max(held(self.states.len(), self.state_bytes));
        }
    }

    #[cfg(test)]
    pub(crate) fn clears(&self) -> u32 {
        self.clears
    }

    #[cfg(test)]
    pub(crate) fn failed(&self) -> bool {
        self.failed
    }
}

fn is_rune(op: InstOp) -> bool {
    matches!(op, InstOp::Rune | InstOp::RuneFold | InstOp::Rune1 | InstOp::RuneAny | InstOp::RuneAnyNotNl)
}
