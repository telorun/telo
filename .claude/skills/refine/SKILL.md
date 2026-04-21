---
name: refine
description: Surface concrete options to refine or refactor a given package. Read-only analysis; does not modify files.
---

Do NOT modify any files. This is a read-only analysis task.

The user will supply a package path (or name) as `$ARGUMENTS`. If `$ARGUMENTS` is empty or ambiguous (e.g. just a name that matches multiple locations), ask the user to clarify before proceeding.

## Step 1: Locate the package

Resolve `$ARGUMENTS` to a concrete directory. Packages typically live under `modules/<name>/`, `kernel/`, `cli/`, `sdk/`, `analyzer/`, `yaml-cel-templating/`, `apps/`, or `ide/`. If the argument is a bare name, check `modules/<name>/` first. Confirm the resolved path before spawning the agent.

## Step 2: Refine

Use the Agent tool to spawn the `refiner` agent with the following prompt:

> Examine the package at `<resolved path>` and surface concrete options to refine or refactor it.
>
> Rules:
>
> - Do NOT modify any files.
> - Ground every option in specific file paths and line ranges from the package.
> - Consider both Telo's core architectural goals (polyglot, visual editing, performance, static analysis) and general code-quality refinement categories (cohesion, duplication, abstraction fit, dead code, naming, error handling, test coverage, docs drift).
> - Rate each option's impact and effort independently, sort by impact-to-effort ratio (best first), and call out quick wins (large impact, small effort) up top.
>
> Read CLAUDE.md for architectural context.
>
> Follow the response structure defined in your agent instructions (Package summary / Refinement options / Out of scope / Open questions).

## Step 3: Present

Relay the refiner's output to the user verbatim, preserving its structure (keep the Quick wins section prominent). Do not collapse options and do not start implementing. After presenting, recommend starting with the quick wins if any were identified, then ask the user which option(s) they want to pursue — and wait for an explicit go-ahead before making any changes.
