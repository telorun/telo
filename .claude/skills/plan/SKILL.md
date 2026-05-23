---
name: plan
description: Collaboratively plan a new feature. Gather context, ask questions, analyze together, then write a short high-level plan to ./plans only after explicit user approval.
argument-hint: Feature idea or description (optional)
---

Collaboratively plan a new feature with the user. Do NOT write the plan file until the user explicitly approves.

## Phase 0 — Make sure you know what feature to plan

Before doing anything else, check whether the user has given enough detail to understand **what** they want to build. A bare invocation like `/plan-new-feature` with no description, or a one-word topic, is not enough.

If the feature is unclear or under-specified:

- Do NOT start scanning the codebase yet.
- Do NOT make assumptions about scope.
- Ask the user to describe the feature: what it does, who it's for, what problem it solves.

Only proceed to Phase 1 once you have a workable description.

## Phase 1 — Gather context (silent)

Before asking anything, read enough of the codebase to ask informed questions:

- Scan top-level structure, relevant modules, existing patterns the feature would touch.
- Check `./plans/` for related prior plans and reuse their conventions.
- Note constraints from `CLAUDE.md` and any module-level conventions.

Do not dump findings — use them to shape better questions.

## Phase 2 — Ask the user questions

Ask focused questions to remove ambiguity. Cover, as relevant:

- **Goal & scope** — what problem this solves, who the user is, what's explicitly out of scope.
- **Behavior** — inputs, outputs, edge cases, failure modes, idempotency, concurrency.
- **Integration points** — which existing modules/tables/APIs are touched or reused.
- **Non-functional** — performance, security, observability, migration/rollback.
- **Open decisions** — when multiple reasonable approaches exist, list them with trade-offs and ask the user to pick.

Batch related questions. Don't ask things you can answer from the code yourself.

## Phase 3 — User asks questions, joint analysis

Let the user probe your understanding and challenge assumptions. Iterate until you both agree on:

- The shape of the solution at a high level.
- Which existing pieces are reused vs. new.
- Key risks and how the plan addresses them.

## Phase 4 — Resolve every open question

Before asking for go-ahead, make sure **every** decision is settled. No item is left for "later" or "TBD". For each open question either:

- Get the user to decide, or
- Decide yourself with a clear rationale and confirm the choice with the user.

If anything is still uncertain, go back to Phase 2 or 3. The plan will be refined further by the user afterwards, but it must not ship with open questions.

## Phase 5 — Get explicit go-ahead

Do NOT write the plan until the user explicitly says to write it (e.g. "write the plan", "go ahead", "looks good, save it"). If unsure, ask.

## Phase 6 — Write the plan

Write to `./plans/<kebab-case-name>.md`. The plan must be:

- **Short** — aim for one page; never more than two.
- **High-level** — architecture, module boundaries, data flow, key decisions and their rationale.
- **No code** — no TypeScript, SQL, YAML, or pseudocode blocks. File paths and module names are fine; implementation snippets are not.
- **Decision-focused** — capture _why_ choices were made (especially rejected alternatives) so future readers understand the trade-offs.
- **Complete** — no open questions, no "TBD", no "to be decided later". Every decision is made.

Structure:

1. **Problem** — what we're solving and why it matters.
2. **Solution** — the chosen approach in prose, with module/file references.
3. **Decisions** — bullet list of the non-obvious choices made, each with a one-line rationale (and rejected alternative where relevant).

After writing, report the path and stop. Do not start implementing.

Do not change the plan until the user explicitly says to update it.
