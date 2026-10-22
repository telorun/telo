//! OnePass: a program anchored at the text's start that never has two live choices. No
//! Node twin: this is the role of re2js 2.8.3's `OnePass`, `OnePassProg` and
//! `QueueOnePass`, files of a dependency.
//!
//! This is those, twinned. A program qualifies when it begins with `^` at the text's start,
//! holds fewer than 1,000 instructions, passes re2js's checks on the instructions that lead
//! to its match, and survives re2js's rewriting of nested alternations and its merge: each
//! alternation is given the code points each branch can begin with, which must not overlap,
//! and a branch that can match without reading is moved first. A search then follows one
//! path, choosing an alternation's branch by the code point at hand, and writes captures as
//! it goes: one step per position, which is what `visits` counts.
//!
//! re2js checks a program recursively; here the check runs on a heap stack, so a program's
//! depth costs no stack. An alternation's code points are kept per alternation; the other
//! instructions are read from the program itself, which re2js's copy restores them to.
//!
//! The form has a budget of 8,388,608 bytes, the engine's own: re2js has none, and an
//! alternation holds the code points of every branch beneath it, so a chain of large
//! disjoint classes would grow with branches × class sizes. The copied instructions are
//! charged first, then each alternation's merge, at 12 bytes per range, before it allocates;
//! a program whose form would pass the budget is declined there, and the backtracker or the
//! Machine answers it.

use std::mem::size_of;
use std::sync::Arc;

use crate::re2_machine::{context, empty_op_context, step_at, UNSET};
use crate::re2_program::{Inst, InstOp, Prog, Slots, EMPTY_BEGIN_TEXT, EMPTY_END_TEXT};
use crate::re2_syntax::{simple_fold, MAX_RUNE};

/// re2js's bound on the program a OnePass copy is made of.
const MAX_ONEPASS_PROG: usize = 1000;

/// The bytes a OnePass form may hold; re2js has no such bound.
const ONEPASS_BUDGET: usize = 8_388_608;

/// One merged range: its two bounds and the branch it chooses.
const MERGED_RANGE_BYTES: usize = 3 * size_of::<u32>();

/// An alternation as OnePass runs it.
#[derive(Clone, Default)]
struct Alternation {
    /// re2js's `ALT_MATCH`: the branch at `out` matches without reading, and is taken when
    /// no code point chooses.
    matches_empty: bool,
    /// The code points each branch begins with, as sorted, disjoint ranges.
    runes: Arc<[u32]>,
    /// For each range of `runes`, the branch it chooses.
    next: Box<[u32]>,
}

/// A program OnePass runs: the program's instructions, with its alternations rewritten, and
/// what each alternation chooses by, at the alternation's own index.
pub(crate) struct OnePassProg {
    start: u32,
    insts: Vec<Inst>,
    alternations: Vec<Alternation>,
}

/// re2js's `QueueOnePass`: a sparse set kept in insertion order, read from the front.
struct OnePassQueue {
    sparse: Vec<u32>,
    dense: Vec<u32>,
    next: usize,
}

impl OnePassQueue {
    fn new(size: usize) -> Self {
        Self { sparse: vec![0; size], dense: Vec::with_capacity(size), next: 0 }
    }

    fn is_empty(&self) -> bool {
        self.next >= self.dense.len()
    }

    fn take(&mut self) -> u32 {
        self.next += 1;
        self.dense[self.next - 1]
    }

    fn clear(&mut self) {
        self.dense.clear();
        self.next = 0;
    }

    fn contains(&self, u: u32) -> bool {
        let u = u as usize;
        u < self.sparse.len() && (self.sparse[u] as usize) < self.dense.len() && self.dense[self.sparse[u] as usize] == u as u32
    }

    fn insert(&mut self, u: u32) {
        if !self.contains(u) && (u as usize) < self.sparse.len() {
            self.sparse[u as usize] = self.dense.len() as u32;
            self.dense.push(u);
        }
    }
}

/// re2js's `mergeRuneSets`: the two branches' ranges in order with the branch each chooses,
/// or nothing when they overlap.
fn merge_rune_sets(left: &[u32], right: &[u32], left_pc: u32, right_pc: u32) -> Option<(Vec<u32>, Vec<u32>)> {
    let (mut lx, mut rx) = (0, 0);
    let mut merged: Vec<u32> = Vec::with_capacity(left.len() + right.len());
    let mut next = Vec::with_capacity((left.len() + right.len()) / 2);
    while lx < left.len() || rx < right.len() {
        let take_left = if rx >= right.len() {
            true
        } else if lx >= left.len() {
            false
        } else {
            right[rx] >= left[lx]
        };
        let (runes, low, pc) = if take_left { (left, lx, left_pc) } else { (right, rx, right_pc) };
        if !merged.is_empty() && runes[low] <= merged[merged.len() - 1] {
            return None;
        }
        merged.extend_from_slice(&runes[low..low + 2]);
        if take_left {
            lx += 2;
        } else {
            rx += 2;
        }
        next.push(pc);
    }
    Some((merged, next))
}

/// re2js's `Inst.matchRunePos` over sorted ranges: the index of the range holding `r`.
fn match_rune_pos(runes: &[u32], r: u32) -> Option<usize> {
    let len = runes.len();
    if len == 0 {
        return None;
    }
    if matches!(len, 2 | 4 | 6 | 8) {
        for j in (0..len).step_by(2) {
            if r < runes[j] {
                return None;
            }
            if r <= runes[j + 1] {
                return Some(j / 2);
            }
        }
        return None;
    }
    let mut base = 0usize;
    let mut n = len >> 1;
    while n > 1 {
        let half = n >> 1;
        if runes[(base + half) << 1] <= r {
            base += half;
        }
        n -= half;
    }
    if runes[base << 1] <= r {
        base += 1;
    }
    (base >= 1 && r <= runes[((base - 1) << 1) | 1]).then(|| base - 1)
}

/// The code points a rune instruction reads, as re2js's OnePass writes them.
fn rune_ranges(prog: &Prog, inst: Inst) -> Arc<[u32]> {
    match inst.op {
        InstOp::Rune => prog.classes[inst.arg as usize].clone(),
        InstOp::RuneFold => {
            let mut runes = vec![inst.arg, inst.arg];
            let mut r = simple_fold(inst.arg);
            while r != inst.arg {
                runes.extend([r, r]);
                r = simple_fold(r);
            }
            runes.sort_unstable();
            runes.into()
        }
        InstOp::Rune1 => Arc::from([inst.arg, inst.arg]),
        InstOp::RuneAny => Arc::from([0, MAX_RUNE]),
        InstOp::RuneAnyNotNl => Arc::from([0, 0x09, 0x0B, MAX_RUNE]),
        other => unreachable!("{other:?} is not a rune instruction"),
    }
}

fn is_alt(op: InstOp) -> bool {
    op == InstOp::Alt
}

/// re2js's `check` still to finish for an instruction.
enum Check {
    Enter(u32),
    /// An alternation's first branch was checked; its second is next.
    AfterOut(u32),
    /// Both branches of an alternation were checked, the first answering `ok`.
    FinishAlt(u32, bool),
    /// The one successor of a capture, an empty-width instruction or a no-op was checked.
    FinishSingle(u32),
}

impl OnePassProg {
    /// re2js's `OnePass.compile`: the OnePass form of `prog`, or nothing when it does not
    /// qualify.
    pub(crate) fn compile(prog: &Prog) -> Option<OnePassProg> {
        if prog.start == 0 {
            return None;
        }
        let start = prog.insts[prog.start as usize];
        if start.op != InstOp::EmptyWidth || start.arg & EMPTY_BEGIN_TEXT == 0 {
            return None;
        }
        let has_alt = prog.insts.iter().any(|inst| is_alt(inst.op));
        for inst in &prog.insts {
            let op_out = prog.insts[inst.out as usize].op;
            match inst.op {
                InstOp::Alt => {
                    if op_out == InstOp::Match || prog.insts[inst.arg as usize].op == InstOp::Match {
                        return None;
                    }
                }
                InstOp::EmptyWidth => {
                    if op_out == InstOp::Match {
                        if inst.arg & EMPTY_END_TEXT == EMPTY_END_TEXT {
                            continue;
                        }
                        return None;
                    }
                }
                _ => {
                    if op_out == InstOp::Match && has_alt {
                        return None;
                    }
                }
            }
        }
        // re2js's `makeOnePass` refuses this size first thing; the copy before it changes
        // nothing.
        if prog.insts.len() >= MAX_ONEPASS_PROG {
            return None;
        }
        let charged = prog.insts.len() * size_of::<Inst>();
        let mut insts = prog.insts.clone();
        one_pass_copy(&mut insts);
        make_one_pass(prog, insts, charged)
    }

    /// re2js's `OnePass.execute`, from `pos`: the first `ncap` slots of the match, or
    /// nothing.
    pub(crate) fn execute(&self, prog: &Prog, text: &str, mut pos: usize, ncap: usize, visits: &mut u64) -> Option<Slots> {
        let mut matchcap = vec![UNSET; ncap];
        let (mut rune, mut width) = step_at(text, pos);
        let (mut rune1, mut width1) = if rune.is_some() { step_at(text, pos + width) } else { (None, 0) };
        let mut flag = if pos == 0 { empty_op_context(None, rune) } else { context(text, pos) };
        let mut pc = self.start;
        *visits += 1;
        loop {
            let at = pc;
            let inst = self.insts[at as usize];
            pc = inst.out;
            let r = rune.map(u32::from);
            match inst.op {
                InstOp::Match => {
                    if ncap > 0 {
                        matchcap[0] = 0;
                        matchcap[1] = pos;
                    }
                    return Some(matchcap.iter().map(|&slot| (slot != UNSET).then_some(slot)).collect());
                }
                InstOp::Rune | InstOp::RuneFold | InstOp::Rune1 | InstOp::RuneAny | InstOp::RuneAnyNotNl => {
                    if !r.is_some_and(|r| prog.rune_matches(inst, r)) {
                        return None;
                    }
                }
                InstOp::Alt => {
                    pc = self.next(at, r);
                    continue;
                }
                InstOp::Fail => return None,
                InstOp::Nop => continue,
                InstOp::EmptyWidth => {
                    if inst.arg & !flag != 0 {
                        return None;
                    }
                    continue;
                }
                InstOp::Capture => {
                    if (inst.arg as usize) < ncap {
                        matchcap[inst.arg as usize] = pos;
                    }
                    continue;
                }
            }
            if width == 0 {
                break;
            }
            *visits += 1;
            flag = empty_op_context(rune, rune1);
            pos += width;
            rune = rune1;
            width = width1;
            if rune.is_some() {
                (rune1, width1) = step_at(text, pos + width);
            }
        }
        None
    }

    /// re2js's `OnePass.next`: the branch the alternation at `pc` takes at the code point
    /// `r`, or the failure instruction.
    fn next(&self, pc: u32, r: Option<u32>) -> u32 {
        let alternation = &self.alternations[pc as usize];
        match r.and_then(|r| match_rune_pos(&alternation.runes, r)) {
            Some(index) => alternation.next[index],
            None if alternation.matches_empty => self.insts[pc as usize].out,
            None => 0,
        }
    }
}

/// re2js's `onePassCopy`: where an alternation's branch is another alternation that loops
/// back to it, the loop is rewritten to skip the inner choice.
fn one_pass_copy(insts: &mut [Inst]) {
    fn field(inst: &Inst, out: bool) -> u32 {
        if out {
            inst.out
        } else {
            inst.arg
        }
    }
    fn set(inst: &mut Inst, out: bool, value: u32) {
        if out {
            inst.out = value;
        } else {
            inst.arg = value;
        }
    }
    for pc in 0..insts.len() {
        if !is_alt(insts[pc].op) {
            continue;
        }
        let (mut a_other, mut a_alt) = (true, false);
        let mut alt_pc = field(&insts[pc], a_alt) as usize;
        if !is_alt(insts[alt_pc].op) {
            (a_other, a_alt) = (false, true);
            alt_pc = field(&insts[pc], a_alt) as usize;
            if !is_alt(insts[alt_pc].op) {
                continue;
            }
        }
        let other_pc = field(&insts[pc], a_other) as usize;
        if is_alt(insts[other_pc].op) {
            continue;
        }
        let (mut b_alt, mut b_other) = (true, false);
        let mut patch = false;
        if insts[alt_pc].out == pc as u32 {
            patch = true;
        } else if insts[alt_pc].arg == pc as u32 {
            patch = true;
            (b_alt, b_other) = (false, true);
        }
        if patch {
            let value = field(&insts[pc], a_other);
            set(&mut insts[alt_pc], b_alt, value);
        }
        if field(&insts[pc], a_other) == field(&insts[alt_pc], b_alt) {
            let value = field(&insts[alt_pc], b_other);
            set(&mut insts[pc], a_alt, value);
        }
    }
}

/// re2js's `makeOnePass` over the rewritten copy, its recursive check on a heap stack, with
/// `charged` bytes of the budget already spent.
fn make_one_pass(prog: &Prog, mut insts: Vec<Inst>, mut charged: usize) -> Option<OnePassProg> {
    let len = insts.len();
    let mut inst_queue = OnePassQueue::new(len);
    let mut visit_queue = OnePassQueue::new(len);
    let empty: Arc<[u32]> = Arc::from([]);
    let mut runes: Vec<Arc<[u32]>> = vec![empty.clone(); len];
    let mut matches_empty = vec![false; len];
    let mut alt_match = vec![false; len];
    let mut nexts: Vec<Box<[u32]>> = vec![Box::from([]); len];
    let mut rune_done = vec![false; len];
    let mut tasks: Vec<Check> = Vec::new();
    inst_queue.insert(prog.start);
    while !inst_queue.is_empty() {
        visit_queue.clear();
        tasks.push(Check::Enter(inst_queue.take()));
        let mut ok = true;
        while let Some(task) = tasks.pop() {
            match task {
                Check::Enter(pc) => {
                    if visit_queue.contains(pc) {
                        ok = true;
                        continue;
                    }
                    visit_queue.insert(pc);
                    let inst = insts[pc as usize];
                    match inst.op {
                        InstOp::Alt => {
                            tasks.push(Check::AfterOut(pc));
                            tasks.push(Check::Enter(inst.out));
                        }
                        InstOp::Capture | InstOp::EmptyWidth | InstOp::Nop => {
                            tasks.push(Check::FinishSingle(pc));
                            tasks.push(Check::Enter(inst.out));
                        }
                        InstOp::Match | InstOp::Fail => {
                            matches_empty[pc as usize] = inst.op == InstOp::Match;
                            ok = true;
                        }
                        InstOp::Rune | InstOp::RuneFold | InstOp::Rune1 | InstOp::RuneAny | InstOp::RuneAnyNotNl => {
                            matches_empty[pc as usize] = false;
                            if !rune_done[pc as usize] {
                                inst_queue.insert(inst.out);
                                runes[pc as usize] = rune_ranges(prog, prog.insts[pc as usize]);
                                rune_done[pc as usize] = true;
                            }
                            ok = true;
                        }
                    }
                }
                Check::AfterOut(pc) => {
                    if ok {
                        tasks.push(Check::FinishAlt(pc, true));
                        tasks.push(Check::Enter(insts[pc as usize].arg));
                    } else {
                        tasks.push(Check::FinishAlt(pc, false));
                    }
                }
                Check::FinishAlt(pc, out_ok) => {
                    let both_ok = out_ok && ok;
                    let inst = &mut insts[pc as usize];
                    let (mut match_out, match_arg) = (matches_empty[inst.out as usize], matches_empty[inst.arg as usize]);
                    if match_out && match_arg {
                        ok = false;
                        continue;
                    }
                    if match_arg {
                        (inst.out, inst.arg) = (inst.arg, inst.out);
                        match_out = true;
                    }
                    if match_out {
                        matches_empty[pc as usize] = true;
                        alt_match[pc as usize] = true;
                    }
                    let (out, arg) = (inst.out, inst.arg);
                    charged += (runes[out as usize].len() + runes[arg as usize].len()) / 2 * MERGED_RANGE_BYTES;
                    if charged > ONEPASS_BUDGET {
                        return None;
                    }
                    match merge_rune_sets(&runes[out as usize], &runes[arg as usize], out, arg) {
                        None => ok = false,
                        Some((merged, next)) => {
                            runes[pc as usize] = merged.into();
                            nexts[pc as usize] = next.into();
                            ok = both_ok;
                        }
                    }
                }
                Check::FinishSingle(pc) => {
                    let out = insts[pc as usize].out as usize;
                    matches_empty[pc as usize] = matches_empty[out];
                    runes[pc as usize] = runes[out].clone();
                }
            }
        }
        if !ok {
            return None;
        }
    }
    let alternations = (0..len)
        .map(|pc| {
            if !is_alt(insts[pc].op) {
                return Alternation::default();
            }
            Alternation {
                matches_empty: alt_match[pc],
                runes: std::mem::replace(&mut runes[pc], empty.clone()),
                next: std::mem::take(&mut nexts[pc]),
            }
        })
        .collect();
    Some(OnePassProg { start: prog.start, insts, alternations })
}
