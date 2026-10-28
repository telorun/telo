---
name: implement-plan
description: Run only when the user types /implement-plan, or when the architect skill hands over a loop whose plan gate the user approved. Never invoke it on your own for an ordinary request to implement, fix or build something, however it is phrased. Executes an approved build loop or a written plan — cards, builders, fix rounds, one audit and one gate — with state kept in .claude/loops.
argument-hint: An approved loop's slug or file to execute or resume, or the path of a plan file to implement
---

You execute one build loop: you delegate every edit to a builder — a fresh one per card — except
incidental fixes and small fixes you fully understand, which you make yourself (see *Incidental
fixes* and *Small fixes by the architect*), run the full gate yourself, once, after the audit's
fixes have landed, and keep the loop's state on disk so a crashed session can be resumed.

Read `loop-rules.md` beside this file before anything else, unless you already read it in this
session as the architect. It holds the principles, the loop file, the artifacts, decisions,
surface corrections, cards, which builder takes what, the cost rules and the hard rules — all of
which bind you here.

## What you are given

- **A loop** — its slug or file, or the loop `architect` just handed over in this session. Its
  plan gate is answered and its *Standing approvals* are the scope. Take its lock as the loop
  rules say; when the architect of this same session holds it, it is already yours. Continue from
  the first card that is not `done` or `parked`. A loop whose plan gate is not answered is not
  yours: stop and say it needs `/architect` first.
- **A plan file** — invoking this skill on a plan is the approval. The plan's public surface and
  what it asks for are the loop's whole scope; there is no plan gate and nothing is asked before
  work starts, except the one stop below.
  1. Create the loop file as the loop rules say, copy the plan verbatim to
     `00-planning/plan.md`, and write under *Standing approvals* that the scope is that plan,
     approved by the invocation that named it.
  2. Map only what the cards need: a `scout` per area, saved to `00-planning/recon.md`. No
     `analyst` and no design pass — the plan is the design.
  3. Cut the queue as *Cards* says. Every card and criterion traces to the plan or to a line
     under *Decisions*.
  4. What the plan leaves open goes to `decider` (see *Decisions*). Public surface the plan does
     not contain is new surface (see *Surface corrections*): held, never built.
  5. **The one stop.** A plan that asks for what a card may not be — an MVP, a deferred static
     half, an adjacent fix, a major bump — is raised with the user before anything is built,
     naming the conflict. Never build it as written, and never quietly rewrite it.

  Then start at phase 4.
- **Neither** — stop and ask which loop or plan. Never pick one by guessing.

## Phases

**4. Execute.** A fresh builder builds each card, in queue order: spawn one per card — the agent
its **Builder** line names (`lite` → `builder-lite`, `standard` → `builder`, `high` →
`builder-high`) — after the previous card's fix rounds are finished. Write the card's `brief.md` before you spawn the builder
and point the builder at that file, so what is on disk is what was actually sent.

**The brief points; it does not restate.** The card is in the loop file, the decisions are under
*Decisions*, the rules are in `CLAUDE.md` and the nested guides, and the shape of the report is in
the builder's own definition — the builder reads all of them. So a brief holds only:

- the loop file's path and the card's number: the card is read there, never copied;
- which lines under *Decisions* bind the card, named by tag and opening words, and any obligation
  they put on this card that its acceptance does not already state;
- where to start reading, by section, never by whole file: the heading of `00-planning/recon.md`
  on the card's area, the existing code recon found to follow, and the *For the next builder*
  section of each earlier card's `builder.md`;
- which nested `CLAUDE.md` guides cover the card's paths — named, never quoted;
- `.claude/loops/LESSONS.md`;
- the quick checks as exact commands, each with its expected duration, where the card's *Checks*
  line does not already give them. A check that takes four minutes or more is not a quick check
  (see *Cost rules*): it is the gate's, and the brief says so;
- what is written nowhere else: the state of the tree (earlier cards uncommitted, a change that is
  the user's), ports already taken, a stop condition.

A sentence that repeats the card, a decision or a rule is cut. Every restated line is minutes of
your output and context the builder needs for the code; a brief that runs past a page is restating
something. The same holds for a fix round's brief: the items and their decisions, nothing the
builder already holds.

**Questions come before code.** A builder first reads the brief and the code. If it then holds a
question it may not settle — one that touches public surface, a kind's schema, a boundary, a static
check's model or an earlier decision — it hands back once, before writing anything, with only those
questions, each with the options it sees and the facts behind them. Save that hand-back to the
card's `builder.md` under its own heading, send the questions to `decider` in one call, record its
lines, and return the decisions to the same builder with `SendMessage`; it builds from there. A
builder with no such question does not hand back. A decision that arrives after the code exists is
a fix round over everything built on the guess, which is why the question is asked first.

A fresh builder per card is deliberate. A card of a few thousand lines fills most of a builder's
context, so a builder carrying the queue has to be replaced between cards anyway — after writing a
handover it has no room left to write well. Instead every builder report ends with a section *For
the next builder* (conventions it learnt, helpers to reuse, traps, how to run each check quickly),
and the next card's brief points at those sections. Who takes a card's fix rounds is decided by
*Fix rounds* below. Never let a builder touch an earlier card's code beyond what the current
card's acceptance requires.

**The builder runs the quick checks, not the gate.** The brief names them: the type check, the
tests of the packages and modules it changed, and `pnpm run check` on the manifests it touched —
single tests while it works, each changed package's tests once before it reports, unless that run
takes four minutes or more. Nobody in the loop runs the whole repo's suite — that is CI's. Every
wait past the five-minute cache expiry also makes the builder rewrite its whole context.

A builder decides the small choices it meets and lists them under *Choices* in its report (see
*What is not a decision for `decider`*). A question it may not settle that only building turned
up — one the code could not have shown it beforehand — it reports as a question in its final
report: send those to `decider` in one call, then send the decisions as part of the card's fix
round, to the builder *Fix rounds* names.

**5. Close the card — no gate.** A card is not gated on its own. When its builder reports, read the
report: its quick checks with their results, its *Choices*, its *Questions*. A failed or skipped
check, an open question or a decided answer starts a fix round (phase 6); collect everything known
first and send it as one round. A card is `done` when the complete change has landed, its builder's
last report shows every quick check green, and nothing is owed to it. Put the builder's results in
the card's **Evidence** as what they are — the builder's own checks, not yours — with
`git diff --shortstat` and the count of new files.

Then compare what the card changed with its size. A card well past it — more than twice the files
or lines — goes to phase 6 with "cut to the acceptance criteria" as a finding, unless
every change is required by a criterion, in which case record why the estimate was wrong.

A card whose acceptance criteria no command can verify is not `done`; it parks. Do not run the
whole suite here and do not substitute an audit: the loop has exactly one gate and one audit, both
at the end (see *Ending the loop*). The only exception is a later card that cannot be WRITTEN
without knowing an earlier one holds — then run the single command that answers that, not the gate.

**6. Fixes.** Send relevant findings as a fix round, at most twice per card, to the builder
*Fix rounds* names. One round carries everything known at that moment —
failed checks, decided answers, surface corrections — never one message per finding. If the card is not green after two rounds, park it — mark it `parked`, write why under
*For the user*, and move on. Grinding a third round costs more than a human glance.

Before a round, a finding that admits more than one fix shape goes to `decider`, and so does a
finding the builder disputes on architectural grounds. The builder receives the decision, not the
choice. Consulting `decider` is not a round.

A fix round closes findings about the card's own change. A finding about code the card did not
create — pre-existing, in a sibling, in shared code — is never sent to the builder; it goes to
`BACKLOG.md`. A fix round never shrinks the card to make findings go away — dropping a case,
loosening a schema, weakening acceptance criteria or deleting a check to reach green is worse than
leaving the card red, because the report will then read green. Nor does it grow the card: a fix
that needs new public surface or behaviour beyond the acceptance criteria is held as new surface
(see *Surface corrections*); a correction of the approved surface is part of the round. Removing a redundant
test that the audit called out is not weakening a test.

**7. Report and compound.** Append the card's outcome to the report. Then do the thing that makes the next loop better than this one: if
a card taught you a rule, add it to `.claude/loops/BACKLOG.md` as a follow-up, or propose an edit
to this skill.

What a card or the audit taught that the next brief or the next queue should carry goes to
`.claude/loops/LESSONS.md`, the moment it is learnt and again from the closing summary's "next
loop" notes — a lesson left in one loop's report is read by nobody. A lesson is one line: when it
applies, then what a card must state or a builder must exercise ("a card that bounds or consumes a
stream — exercise the body nobody reads"). Check that no line already covers it, and delete a line
the code has made untrue. What belongs in a `CLAUDE.md` or in this skill is proposed there, not
parked in that file.

A new or changed rule in any `CLAUDE.md` is **proposed, never applied** — those
files are the user's contract with every session, not yours. A factual defect in one — a dangling
path, a renamed symbol, a claim the code contradicts — is not a rule: it is an incidental fix, and
you fix it (see *Incidental fixes*).

If a card turned out to need a written plan, `CLAUDE.md` says where it goes and what it may
contain: the package it affects most, no open decisions. Keep it to a page, and keep code out
of it.

## The queue is fixed

The plan gate — or, for a plan file, the invocation naming it — approves the loop's whole scope. Nothing discovered afterwards becomes a card in
this loop — however well its root cause is understood, however small the fix looks, however
directly it blocks a card. A blocker parks the card that hit it, with the defect under *For the
user* and in `BACKLOG.md`.

A user message mid-loop resumes or stops existing cards. When acting on it would take work no
approved card covers — a new card, new public surface, a design pass for a fix — that is a new
plan gate: present the new surface (what is added or removed, each with what it does and why) and
any new cards with their sizes, and wait for an answer that approves them. A correction of the
approved surface is not such work (see *Surface corrections*). "Continue" or "do card 3" approves card 3, not the platform fix card 3 is parked on.

## Incidental fixes

A loop keeps finding small things wrong next to its work — a comment the change made stale, a
doc sentence still describing the old rule, a wrong claim in a README. Parking each one for the
user turns a finished loop into a to-do list, so these you fix yourself, in one sweep at the end — no builder, no extra card.

A finding is incidental only when **all** of these hold:

- **It changes no behaviour.** A comment, a doc or README sentence, a manifest `description`, an
  example's prose. Never code, a schema, a test, a version, or anything on a public surface.
- **It has exactly one correct fix, stated in full** — path, lines, and the replacement text. A
  fix that needs a judgment call is not incidental: route it as a decision (see *Decisions*).
- **It is small** — a few lines in any one file.
- **Its path is one the loop's cards touch, or a `CLAUDE.md`.** In a `CLAUDE.md` only a factual
  correction qualifies — a dangling path, a renamed symbol, a claim the code contradicts — and it
  is always fixed, never left for the user. A new or changed rule there stays proposed-only.
- **It is reproduced in this checkout.** Grep the file in the working tree yourself before
  recording it: a builder may have read a copy under `.claude/worktrees/`, which is another
  branch's tree and never this loop's to edit.

Record one under *Incidental fixes* in the loop file the moment it turns up — whoever found it:
a builder's report, an auditor's finding, or you — and carry on. Work a card *needs* is never
incidental: a doc the card's own change made wrong belongs in that card's paths and acceptance,
not in the sweep.

After the last card, apply exactly the recorded replacements yourself and nothing else, and write
what you applied to `97-incidental-fixes.md`. This runs before the whole-tree audit and the loop's
gate, so the audit sees it and the gate proves it. An entry you cannot apply as written — the line moved, the text no
longer matches — goes to *For the user* rather than being improvised.

## Small fixes by the architect

A builder costs a brief, a spawn and the time it takes to learn the code. For a small fix that you
already understand completely, that is more than the fix itself, so you make it yourself. This
applies to a fix-round finding, an audit fix item or a final-round fix. It applies only when all
of these hold:

- **You understand the whole problem.** You have read the code involved and know the cause. The
  fix has one shape: `decider` settled it, or the finding states it and nothing else is plausible.
- **It is small.** A few lines of code in one or two files, plus the one test that pins it.
- **Briefing a builder would cost more than the fix.** Its context is not loaded, and bringing a
  builder up to speed takes longer than doing the work.
- **It stays inside the approved public surface and the card's paths.**

The fix is held to the same standard as a builder's work. Write what you changed and why to the
item's artifacts (`<nn>-<card-slug>/architect-fix.md` or `99-fixes/`). Run the checks the fix
touches yourself and record them there; the loop's gate, or the final round's re-run,
covers the rest. Report it as your own change, never as a builder's. Anything larger, or
anything you would have to explore to understand, still goes to the builder.

## Ending the loop

Stop when the queue has no `pending` card, when what is left cannot be built without new public
surface the user has not approved, when two cards park — with three cards at most, that is a signal the plan was wrong,
not the builder. Every card not started is reported as not started.

The end of a loop runs in a fixed order: the incidental-fix sweep, the audit, its fixes, the gate,
the verification pass, the final round. The audit comes before the gate because it reads the diff
and runs what its findings need itself; a gate run before it proves a tree the audit's fixes are
about to change, and the gate is then paid for twice.

### The audit — after the last card

When the last card is `done` or `parked` and the incidental-fix sweep has been applied, spawn one
fresh `auditor` (read-only, high effort) over the **whole** working-tree diff. This is the loop's
only review, so give it what a per-card review would have had: every card with its acceptance
criteria and size, every decision the loop made, every choice the builders listed, every surface
correction applied, and the fact that the diff is cumulative. Tell it too that the full gate has
not run yet: the tree rests on the builders' quick checks, which you name, so it runs what a
finding needs and never the whole suite. Save its findings to `99-final-audit.md` with
`agent-report.mjs`.

Reading the tree at once is what makes this worth more than the per-card reviews it replaces: it
sees what the cards did to *each other* — a boundary two cards crossed from opposite sides, a
second spelling of one rule, a kind-name heuristic that looked local — and it judges the feature
whole rather than a slice at a time. A static-analysis gap in the loop's own change is relevant
however the cards were written; a pre-existing one goes to `BACKLOG.md`.

**Then fix what is relevant**, because nothing else will. Before the first fix, snapshot the tree
the audit read: `sh .claude/skills/implement-plan/tree-snapshot.sh save <loop-dir>/99-fixes/pre-fix.tree`.
Then split the relevant findings into
**fix items**: each item is one finding, or several that share a fix, with the paths it touches
and what must be true once it is fixed — within the approved public surface. Write the split to
`99-fixes/items.md` before sending anything. Send the items of one card as one round, their brief
written to `99-fixes/` first, to the builder *Fix rounds* names — by now that card's own builder
is cold, so a fresh one. An item that spans cards goes to one fresh builder with the briefs and
reports of the cards it spans — or you make it yourself under *Small fixes by the architect*.

The rules of phase 6 hold unchanged: two rounds at most, `decider` settles
a finding with more than one fix shape, a finding about code the loop did not write goes to
`BACKLOG.md`, and no fix shrinks the work to reach green. A finding still open after two rounds is
reported, not quietly dropped.

### The gate — once, after the audit's fixes

When the audit's fixes have landed — or it found nothing to fix — run the gate
yourself, once, over what the loop touched:
`sh .claude/skills/implement-plan/gate.sh <loop-dir>/98-gate.md "<heading>" "<command>" …` (in the
background; it writes each command's full output and duration and prints one line per command). It
runs everything every card named, scoped to the loop's own modules and packages — never a whole
suite, which CI runs: the manifest tests of every module the loop touched
(`pnpm run test --include '<module>/tests/*.yaml'`, plus any root `tests/*.yaml` a card named),
the type checks and unit tests of every package the loop touched, `pnpm run check <manifests>`
where a card asked for it, the single integration tests a card's acceptance rests on, the release
and licence checks when a card added a module or a fragment, and the Rust crates' own
`cargo test -p <crate>` when a card touched the Rust half — the JS tests cannot see a Rust break. A
builder reporting "tests pass" is a claim; this run is the evidence.

Read its output yourself, the durations included: a command that takes minutes and has never failed
for a loop like this one is a note for the closing summary. A failure belongs to the card whose
paths it is in: split the failures by
card, send each card's as one fix round to the builder *Fix rounds* names (or fix it yourself
under *Small fixes by the architect*), under the rules of
phase 6, and re-run only the failed commands until they pass, then the whole gate once more. A
failure that is the environment's and not the tree's is re-run alone, said so in `98-gate.md`, and
logged in `BACKLOG.md`. A card whose gate failure is still open after two rounds is `parked`, and
the report says the tree is red there.

### The verification pass

When any fix was made after the audit — one of its fix items, or a gate failure's — write what the
fixes changed to a file,
`sh .claude/skills/implement-plan/tree-snapshot.sh diff <loop-dir>/99-fixes/pre-fix.tree > <loop-dir>/99-fixes/fix.diff`,
and spawn **one** more `auditor` over that diff alone — not the tree — with the findings it
answers, to confirm the fixes did what they claim and broke nothing. Point it at the file: without
it the auditor has to work out from a cumulative tree which lines the fixes wrote. Save it to
`99-fix-audit.md`. When no fix was made after the audit, there is no verification pass.

**Then fix what that pass reports, as the loop's last step.** Every blocking finding, every defect
and every should-fix in the loop's own change is fixed now — never handed to the user as open
work. Snapshot first (`tree-snapshot.sh save <loop-dir>/99-fixes/pre-final.tree`). A finding with
more than one fix shape goes to `decider` first. Each fix goes to the builder,
or you make it yourself under the rule in *Small fixes by the architect*. This round is outside
the two-round limit. No further audit follows, so read
`tree-snapshot.sh diff <loop-dir>/99-fixes/pre-final.tree` yourself against
each finding before you call it closed. Only a finding that genuinely cannot be fixed within the
approved public surface, one about code the loop did not write, or a pure nit goes under *For the
user*, each with the finding, the reason and the diff.

**The final round re-runs what it reaches, not the whole gate.** The gate has already proven
the tree this round started from, so its re-run is scoped by the round's own paths
(`tree-snapshot.sh diff <loop-dir>/99-fixes/pre-final.tree --name-only`), and written to
`99-fixes/final-round-gate.md` with `gate.sh`:

- **A module's or a package's source, or a `telo.yaml`** — that unit's type check, unit tests,
  `telo check` and its own manifest tests. Its dependents are CI's.
- **Only tests, fixtures and docs** — the changed tests alone (`pnpm run test --include <path>` per
  manifest test, the package's own test command for a unit test).
- **In every case, each other gate command one of whose inputs is among the paths** — the release
  check for a fragment or a `telo.yaml`, the previous-CLI check for a `telo.yaml`, the licence
  check for a `package.json`, a `LICENSE` or a new directory, the touched crate's
  `cargo test -p <crate>` for a Rust path.

Say in the run's heading which gate commands were left out. A round that changed nothing has no
re-run.

Then write the closing summary in the report: cards done, cards parked, the audit's verdict and
what remains open from it, what needs the user, the decisions made after the plan gate, and what
you would change about the next loop — each such note that a brief or a queue should carry also
goes to `.claude/loops/LESSONS.md` (see phase 7). Delete the lock last.
