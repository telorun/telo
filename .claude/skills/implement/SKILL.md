---
name: implement
description: Run only when the user types /implement. Never invoke it yourself, whatever the task. Implements one task whose design is settled — named in the arguments, pointed at by the user, or just agreed in this conversation — with as many builders as it needs, one audit, one fix round, then /pr.
argument-hint: a task, a path to one (a backlog entry, a plan section, an issue), or nothing for the design just agreed in this conversation
---

Carry one settled task to a green pull request: builders build it, one `auditor` reviews it, one fix
round answers the review, `/pr` lands it. Write no report files; briefs go in the builder's prompt.

## 1. Settle the task

The task is what the arguments name or point at, or — with no arguments — the design this
conversation just agreed. Record `git status` first, so you know what the tree held before.

Stop and ask, building nothing, when no task can be identified or a public-surface question (a kind,
field, schema shape, diagnostic code, package boundary) is still open.

Otherwise cut the task into **parts**, as few as it needs — one is the norm. Split only along a real
boundary: a different package or runtime, work that must land first, or more than one builder's
context holds. Each part is one complete change, never an MVP or an adjacent fix.

Each part's brief: intent in one sentence, the conversation's decisions verbatim, acceptance
criteria as behaviour, paths it may touch, quick checks that prove it, and its tier.

## Tiers

- `lite` (`builder-lite`) — mechanical: the brief and an existing pattern fully determine the
  change. In doubt between `lite` and `standard`, take `lite`.
- `standard` (`builder`) — any settled work, new surface included. In doubt between `standard` and
  `high`, take `standard`.
- `high` (`builder-high`) — the builder must design something hard: a new analyzer check, a kernel
  refusal with its analyzer twin, a mechanism changed across kernel and analyzer or Node and Rust
  that the decisions do not spell out, CEL typing/evaluation, effects and teardown, init order,
  durable execution or concurrency. Merely touching those areas is `standard`.

## Build it yourself

Do a part (or a fix item) yourself, with no builder, only when **all** hold: you already read every
file it touches; the conversation settled its one shape; it is a few files and a few dozen lines,
test included; it stays inside the brief's paths and the decided surface. Hold it to
`.claude/agents/builder.md`'s standard.

## 2. Build

One part at a time, a fresh builder each. A brief after the first also carries
the earlier builders' *For the next builder* notes.

- Questions before building go to `decider` in one call; return its decisions to the same builder.
- A `builder-lite` that escalates hands the part to a fresh `builder`.
- A builder that stops on a blocker stops the build: report it, start no later part.

## 3. Audit

A fresh `auditor` reviews the whole working-tree diff against all the briefs. Audit even work you built
yourself. A `green` verdict with no red builder check goes straight to step 5.

## 4. One fix round

Carry every blocking finding, every non-blocking defect and every red builder check. Do yourself
what *Build it yourself* allows and any doc or comment replacement the auditor states in full. Group
the rest by part, one fresh builder per part: `builder-lite` when every item states its fix,
otherwise `builder`, `builder-high` only when an item reopens a `high` part's design; an item
spanning parts goes to one `builder`.

A declined finding and every pre-existing defect go in the final message, never in the tree. No
second round, no second audit, never two builders at once.

## 5. Verify, then `/pr`

Re-run every part's quick checks and read the output. Anything red: stop and report it, no pull
request. All green: invoke `pr`, passing a scope naming this change if the tree held other work
before step 1.

Final message: `/pr`'s result, then findings left unfixed and why, builders' *Choices*, and
pre-existing defects found.
