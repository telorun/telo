//! A compiled RE2 pattern. No Node twin: Node compiles a pattern with re2js 2.8.3's
//! `Simplify`, `Compiler` and `Prog`, files of a dependency.
//!
//! This is those three, twinned: the simplifier's rewriting of counted repetition into
//! copies, optionals and plus loops; the compiler's instruction set, emitted in its order;
//! the program's start condition. A character class is one instruction over one shared,
//! immutable range list — every copy a counted repetition makes of a class points at the
//! same list — so a program's memory is the instruction count RE2's size limit bounds, as
//! re2js's is. A literal folded for case keeps re2js's meaning: it matches its fold orbit.
//!
//! Both walks run on heap stacks, and the simplifier's answer for a subexpression is
//! remembered by node, so a subexpression shared by the copies of a repetition is
//! simplified once.
//!
//! Not twinned: re2js's literal prefix, its prefilter, OnePass, the backtracker and the
//! DFA — accelerators with no answer of their own — and lookbehind, which CEL never
//! enables. The program runs on `re2_machine.rs`.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use crate::re2_machine::Machine;
use crate::re2_syntax::{
    max_cap, parse, simple_fold, NodeId, Op, Regexp, SyntaxError, FOLD_CASE, MAX_RUNE, NON_GREEDY,
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

// ------------------------------------------------------------------- the public face

/// A match's place in the text: byte offsets, each on a character boundary.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Re2Span {
    pub start: usize,
    pub end: usize,
}

/// One search's answer: the spans asked for — the whole match first, then each group,
/// `None` for a group that took no part — or `None` for no match; and how many times the
/// machine visited an instruction, the measure of its linear time.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Re2Search {
    pub groups: Option<Vec<Option<Re2Span>>>,
    pub visits: u64,
}

const IDLE_LOCK: &str = "the idle machine's lock is held only to take or return it";

/// A pattern compiled to RE2's program, ready to search any number of texts from any
/// number of threads.
pub struct Re2Program {
    pub(crate) prog: Prog,
    group_count: usize,
    named_groups: Vec<(String, usize)>,
    /// One idle machine kept for the next search; a search that finds none builds one.
    idle: Mutex<Option<Box<Machine>>>,
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
    /// first `groups` groups — the whole match counting as the first — as re2js's
    /// `matchMachineInput` answers with `ngroup` of `groups`. The text before `start` is
    /// still the context of `^`, `\b` and `\B`. With `groups` of zero only whether it
    /// matched is answered, and the search stops at the first match it finds.
    ///
    /// Panics when `start` is past the text's end or not on a character boundary.
    pub fn search(&self, text: &str, start: usize, groups: usize) -> Re2Search {
        assert!(
            text.is_char_boundary(start),
            "a search starts on a character boundary within the text, and byte {start} is not one of {:?}",
            text
        );
        let idle = self.idle.lock().expect(IDLE_LOCK).take();
        let mut machine = idle.unwrap_or_else(|| Box::new(Machine::new(&self.prog)));
        let found = machine.find(&self.prog, text, start, 2 * groups);
        let visits = machine.visits();
        let groups = found.map(|slots| {
            slots
                .chunks_exact(2)
                .map(|pair| match (pair[0], pair[1]) {
                    (Some(start), Some(end)) => Some(Re2Span { start, end }),
                    _ => None,
                })
                .collect()
        });
        let mut slot = self.idle.lock().expect(IDLE_LOCK);
        if slot.is_none() {
            *slot = Some(machine);
        }
        Re2Search { groups, visits }
    }
}

/// Reads and compiles `pattern` as re2js's `RE2.compileImpl(pattern, PERL, false)` does.
pub(crate) fn compile_pattern(pattern: &str) -> Result<Re2Program, SyntaxError> {
    let parsed = parse(pattern)?;
    let mut nodes = parsed.nodes;
    let group_count = max_cap(&nodes, parsed.root) as usize;
    let root = simplify(&mut nodes, parsed.root);
    let mut compiler = Compiler { insts: Vec::new(), classes: Vec::new(), class_of: HashMap::new(), num_cap: 2 };
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
    let named_groups = parsed.named_groups.into_iter().map(|(name, index)| (name, index as usize)).collect();
    Ok(Re2Program { prog, group_count, named_groups, idle: Mutex::new(None) })
}
