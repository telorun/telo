# Loop rules

The rules of one build loop, shared by two skills: `architect` plans it (phases 1–3: recon, cards,
the plan gate) and `implement-plan` executes it (phases 4–7 and the loop's end). Read this file once
per session; a session that read it while planning does not read it again when it continues into
`implement-plan`.

*You* are the loop's architect whichever skill you entered through. *A builder* is either agent —
`builder` (full) or `builder-lite` — chosen per card and per fix item (see *Which builder*). A
section named here that this file does not hold is in one of the two skills. When `implement-plan`
runs on a plan file, the invocation naming the plan stands where the plan gate's answer stands.

## Principles

**The shape of the loop: one stop, then work.** The user is never asked to make a decision. Every
choice the loop meets — design and scope alike — is settled by `decider` (see *Decisions*). The
one stop is the plan gate (phase 3), where the user sees the settled design and approves its
public surface and the queue, or corrects it. Mid-loop nothing is asked: a choice goes to `decider`,
a correction of the approved surface is applied and reported (see *Surface corrections*), and only
work that would give the feature new public surface is held for the user — once, at the end, while
everything else carries on. Nothing is ever guessed at.

**The user approves public surface, and only public surface.** Every approval the loop asks for —
at the plan gate and, rarely, after it — is stated as the public surface it adds, changes or
removes: kinds, fields, exports, functions, protocol methods, settings, commands, file formats,
diagnostic codes, CLI flags, published package names — each with what it does and why. Nothing else
is put to the user, and nothing else is a reason for a gate.

**One audit and one gate, at the end, in that order.** No card is reviewed or gated on its own. A
card is closed on its builder's quick checks. After the last card one `auditor` reads the whole
working-tree diff, its findings are fixed, and only then do you run the full gate, once — on the
tree that will be handed over, never on one the audit is about to change. That
is what catches what the cards did to each other, and it reads the feature as the user will. The
cost is that a design flaw surfaces once it has been built on, so the front of the loop carries the
weight: recon settles the design, `decider` closes every choice — what a review of the queue would
raise included — a builder asks what it may not settle before it writes any code, and a
card whose acceptance criteria you cannot check by command is re-cut before the plan gate, not after.

**Complete features, not MVPs.** The feature the user asked for is planned and delivered whole.
There is no "v1", no "basic support for", no stub, no placeholder, no `TODO`, no fast path that
handles the common case and leaves the general one, no static half deferred to a later card, and
no narrowing of the feature to make a check pass. A feature too large for one card is split into
cards that are each complete — never into a first one that half-works — and never into more than
three.

**Complete is bounded by the feature.** It means the feature's own surface, the static analysis
of that surface, its docs and its release bookkeeping. It does not mean closing every gap the work
walks past: a pre-existing defect in shared code, a sibling kind with the same weakness, a latent
bug the feature merely exercises, a thin test suite next door. Those are reported — under *For the
user* and in `BACKLOG.md` — and never absorbed. Overshoot is as much a defect as shortfall, and the
more expensive one: a kind of a few hundred lines that lands thousands of lines across a hundred
files has not delivered more, it has delivered something the user cannot review or commit. When a
pre-existing defect genuinely blocks the feature, the card parks and `decider` settles how the
feature lives with it; the loop does not fix the platform to unblock itself.

## The loop file

State lives in `.claude/loops/<YYYY-MM-DD>-<slug>.md`, created from `.claude/loops/TEMPLATE.md`,
where the slug is the loop's title in a few kebab-case words (`2026-09-11-stream-tap`). Several
loops can run in one day, so the date alone never identifies one; if the name is already taken
by another loop, append `-2`.

**Resuming is explicit.** When the invocation names an existing loop — by slug or filename — you
are resuming it: read its file and continue from the first card that is not `done` or `parked`.
Otherwise you are starting a new loop. Never choose a loop to resume by guessing from dates or
from which file looks unfinished; resuming the wrong one spends hours on work nobody asked for.

**One session holds a loop.** On start or resume, look for `<loop-file>.lock` beside the loop
file. If it exists, another session holds the loop: stop and tell the user, naming the file —
never delete a lock you did not write. Otherwise write it (your scratchpad path and the time) and
delete it when the loop ends or hands over. Two architects on one loop spawn builders that
overwrite each other.

Its six sections are the loop's whole memory:

- **Standing approvals** — the queue and its public surface as the loop's whole scope. Written at the plan gate, by the user's answer. This is the authorization
  that `CLAUDE.md`'s edit-gate requires, and it is scoped: approval covers the cards in the queue
  and the surface they deliver, nothing else.
- **Queue** — one card per unit of work, each with status `pending` / `running` / `done` /
  `parked`, and its evidence.
- **Decisions** — every decision `decider` made, one line each: where it arose and the decision
  itself, stated as behaviour. This line is the decision's only record.
- **For the user** — cards you dropped, pre-existing defects that blocked a card, every surface
  correction you applied without asking, and any new surface held for their answer. This is what
  the user reads first when the loop ends, so small corrections of docs and comments do not go
  here.
- **Incidental fixes** — behaviour-free corrections found along the way, each with its exact
  replacement, applied by you in one sweep at the end (see *Incidental fixes* below).
- **Report** — appended as you go, never rewritten at the end. A crash must leave a readable
  trail.

A card's entry keeps the template's shape: one line per field. How a round went, what a builder
reasoned, what an auditor argued — that narrative lives in the card's artifacts, never in the loop
file.

## Artifacts — what the user audits

The loop file holds your summary, and a summary is the one thing an audit cannot trust. So every
artifact is kept **verbatim** as well, in a directory named like the loop file
(`.claude/loops/<YYYY-MM-DD>-<slug>/`), written the moment it
exists and never reconstructed at the end — a crash has to leave the evidence behind.

**You never retype a report.** A subagent's report is saved from its transcript, by command, the
moment it returns:
`node .claude/skills/implement-plan/agent-report.mjs <agentId> <file> "<heading>"` appends it verbatim
under the heading and prints the agent's context size. Copying a report out by hand costs minutes
and tokens per report and can only make it less faithful. What you write yourself is the briefs,
the loop file, and your notes on what you did with a report.

- `00-planning/plan.md` — the plan file as given, verbatim, when the loop implements one.
- `00-planning/recon.md` — each `scout` report, saved by command, and the recon runs of phase 1.
- `<nn>-<card-slug>/brief.md` — the brief exactly as you handed it to the builder, written before
  you spawn it. Auditing what was built is meaningless without what was asked. A fix round is
  appended under its own heading.
- `<nn>-<card-slug>/builder.md` — the builder's report, saved by command. Its questions before
  building, when it had any, and each fix round are appended under their own headings, never
  overwriting the first. It ends with a section *For the next builder*, which is how one card's
  builder hands what it learnt to the next.
- `97-incidental-fixes.md` — the entries the incidental-fix sweep applied, and any it could not.
- `99-final-audit.md` — the loop's one audit, over the whole working-tree diff, as returned. It
  runs before the gate; the file names keep their numbers and do not give the order.
- `98-gate.md` — the loop's one gate, run after the audit's fixes: every gate command you ran, with
  its full output, written by
  `sh .claude/skills/implement-plan/gate.sh <gate.md> "<heading>" "<command>" …`, which runs each command,
  records its output, exit status and duration and the tree's `git diff --shortstat`, and prints one
  line per command. A re-run after a fix is appended under its own heading. Truncate nothing here;
  the loop file is where the short version belongs.
- `99-fixes/` — the final audit's fix rounds: `items.md` (the findings split into fix items), a
  brief per item sent to the builder, the builder's report per item, the snapshots `pre-fix.tree`
  and `pre-final.tree`, `fix.diff` (what the fixes changed, as the verification pass reads it), and
  `final-round-gate.md` (the final round's scoped re-run).
- `99-fix-audit.md` — the verification pass over the fix diff, when fixes were made.

**These are the only files a loop writes**, beside its loop file and its lines in
`.claude/loops/BACKLOG.md` and `.claude/loops/LESSONS.md`. No decision files, no question files, no
option analyses, no queue drafts, no design summaries: a `decider` answer lives as one line under
*Decisions*, an `analyst`'s options live in the prompt you give `decider`, and the design the user
must see is shown to them in the conversation at the plan gate, never parked in a file for them to
open.

No per-card diff snapshots are kept. The loop never commits, so the tree is one cumulative change;
the final audit reads the live tree, and each card's **Evidence** records `git diff --shortstat` and
the count of new files when the card ended. The one thing the live tree cannot give back is what the
fixes changed, so the tree is snapshotted before the audit's first fix and before the final round
(`sh .claude/skills/implement-plan/tree-snapshot.sh save <id-file>`, a git tree object built in a
throwaway index — no commit, no stash, the index and `HEAD` untouched), and
`tree-snapshot.sh diff <id-file>` prints what changed since, untracked files included.

Each card's **Evidence** in the loop file stays one line and points at these paths. Your summary
and the artifact must never disagree: if a builder's report or `98-gate.md` shows a failure, the card
says so too. These are ordinary files in the repo — add an ignore rule if you would rather a loop's diffs
were not tracked.

## Decisions

**Every architectural decision goes to `decider`.** Whenever the loop meets a choice between
shapes, you do not choose, and neither does a builder, `analyst` or an `auditor`. That
covers where code lives, a package boundary or the direction of a dependency, a generic primitive
or a specific one, a kind's schema, capability or annotations, how a static check is modelled, and
which of several fixes a finding needs. They supply options, and `decider` decides. Spawn a fresh
`decider` per set of related decisions and give it:

- the questions — every one that touches the same kind, shape, contract, boundary or
  vocabulary, in one prompt
- every option on the table, with who proposed it
- the facts recon established
- the `CLAUDE.md` rules that bear on it

**Related decisions are one call.** Questions whose answers constrain each other — a data shape
and the kinds that consume it, where a converter lives and what it takes as input — go to ONE
`decider`, which decides them in dependency order and makes them agree. Never split them across
parallel deciders and reconcile afterwards: parallel answers to related questions contradict each
other, and the reconciliation is a second decision that reopens the first. Only questions that
share nothing run in parallel.

Its answer may pick an option as given, amend one, or be a new option. Take it as returned, and
record its one line under *Decisions* before you act on it.

**What is not a decision for `decider`.** A choice a builder meets while building that stays
inside the approved public surface and changes no kind's schema, capability or annotations, no
package boundary, no static check's model and no earlier decision is the builder's to make: it
picks, and lists the choice under *Choices* in its report. You read that list and send on only the
entries that do touch one of those — as one `decider` call per card, never one per question. The
rest stands unless the final audit finds it wrong. Asking `decider` to confirm what a builder
already built correctly buys nothing: in practice three of four such questions come back "as
built", each batch costs a decider run and usually a fix round of tests and docs, and the final
audit reads the same code anyway.


**Scope choices go to `decider` too**, framed by the user's request: whether an optional part is
in, how the feature lives with a pre-existing defect, whether a prerequisite is built or the
feature narrowed. Tell it that what the request asks for is in, that what it does not ask for is
out, and that overshoot is a defect (see *Complete is bounded by the feature*). The user corrects
scope at the plan gate by editing the queue, not by answering questions.

**Parallel deciders must not contradict each other.** Decisions that share a surface — the same
kind, shape or boundary — go to one `decider` together, or in sequence with the earlier answers
given as facts. Never run them in parallel and reconcile afterwards.

**A decision binds the rest of the loop.**

- A builder receives the decision and its obligations, never the rejected options.
- The final `auditor` receives every decision the loop made, so it judges the tree against them
  rather than reopening the approach.
- A finding that contradicts a decision reopens it only when it brings a fact `decider` did not
  have. It then goes to a fresh `decider` with that fact. You never overrule a decision yourself.

**Obligations become acceptance.** What a decision commits the work to, such as an analyzer twin,
a `requires:` floor, a migration, docs or the authoring-agent primer, joins the acceptance
criteria of the card it lands in.

**Decisions are never brought to the user.** Not for confirmation, not as a choice between
options, not with their rejected alternatives. Before the gate, the user sees the design they
produced — as the design, not as a list of decisions to approve. After the gate, a decision is
applied; what it does to the approved surface is governed by *Surface corrections*.

## Surface corrections

The user approved a design, not a transcript of field names. After the plan gate, a decision or a
finding often shows that one approved item, as written, is wrong against the approved design
itself. **Such a correction is applied without asking.** Waiting for the user on it stalls a loop
for hours over something they will answer "obviously" to.

A change to approved public surface is a **correction**, applied at once, when it does not give
the feature anything new and a `decider` decision (or an audit finding with one evident fix)
requires it. That covers:

- **Removing what can never occur** — an enum value, field, output, throw or diagnostic code that
  no code path can produce or that an approved rule makes unreachable.
- **A refusal that closes a gap in an approved rule** — an existing or already-approved diagnostic
  or error code reported for one more input or in one more place, where without it the approved
  rule can be bypassed or silently not honoured.
- **A narrowing or tightening** — a stricter schema, a value set losing a member, one more member
  of a list of failure codes the user approved as such.
- **Renames and shape fixes forced by consistency** with another approved item, where only one
  spelling can be right.

Apply it, record its one line under *Decisions*, and list it under *For the user* as "surface
corrected: was …, is …, because …". The user reads these in the closing summary; none of them is
a question.

A change is **new surface**, and is the user's to approve, only when it adds a capability or takes
one away: a new kind, export, function, protocol method, setting, command, CLI flag or file
format; a new field or option an author can use; removing or changing what an approved item does
for someone who used it as approved; anything a `decider` marks as a scope change. New surface
never blocks the loop: the card is finished without it, the item is recorded under *For the user*
with what it adds and why, all such items are put to the user **once**, together, in the closing
summary — or earlier only when a later card cannot be built without the answer — and work that
does not depend on the answer carries on.

When in doubt whether a change is a correction or new surface, ask what someone who relied on the
approved text loses or gains. Nothing gained and nothing legitimate lost is a correction.

## Cards

Write the queue, with as few cards as the work allows: **one is the norm, three the
hard maximum.** Every card boundary costs a brief and a round trip to the builder; a coarse card costs none of that. Split only along a boundary that is
real — a different package, a different runtime, work that must land before the rest
can be written — never to make cards small. A feature that seems to need more than three cards is
cut coarser, not longer; if it truly cannot fit in three, that is a scope question for the user —
at the plan gate, or at `implement-plan`'s one stop for a plan file.

A card is one reviewable change with: its intent in one
sentence, the paths it may touch, acceptance criteria a reader can check, the commands
that prove it (the builder's quick checks, and what the loop's gate must run for it), a **size** (the files and roughly the lines recon says it needs), and its **builder** (see *Which builder*). A card must
be verifiable by a command, and must not depend on
a card that is still `pending` unless you order them accordingly. A card you cannot state
acceptance criteria for is not understood yet — go back to recon, do not split it into more cards.

Read `.claude/loops/LESSONS.md` before cutting: its lines on sizing and paths are about cards, and
a card that repeats a recorded mistake repeats its cost. Every card and every criterion traces to
the user's request or to a line under *Decisions*; one that traces to neither is cut, since nothing
after this point reads the queue for scope before the user does.

**The queue is the feature.** Every card is part of what the user asked for. A card that is not —
a prerequisite, a platform fix, a primitive a doc example would like to use — goes to the gate on
its own line, saying why the feature cannot be complete without it. When the honest answer is that
an example or a nicety wants it, narrow the example; do not build the prerequisite.

**Acceptance states behaviour, not tests.** Write what must be true of the result — "a handler
failure stops the stream with the handler's own code, and that value is not delivered" — never the
test cases to write. The builder chooses the tests: one per behaviour, at the lowest level that
proves it. Scenarios enumerated in a card before the implementation exists are how a small kind
ends up with more test than code.

What a card may **not** be, because the audit at the end of the loop will reject the result — and
by then it is built on, which is why it is caught here:

- **An MVP.** "A follow-up card will finish it", "v1 of", "basic support for", a `TODO`, a stub,
  or acceptance criteria that describe less than the card's own intent are all the same defect.
- **A slice that defers its own static analysis.** A card that makes the kernel validate
  something at runtime, or that adds surface — a kind, a field, a slot — carries the analyzer's
  matching check in the *same* card. This is about the card's own change: a static gap that
  predates it belongs on recon's pre-existing list, not in the card.
- **An adjacent fix.** Correcting a defect the card only runs into, applying the card's change to
  sibling kinds that share the weakness, hardening shared code "while we are there". Backlog it.
- **A use-case shortcut where a generic primitive belongs.** Telo's default is the generic
  primitive. Generic describes the *shape* of what the card builds, not how many other callers it
  fixes.
- **Docs and release bookkeeping as someone else's problem.** A card touching a module carries
  that module's docs; a card touching a published package or module carries its changeset or
  release fragment. `CLAUDE.md` makes both mandatory, so they are acceptance criteria, not
  chores to sweep up at the end.
- **A major version bump.** Breaking changes ship as minors here, deliberately.

## Which builder

Two agents build: `builder` (full — Opus, effort `medium` or `high`) and `builder-lite` (Sonnet,
reads only what its brief names, decides nothing architectural). A card's **Builder** line is
`lite`, `full-medium` or `full-high`, set when the card is cut.

A card is `lite` only when **all** of these hold:

- it adds or changes no public surface, no kind's schema, capability or annotations, no analyzer
  check and no diagnostic code;
- it follows a pattern recon named, inside one package or module;
- it is small — about five files and two hundred lines at most;
- its quick checks prove its acceptance.

Otherwise it is `full`. When in doubt, `full`: a lite round that escalates costs more than it
saved. With at most three cards, most first cards are `full`; `lite` earns its keep on doc,
migration and call-site cards, and on fix work.

**Fix rounds** — a card's own fix round, an audit fix item, a gate failure — go to a **fresh**
builder by default, not to the card's builder by `SendMessage`. A builder's context is cached for
five minutes. One that reported longer ago than that has gone cold, and resuming it rewrites the
whole context — about $2 at 400k — before every turn of the round re-reads it. That is where most
of a loop's cache rewrites come from. A fresh builder starts small: give it the card's `brief.md`,
its `builder.md` and the round's items, and nothing else.

- A round whose every item states its one fix goes to a fresh `builder-lite`. The saving is its
  small context; Sonnet's cache reads cost what Opus's do.
- A round with an item that needs judgment goes to a fresh full `builder`.
- `SendMessage` to the card's own builder is reserved for two cases. One is answering its
  *Questions before building*, while its context is still small. The other is a round that needs
  the judgment it already holds, sent within four minutes of its report and while its context is
  under 450k tokens (`agent-report.mjs` prints the size each time you save a report).

**Escalation.** `builder-lite` stops with an `Escalate:` heading instead of asking questions. Save
that report to the card's `builder.md` as usual, then hand the card to a fresh full `builder` with
its `brief.md` and `builder.md`; the hand-over is not a fix round. A `lite` card still red after its
first fix round gets its second round from a fresh full `builder`, inside the two-round limit.

## Cost rules

- At most three cards. Each extra card is another brief and fix cycle.
- `scout` is Haiku. Recon is reading, and reading does not need a frontier model.
- `builder-lite` for every card and fix item that qualifies (see *Which builder*); the full
  `builder` for the rest.
- One audit per loop, over the whole tree, plus the single verification pass over its fixes. A
  per-card review re-reads the same context for a slice of the picture, and costs a pass each time.
- One `decider` per set of related decisions; independent sets may run in parallel. Asking the
  same question again without a new fact is shopping for a different answer.
- `SendMessage` only to a card's own builder, and only while its cache is warm (see *Fix rounds*).
  Every other role, every next card and every cold fix round is a fresh subagent.
- No wait of four minutes or more inside a builder. A command or poll loop past the five-minute
  cache expiry makes the builder's next turn rewrite its whole context. A check that slow is the
  gate's, never a builder's quick check.
- Builders and scouts never read under `.claude/worktrees/`: those are other branches' trees, and
  they were 15% of what builders read.
- The full gate once per loop, by you, after the audit's fixes have landed — never before the
  audit, whose fixes would make that run throwaway. Builders run quick checks only, and no card is
  gated on its own. It is re-run in full only after a fix made in answer to the gate itself; the
  final round re-runs what it reaches (see *The verification pass*). Never between cards, never
  between two fix rounds you already know about. The whole suite run per card is the loop's largest
  avoidable cost.
- One `decider` call at planning (with the planning checklist, which stands in for a queue review),
  one per card for the questions its builder asks before it writes, and a second per card only for
  what building itself turned up. Never a call to confirm what was built.
- A brief points at the card, the decisions and the rules; it restates none of them.
- One fix round carries everything known. A second round exists for what the builder's next report
  then shows.
- Reports are saved by `agent-report.mjs`, never retyped.
- Nothing waits for the user after the plan gate except new surface, and that waits once, at the
  end, with the rest of the loop finished.
- Gates in one command where possible. Ten probing commands cost more than the suite.
- A gate that spends money — a suite that calls a paid model or API — runs once per loop, after
  the last fix and before the closing summary. Cards, fix rounds and builders gate on the offline
  cases; a brief says so, since a builder otherwise runs everything its gates list. A failure the
  offline cases cannot reach is re-run alone, never by re-running the whole paid suite.
- One test per behaviour. A second proof of the same behaviour is cost, not coverage.
- Park early. The cheapest card is the one you stopped working on at round two.
- Measure before changing these rules: `loop-cost.mjs` and `cache-misses.mjs` beside this file
  read past loops' transcripts and report each role's cost and where caches expired.

## Hard rules this loop must never break

- **Never commit, amend, push, or stash.** `CLAUDE.md` forbids it and that does not relax
  inside a loop. A card's evidence is its builder's check results plus `git diff --stat`, and the loop's is its gate
  output; the user commits.
- **Never add a card after the plan gate** without a new gate the user answers (see *The queue
  is fixed*).
- **Never make an architectural decision yourself, and never overrule `decider`.** Bring a new
  fact to a fresh `decider` instead.
- **Never give the feature public surface the user did not approve.** New surface is held for the
  user and never built on a guess; a correction of approved surface is applied and reported (see
  *Surface corrections*) — never held. Your incidental-fix sweep touches only the recorded
  entries.
- Never weaken or delete a test to make a gate pass. A gate that passes because its check was
  removed is the failure this loop exists to prevent.
- Report failures as failures, in the report, with the output. A loop that ends claiming eight
  green cards when two were parked is worse than a loop that ends early.
- Never mark a card `done` on partial work. `done` means the complete change landed and its builder's
  quick checks are green with nothing owed; anything less is `parked`, with what remains written
  under *For the user*. A `done` card is still unproved by you until the loop's gate has run, and the
  report says so wherever it mentions a card before then.
- **Never end a loop on an ungated tree.** Every loop that changed anything runs the full gate once
  before it ends, even one that parked most of its cards, and every change made after that run is
  covered by a re-run of the commands it reaches.
- **Never end a loop on an unaudited tree.** Every loop that changed anything runs the final audit,
  even one that parked most of its cards. A tree nobody read is worse than a
  short loop, because the report claims work that was never checked.
