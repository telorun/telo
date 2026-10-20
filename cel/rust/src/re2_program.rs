//! A compiled RE2 pattern and how a search runs it. No Node twin: Node compiles a pattern
//! with re2js 2.8.3's `Simplify`, `Compiler` and `Prog`, and searches with its
//! `RE2.executeEngine`, files of a dependency.
//!
//! This is those, twinned: the simplifier's rewriting of counted repetition into copies,
//! optionals and plus loops; the compiler's instruction set, emitted in its order; the
//! program's start condition and its literal prefix. A character class is one instruction
//! over one shared, immutable range list — every copy a counted repetition makes of a class
//! points at the same list — so a program's memory is the instruction count RE2's size limit
//! bounds, as re2js's is. A literal folded for case keeps re2js's meaning: it matches its
//! fold orbit.
//!
//! A search picks its engine in `executeEngine`'s order: a pattern that is one literal is a
//! literal search; a text lacking a literal the pattern requires is refused at once
//! (`re2_prefilter.rs`); a program anchored at the text's start that qualifies runs on
//! OnePass (`re2_onepass.rs`); with groups asked, the backtracker (`re2_backtracker.rs`)
//! when the program and the text are small enough, the Machine (`re2_machine.rs`)
//! otherwise; with none asked, the DFA (`re2_dfa.rs`) unless it declines, then the
//! backtracker or the Machine. Every engine answers as the Machine does; the choice is cost
//! alone. The working state of every engine is pooled per program, one kept idle.
//!
//! Both compiling walks run on heap stacks, and the simplifier's answer for a subexpression
//! is remembered by node, so a subexpression shared by the copies of a repetition is
//! simplified once.
//!
//! Not twinned: lookbehind, which CEL never enables.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use crate::re2_backtracker::{max_bit_state_len, BitState};
use crate::re2_dfa::Dfa;
use crate::re2_machine::Machine;
use crate::re2_onepass::OnePassProg;
use crate::re2_prefilter::Prefilter;
use crate::re2_syntax::{
    equals_ignore_case, max_cap, parse, simple_fold, NodeId, Op, Regexp, SyntaxError, FOLD_CASE, MAX_RUNE, NON_GREEDY,
};

// ------------------------------------------------------------------- simplify

/// re2js's `Simplify.simplify1`: `op` over `sub`, unless `sub` makes it redundant.
fn simplify1(nodes: &mut Vec<Regexp>, op: Op, flags: u32, sub: NodeId, re: Option<NodeId>) -> NodeId {
    let sub_node = &nodes[sub as usize];
    if sub_node.op == Op::EmptyMatch {
        return sub;
    }
    if sub_node.op == Op::NoMatch {
        if op == Op::Plus {
            return sub;
        }
        return push_node(nodes, Regexp::new(Op::EmptyMatch));
    }
    if op == sub_node.op && flags & NON_GREEDY == sub_node.flags & NON_GREEDY {
        return sub;
    }
    if let Some(re) = re {
        let node = &nodes[re as usize];
        if node.op == op && node.flags & NON_GREEDY == flags & NON_GREEDY && node.subs[0] == sub {
            return re;
        }
    }
    let mut node = Regexp::new(op);
    node.flags = flags;
    node.subs = vec![sub];
    push_node(nodes, node)
}

fn push_node(nodes: &mut Vec<Regexp>, node: Regexp) -> NodeId {
    nodes.push(node);
    (nodes.len() - 1) as NodeId
}

fn concat_of(nodes: &mut Vec<Regexp>, subs: Vec<NodeId>) -> NodeId {
    let mut node = Regexp::new(Op::Concat);
    node.subs = subs;
    push_node(nodes, node)
}

/// A copy of `re` with `subs`, re2js's `Regexp.fromRegexp` with its runes cleared.
fn copy_with(nodes: &mut Vec<Regexp>, re: NodeId, subs: Vec<NodeId>) -> NodeId {
    let mut node = nodes[re as usize].clone();
    node.runes = Vec::new();
    node.subs = subs;
    push_node(nodes, node)
}

enum SimplifyTask {
    Visit(NodeId),
    Finish(NodeId),
    /// The answer for the first is the answer for the second.
    Alias(NodeId, NodeId),
}

/// re2js's `Simplify.simplify`, answered for `root` and every node beneath it.
fn simplify(nodes: &mut Vec<Regexp>, root: NodeId) -> NodeId {
    let mut answers: HashMap<NodeId, NodeId> = HashMap::new();
    let mut tasks = vec![SimplifyTask::Visit(root)];
    while let Some(task) = tasks.pop() {
        match task {
            SimplifyTask::Visit(id) => {
                if answers.contains_key(&id) {
                    continue;
                }
                let node = &nodes[id as usize];
                let visits = match node.op {
                    Op::Capture | Op::Concat | Op::Alternate | Op::Star | Op::Plus | Op::Quest => true,
                    Op::Repeat => !(node.min == 0 && node.max == 0),
                    _ => false,
                };
                tasks.push(SimplifyTask::Finish(id));
                if visits {
                    for &sub in node.subs.iter().rev() {
                        tasks.push(SimplifyTask::Visit(sub));
                    }
                }
            }
            SimplifyTask::Alias(id, target) => {
                let answer = answers[&target];
                answers.insert(id, answer);
            }
            SimplifyTask::Finish(id) => {
                if answers.contains_key(&id) {
                    continue;
                }
                let node = nodes[id as usize].clone();
                let answer_of = |sub: NodeId| answers[&sub];
                let answer = match node.op {
                    Op::Capture => {
                        let sub = answer_of(node.subs[0]);
                        if sub != node.subs[0] {
                            copy_with(nodes, id, vec![sub])
                        } else {
                            id
                        }
                    }
                    Op::Concat | Op::Alternate => {
                        let mut subs = Vec::with_capacity(node.subs.len());
                        let mut changed = false;
                        let mut answer = None;
                        for &sub in &node.subs {
                            let simplified = answer_of(sub);
                            if simplified != sub {
                                changed = true;
                            }
                            let inner = &nodes[simplified as usize];
                            if node.op == Op::Concat {
                                if inner.op == Op::NoMatch {
                                    answer = Some(push_node(nodes, Regexp::new(Op::NoMatch)));
                                    break;
                                }
                                if inner.op == Op::EmptyMatch {
                                    changed = true;
                                    continue;
                                }
                                if inner.op == Op::Concat {
                                    changed = true;
                                    subs.extend(inner.subs.iter().copied());
                                    continue;
                                }
                            } else {
                                if inner.op == Op::NoMatch {
                                    changed = true;
                                    continue;
                                }
                                if inner.op == Op::Alternate {
                                    changed = true;
                                    subs.extend(inner.subs.iter().copied());
                                    continue;
                                }
                            }
                            subs.push(simplified);
                        }
                        match answer {
                            Some(answer) => answer,
                            None if !changed => id,
                            None if subs.is_empty() => push_node(
                                nodes,
                                Regexp::new(if node.op == Op::Concat { Op::EmptyMatch } else { Op::NoMatch }),
                            ),
                            None if subs.len() == 1 => subs[0],
                            None => copy_with(nodes, id, subs),
                        }
                    }
                    Op::CharClass => {
                        if node.runes.is_empty() {
                            push_node(nodes, Regexp::new(Op::NoMatch))
                        } else if node.runes == [0, MAX_RUNE] {
                            push_node(nodes, Regexp::new(Op::AnyChar))
                        } else if node.runes == [0, 0x09, 0x0B, MAX_RUNE] {
                            push_node(nodes, Regexp::new(Op::AnyCharNotNl))
                        } else {
                            id
                        }
                    }
                    Op::Star | Op::Plus | Op::Quest => {
                        let sub = answer_of(node.subs[0]);
                        simplify1(nodes, node.op, node.flags, sub, Some(id))
                    }
                    Op::Repeat => {
                        if node.min == 0 && node.max == 0 {
                            push_node(nodes, Regexp::new(Op::EmptyMatch))
                        } else {
                            let sub = answer_of(node.subs[0]);
                            match repeat_expansion(nodes, &node, sub) {
                                Expansion::Done(answer) => answer,
                                Expansion::Simplify(target) => {
                                    tasks.push(SimplifyTask::Alias(id, target));
                                    tasks.push(SimplifyTask::Visit(target));
                                    continue;
                                }
                            }
                        }
                    }
                    _ => id,
                };
                answers.insert(id, answer);
            }
        }
    }
    answers[&root]
}

enum Expansion {
    Done(NodeId),
    /// The answer is this new node simplified, as re2js simplifies it again.
    Simplify(NodeId),
}

/// re2js's rewriting of `x{n,m}` into copies of `x`, with `sub` already simplified.
fn repeat_expansion(nodes: &mut Vec<Regexp>, node: &Regexp, sub: NodeId) -> Expansion {
    let (min, max, flags) = (node.min, node.max, node.flags);
    if max == -1 {
        if min == 0 {
            return Expansion::Done(simplify1(nodes, Op::Star, flags, sub, None));
        }
        if min == 1 {
            return Expansion::Done(simplify1(nodes, Op::Plus, flags, sub, None));
        }
        let mut subs = vec![sub; (min - 1) as usize];
        subs.push(simplify1(nodes, Op::Plus, flags, sub, None));
        return Expansion::Simplify(concat_of(nodes, subs));
    }
    if min == 1 && max == 1 {
        return Expansion::Done(sub);
    }
    let mut prefix = (min > 0).then(|| vec![sub; min as usize]);
    if max > min {
        let mut suffix = simplify1(nodes, Op::Quest, flags, sub, None);
        for _ in min + 1..max {
            let pair = concat_of(nodes, vec![sub, suffix]);
            suffix = simplify1(nodes, Op::Quest, flags, pair, None);
        }
        match prefix.as_mut() {
            None => return Expansion::Done(suffix),
            Some(prefix) => prefix.push(suffix),
        }
    }
    match prefix {
        Some(prefix) => Expansion::Simplify(concat_of(nodes, prefix)),
        None => Expansion::Done(push_node(nodes, Regexp::new(Op::NoMatch))),
    }
}

// ------------------------------------------------------------------- the program

/// re2js's `Inst` operators, less the lookbehind pair.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum InstOp {
    Alt,
    Capture,
    EmptyWidth,
    Fail,
    Match,
    Nop,
    /// A class: `arg` indexes the program's shared range lists.
    Rune,
    /// One code point folded for case: `arg` is the code point.
    RuneFold,
    /// One code point: `arg` is the code point.
    Rune1,
    RuneAny,
    RuneAnyNotNl,
}

/// One instruction. `out` and `arg` are re2js's two links (`arg` is also an `Alt`'s second
/// branch, a capture's slot, an empty-width condition, or the operand of a rune operator).
#[derive(Clone, Copy, Debug)]
pub(crate) struct Inst {
    pub(crate) op: InstOp,
    pub(crate) out: u32,
    pub(crate) arg: u32,
}

/// re2js's empty-width conditions.
pub(crate) const EMPTY_BEGIN_LINE: u32 = 1;
pub(crate) const EMPTY_END_LINE: u32 = 2;
pub(crate) const EMPTY_BEGIN_TEXT: u32 = 4;
pub(crate) const EMPTY_END_TEXT: u32 = 8;
pub(crate) const EMPTY_WORD_BOUNDARY: u32 = 16;
pub(crate) const EMPTY_NO_WORD_BOUNDARY: u32 = 32;

/// re2js's `Prog`.
pub(crate) struct Prog {
    pub(crate) insts: Vec<Inst>,
    pub(crate) classes: Vec<Arc<[u32]>>,
    pub(crate) start: u32,
    pub(crate) num_cap: usize,
    /// The conditions every match must begin under, or `None` when nothing can match
    /// (re2js's `EMPTY_ALL`).
    pub(crate) start_cond: Option<u32>,
}

impl Prog {
    /// re2js's `Inst.matchRune` for a class: a scan of up to four ranges, a binary search
    /// beyond.
    pub(crate) fn class_matches(&self, class: u32, r: u32) -> bool {
        let runes = &self.classes[class as usize];
        let len = runes.len();
        if len == 0 {
            return false;
        }
        if len <= 8 && len % 2 == 0 {
            for pair in runes.chunks_exact(2) {
                if r < pair[0] {
                    return false;
                }
                if r <= pair[1] {
                    return true;
                }
            }
            return false;
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
        base >= 1 && r <= runes[((base - 1) << 1) | 1]
    }

    /// Whether the rune instruction `inst` accepts the code point `r`, re2js's
    /// `Inst.matchRune` for every rune operator.
    pub(crate) fn rune_matches(&self, inst: Inst, r: u32) -> bool {
        match inst.op {
            InstOp::Rune => self.class_matches(inst.arg, r),
            InstOp::RuneFold => equals_ignore_case(inst.arg, r),
            InstOp::Rune1 => r == inst.arg,
            InstOp::RuneAny => true,
            InstOp::RuneAnyNotNl => r != u32::from('\n'),
            other => unreachable!("{other:?} is not a rune instruction"),
        }
    }

    /// The first instruction at or after `pc` that is neither a no-op nor a capture,
    /// re2js's `Prog.skipNop`.
    fn skip_nop(&self, mut pc: u32) -> u32 {
        while matches!(self.insts[pc as usize].op, InstOp::Nop | InstOp::Capture) {
            pc = self.insts[pc as usize].out;
        }
        pc
    }

    /// re2js's `Prog.prefix`: the literal every match begins with, and whether the pattern
    /// is that literal alone. `class_singles` holds the single-code-point instructions a
    /// class compiled to, which re2js keeps out of a prefix.
    fn literal_prefix(&self, class_singles: &HashSet<u32>) -> (bool, Vec<u32>) {
        let literal = |pc: u32| self.insts[pc as usize].op == InstOp::Rune1 && !class_singles.contains(&pc);
        let mut pc = self.skip_nop(self.start);
        let mut prefix = Vec::new();
        while literal(pc) {
            prefix.push(self.insts[pc as usize].arg);
            pc = self.skip_nop(self.insts[pc as usize].out);
        }
        (self.insts[pc as usize].op == InstOp::Match, prefix)
    }

    fn start_condition(&self) -> Option<u32> {
        let mut flag = 0;
        let mut pc = self.start;
        loop {
            let inst = self.insts[pc as usize];
            match inst.op {
                InstOp::EmptyWidth => flag |= inst.arg,
                InstOp::Fail => return None,
                InstOp::Capture | InstOp::Nop => {}
                _ => return Some(flag),
            }
            pc = inst.out;
        }
    }
}

#[derive(Clone, Copy)]
struct PatchList {
    head: u32,
    tail: u32,
}

const EMPTY_PATCH: PatchList = PatchList { head: 0, tail: 0 };

#[derive(Clone, Copy)]
struct Frag {
    i: u32,
    out: PatchList,
    nullable: bool,
}

struct Compiler {
    insts: Vec<Inst>,
    classes: Vec<Arc<[u32]>>,
    class_of: HashMap<NodeId, u32>,
    /// The single-code-point instructions a class compiled to.
    class_singles: HashSet<u32>,
    num_cap: usize,
}

enum CompileTask {
    Compile(NodeId),
    Ket { cap: u32, bra: Frag },
    Unary { op: Op, non_greedy: bool },
    Fold { node: NodeId, next: usize, alternate: bool },
}

impl Compiler {
    fn new_inst(&mut self, op: InstOp) -> Frag {
        self.insts.push(Inst { op, out: 0, arg: 0 });
        Frag { i: (self.insts.len() - 1) as u32, out: EMPTY_PATCH, nullable: true }
    }

    fn patch(&mut self, list: PatchList, val: u32) {
        let mut head = list.head;
        while head != 0 {
            let inst = &mut self.insts[(head >> 1) as usize];
            if head & 1 == 0 {
                head = inst.out;
                inst.out = val;
            } else {
                head = inst.arg;
                inst.arg = val;
            }
        }
    }

    fn append(&mut self, l1: PatchList, l2: PatchList) -> PatchList {
        if l1.head == 0 {
            return l2;
        }
        if l2.head == 0 {
            return l1;
        }
        let inst = &mut self.insts[(l1.tail >> 1) as usize];
        if l1.tail & 1 == 0 {
            inst.out = l2.head;
        } else {
            inst.arg = l2.head;
        }
        PatchList { head: l1.head, tail: l2.tail }
    }

    fn nop(&mut self) -> Frag {
        let mut f = self.new_inst(InstOp::Nop);
        f.out = PatchList { head: f.i << 1, tail: f.i << 1 };
        f
    }

    fn fail(&self) -> Frag {
        Frag { i: 0, out: EMPTY_PATCH, nullable: false }
    }

    fn cap(&mut self, arg: u32) -> Frag {
        let mut f = self.new_inst(InstOp::Capture);
        f.out = PatchList { head: f.i << 1, tail: f.i << 1 };
        self.insts[f.i as usize].arg = arg;
        self.num_cap = self.num_cap.max(arg as usize + 1);
        f
    }

    fn cat(&mut self, f1: Frag, f2: Frag) -> Frag {
        if f1.i == 0 || f2.i == 0 {
            return self.fail();
        }
        self.patch(f1.out, f2.i);
        Frag { i: f1.i, out: f2.out, nullable: f1.nullable && f2.nullable }
    }

    fn alt(&mut self, f1: Frag, f2: Frag) -> Frag {
        if f1.i == 0 {
            return f2;
        }
        if f2.i == 0 {
            return f1;
        }
        let mut f = self.new_inst(InstOp::Alt);
        self.insts[f.i as usize].out = f1.i;
        self.insts[f.i as usize].arg = f2.i;
        f.out = self.append(f1.out, f2.out);
        f.nullable = f1.nullable || f2.nullable;
        f
    }

    fn loop_(&mut self, f1: Frag, non_greedy: bool) -> Frag {
        let mut f = self.new_inst(InstOp::Alt);
        if non_greedy {
            self.insts[f.i as usize].arg = f1.i;
            f.out = PatchList { head: f.i << 1, tail: f.i << 1 };
        } else {
            self.insts[f.i as usize].out = f1.i;
            f.out = PatchList { head: (f.i << 1) | 1, tail: (f.i << 1) | 1 };
        }
        self.patch(f1.out, f.i);
        f
    }

    fn quest(&mut self, f1: Frag, non_greedy: bool) -> Frag {
        let mut f = self.new_inst(InstOp::Alt);
        if non_greedy {
            self.insts[f.i as usize].arg = f1.i;
            f.out = PatchList { head: f.i << 1, tail: f.i << 1 };
        } else {
            self.insts[f.i as usize].out = f1.i;
            f.out = PatchList { head: (f.i << 1) | 1, tail: (f.i << 1) | 1 };
        }
        f.out = self.append(f.out, f1.out);
        f
    }

    fn star(&mut self, f1: Frag, non_greedy: bool) -> Frag {
        if f1.nullable {
            let plus = self.plus(f1, non_greedy);
            return self.quest(plus, non_greedy);
        }
        self.loop_(f1, non_greedy)
    }

    fn plus(&mut self, f1: Frag, non_greedy: bool) -> Frag {
        let looped = self.loop_(f1, non_greedy);
        Frag { i: f1.i, out: looped.out, nullable: f1.nullable }
    }

    fn empty(&mut self, condition: u32) -> Frag {
        let mut f = self.new_inst(InstOp::EmptyWidth);
        self.insts[f.i as usize].arg = condition;
        f.out = PatchList { head: f.i << 1, tail: f.i << 1 };
        f
    }

    /// re2js's `Compiler.rune` for a single code point of a literal.
    fn single_rune(&mut self, r: u32, flags: u32) -> Frag {
        let folds = flags & FOLD_CASE != 0 && simple_fold(r) != r;
        let mut f = self.new_inst(if folds { InstOp::RuneFold } else { InstOp::Rune1 });
        f.nullable = false;
        self.insts[f.i as usize].arg = r;
        f.out = PatchList { head: f.i << 1, tail: f.i << 1 };
        f
    }

    /// re2js's `Compiler.rune` for a class, its range list shared by every copy of `node`.
    fn class_rune(&mut self, node: NodeId, runes: &[u32]) -> Frag {
        let op = if runes.len() == 2 && runes[0] == runes[1] {
            InstOp::Rune1
        } else if runes == [0, MAX_RUNE] {
            InstOp::RuneAny
        } else if runes == [0, 0x09, 0x0B, MAX_RUNE] {
            InstOp::RuneAnyNotNl
        } else {
            InstOp::Rune
        };
        let arg = match op {
            InstOp::Rune1 => runes[0],
            InstOp::Rune => match self.class_of.get(&node) {
                Some(&index) => index,
                None => {
                    let index = self.classes.len() as u32;
                    self.classes.push(Arc::from(runes));
                    self.class_of.insert(node, index);
                    index
                }
            },
            _ => 0,
        };
        let mut f = self.new_inst(op);
        f.nullable = false;
        self.insts[f.i as usize].arg = arg;
        f.out = PatchList { head: f.i << 1, tail: f.i << 1 };
        if op == InstOp::Rune1 {
            self.class_singles.insert(f.i);
        }
        f
    }

    fn any(&mut self, op: InstOp) -> Frag {
        let mut f = self.new_inst(op);
        f.nullable = false;
        f.out = PatchList { head: f.i << 1, tail: f.i << 1 };
        f
    }

    /// re2js's `Compiler.compile`, its recursion on a heap stack, its instructions in its
    /// order.
    fn compile(&mut self, nodes: &[Regexp], root: NodeId) -> Frag {
        let mut tasks = vec![CompileTask::Compile(root)];
        let mut results: Vec<Frag> = Vec::new();
        while let Some(task) = tasks.pop() {
            match task {
                CompileTask::Compile(id) => {
                    let node = &nodes[id as usize];
                    let frag = match node.op {
                        Op::NoMatch => self.fail(),
                        Op::EmptyMatch => self.nop(),
                        Op::Literal => {
                            if node.runes.is_empty() {
                                self.nop()
                            } else {
                                let mut frag: Option<Frag> = None;
                                for &r in &node.runes {
                                    let f1 = self.single_rune(r, node.flags);
                                    frag = Some(match frag {
                                        None => f1,
                                        Some(f) => self.cat(f, f1),
                                    });
                                }
                                frag.expect("a literal holds a code point")
                            }
                        }
                        Op::CharClass => self.class_rune(id, &node.runes),
                        Op::AnyCharNotNl => self.any(InstOp::RuneAnyNotNl),
                        Op::AnyChar => self.any(InstOp::RuneAny),
                        Op::BeginLine => self.empty(EMPTY_BEGIN_LINE),
                        Op::EndLine => self.empty(EMPTY_END_LINE),
                        Op::BeginText => self.empty(EMPTY_BEGIN_TEXT),
                        Op::EndText => self.empty(EMPTY_END_TEXT),
                        Op::WordBoundary => self.empty(EMPTY_WORD_BOUNDARY),
                        Op::NoWordBoundary => self.empty(EMPTY_NO_WORD_BOUNDARY),
                        Op::Capture => {
                            let bra = self.cap(node.cap << 1);
                            tasks.push(CompileTask::Ket { cap: node.cap, bra });
                            tasks.push(CompileTask::Compile(node.subs[0]));
                            continue;
                        }
                        Op::Star | Op::Plus | Op::Quest => {
                            tasks.push(CompileTask::Unary { op: node.op, non_greedy: node.flags & NON_GREEDY != 0 });
                            tasks.push(CompileTask::Compile(node.subs[0]));
                            continue;
                        }
                        Op::Concat | Op::Alternate => {
                            if node.subs.is_empty() {
                                self.nop()
                            } else {
                                tasks.push(CompileTask::Fold { node: id, next: 1, alternate: node.op == Op::Alternate });
                                tasks.push(CompileTask::Compile(node.subs[0]));
                                continue;
                            }
                        }
                        Op::Repeat | Op::LeftParen | Op::VerticalBar => {
                            unreachable!("a simplified tree holds no {:?}", node.op)
                        }
                    };
                    results.push(frag);
                }
                CompileTask::Ket { cap, bra } => {
                    let sub = results.pop().expect("the capture's subexpression compiled");
                    let ket = self.cap((cap << 1) | 1);
                    let inner = self.cat(bra, sub);
                    let frag = self.cat(inner, ket);
                    results.push(frag);
                }
                CompileTask::Unary { op, non_greedy } => {
                    let sub = results.pop().expect("the operand compiled");
                    let frag = match op {
                        Op::Star => self.star(sub, non_greedy),
                        Op::Plus => self.plus(sub, non_greedy),
                        _ => self.quest(sub, non_greedy),
                    };
                    results.push(frag);
                }
                CompileTask::Fold { node, next, alternate } => {
                    if next >= 2 {
                        let f1 = results.pop().expect("a subexpression compiled");
                        let f = results.pop().expect("the subexpressions before it compiled");
                        let combined = if alternate { self.alt(f, f1) } else { self.cat(f, f1) };
                        results.push(combined);
                    }
                    let subs = &nodes[node as usize].subs;
                    if next < subs.len() {
                        tasks.push(CompileTask::Fold { node, next: next + 1, alternate });
                        tasks.push(CompileTask::Compile(subs[next]));
                    }
                }
            }
        }
        results.pop().expect("the pattern compiled")
    }
}

// ------------------------------------------------------------------- literals

/// A literal a search looks for in a text: its code points written as UTF-8 — a surrogate
/// written as generalized UTF-8, which no text holds, so a literal holding one is never
/// found.
pub(crate) struct Re2Literal {
    bytes: Box<[u8]>,
    first: Option<u32>,
    /// Whether the bytes are UTF-8, so the literal can occur in a text at all.
    text: bool,
}

impl Re2Literal {
    pub(crate) fn from_code_points(points: &[u32]) -> Self {
        let mut bytes = Vec::with_capacity(points.len());
        for &point in points {
            match point {
                0..=0x7F => bytes.push(point as u8),
                0x80..=0x7FF => bytes.extend([0xC0 | (point >> 6) as u8, 0x80 | (point & 0x3F) as u8]),
                0x800..=0xFFFF => bytes.extend([
                    0xE0 | (point >> 12) as u8,
                    0x80 | ((point >> 6) & 0x3F) as u8,
                    0x80 | (point & 0x3F) as u8,
                ]),
                _ => bytes.extend([
                    0xF0 | (point >> 18) as u8,
                    0x80 | ((point >> 12) & 0x3F) as u8,
                    0x80 | ((point >> 6) & 0x3F) as u8,
                    0x80 | (point & 0x3F) as u8,
                ]),
            }
        }
        let text = std::str::from_utf8(&bytes).is_ok();
        Self { bytes: bytes.into_boxed_slice(), first: points.first().copied(), text }
    }

    pub(crate) fn bytes(&self) -> &[u8] {
        &self.bytes
    }

    /// The literal's first code point; nothing for the empty literal.
    pub(crate) fn first(&self) -> Option<u32> {
        self.first
    }

    pub(crate) fn len(&self) -> usize {
        self.bytes.len()
    }

    /// How many bytes past `pos` the literal next occurs in `text`, re2js's
    /// `MachineInput.index`: std's byte-level search — a scan for the code point's last
    /// byte when the literal is one code point, Two-Way otherwise.
    pub(crate) fn find(&self, text: &str, pos: usize) -> Option<usize> {
        if !self.text {
            return None;
        }
        let literal = std::str::from_utf8(&self.bytes).expect("the literal's bytes were checked as UTF-8");
        let mut points = literal.chars();
        match (points.next(), points.next()) {
            (Some(point), None) => text[pos..].find(point),
            _ => text[pos..].find(literal),
        }
    }
}

// ------------------------------------------------------------------- the public face

/// A match's place in the text: byte offsets, each on a character boundary.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Re2Span {
    pub start: usize,
    pub end: usize,
}

/// One search's answer: the spans asked for — the whole match first, then each group,
/// `None` for a group that took no part — or `None` for no match; and how many times the
/// engines that ran visited an instruction, the measure of the search's linear time.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Re2Search {
    pub groups: Option<Vec<Option<Re2Span>>>,
    pub visits: u64,
}

/// The capture slots a search answers: each a byte offset, or `None` where nothing wrote.
pub(crate) type Slots = Vec<Option<usize>>;

/// The engine that answered a search.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Engine {
    /// The pattern is one literal, searched for as text.
    Literal,
    /// The text lacks a literal the pattern requires.
    Prefilter,
    OnePass,
    Backtracker,
    Dfa,
    Machine,
}

/// The working state of every engine, kept between searches of one program; each part is
/// made the first time a search needs it.
#[derive(Default)]
pub(crate) struct SearchState {
    machine: Option<Machine>,
    dfa: Dfa,
    bits: BitState,
    /// The work of every engine that ran in the current search.
    visits: u64,
}

const IDLE_LOCK: &str = "the idle search state's lock is held only to take or return it";

/// A pattern compiled to RE2's program, ready to search any number of texts from any
/// number of threads.
pub struct Re2Program {
    pub(crate) prog: Prog,
    group_count: usize,
    named_groups: Vec<(String, usize)>,
    /// re2js's `prefix`: the literal every match begins with, possibly empty.
    prefix: Re2Literal,
    /// re2js's `prefixComplete`: the pattern is its prefix and nothing else.
    prefix_complete: bool,
    prefilter: Option<Prefilter>,
    onepass: Option<OnePassProg>,
    /// One idle search state kept for the next search; a search that finds none makes one.
    idle: Mutex<Option<Box<SearchState>>>,
}

impl std::fmt::Debug for Re2Program {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Re2Program")
            .field("instructions", &self.prog.insts.len())
            .field("group_count", &self.group_count)
            .field("named_groups", &self.named_groups)
            .finish()
    }
}

impl Re2Program {
    /// How many instructions the program holds, re2js's `numberOfInstructions`.
    pub fn instruction_count(&self) -> usize {
        self.prog.insts.len()
    }

    /// How many capture groups the pattern writes, the whole match not counted.
    pub fn group_count(&self) -> usize {
        self.group_count
    }

    /// The index of the group a name was given to.
    pub fn named_group(&self, name: &str) -> Option<usize> {
        self.named_groups.iter().find(|(entry, _)| entry == name).map(|&(_, index)| index)
    }

    /// Whether the pattern matches anywhere in `text`.
    pub fn is_match(&self, text: &str) -> bool {
        self.search(text, 0, 0).groups.is_some()
    }

    /// The leftmost-first match at or after byte `start` of `text`, with the spans of the
    /// first `groups` groups — the whole match counting as the first, and no more than the
    /// pattern has — as re2js's `matchMachineInput` answers with `ngroup` of `groups`. The
    /// text before `start` is still the context of `^`, `\b` and `\B`. With `groups` of zero
    /// only whether it matched is answered.
    ///
    /// Panics when `start` is past the text's end or not on a character boundary.
    pub fn search(&self, text: &str, start: usize, groups: usize) -> Re2Search {
        assert!(
            text.is_char_boundary(start),
            "a search starts on a character boundary within the text, and byte {start} is not one of {:?}",
            text
        );
        let groups = groups.min(self.group_count + 1);
        let idle = self.idle.lock().expect(IDLE_LOCK).take();
        let mut state = idle.unwrap_or_default();
        state.visits = 0;
        let (found, _) = self.execute(&mut state, text, start, 2 * groups);
        let visits = state.visits;
        let mut slot = self.idle.lock().expect(IDLE_LOCK);
        if slot.is_none() {
            *slot = Some(state);
        }
        drop(slot);
        let groups = found.map(|slots| {
            slots
                .chunks_exact(2)
                .map(|pair| match (pair[0], pair[1]) {
                    (Some(start), Some(end)) => Some(Re2Span { start, end }),
                    _ => None,
                })
                .collect()
        });
        Re2Search { groups, visits }
    }

    /// re2js's `RE2.executeEngine`, unanchored from `start` with `ncap` slots asked: the
    /// slots of the match, or nothing, and the engine that answered.
    pub(crate) fn execute(&self, state: &mut SearchState, text: &str, start: usize, ncap: usize) -> (Option<Slots>, Engine) {
        if self.prefix_complete && (ncap == 0 || self.group_count == 0) {
            return (self.literal_match(text, start, ncap), Engine::Literal);
        }
        if let Some(prefilter) = &self.prefilter {
            if !prefilter.passes(text, start) {
                return (None, Engine::Prefilter);
            }
        }
        if let Some(onepass) = &self.onepass {
            return (onepass.execute(&self.prog, text, start, ncap, &mut state.visits), Engine::OnePass);
        }
        let fits = text.len() <= max_bit_state_len(&self.prog);
        if ncap == 0 {
            if let Some(matched) = state.dfa.matches(&self.prog, text, start, &mut state.visits) {
                return (matched.then(Vec::new), Engine::Dfa);
            }
        }
        if fits {
            let found = state.bits.execute(&self.prog, text, start, ncap, &self.prefix, &mut state.visits);
            return (found, Engine::Backtracker);
        }
        (self.run_machine(state, text, start, ncap, &self.prefix), Engine::Machine)
    }

    /// re2js's `matchPrefixComplete`, unanchored: the prefix's next occurrence.
    fn literal_match(&self, text: &str, start: usize, ncap: usize) -> Option<Slots> {
        let at = start + self.prefix.find(text, start)?;
        let mut slots = vec![None; ncap];
        if ncap > 0 {
            slots[0] = Some(at);
            slots[1] = Some(at + self.prefix.len());
        }
        Some(slots)
    }

    fn run_machine(&self, state: &mut SearchState, text: &str, start: usize, ncap: usize, prefix: &Re2Literal) -> Option<Slots> {
        let machine = state.machine.get_or_insert_with(|| Machine::new(&self.prog));
        let found = machine.find(&self.prog, text, start, ncap, prefix);
        state.visits += machine.visits();
        found
    }
}

/// Reads and compiles `pattern` as re2js's `RE2.compileImpl(pattern, PERL, false)` does.
pub(crate) fn compile_pattern(pattern: &str) -> Result<Re2Program, SyntaxError> {
    let parsed = parse(pattern)?;
    let mut nodes = parsed.nodes;
    let group_count = max_cap(&nodes, parsed.root) as usize;
    let root = simplify(&mut nodes, parsed.root);
    let prefilter = Prefilter::build(&nodes, root);
    let mut compiler = Compiler {
        insts: Vec::new(),
        classes: Vec::new(),
        class_of: HashMap::new(),
        class_singles: HashSet::new(),
        num_cap: 2,
    };
    compiler.new_inst(InstOp::Fail);
    let frag = compiler.compile(&nodes, root);
    drop(nodes);
    let matched = compiler.new_inst(InstOp::Match);
    compiler.patch(frag.out, matched.i);
    let mut prog = Prog {
        insts: compiler.insts,
        classes: compiler.classes,
        start: frag.i,
        num_cap: compiler.num_cap,
        start_cond: None,
    };
    prog.start_cond = prog.start_condition();
    let (prefix_complete, prefix) = prog.literal_prefix(&compiler.class_singles);
    let onepass = OnePassProg::compile(&prog);
    let named_groups = parsed.named_groups.into_iter().map(|(name, index)| (name, index as usize)).collect();
    Ok(Re2Program {
        prog,
        group_count,
        named_groups,
        prefix: Re2Literal::from_code_points(&prefix),
        prefix_complete,
        prefilter,
        onepass,
        idle: Mutex::new(None),
    })
}

#[cfg(test)]
mod tests {
    //! Every engine against the Machine. A search is answered by the engine `executeEngine`
    //! picks, and each must answer as re2js's Machine answers — the verdict, the match and
    //! every group — so each engine is forced here, wherever it applies, and compared with
    //! the Machine run alone, without its prefix skip. The corpus is the patterns of this
    //! crate's RE2 tests, the visit-count patterns, the audit's four, a fixed-seed generator
    //! of 6,000 patterns over texts of its own, and a named case for what each engine could
    //! get wrong, each asserting the engine that answered. No Node test file is the twin of
    //! this one: re2js's engines are not reachable one by one from Node, and the answers
    //! compared are the Machine's, which `tests/re2_matching.rs` pins against Node.

    use super::*;

    /// An engine run on its own, the reference among them.
    #[derive(Clone, Copy, PartialEq, Eq, Debug)]
    enum Forced {
        /// The Machine without its prefix skip: the reference.
        Reference,
        Engine(Engine),
    }

    fn compile(pattern: &str) -> Re2Program {
        compile_pattern(pattern).unwrap_or_else(|refused| panic!("{pattern:?} is refused: {refused:?}"))
    }

    /// The answer of one engine forced, and its visits, or nothing where it does not apply
    /// or declines.
    fn forced(
        program: &Re2Program,
        state: &mut SearchState,
        engine: Forced,
        text: &str,
        start: usize,
        ncap: usize,
    ) -> Option<(Option<Slots>, u64)> {
        state.visits = 0;
        let found = match engine {
            Forced::Reference => program.run_machine(state, text, start, ncap, &Re2Literal::from_code_points(&[])),
            Forced::Engine(Engine::Machine) => program.run_machine(state, text, start, ncap, &program.prefix),
            Forced::Engine(Engine::Literal) => {
                if !(program.prefix_complete && (ncap == 0 || program.group_count == 0)) {
                    return None;
                }
                program.literal_match(text, start, ncap)
            }
            Forced::Engine(Engine::Prefilter) => {
                if program.prefilter.as_ref()?.passes(text, start) {
                    return None;
                }
                None
            }
            Forced::Engine(Engine::OnePass) => {
                program.onepass.as_ref()?.execute(&program.prog, text, start, ncap, &mut state.visits)
            }
            Forced::Engine(Engine::Backtracker) => {
                if text.len() > max_bit_state_len(&program.prog) {
                    return None;
                }
                state.bits.execute(&program.prog, text, start, ncap, &program.prefix, &mut state.visits)
            }
            Forced::Engine(Engine::Dfa) => {
                if ncap != 0 {
                    return None;
                }
                state.dfa.matches(&program.prog, text, start, &mut state.visits)?.then(Vec::new)
            }
        };
        Some((found, state.visits))
    }

    const ENGINES: [Engine; 6] =
        [Engine::Literal, Engine::Prefilter, Engine::OnePass, Engine::Backtracker, Engine::Dfa, Engine::Machine];

    /// How often each engine answered, forced and when picked.
    #[derive(Default)]
    struct Tally {
        forced: HashMap<Engine, usize>,
        picked: HashMap<Engine, usize>,
    }

    impl std::hash::Hash for Engine {
        fn hash<H: std::hash::Hasher>(&self, state: &mut H) {
            (*self as u8).hash(state);
        }
    }

    /// Every engine that applies agrees with the reference at 0 groups, 1 group and all
    /// groups; answers the engine the search picked when all groups are asked.
    fn agree(program: &Re2Program, state: &mut SearchState, label: &str, text: &str, start: usize, tally: &mut Tally) -> [Engine; 3] {
        let all = program.group_count + 1;
        let mut picked = [Engine::Machine; 3];
        for (slot, groups) in [0, 1, all].into_iter().enumerate() {
            let ncap = 2 * groups;
            let (reference, _) = forced(program, state, Forced::Reference, text, start, ncap).expect("the Machine always runs");
            for engine in ENGINES {
                let Some((answer, _)) = forced(program, state, Forced::Engine(engine), text, start, ncap) else {
                    continue;
                };
                *tally.forced.entry(engine).or_default() += 1;
                let expected = match engine {
                    Engine::Dfa => reference.as_ref().map(|_| Vec::new()),
                    _ => reference.clone(),
                };
                assert_eq!(answer, expected, "{engine:?} for {label:?} over {text:?} from {start}, {groups} groups");
            }
            state.visits = 0;
            let (answer, engine) = program.execute(state, text, start, ncap);
            let expected = if ncap == 0 { reference.as_ref().map(|_| Vec::new()) } else { reference };
            assert_eq!(answer, expected, "the search for {label:?} over {text:?} from {start}, {groups} groups, by {engine:?}");
            *tally.picked.entry(engine).or_default() += 1;
            picked[slot] = engine;
        }
        picked
    }

    /// The patterns of this crate's RE2 tests.
    const FIXED: [&str; 40] = [
        "a", "abc", "a*", "a+?b", "(a)(b)?", "(a|ab)(c|bcd)(d*)", "(a*)+", "(a*)*b", "(a|aa)*c", "(x+x+)+y",
        "x*", "^", "$", "^$", "\\bfoo\\b", "\\Bo", "(?m)^b$", "(?s).", "(?i)k", "(?i)\\x{212A}", "[[:alpha:]]+",
        "\\pL+", "\\PL", "\\d{2,3}", "a{2}b{0,1}", "(?U)a+", "(?P<n>x)(?<m>y)", "\\Qa.b\\E", "日本", "é+",
        "(?i)é", "a|b|c", "ab|ac|ad", "^(?:a|b)+$", "^(a+)(b)$", "^x(?:y|$)", "[^a]", "\\Aa\\z", ".*", "(?:)",
    ];

    /// re2js's generator would be a dependency's; this one is the test's own: patterns of
    /// literals, classes, anchors, groups, alternations and quantifiers, about two in five
    /// anchored at the text's start.
    struct Generator(u64);

    impl Generator {
        fn next(&mut self) -> u64 {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 7;
            self.0 ^= self.0 << 17;
            self.0
        }

        fn below(&mut self, n: usize) -> usize {
            (self.next() % n as u64) as usize
        }

        fn pick<'a>(&mut self, items: &[&'a str]) -> &'a str {
            items[self.below(items.len())]
        }

        fn expression(&mut self, depth: usize) -> String {
            const ATOMS: [&str; 26] = [
                "a", "b", "c", "ab", "ba", "é", "日", "1", "[a-c]", "[^a]", "[ab]", "\\d", "\\w", "\\s", ".", "(?i:a)",
                "(?i:é)", "(?i)b", "\\x{212A}", "\\b", "\\B", "$", "(?m:^)", "(?m:$)", "(?s:.)", "\\pL",
            ];
            const QUANTIFIERS: [&str; 7] = ["*", "+", "?", "{2}", "{0,2}", "{1,}", "{1,3}"];
            match self.below(if depth == 0 { 1 } else { 8 }) {
                0..=2 => self.pick(&ATOMS).to_owned(),
                3 => (0..2 + self.below(2)).map(|_| self.expression(depth - 1)).collect(),
                4 => {
                    let branches: Vec<String> = (0..2 + self.below(2)).map(|_| self.expression(depth - 1)).collect();
                    format!("(?:{})", branches.join("|"))
                }
                5 => format!("({})", self.expression(depth - 1)),
                _ => {
                    let lazy = if self.below(3) == 0 { "?" } else { "" };
                    format!("(?:{}){}{lazy}", self.expression(depth - 1), self.pick(&QUANTIFIERS))
                }
            }
        }

        fn pattern(&mut self) -> String {
            let flags = self.pick(&["", "", "", "(?i)", "(?s)", "(?m)", "(?U)"]);
            let start = if self.below(5) < 2 { "^" } else { "" };
            let end = if self.below(3) == 0 { "$" } else { "" };
            format!("{flags}{start}{}{end}", self.expression(3))
        }

        fn text(&mut self) -> String {
            const ALPHABET: [&str; 14] = ["a", "a", "b", "b", "c", "A", "é", "É", "日", "1", " ", "\n", "K", "\u{212A}"];
            (0..self.below(11)).map(|_| self.pick(&ALPHABET)).collect()
        }
    }

    fn starts(text: &str) -> Vec<usize> {
        let mut starts = vec![0];
        if let Some((second, _)) = text.char_indices().nth(1) {
            starts.push(second);
        }
        starts
    }

    #[test]
    fn every_engine_answers_as_the_machine() {
        let mut tally = Tally::default();
        let mut generator = Generator(0x9E37_79B9_7F4A_7C15);
        let mut patterns: Vec<String> = FIXED.iter().map(|&pattern| pattern.to_owned()).collect();
        patterns.extend(linear_cases().into_iter().map(|(pattern, _)| pattern));
        let mut generated = 0;
        while generated < 6000 {
            let pattern = generator.pattern();
            if compile_pattern(&pattern).is_ok() {
                patterns.push(pattern);
                generated += 1;
            }
        }
        for pattern in &patterns {
            let program = compile(pattern);
            let mut state = SearchState::default();
            let mut texts: Vec<String> = (0..6).map(|_| generator.text()).collect();
            texts.extend(["", "abc", "ABC", "foo 12", "xx日本", "aab"].map(str::to_owned));
            for text in &texts {
                for start in starts(text) {
                    agree(&program, &mut state, pattern, text, start, &mut tally);
                }
            }
        }
        // Every engine is forced often; the Machine is picked only for texts past the
        // backtracker's bound, which the named cases and the visit test reach.
        for engine in ENGINES {
            let forced = tally.forced.get(&engine).copied().unwrap_or(0);
            let picked = tally.picked.get(&engine).copied().unwrap_or(0);
            assert!(forced >= 1000, "{engine:?} answered {forced} searches forced: the corpus does not reach it");
            assert!(engine == Engine::Machine || picked >= 1000, "{engine:?} was picked for {picked} searches");
        }
    }

    /// `(pattern, text, start, the engines picked at 0 groups, 1 group and all groups)`.
    fn named_cases() -> Vec<(&'static str, String, usize, [Engine; 3])> {
        use Engine::*;
        vec![
            // A folded literal is no prefix and no required literal.
            ("(?i)abc", "xABC".to_owned(), 0, [Dfa, Backtracker, Backtracker]),
            // An alternation with a branch requiring no literal requires none.
            ("foo|\\d", "x1".to_owned(), 0, [Dfa, Backtracker, Backtracker]),
            ("(ab){0,1}c", "abc".to_owned(), 0, [Dfa, Backtracker, Backtracker]),
            ("(ab){0,1}c", "abd".to_owned(), 0, [Prefilter, Prefilter, Prefilter]),
            // Multi-byte literals.
            ("日本", "xx日本".to_owned(), 0, [Literal, Literal, Literal]),
            ("é+本", "éé本".to_owned(), 0, [Dfa, Backtracker, Backtracker]),
            // A required literal that lies before the start.
            ("a\\wc", "abc".to_owned(), 1, [Prefilter, Prefilter, Prefilter]),
            ("abc", "abc".to_owned(), 1, [Literal, Literal, Literal]),
            // A pattern that is one literal, with groups asked of a pattern with groups.
            ("(abc)", "xabc".to_owned(), 0, [Literal, Backtracker, Backtracker]),
            // Not one-pass.
            ("^(a|ab)(c|bcd)(d*)$", "abcd".to_owned(), 0, [Backtracker, Backtracker, Backtracker]),
            ("^x(?:y|$)", "x".to_owned(), 0, [Backtracker, Backtracker, Backtracker]),
            // One-pass, its captures non-greedy; and not, its branches overlapping.
            ("^(a+?)(b)$", "aab".to_owned(), 0, [OnePass, OnePass, OnePass]),
            ("^(?:\\d+a|\\w+b)$", "1b".to_owned(), 0, [Backtracker, Backtracker, Backtracker]),
            // Leftmost-first order through the backtracker.
            ("(a|ab)(c|bcd)(d*)", "abcd".to_owned(), 0, [Dfa, Backtracker, Backtracker]),
            ("(a*)+", "b".to_owned(), 0, [Dfa, Backtracker, Backtracker]),
            // `\b` begun inside the text; the DFA declines a closure reaching it.
            ("\\bb", "ab".to_owned(), 1, [Backtracker, Backtracker, Backtracker]),
            ("\\Bb", "ab".to_owned(), 1, [Backtracker, Backtracker, Backtracker]),
            ("\\bfoo\\b", "a foo".to_owned(), 0, [Backtracker, Backtracker, Backtracker]),
            // The DFA over code points above Latin-1.
            ("日+本", "x日日本".to_owned(), 0, [Dfa, Backtracker, Backtracker]),
        ]
    }

    #[test]
    fn each_named_case_is_answered_by_its_engine_as_the_machine_answers() {
        let mut tally = Tally::default();
        for (pattern, text, start, engines) in named_cases() {
            let program = compile(pattern);
            let picked = agree(&program, &mut SearchState::default(), pattern, &text, start, &mut tally);
            assert_eq!(picked, engines, "{pattern:?} over {text:?} from {start}");
        }
        for (pattern, onepass, prefilter, prefix, complete) in NODE_SELECTION {
            let program = compile(pattern);
            assert_eq!(program.onepass.is_some(), onepass, "{pattern:?} on OnePass");
            assert_eq!(program.prefilter.as_ref().map(Prefilter::kind), prefilter, "{pattern:?}'s prefilter");
            assert_eq!(program.prefix.bytes(), prefix.as_bytes(), "{pattern:?}'s prefix");
            assert_eq!(program.prefix_complete, complete, "{pattern:?} as one literal");
        }
    }

    /// `(pattern, OnePass compiled, the prefilter's type, the prefix, the prefix complete)`,
    /// read from re2js 2.8.3's `RE2` for each named case, executed (`@telorun/cel 0.120.1 at
    /// b4a2b6e9`, Node 24.21): `onepass !== null`, `prefilter.type` (1 EXACT, 2 AND, 3 OR),
    /// `prefix` and `prefixComplete`.
    const NODE_SELECTION: [(&str, bool, Option<u8>, &str, bool); 19] = [
        ("(?i)abc", false, None, "", false),
        ("foo|\\d", false, None, "", false),
        ("(ab){0,1}c", false, Some(1), "", false),
        ("日本", false, Some(1), "日本", true),
        ("é+本", false, Some(2), "é", false),
        ("a\\wc", false, Some(2), "a", false),
        ("abc", false, Some(1), "abc", true),
        ("(abc)", false, Some(1), "abc", true),
        ("^(a|ab)(c|bcd)(d*)$", false, Some(2), "", false),
        ("^x(?:y|$)", false, Some(1), "", false),
        ("^(a+?)(b)$", true, Some(2), "", false),
        ("^(?:\\d+a|\\w+b)$", false, Some(3), "", false),
        ("(a|ab)(c|bcd)(d*)", false, Some(2), "a", false),
        ("(a*)+", false, None, "", false),
        ("\\bb", false, Some(1), "", false),
        ("\\Bb", false, Some(1), "", false),
        ("\\bfoo\\b", false, Some(1), "", false),
        ("日+本", false, Some(2), "日", false),
        ("(a+)(b)", false, Some(2), "a", false),
    ];

    #[test]
    fn a_text_at_the_backtrackers_bound_is_backtracked_and_one_past_it_is_not() {
        let program = compile("(a+)(b)");
        let bound = max_bit_state_len(&program.prog);
        let mut tally = Tally::default();
        for (length, engine) in [(bound, Engine::Backtracker), (bound + 1, Engine::Machine)] {
            let text = format!("{}b", "a".repeat(length - 1));
            let picked = agree(&program, &mut SearchState::default(), "(a+)(b)", &text, 0, &mut tally);
            assert_eq!(picked, [Engine::Dfa, engine, engine], "{length} bytes");
        }
        let anchored = compile("\\b(a+)$");
        let bound = max_bit_state_len(&anchored.prog);
        for (length, engine) in [(bound, Engine::Backtracker), (bound + 1, Engine::Machine)] {
            let text = "a".repeat(length);
            let picked = agree(&anchored, &mut SearchState::default(), "\\b(a+)$", &text, 0, &mut tally);
            assert_eq!(picked, [engine; 3], "{length} bytes");
        }
    }

    /// D1's four patterns and the audit's four, each with the text unit repeated to length;
    /// none matches its text.
    fn linear_cases() -> Vec<(String, String)> {
        let mut generator = Generator(12345);
        let letters = |generator: &mut Generator, n: usize| -> String {
            (0..n).map(|_| char::from(b'a' + generator.below(26) as u8)).collect()
        };
        let words: Vec<String> = (0..200).map(|_| letters(&mut generator, 8)).collect();
        let email = "[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}".to_owned();
        vec![
            ("(a*)*b".to_owned(), "a".to_owned()),
            ("(a|aa)*c".to_owned(), "a".to_owned()),
            ("(x+x+)+y".to_owned(), "x".to_owned()),
            ("\\pL{1000}".to_owned(), format!("{}1", "a".repeat(999))),
            (email.clone(), "ab@cd".to_owned()),
            (email, "abcde".to_owned()),
            (format!("(?:{})", words.join("|")), letters(&mut generator, 4096)),
            (
                (0..30000).map(|i| format!("[a-{}]x", char::from(b'b' + (i % 20) as u8))).collect::<Vec<_>>().join("|"),
                "z".to_owned(),
            ),
        ]
    }

    /// The Machine forced alone, with its prefix skip and without, keeps D1's bound —
    /// (|program| + 1) × (n + 1) visits — and doubling the text at most doubles its visits,
    /// less one ramp of threads. The dispatched bounds are `tests/re2_linear_time.rs`'s.
    #[test]
    fn the_machine_alone_visits_each_instruction_at_most_once_per_position() {
        for (pattern, unit) in linear_cases() {
            let program = compile(&pattern);
            let size = program.instruction_count() as u64 + 1;
            let mut state = SearchState::default();
            let mut previous: [Option<u64>; 2] = [None; 2];
            let mut length = 1usize;
            while length <= 64 * 1024 && size * (length as u64 + 1) <= 1 << 24 {
                let text = &unit.repeat(length.div_ceil(unit.len()))[..length];
                let bound = size * (length as u64 + 1);
                for (slot, engine) in [Forced::Reference, Forced::Engine(Engine::Machine)].into_iter().enumerate() {
                    let (found, visits) = forced(&program, &mut state, engine, text, 0, 2).expect("the Machine runs");
                    assert_eq!(found, None, "{engine:?} for {pattern:.40} over {length} bytes");
                    assert!(visits <= bound, "{engine:?} for {pattern:.40} over {length} bytes: {visits} visits");
                    if let Some(previous) = previous[slot] {
                        assert!(
                            visits <= 2 * previous + size * size,
                            "{engine:?} for {pattern:.40}: {previous} visits at {} bytes, {visits} at {length}",
                            length / 2
                        );
                    }
                    previous[slot] = Some(visits);
                }
                length *= 2;
            }
        }
    }

    #[test]
    fn the_dfa_holds_its_states_within_the_budget_and_fails_after_the_fifth_clear() {
        let mut generator = Generator(0x5EED);
        let mut text: String = (0..1 << 20).map(|_| if generator.below(2) == 0 { 'a' } else { 'b' }).collect();
        let program = compile("(?:a|b)*a(?:a|b){20}");
        let mut state = SearchState::default();
        let (reference, _) = forced(&program, &mut state, Forced::Reference, &text, 0, 0).expect("the Machine runs");
        let (answer, _) = forced(&program, &mut state, Forced::Engine(Engine::Dfa), &text, 0, 0).expect("the DFA answers");
        assert_eq!(answer, reference);
        // The same states, with a match only at the text's end: the DFA meets every state
        // the text leads to before it can answer.
        text.push_str(&format!("a{}c", "b".repeat(20)));
        let program = compile("(?:a|b)*a(?:a|b){20}c");
        let mut state = SearchState::default();
        assert_eq!(forced(&program, &mut state, Forced::Engine(Engine::Dfa), &text, 0, 0), None);
        assert!(state.dfa.failed());
        assert_eq!(state.dfa.clears(), MAX_DFA_CLEARS);
        assert!(state.dfa.peak <= crate::re2_dfa::DFA_BUDGET, "{} bytes held", state.dfa.peak);
        assert!(state.dfa.peak > crate::re2_dfa::DFA_BUDGET / 2, "{} bytes held", state.dfa.peak);
        let (reference, _) = forced(&program, &mut state, Forced::Reference, &text, 0, 0).expect("the Machine runs");
        assert!(reference.is_some());
        state.visits = 0;
        assert_eq!(program.execute(&mut state, &text, 0, 0), (reference, Engine::Machine));
    }

    const MAX_DFA_CLEARS: u32 = 5;

    /// `^(?:([…])a|…)$`: one branch per class, the classes disjoint, each of single code
    /// points two apart.
    fn class_alternation(classes: &[usize]) -> String {
        let mut code_points = (0x100u32..).step_by(2).map(|r| char::from_u32(r).expect("below the surrogates"));
        let branches: Vec<String> =
            classes.iter().map(|&size| format!("([{}])a", code_points.by_ref().take(size).collect::<String>())).collect();
        format!("^(?:{})$", branches.join("|"))
    }

    /// The form is charged its copied instructions, then 12 bytes for each range an
    /// alternation merges; the left fold of `n` branches merges the first `j + 1` at its
    /// `j`th alternation. Built at the budget, declined one range past it.
    #[test]
    fn a_one_pass_form_past_its_budget_is_declined_and_the_backtracker_answers() {
        const BUDGET: usize = 8_388_608;
        const BRANCHES: usize = 99;
        const PER_BRANCH: usize = 141;
        let probe = compile(&class_alternation(&[PER_BRANCH; BRANCHES]));
        let instructions = probe.instruction_count() * size_of::<Inst>();
        let merged = PER_BRANCH * (2..=BRANCHES).sum::<usize>();
        let fits = (BUDGET - instructions) / 12 - merged;
        let mut tally = Tally::default();
        for (last, engine) in [(fits, Engine::OnePass), (fits + 1, Engine::Backtracker)] {
            let mut classes = [PER_BRANCH; BRANCHES];
            classes[BRANCHES - 1] += last;
            let pattern = class_alternation(&classes);
            let program = compile(&pattern);
            assert_eq!(program.instruction_count(), probe.instruction_count());
            assert_eq!(program.onepass.is_some(), engine == Engine::OnePass, "{last} more ranges in the last branch");
            let last_code_point = char::from_u32(0x100 + 2 * (classes.iter().sum::<usize>() as u32 - 1)).expect("a code point");
            let mut state = SearchState::default();
            for text in [format!("{}a", '\u{100}'), format!("{last_code_point}a")] {
                let picked = agree(&program, &mut state, "the class alternation", &text, 0, &mut tally);
                assert_eq!(picked, [engine; 3], "{text:?}, {last} more ranges in the last branch");
            }
            for text in ["\u{101}a", "\u{100}", "\u{100}ab", ""] {
                agree(&program, &mut state, "the class alternation", text, 0, &mut tally);
            }
        }
    }

    #[test]
    fn checks_the_deepest_one_pass_program_on_a_small_stack() {
        let work = || {
            let pattern = format!("^{}a{}$", "(".repeat(496), ")".repeat(496));
            let program = compile(&pattern);
            assert!(program.instruction_count() < 1000);
            assert!(program.onepass.is_some());
            let search = program.search("a", 0, 497);
            assert!(search.groups.expect("it matches").iter().all(|span| *span == Some(Re2Span { start: 0, end: 1 })));
        };
        let thread = std::thread::Builder::new().stack_size(256 * 1024).spawn(work).expect("the thread starts");
        thread.join().expect("the work ran to its end");
    }
}
