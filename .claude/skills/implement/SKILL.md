---
name: implement
description: Run only when the user types /implement. Never invoke it yourself, whatever the task. Implements one task whose design is settled — named in the arguments, pointed at by the user, or just agreed in this conversation — with as many builders as it needs, one audit, one fix round, then /pr.
argument-hint: a task, a path to one (a backlog entry, a plan section, an issue), or nothing for the design just agreed in this conversation
---

You carry one settled task to a green pull request: builders build it, one part each — or you do,
where *Build it yourself* holds — one `auditor` reviews the whole of it, one fix round answers the
review, and `/pr` lands it.

Read `.claude/skills/implement-plan/loop-rules.md` → *Which builder* before step 1. Its tiers, its
fix-round routing and its escalation bind you here; the rest of that file is for loops and does
not.

## 1. Settle the task

The task is what the arguments name, what they point at, or — with no arguments — the design this
conversation just agreed. Record `git status` before anything else, so you know what the tree held
before the build.

Stop and ask the user, building nothing, when:

- no task can be identified;
- a public-surface question is still open — a kind, a field, a schema shape, a diagnostic code, a
  package boundary the conversation has not decided.

Otherwise cut the task into **parts**, as many as it needs and no more. Split along a real
boundary — a different package, a different runtime, work that must land before the rest can be
written, or a part a builder's context could not hold together with the rest — never to make parts
small; one part is the norm. Each part is one complete change; none is an MVP, a deferred static
half or an adjacent fix.

Write each part's brief to `.claude/loops/<YYYY-MM-DD>-<slug>/<nn>-<part-slug>/brief.md`. It holds
the part's intent in one sentence, the decisions from the conversation verbatim, acceptance
criteria stated as behaviour, the paths it may touch, the quick checks that prove it, its size
(files and roughly lines), and its tier — `lite`, `standard` or `high` — by *Which builder*, or
`self` when *Build it yourself* holds. Read only what you need to write the briefs; the builders
read the code.

## Build it yourself

A builder costs a brief, a spawn and the time it takes to learn the code. When the work is
smaller than that, you do it yourself — a whole part, or a fix item in step 4. Only when **all**
of these hold:

- **You already know every file it touches.** You read them in this session and know the change
  each needs; nothing is left to explore.
- **It has one shape.** The conversation or `decider` settled it, and no question a builder would
  ask before building remains.
- **It is small.** A few files and a few dozen lines, the test that pins it included.
- **It stays inside the brief's paths and the decided public surface.**

Anything larger, or anything you would have to explore to understand, goes to a builder.

Your work is held to the builder's standard, read from `.claude/agents/builder.md`: complete, one
test per behaviour, docs and release bookkeeping included, no `JS.Script`, nothing beyond the task.
Run the part's quick checks and read their output. Write what you changed, the checks and their
results to the part's `self.md` in place of `builder.md`. The audit judges it like any builder's
work.

## 2. Build

Build the parts in order, a fresh builder per part — or yourself, for a `self` part — one at a
time, never two at once. Spawn the
builder of the part's tier (`builder-lite`, `builder` or `builder-high`), pointed at its
`brief.md`; a brief after the first also names the *For the next builder* section of each earlier
part's report. Save each report with
`node .claude/skills/implement-plan/agent-report.mjs <agentId> .claude/loops/<dir>/<nn>-<part-slug>/builder.md "<heading>"`.
A part you built yourself passes its notes on in its `self.md` the same way.

- *Questions before building* go to `decider` in one call. Save its answer beside the report and
  return the decisions to the same builder with `SendMessage`.
- A `builder-lite` that escalates hands the part to a fresh `builder` with `brief.md` and
  `builder.md`.
- A builder that stops on a blocker stops the build: report it, with no later part started.

## 3. Audit

Once every part is built, a fresh `auditor` reviews the whole working-tree diff against all the
briefs — together they are its stated intent. Save its report to `audit.md`. A `green` verdict
with no red check in any builder's report goes straight to step 5.

## 4. One fix round

The round carries every blocking finding, every non-blocking finding that is a defect, and every
red check in a builder's report. Fix yourself every item *Build it yourself* allows, writing it to
the part's `self-fix.md`. Group the rest by the part they land in; each part's items go,
together, to one fresh builder, routed as *Which builder* → *Fix rounds* says: every item stating
its fix to `builder-lite`, otherwise a builder of the part's tier. An item spanning parts goes to
one builder of the highest tier among them. These builders also run one at a time. Write each
round's brief to `<nn>-<part-slug>/fix-round.md` and save its report to `fix-builder.md`.

A doc or comment replacement the auditor states in full, you apply yourself. A finding you decline,
and every *Pre-existing* defect, goes in the final report, never in the tree.

There is no second round and no second audit.

## 5. Verify, then `/pr`

Re-run every part's quick checks yourself and read their output. Anything red: stop and report it,
with no pull request.

All green: invoke the `pr` skill. When the tree held other work before step 1, pass it a scope
naming this change; otherwise pass nothing.

## Report

`/pr`'s report, followed by the findings left unfixed and why, the builders' *Choices*, and the
pre-existing defects found.

## Never

- Run two builders at once, or a second fix round.
- Spawn a builder for work *Build it yourself* allows, or build yourself what it does not.
- Skip the audit because you built the work yourself.
- Run a whole test suite — CI runs it through `/pr`.
- Commit, push or open a pull request outside `/pr`.
- Build past an open public-surface question, or past a brief's paths.
