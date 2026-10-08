---
name: lens
description: Run only when the user types /lens. Never invoke it yourself, whatever the task or however the request is phrased. Builds or extends a decider lens with the user and writes it into .claude/decider-lenses/.
disable-model-invocation: true
argument-hint: a decision idea (`who retries`, `reliability`), or nothing / `give new idea` for suggestions
---

The user supplies a decision idea as `$ARGUMENTS` — a domain ("reliability"), a single rule ("who retries"), or a worry ("our services call each other too much") — or asks you for one: `$ARGUMENTS` empty, or a request such as "give new idea" or "what next?". Your job is a conversation that ends in a lens file the `decider` agent reads. The decider finds a lens through the index in its own prompt (`.claude/agents/decider.md`, under "Domain lenses"), so a lens missing from the index is never read and one whose row is stale is read for the wrong questions — the index is updated in the same write as the lens.

Ask questions directly in chat, never through the AskUserQuestion tool. Write nothing until the user explicitly says to apply.

## Step 1: Place the idea

Read `.claude/agents/decider.md` and every file in `.claude/decider-lenses/`. Then tell the user, in a few lines:

- whether the idea extends an existing lens or needs a new one, and why;
- what the existing lenses already settle about it — never re-ask a settled choice;
- the contested choices you see in it, as a short list, recommending which to take first.

**When the user asks for an idea**, propose two or three candidates instead of placing one. Draw them from:

- domains no lens covers yet — the cross-cutting concerns listed in the root `CLAUDE.md` are a good source;
- gaps inside existing lenses — a question a lens touches but does not settle.

For each candidate, give two to four of the real disagreements it holds, one line each, and why getting them wrong is expensive or hard to undo. Recommend one. Once the user picks, place it as described above and continue with Step 2.

**Only contested choices earn a question.** A choice belongs in a lens when competent teams genuinely disagree about it. When an idea is obvious ("the app must be secure"), say so, and find the disagreements underneath it ("where is authorization checked: edge, owner, or policy engine?"). If none exist, say the idea needs no lens.

## Step 2: Decide, one proposal at a time

Present exactly ONE decision per message, numbered `D1`, `D2`, …, continuing across the whole lens. Never bundle decisions or recap several for a combined answer, even related ones. Each decision:

- **a plain explanation first.** The user decides from it, so define terms, give a concrete example, and show what goes wrong. Write for someone who has not met the concept.
- **options labelled (a), (b), (c)**, the recommended one first and marked *(recommended)*;
- **for each losing option, the concrete failure it leads to**, measured against Telo's core goals and the horizon (a second replica, 100× the data, a second backend, a consumer nobody has written yet) — never effort, schedule or backwards compatibility;
- how it connects to decisions already made, in this lens or another.

**No variants.** Every option is a plain letter the user picks as-is — never an "(a), with …" amendment offered alongside the options. When an amendment strengthens the recommended option, fold it into that option; when it is a separate choice, it becomes its own decision later.

End by asking the user to pick. Then handle the answer:

- **Pick** → open the next message with one line stating the decision as recorded, then present the next decision.
- **Pushback or an addition** → when it is valid, concede plainly, restate the decision as amended, and ask the user to accept it before moving on. Never defend a position the pushback has overturned.
- **An answer to a decision still open while another was presented** → record it, then re-ask the one still pending.
- **"It's case by case"** → the choice holds a branch. Find the property of the case that decides it, and propose it as a distinguishing question with a consequence for each answer. It must be a property the decider can settle from the question and the codebase, never one it has to ask about.
- **A decision that contradicts another lens** → propose the amendment to that lens as part of the same decision. Never leave two lenses disagreeing.

## Step 3: Disqualifiers

When the contested choices you listed are decided, offer any further contested choice you found along the way as a single optional next decision, or moving on. Once the principles are settled, present the disqualifiers — one list in one message, for the user to accept, strike or amend — each as:

- **Forbidden:** a concrete example;
- **Instead:** what to do;
- **Why:** the failure it causes;
- **Branch:** only when the item depends on the case.

Say which items the principles already cover, and fold those in rather than listing them twice.

## Step 4: Horizon and Verify

Propose these explicitly and get them approved. Never write them unseen.

- **Horizon:** the futures specific to this domain, each with what fails under it.
- **Verify:** the checks a decision in this domain should name — how someone would know, later, that it held.

## Step 5: Write

Summarize what the file will hold, and show the index row that goes with it. Ask "Apply this?" and write only on an explicit yes. A new lens goes to `.claude/decider-lenses/<domain>.md`, with a kebab-case domain name. Never add a README or any other non-lens file to that directory.

**Keep the decider's index in step, in the same write.** The table under "Domain lenses" in `.claude/agents/decider.md` holds one row per lens: the filename and the questions that trigger it.

- A new lens adds its row, in alphabetical order by filename.
- An extension that changes what the lens applies to rewrites its row; one that does not leaves the row alone.
- A renamed or removed lens has its row renamed or removed.

A row is written for matching, not for reading: name the things a question in this domain actually mentions — the manifest keys, the concepts, the words a caller would use — because the decider matches a question against the row without opening the file. It is derived from the lens's **Applies to**, widened with those terms. Before writing, check that the table's rows and the files in the directory are the same set, and repair any difference you find.

The file is written for the decider, not for the user. Keep a line only if it is one of these:

1. **a contested choice**, stated as the side taken, plus a short *why* only when the reason is not obvious. The why is what lets the decider apply the rule to cases the lens does not list.
2. **a Telo mapping** — what the concept is in Telo terms;
3. **a branch condition** and its consequence;
4. **a check** the decider must not forget, in one line.

Cut definitions, textbook reasoning, and the explanations you gave the user. A rule a strong model already knows stays only as a one-line check.

Use these sections, in this order:

- `# Lens: <Title>`
- **Applies to** — one or two lines: which questions trigger the lens, and how it relates to the other lenses.
- `## Principles, in ranking order` — numbered, each one bold-headed rule plus at most a few lines.
- `## Distinguishing questions` — numbered, each one short question.
- `## Consequences` — bullets keyed by the answer (**Derived** → …); disqualified options named as "is disqualified". Then **Always:** — the rules that hold in every case.
- `## Horizon` — one line of futures, separated by ` · `.
- `## Verify` — numbered checks.

When the lens extends an existing one, edit only what changed, in the same form.

## Step 6: Report

Say what was written or amended, including any other lens you touched and the index row you added or changed. Flag any part of the file the user has not seen word for word.
