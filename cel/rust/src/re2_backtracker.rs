//! The bit-state backtracker. No Node twin: this is the role of re2js 2.8.3's `Backtracker`
//! and `BitState`, files of a dependency.
//!
//! This is those, twinned: a depth-first search of the program in priority order — an
//! alternation's first branch before its second — from each start position in turn, that
//! visits each (instruction, position) pair at most once over the whole search, remembered
//! in one bit each. The first match found is the leftmost-first match the Machine finds. A
//! capture is undone when the search backs out of it. A start position is skipped to the
//! program's literal prefix when it has one.
//!
//! It runs when the program holds at most 500 instructions and the text is at most
//! 262,144 / |program| bytes long, so the visited bits never exceed 262,144 plus one row,
//! and `visits` counts each pair marked: at most |program| × (n + 1). re2js measures the
//! text in UTF-16 code units; here it is bytes, a cost difference only.

use crate::re2_machine::{context, step_at, UNSET};
use crate::re2_program::{InstOp, Prog, Re2Literal, Slots, EMPTY_BEGIN_TEXT};

const MAX_BACKTRACK_PROG: usize = 500;
const MAX_BACKTRACK_VECTOR: usize = 256 * 1024;

/// re2js's `Backtracker.maxBitStateLen`: the longest text the backtracker takes.
pub(crate) fn max_bit_state_len(prog: &Prog) -> usize {
    if prog.insts.len() > MAX_BACKTRACK_PROG {
        return 0;
    }
    MAX_BACKTRACK_VECTOR / prog.insts.len()
}

/// A step still to take: at `pc` and `pos`, or with `arg` set, the second half of an
/// alternation or a capture to restore to `pos`.
#[derive(Clone, Copy)]
struct Job {
    pc: u32,
    arg: bool,
    pos: usize,
}

/// re2js's `BitState`: the visited bits, the job stack and the capture slots, kept between
/// searches.
#[derive(Default)]
pub(crate) struct BitState {
    end: usize,
    visited: Vec<u32>,
    jobs: Vec<Job>,
    ncap: usize,
    cap: Vec<usize>,
    matchcap: Vec<usize>,
}

impl BitState {
    fn reset(&mut self, prog: &Prog, end: usize, ncap: usize) {
        self.end = end;
        self.jobs.clear();
        self.ncap = ncap;
        let words = (prog.insts.len() * (end + 1)).div_ceil(32);
        self.visited.clear();
        self.visited.resize(words, 0);
        self.cap.clear();
        self.cap.resize(ncap, UNSET);
        self.matchcap.clear();
        self.matchcap.resize(ncap, UNSET);
    }

    fn should_visit(&mut self, pc: u32, pos: usize, visits: &mut u64) -> bool {
        let n = pc as usize * (self.end + 1) + pos;
        let (word, bit) = (n >> 5, 1u32 << (n & 31));
        if self.visited[word] & bit != 0 {
            return false;
        }
        self.visited[word] |= bit;
        *visits += 1;
        true
    }

    fn push(&mut self, prog: &Prog, pc: u32, pos: usize, arg: bool, visits: &mut u64) {
        if prog.insts[pc as usize].op != InstOp::Fail && (arg || self.should_visit(pc, pos, visits)) {
            self.jobs.push(Job { pc, arg, pos });
        }
    }

    /// re2js's `BitState.tryBacktrack`, leftmost-first, unanchored at its end.
    fn try_backtrack(&mut self, prog: &Prog, text: &str, pc: u32, pos: usize, visits: &mut u64) -> bool {
        self.push(prog, pc, pos, false, visits);
        while let Some(job) = self.jobs.pop() {
            let Job { mut pc, mut arg, mut pos } = job;
            let mut skip_should_visit = true;
            loop {
                if !skip_should_visit && !self.should_visit(pc, pos, visits) {
                    break;
                }
                skip_should_visit = false;
                let inst = prog.insts[pc as usize];
                match inst.op {
                    InstOp::Fail => unreachable!("no instruction leads to the program's failure"),
                    InstOp::Alt => {
                        if arg {
                            arg = false;
                            pc = inst.arg;
                        } else {
                            self.push(prog, pc, pos, true, visits);
                            pc = inst.out;
                        }
                    }
                    InstOp::Rune | InstOp::RuneFold | InstOp::Rune1 | InstOp::RuneAny | InstOp::RuneAnyNotNl => {
                        let (rune, width) = step_at(text, pos);
                        match rune {
                            Some(rune) if prog.rune_matches(inst, u32::from(rune)) => {
                                pos += width;
                                pc = inst.out;
                            }
                            _ => break,
                        }
                    }
                    InstOp::Capture => {
                        if arg {
                            self.cap[inst.arg as usize] = pos;
                            break;
                        }
                        if (inst.arg as usize) < self.ncap {
                            let previous = self.cap[inst.arg as usize];
                            self.push(prog, pc, previous, true, visits);
                            self.cap[inst.arg as usize] = pos;
                        }
                        pc = inst.out;
                    }
                    InstOp::EmptyWidth => {
                        if inst.arg & !context(text, pos) != 0 {
                            break;
                        }
                        pc = inst.out;
                    }
                    InstOp::Nop => pc = inst.out,
                    InstOp::Match => {
                        if self.ncap == 0 {
                            return true;
                        }
                        if self.ncap > 1 {
                            self.cap[1] = pos;
                        }
                        if self.matchcap[1] == UNSET {
                            self.matchcap.copy_from_slice(&self.cap);
                        }
                        return true;
                    }
                }
            }
        }
        false
    }

    /// re2js's `Backtracker.execute`, unanchored from `pos`: the first `ncap` slots of the
    /// leftmost-first match, or nothing.
    pub(crate) fn execute(
        &mut self,
        prog: &Prog,
        text: &str,
        mut pos: usize,
        ncap: usize,
        prefix: &Re2Literal,
        visits: &mut u64,
    ) -> Option<Slots> {
        let start_cond = prog.start_cond?;
        if start_cond & EMPTY_BEGIN_TEXT != 0 && pos != 0 {
            return None;
        }
        let end = text.len();
        self.reset(prog, end, ncap);
        let mut matched = false;
        if start_cond & EMPTY_BEGIN_TEXT != 0 {
            if self.ncap > 0 {
                self.cap[0] = pos;
            }
            matched = self.try_backtrack(prog, text, prog.start, pos, visits);
        } else {
            let mut width = None;
            while pos <= end && width != Some(0) {
                if prefix.len() > 0 {
                    let Some(advance) = prefix.find(text, pos) else {
                        break;
                    };
                    pos += advance;
                }
                if self.ncap > 0 {
                    self.cap[0] = pos;
                }
                if self.try_backtrack(prog, text, prog.start, pos, visits) {
                    matched = true;
                    break;
                }
                let step = step_at(text, pos).1;
                width = Some(step);
                pos += step;
            }
        }
        matched.then(|| self.matchcap.iter().map(|&slot| (slot != UNSET).then_some(slot)).collect())
    }
}
