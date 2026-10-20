//! The machine an RE2 program runs on. No Node twin: Node runs a program on re2js 2.8.3's
//! `Machine`, a file of a dependency.
//!
//! This is that machine, twinned: a Pike VM over the text's code points, one run queue per
//! position, each instruction added to a queue at most once (a sparse set), threads kept in
//! priority order so the first to match wins — leftmost-first, a non-greedy operator
//! preferring to leave — and the lower-priority threads cut when one matches. A capture
//! instruction writes the thread's own slots, held only while the thread lives and only
//! when groups are asked for; an empty-width instruction holds when the
//! context of its position allows it: the text's ends, a line feed either side, and an ASCII
//! word character on exactly one side (`\b`) or on both or neither (`\B`).
//!
//! re2js adds a target's epsilon closure recursively; here it is a heap stack, pushed so the
//! first branch of an alternation is finished before the second, with a capture's previous
//! slot value restored once everything reached through it has been added. A search is
//! therefore O(|program| × (n + 1)) instruction visits for a text of n code points, each
//! class test a binary search; `visits` counts them.
//!
//! Positions are byte offsets into UTF-8 text, where re2js's are UTF-16 code units: the same
//! code points are stepped over, and the context of a position reads the same characters.
//!
//! Not twinned: re2js's anchored modes, its longest-match mode, its set matching and its
//! lookbehind tables — none is reachable from CEL — and the literal-prefix skip it takes
//! when its run queue empties, which only skips positions where no match can start.

use crate::re2_program::{
    InstOp, Prog, EMPTY_BEGIN_LINE, EMPTY_BEGIN_TEXT, EMPTY_END_LINE, EMPTY_END_TEXT, EMPTY_NO_WORD_BOUNDARY,
    EMPTY_WORD_BOUNDARY,
};
use crate::re2_syntax::equals_ignore_case;

/// A capture slot nothing wrote.
const UNSET: usize = usize::MAX;

/// A queue entry with no thread at it.
const NO_THREAD: u32 = u32::MAX;

/// re2js's `Queue`: a sparse set of program counters in the order they were added, each
/// with the thread at it, if any.
struct Queue {
    sparse: Vec<u32>,
    dense: Vec<u32>,
    thread: Vec<u32>,
    size: usize,
}

impl Queue {
    fn new(instructions: usize) -> Self {
        Self { sparse: vec![0; instructions], dense: vec![0; instructions], thread: vec![NO_THREAD; instructions], size: 0 }
    }

    fn contains(&self, pc: u32) -> bool {
        let j = self.sparse[pc as usize] as usize;
        j < self.size && self.dense[j] == pc
    }

    fn add(&mut self, pc: u32) -> usize {
        let j = self.size;
        self.size += 1;
        self.sparse[pc as usize] = j as u32;
        self.dense[j] = pc;
        self.thread[j] = NO_THREAD;
        j
    }
}

/// re2js's thread pool: each live thread's capture slots, allocated when a thread is and
/// returned when it ends, so slots are held for live threads only.
struct Threads {
    ncap: usize,
    caps: Vec<usize>,
    free: Vec<u32>,
    allocated: u32,
}

impl Threads {
    fn reset(&mut self, ncap: usize) {
        self.ncap = ncap;
        self.free.clear();
        self.allocated = 0;
    }

    fn alloc(&mut self, cap: &[usize]) -> u32 {
        let id = match self.free.pop() {
            Some(id) => id,
            None => {
                let id = self.allocated;
                self.allocated += 1;
                let end = self.allocated as usize * self.ncap;
                if self.caps.len() < end {
                    self.caps.resize(end, UNSET);
                }
                id
            }
        };
        let ncap = self.ncap;
        self.slots_mut(id).copy_from_slice(&cap[..ncap]);
        id
    }

    fn slots(&self, id: u32) -> &[usize] {
        let at = id as usize * self.ncap;
        &self.caps[at..at + self.ncap]
    }

    fn slots_mut(&mut self, id: u32) -> &mut [usize] {
        let at = id as usize * self.ncap;
        &mut self.caps[at..at + self.ncap]
    }

    /// Ends every thread of `q` from entry `from` on, and empties `q` when `from` is zero.
    fn free_queue(&mut self, q: &mut Queue, from: usize) {
        for j in from..q.size {
            let id = q.thread[j];
            if id != NO_THREAD {
                self.free.push(id);
                q.thread[j] = NO_THREAD;
            }
        }
        if from == 0 {
            q.size = 0;
        }
    }
}

/// A step of the epsilon closure still to take.
enum Closure {
    Explore(u32),
    /// Put a capture slot back once everything reached through its capture was added.
    Restore(usize, usize),
}

/// The working state of one search, kept between searches of one program.
pub(crate) struct Machine {
    q0: Queue,
    q1: Queue,
    threads: Threads,
    matched: bool,
    matchcap: Vec<usize>,
    scratch: Vec<usize>,
    closure: Vec<Closure>,
    visits: u64,
}

/// re2js's `Utils.isWordRune`: an ASCII letter, digit or underscore.
fn is_word(r: Option<char>) -> bool {
    matches!(r, Some(c) if c.is_ascii_alphanumeric() || c == '_')
}

/// re2js's `Utils.emptyOpContext`: the conditions that hold between `before` and `after`.
fn empty_op_context(before: Option<char>, after: Option<char>) -> u32 {
    let mut op = 0;
    match before {
        None => op |= EMPTY_BEGIN_TEXT | EMPTY_BEGIN_LINE,
        Some('\n') => op |= EMPTY_BEGIN_LINE,
        Some(_) => {}
    }
    match after {
        None => op |= EMPTY_END_TEXT | EMPTY_END_LINE,
        Some('\n') => op |= EMPTY_END_LINE,
        Some(_) => {}
    }
    if is_word(before) != is_word(after) {
        op |= EMPTY_WORD_BOUNDARY;
    } else {
        op |= EMPTY_NO_WORD_BOUNDARY;
    }
    op
}

fn context(text: &str, pos: usize) -> u32 {
    empty_op_context(text[..pos].chars().next_back(), text[pos..].chars().next())
}

/// The code point at `pos` and its width, or nothing and no width at the end.
fn step_at(text: &str, pos: usize) -> (Option<char>, usize) {
    match text[pos..].chars().next() {
        Some(c) => (Some(c), c.len_utf8()),
        None => (None, 0),
    }
}

impl Machine {
    pub(crate) fn new(prog: &Prog) -> Self {
        Self {
            q0: Queue::new(prog.insts.len()),
            q1: Queue::new(prog.insts.len()),
            threads: Threads { ncap: 0, caps: Vec::new(), free: Vec::new(), allocated: 0 },
            matched: false,
            matchcap: Vec::new(),
            scratch: Vec::new(),
            closure: Vec::new(),
            visits: 0,
        }
    }

    pub(crate) fn visits(&self) -> u64 {
        self.visits
    }

    /// re2js's `Machine.match`, unanchored from `start`: the first `ncap` capture slots of
    /// the match, or nothing.
    pub(crate) fn find(&mut self, prog: &Prog, text: &str, start: usize, ncap: usize) -> Option<Vec<Option<usize>>> {
        self.visits = 0;
        let slots = ncap.max(prog.num_cap).max(2);
        self.matchcap.clear();
        self.matchcap.resize(slots, UNSET);
        self.scratch.clear();
        self.scratch.resize(slots, UNSET);
        self.q0.size = 0;
        self.q1.size = 0;
        self.threads.reset(ncap);
        let start_cond = prog.start_cond?;
        self.matched = false;

        let mut pos = start;
        let (mut rune, mut width) = step_at(text, pos);
        let (mut rune1, mut width1) = (None, 0);
        if rune.is_some() {
            (rune1, width1) = step_at(text, pos + width);
        }
        let mut flag = if pos == 0 { empty_op_context(None, rune) } else { context(text, pos) };
        let mut run_is_q0 = true;
        loop {
            let (runq, nextq) = if run_is_q0 { (&mut self.q0, &mut self.q1) } else { (&mut self.q1, &mut self.q0) };
            if runq.size == 0 {
                if start_cond & EMPTY_BEGIN_TEXT != 0 && pos != 0 {
                    break;
                }
                if self.matched {
                    break;
                }
            }
            if !self.matched {
                if ncap > 0 {
                    self.matchcap[0] = pos;
                }
                add(prog, runq, &mut self.threads, &mut self.closure, &mut self.visits, prog.start, pos, &mut self.matchcap, flag);
            }
            let next_pos = pos + width;
            flag = context(text, next_pos);
            step(
                prog,
                runq,
                nextq,
                &mut self.threads,
                &mut self.closure,
                &mut self.visits,
                &mut self.scratch,
                &mut self.matchcap,
                &mut self.matched,
                pos,
                next_pos,
                rune,
                flag,
            );
            if width == 0 {
                break;
            }
            if ncap == 0 && self.matched {
                break;
            }
            pos += width;
            rune = rune1;
            width = width1;
            if rune.is_some() {
                (rune1, width1) = step_at(text, pos + width);
            }
            run_is_q0 = !run_is_q0;
        }
        self.threads.free_queue(&mut self.q0, 0);
        self.threads.free_queue(&mut self.q1, 0);
        self.matched
            .then(|| self.matchcap[..ncap].iter().map(|&slot| (slot != UNSET).then_some(slot)).collect())
    }
}

/// re2js's `Machine.step`: every thread of `runq`, in priority order, against the code point
/// at `pos`.
#[allow(clippy::too_many_arguments)]
fn step(
    prog: &Prog,
    runq: &mut Queue,
    nextq: &mut Queue,
    threads: &mut Threads,
    closure: &mut Vec<Closure>,
    visits: &mut u64,
    scratch: &mut [usize],
    matchcap: &mut [usize],
    matched: &mut bool,
    pos: usize,
    next_pos: usize,
    c: Option<char>,
    next_cond: u32,
) {
    let ncap = threads.ncap;
    let mut j = 0;
    while j < runq.size {
        let id = runq.thread[j];
        if id == NO_THREAD {
            j += 1;
            continue;
        }
        let inst = prog.insts[runq.dense[j] as usize];
        let r = c.map(|c| c as u32);
        let follows = match inst.op {
            InstOp::Match => {
                if ncap > 0 {
                    threads.slots_mut(id)[1] = pos;
                    matchcap[..ncap].copy_from_slice(threads.slots(id));
                }
                threads.free_queue(runq, j + 1);
                *matched = true;
                false
            }
            InstOp::Rune => r.is_some_and(|r| prog.class_matches(inst.arg, r)),
            InstOp::RuneFold => r.is_some_and(|r| equals_ignore_case(inst.arg, r)),
            InstOp::Rune1 => r == Some(inst.arg),
            InstOp::RuneAny => true,
            InstOp::RuneAnyNotNl => c != Some('\n'),
            other => unreachable!("a thread stands only at a match or a rune instruction, not at {other:?}"),
        };
        if follows {
            scratch[..ncap].copy_from_slice(threads.slots(id));
            add(prog, nextq, threads, closure, visits, inst.out, next_pos, scratch, next_cond);
        }
        threads.free.push(id);
        runq.thread[j] = NO_THREAD;
        j += 1;
    }
    runq.size = 0;
}

/// re2js's `Machine.add`: `pc` and everything its empty transitions reach under `cond`,
/// each added to `q` once, a thread holding a copy of `cap` left at each rune and match
/// instruction.
#[allow(clippy::too_many_arguments)]
fn add(
    prog: &Prog,
    q: &mut Queue,
    threads: &mut Threads,
    closure: &mut Vec<Closure>,
    visits: &mut u64,
    pc: u32,
    pos: usize,
    cap: &mut [usize],
    cond: u32,
) {
    let ncap = threads.ncap;
    closure.push(Closure::Explore(pc));
    while let Some(next) = closure.pop() {
        let mut pc = match next {
            Closure::Restore(slot, value) => {
                cap[slot] = value;
                continue;
            }
            Closure::Explore(pc) => pc,
        };
        loop {
            if pc == 0 || q.contains(pc) {
                break;
            }
            let d = q.add(pc);
            *visits += 1;
            let inst = prog.insts[pc as usize];
            match inst.op {
                InstOp::Fail => break,
                InstOp::Alt => {
                    closure.push(Closure::Explore(inst.arg));
                    pc = inst.out;
                }
                InstOp::EmptyWidth => {
                    if inst.arg & !cond != 0 {
                        break;
                    }
                    pc = inst.out;
                }
                InstOp::Nop => pc = inst.out,
                InstOp::Capture => {
                    let slot = inst.arg as usize;
                    if slot < ncap {
                        closure.push(Closure::Restore(slot, cap[slot]));
                        cap[slot] = pos;
                    }
                    pc = inst.out;
                }
                InstOp::Match
                | InstOp::Rune
                | InstOp::RuneFold
                | InstOp::Rune1
                | InstOp::RuneAny
                | InstOp::RuneAnyNotNl => {
                    q.thread[d] = threads.alloc(cap);
                    break;
                }
            }
        }
    }
}
