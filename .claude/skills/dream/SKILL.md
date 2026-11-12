---
name: dream
description: Run only when the user types /dream. Mines the last N session transcripts for corrections, refusals and repeated failures, then refines Claude's own instruction files in place — CLAUDE.md guides, .claude/skills, .claude/agents and the project memory — and ends with a very short summary of what changed.
---

Refine Claude's own instructions from what actually happened in past sessions. `$ARGUMENTS` may hold a session count (default `30`) and any `--grep <regex>` filters, passed through to the miner.

**Invoking `/dream` authorizes every edit this skill describes, inside its scope.** Do not ask "Apply this?" and do not stop for approval. The rule against writing memories on your own is lifted for the memory directory while this skill runs. Never commit, push or stash.

## Scope

Edit only:

- every `CLAUDE.md` in the repo (root and nested), outside `.claude/worktrees/` and `node_modules/`
- `.claude/skills/*/SKILL.md` and the skills' markdown companions (`loop-rules.md`, `state-template.md`)
- `.claude/agents/*.md`
- the project memory: `~/.claude/projects/-home-pasi-projects-telorun-telo/memory/` (`MEMORY.md` and its files)

Never touch: this skill's own files, the authoring-agent primer (`apps/authoring-agent/chat/primer.md`), hub guides (`apps/hub/guides/`), `plans/`, `docs/`, module docs, `.claude/loops/`, `.claude/settings*.json`, `.claude/hooks/`, skill scripts (`*.mjs`, `*.sh`), or any source code.

## Step 1: Mine

Run `node .claude/skills/dream/mine.mjs --sessions <N> [--grep …] --out <scratchpad>/dream-digest.md` and read the digest. It lists, per session, every human prompt, with `[correction]` prompts (a heuristic, so judge each one) shown beside the assistant text they answered; `[interrupt]`, `[refused]` (the user rejected a tool call) and `[hook]` events; and tool errors repeated across sessions.

To dig into one theme, re-run with `--grep` (for example `--grep 'worktree|rebase'`), or read the full transcript `~/.claude/projects/-home-pasi-projects-telorun-telo/<session id>*.jsonl` with `jq`.

## Step 2: Turn the signals into findings

A finding is one behaviour to change, backed by evidence: session ids plus the user's words. Keep a finding when:

- the user corrected the same behaviour in **two or more sessions**, or
- the user stated a rule explicitly once ("ALWAYS", "never", "I said", "!!!"), or
- a tool error repeats because an instruction is wrong or missing (for example a skill tells agents to use a tool the session does not have).

Drop one-off task feedback that says nothing about how to work in general ("remove the delivered parts of this plan" is about one plan, unless it recurs). Drop anything already covered by an instruction that was followed afterwards.

For each kept finding, find out why it happened:

- **Missing**: no instruction covers it. Add one.
- **Ignored**: an instruction exists but was not followed. Make it harder to miss: move it to where the decision is made (the skill step, the agent definition), state it more directly, or merge duplicates that dilute it. Do not just repeat it in a second place.
- **Wrong**: the user contradicted an instruction. Correct it. The user's latest explicit words win.
- **Misplaced**: it lives in the root `CLAUDE.md` but applies to one package or one skill, or the other way round. Move it.

## Step 3: Hygiene pass

Over the in-scope files, regardless of the digest:

- **Stale references**: verify every path, script, skill name, agent name, env var and diagnostic code a rule names (`ls`, `grep`). Fix the reference if it moved; drop the rule only if what it governs no longer exists.
- **Contradictions** between files: resolve them to the version the user stated most recently; if there is no evidence, keep the stricter one.
- **Duplicates**: keep the rule in the one file that owns it (root vs nested guide vs skill), and cut the copies.
- **Memory**: each memory file follows the memory format (frontmatter `name`, `description`, `metadata.type`). Delete a memory that is wrong, or that duplicates what a `CLAUDE.md` or skill now states. Keep `MEMORY.md` one line per existing file. A rule about working in this repo belongs in `CLAUDE.md` or the skill it concerns, not in memory. Memory is for facts about the user and preferences that no repo file should carry.

## Step 4: Edit in place

Rules for every edit:

- **Preserve every constraint.** Shorten wording, never meaning. Never delete a rule only because no transcript exercised it.
- **Never weaken a rule the user stated.** Strengthen or relocate it instead.
- Keep each file's existing invariants. In particular, the root `CLAUDE.md` must never cite a plan path, its "Communicating" rules hold for everything you write, and nested guides keep owning their package's detail.
- Write new rules in the file's own style: imperative, concise, the reason in one clause where a reader would otherwise argue with the rule. No dates, no "the user said on…", no session ids in the files.
- Make targeted edits (`Edit`), not rewrites of whole files.
- If a finding needs a change outside scope (code, a hook, settings, a script), do not make it. List it in the summary under "Not done".

## Step 5: Summary

End with a very short summary, easy to scan, and nothing else: no preamble, no process narrative. Use exactly this shape:

```
Dreamed over <N> sessions (<first date> → <last date>).

Changed
- <file> — <what changed, ≤12 words> (<evidence: N sessions | stated rule | stale ref>)

Removed
- <file> — <what was cut and why, ≤12 words>

Not done
- <finding needing an out-of-scope change, ≤15 words>
```

Leave out a section that is empty. If nothing changed, the summary is the first line plus `No changes.`
