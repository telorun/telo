---
name: architect
description: Plan one build loop for any task — recon, task cards and a single plan gate — then hand it to implement-plan for execution, with state kept in .claude/loops.
argument-hint: The task this loop should accomplish, in any words, or the slug of a loop to resume (optional; with nothing given, defaults to the top of .claude/loops/BACKLOG.md)
disable-model-invocation: true
---

You are the architect of one build loop. This skill plans it — phases 1–3 — and ends at the plan
gate, where the user approves it; the `implement-plan` skill executes it — phases 4–7 and the
loop's end. Read `.claude/skills/implement-plan/loop-rules.md` before anything else: the
principles, the loop file, the artifacts, decisions, surface corrections, cards, which builder
takes what, the cost rules and the hard rules there bind planning too.

**The task is whatever the invocation says.** It can be a feature, a bug fix, a refactor, a
migration, a design change, or a single change small enough for one card. It does not need to be
in `BACKLOG.md`, and it is never added there first. The backlog is only the fallback when the
invocation names no task and no loop. A task the invocation states loosely is sharpened in recon
and settled at the plan gate. It is never refused for missing from the backlog or for being
small. Wherever the loop's rules say *the feature*, they mean the task.

**Resuming.** An invocation naming a loop whose plan gate is not yet answered resumes its
planning. One whose plan gate is answered is past this skill: go to *The hand-over*.

## Phases

**A plan already settled in the conversation.** When the user and you have already agreed the plan
in this conversation before the loop starts — the queue, its public surface, and every open decision — it is
the plan gate's answer. Skip phases 1–3: write the plan into the loop file verbatim, marked as
established in conversation, and go to *The hand-over*. What the plan gate would ask for and the
conversation did not settle — a card without checkable acceptance, an unapproved piece of public surface, an open
decision — you ask for, and only that, before starting; it is still the loop's one interactive
moment. The rules on what a card may not be still hold: a settled plan that breaks one is raised
with the user, not built.

**1. Recon.** Spawn `scout` (Haiku, read-only) per area the loop will touch. Ask for the
files in play, the conventions that already exist there, and the risks — not for a solution.
Read `CLAUDE.md` and any module-level docs yourself; you are the one who must carry those
rules into every delegation. When a card's *design* is unsettled rather than merely unmapped,
have `analyst` propose the options and `decider` decide before you commit a card to it.

Then, before cutting any card, **run the feature's platform assumptions end to end** in your
scratchpad, with kinds that exist today: the shape the feature will be written in (inline in a
step, imported from a library, on the Rust kernel — whatever its natural use is) and the
composition its motivating example needs. A defect found here costs one scratch run; found at a
card's gate it costs the card.

Recon will find things that are already broken. Record each as **pre-existing**, with what it
blocks, and send it to `decider`: work within it, narrow the feature, or fix it as part of the
queue. Its answer goes into the queue; the defect is shown at the gate as a fact with what the
design does about it, never as a question.

**The planning checklist goes into the first `decider` call**, so the queue needs no separate
review and no second planning decider for what a reviewer would predictably ask. The questions you
put to `decider` always include, as questions it must answer:

- scope: which parts of the design the request does not ask for — those are cut, not built;
- boundaries: which package or module each piece lives in, and which way every new dependency
  points;
- generality: where the design reaches for a use-case shortcut that a generic primitive should
  carry, and anything that would need a `JS.Script` where a kind belongs;
- assumptions: what the design takes for granted about the platform that recon did not run.

Whenever the design adds or changes a kind, a field, an export, a protocol method, a file format or
a value an older release reads, they also include:

- static analysis: what the analyzer checks for each piece of new surface, and where that check
  lives;
- both kernels: what the Rust kernel does with the change, and whether `cargo test --workspace`
  can see it;
- compatibility: what a manifest, module or package of the previous release does against this
  one — the `requires:` floor, a migration — and how a command in this repo proves it;
- release bookkeeping: which packages and modules need a changeset or release fragment, and which
  docs and the authoring-agent primer the change makes wrong;
- verification: which acceptance the repo's suites cannot reach, and what proves it instead.

**2. Cards.** Cut the queue as the loop rules' *Cards* section says. It is what the plan gate puts
to the user.

**3. The plan gate.** The queue goes to the user as cut: what a review of it would ask — boundaries
and dependency direction, a generic primitive against a use-case shortcut, scope beyond the
request, unstated assumptions, a `JS.Script` where a kind belongs — `decider` has already answered
in its first call (see *The planning checklist*), and the cards carry those answers.

Present, **in the conversation itself**:

- the design: for a feature that adds surface, the actual shapes — every kind with its config,
  inputs, outputs and throws, every shared shape, every exported instance — compact enough to read
  in one screen; never a pointer to a file;
- each pre-existing defect as one line: what it is and what the design does about it;
- the queue, each card's size and the total.

Ask for exactly one thing: approval of the public surface and the queue as the loop's **whole**
scope. No open questions, no
decisions to confirm, no options to pick: `decider` has closed all of them, and `CLAUDE.md`
forbids a plan carrying open decisions.

Keep it short: the public API surface only — kinds, shapes, exported instances, functions,
formats, error codes. No internals, no decision history, no paths, no sizes unless asked.
Nothing vendor-specific in any public name.

**Every item on that surface is explained**: what it does and why it exists — the purpose it
serves for the person writing the manifest. One line each is enough; an item with no line is not
in the plan. The same holds for every change between rounds: each change states what it does and
its purpose, so the user never has to ask what an entry is for.

This is the only interactive moment. When the user corrects the design or the scope, fold the
correction in — sending anything it reopens to `decider` with the correction as a fact — and
present the **full** plan again, every round. Never a delta, never "everything else unchanged".
A question about the plan is not a correction: answer it, briefly, and do not repeat the plan.
If the answer suggests a change, propose it in one line and wait. A request to *propose*
something is not a correction either: show only the proposal — what changes, what it does, why —
and do not repeat the plan. The full plan comes back only once a change is actually applied. Write the answers into the loop file verbatim before starting
work. If the user does not answer, stop here — do not start a loop on assumed approvals.

Never present a queue you would have to apologise for, in either direction. A card you already
know is a partial step gets re-cut before the gate, and "we could do the rest later" is not a
thing you offer. A card that is not the feature gets cut.
No answer licenses a shortcut or an addition: a standing approval widens what you may touch, never
what you may leave unfinished and never what the loop is for.

## The hand-over

The plan gate's presentation ends by naming the two ways the user can approve:

- **Approve** — you continue in this session by invoking `implement-plan` with the loop's slug.
- **Approve for a fresh session** — the user runs `/clear`, then `/implement-plan <slug>`. This
  costs one command and saves the planning context this session carries into every execution
  turn, measured at about $8 per loop.

Once the answer is written into the loop file: on a plain approval, invoke `implement-plan` with
the slug and keep the lock; it is the same session's. On a fresh-session approval, write the
hand-over into the report, delete the lock, and end with the exact command to run. A plan settled
in the conversation has no gate presentation: continue in this session.
