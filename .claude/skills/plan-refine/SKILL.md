---
name: plan-refine
description: Refine an implementation plan until it is ready to implement — up to three rounds of reviewer review, decider decisions and plan edits, with full usage examples as the first concern and every new name weighed against alternatives.
argument-hint: Plan path (optional; defaults to the selected file)
---

Refine one plan in `plans/` until it is ready for implementation. Invoking this skill authorizes
edits to **that plan file only**. Never edit any other file, never commit, never change the plan's
`status:` — approving a plan is the user's call.

The plan is the argument, else the file selected in the editor. If neither names a file under
`plans/`, ask for it and stop.

Refinement makes a plan correct, not bigger. Every mechanism it adds is something a maintainer
keeps working forever, so a mechanism is added only for a failure that happens in practice, and the
first answer to a problem inside a mechanism is removing that mechanism.

Before the first round, copy the plan unchanged to the scratchpad — the **original**, which the
final report's **What changed** compares against. Never rely on git for it: a plan is often
untracked.

## The round (at most 3)

### 1. Review

Spawn a fresh `reviewer` agent each round. Its prompt holds: the plan's path, the **Review
checklist** below copied in full, and — from round 2 on — the **settled decisions** so far, each
one sentence. Settled decisions are facts: the reviewer may reopen one only by naming a new,
concrete failure it causes, never by restating a rejected option.

### 2. Sort

**Reality test first.** An issue's failure is **real** only when it happens in normal operation:
someone following the documented process, with no malice, no bypassed rule, no bug in a third-party
tool and no race between two manual steps. An issue whose failure is not real is **Hypothetical** —
listed in the final report, never acted on. An issue whose scenario or frequency the reviewer did
not state is judged by reading the plan; when it still cannot be shown real, it is Hypothetical.

Every entry of the reviewer's **name inventory** is a **Name**: it skips the reality test and goes
to Decide.

Sort every other issue into exactly one of:

- **Decision** — only one of:
  - an **open decision**: the plan names a choice without making it;
  - a **gap that forces a choice**: the plan cannot be implemented as written without choosing
    something it does not state — including a choice the plan made that the reviewer shows fails in
    a concrete case, and a settled decision the reviewer reopened with a new failure.
- **Fix** — a missing step, a wrong fact, redundant text, or a missing, incomplete or incorrect
  usage example. Settled by editing, not by choosing.
- **Removal** — a mechanism that guards only a Hypothetical failure, or serves no failure at all.
  Settled by deleting it and everything that only served it.
- **User question** — scope or product intent that no architectural argument settles (what the
  feature is for, who uses it). Never guessed; collected for the final report.
- **Alternative not taken** — a different design for a choice the plan already made, with no
  concrete failure of the current one. The plan stays as it is; collected for the final report.

An issue that is none of these is reported, not decided. Never settle an architectural choice
yourself.

### 3. Decide

Send all of the round's decisions to `decider` in **one** call, as a set of related questions, each
with the reviewer's options and the plan's path. When the issue sits inside a mechanism the plan or
this refinement added, add **removing that mechanism** as an option. Skip the call when there are
none. Tell it that maintenance cost counts here, whatever its usual brief says: a mechanism a
maintainer must keep working is a cost. Ask it to state, beside each answer:

- the failure the chosen option prevents, who hits it, and how often;
- the machinery the answer adds — workflows, ref or tag families, state files, commands, refusals,
  checks;
- the simplest sound option, and what that option gives up.

The round's **Names** go in the same call — a name and a design choice constrain each other, so
they are decided together. Each name is its own question, carrying the plan's name and the
reviewer's alternatives, with the **Naming rubric** below copied in full. The three statements
above are not asked for names.

### 4. Weigh

Apply the decider's **simplest sound option**. Apply its full answer instead only when the simplest
option leaves a failure that passes the reality test; hold every other full answer for the final
report.

**Ledger.** Keep a list of every mechanism this refinement has added — a workflow, a ref or tag
family, a state file, a command, a refusal, a check — each with the decision that added it and the
real failure it prevents. A round adds a mechanism only for a real failure, and records it here.

**Chain check, every round, over the whole ledger.** Before editing, each entry must still earn its
place. An entry that guards a problem created by another entry is weighed together with it as one
chain; when the chain's root can be replaced by its simplest sound option, or removed, do that and
delete everything that only served it. Never add a layer to fix a layer.

A chosen name is applied as the decider returns it; it is never held.

Every answer, applied or held, becomes a settled decision for later rounds — a held one in its
simpler form.

### 5. Edit

Apply every decision, fix and removal to the plan yourself:

- State each decision as the decision itself; remove any decision section it closes — the plan
  reflects the current state, not how it was reached.
- When a decision changes a user-facing surface, update every example in the same round.
- Apply each chosen name everywhere in the plan — prose, examples, Verify.
- Bring in only the obligations the repo's rules require as plan steps: analyzer twin,
  `requires:` floor, migration, docs, primer, benefits ledger. Any other obligation the decider
  lists is held for the final report.
- Keep the plan's rules: valid frontmatter, no code other than usage examples, no source paths,
  observable artifacts named exactly, Before / After / Verify, short.

### 6. Stop or continue

Stop when the reviewer returns no issues and no names, or when every remaining issue is Hypothetical or lies in
machinery this refinement added — that machinery is weighed by the chain check, not reviewed again.
Otherwise start the next round, up to three.

## Examples

Usage examples are the most important part of a plan and are reviewed first, every round. An
example is a fenced code block inside the plan itself, showing what a user writes, types or sets.

**When required.** Every surface the plan adds or changes for a user has a full example:

- **Manifest** — a kind, a key, an annotation, a tag, an import form: a YAML block.
- **Command line** — a command or flag: a shell session with the commands and the output that
  matters, refusals included.
- **Configuration** — an env var, a setting, a file a user edits or reads: the values set, or the
  file's content.
- **Wire** — an HTTP endpoint, a protocol message, an MCP tool: a request with its response.

A plan that changes only internals needs none. A required example that is missing is a fix.

**Full means:**

- Complete as written: no ellipses, placeholders or "rest unchanged". A manifest example is a whole
  document stream — the module doc, its `imports:` with real sources, every resource and `targets:`.
- A **Before** example beside the **After** when the plan changes existing surface.
- Every new item of that surface appears in it, and at least one refused case — with the message or
  diagnostic code the user sees — when the plan adds a refusal.
- It shows how a real user would use the feature, including its hard case, not a toy that avoids it.

Examples are judged by reading only — never run them, `telo format` or `telo check` on them, since
they may show surface that is not implemented yet.

## Naming rubric

Copy this section verbatim into every decider call that carries names.

> For each name, weigh the plan's name, the reviewer's alternatives and any better name you find;
> you may coin one. Names in one plan are decided together and must agree with each other.
>
> Disqualified — a candidate that:
>
> - collides with an existing name in the same namespace (a kind, a key, a module, a code, a flag)
> - uses a different word for a concept Telo already names, or the same word for a different one
> - names a backend or an implementation in a generic kind, field or module
> - only makes sense against history (`new`, `v2`, `legacy`, `unlike before`)
> - breaks the case rules (PascalCase types, camelCase values), is a CEL keyword, or is a
>   diagnostic code not spelled `<SUBJECT>_<PROBLEM>`
>
> Among the survivors, pick the one that:
>
> 1. uses the term established systems converge on for the same concept, when they converge
> 2. says what the thing is or does, not how it is built
> 3. reads right where it is used — `<Alias>.<Kind>`, `resources.<name>.<field>`, `--flag`, the
>    diagnostic a user reads
> 4. is the word a searcher on the hub would type
> 5. is shorter, when everything above ties
>
> For each name return the chosen name, labelled *kept*, *alternative* or *new*, and one sentence
> on why it beats the others.

## Review checklist

Copy this section verbatim into every reviewer prompt.

> Perform a read-only review of an implementation plan. Do NOT modify any files (including the plan
> itself).
>
> **Review the usage examples first.** An example is a fenced code block inside the plan. Every
> surface the plan adds or changes for a user — manifest (a YAML block), command line (a shell
> session with the output that matters), configuration (env vars, settings, a file's content), wire
> (a request with its response) — must carry a full example: complete as written, no ellipses or
> placeholders, a Before beside the After when existing surface changes, every new item of that
> surface used, a refused case with the message or code the user sees when the plan adds a refusal,
> and the feature used as a real user would, including its hard case. Each example must match the
> plan's current decisions and prose exactly.
>
> A manifest example is a whole document stream — module doc, `imports:` with real sources, every
> resource, `targets:` — and must also:
>
> - be type safe
> - write CEL only behind `!cel` / `!interpolate`, never as a plain string holding `${{`
> - declare a resource used exactly once inline at its use site, without `metadata.name` (a router
>   mounted on a server stays named)
> - write short leaves in YAML flow style
> - follow the naming rules: PascalCase for types, camelCase for values
> - use no `JS.Script`
>
> A missing, incomplete or incorrect example is an issue.
>
> **Then list every name** the plan introduces or changes that a user sees — module, kind, key,
> annotation, tag, diagnostic code, command, flag, env var, file path, event — as a **name
> inventory**, each with the plan's name and 2–3 alternatives. When settled decisions are given,
> list only names that are new or changed since; a settled name is reopened only with a concrete
> problem it causes. A name is never an issue — it goes in the inventory.
>
> Then determine whether the proposed plan is sound, sustainable long-term, and aligned with Telo's
> core goals:
>
> - **Polyglot architecture** — Telo must support controllers and runtimes in any language, not
>   just Node.js
> - **Visual editing** — Telo manifests must remain visually editable in a GUI editor; the plan
>   must not break declarative structure or introduce constructs that can't be represented visually
> - **Performance** — the init loop, CEL evaluation, and resource resolution must stay fast; the
>   plan must not introduce unnecessary overhead
> - **Static analysis** — YAML manifests must remain statically analyzable; the plan must preserve
>   the ability to validate references, type-check CEL expressions, and detect errors without
>   running the kernel
>
> Focus on:
>
> - architecture and design of the proposed solution
> - package boundaries, dependency direction, and where code lives
> - encapsulation, modularity, cohesion, and coupling implied by the plan
> - whether the plan reaches for a generic primitive or a use-case-specific shortcut (default
>   should be the generic primitive)
> - whether `JS.Script` is being used where a new resource kind would be a better fit
> - scope creep, missing steps, unstated assumptions, and risks
> - open decisions the plan still carries
> - adherence to Telo's core goals
> - whether the plan contains redundant text that doesn't add value for implementers
> - proportionality: mechanisms out of proportion to the Problem section, each named with the
>   decision it stems from and a simpler alternative
> - for every mechanism the plan contains, whether the problem it solves happens in practice; a
>   mechanism that guards only a hypothetical failure is an issue — report it for removal
>
> Never mention:
>
> - minor implementation details that don't affect the overall soundness of the plan
> - gaps that can be easily filled in during implementation without affecting the overall design
> - backwards compatibility issues - telo is not released yet and breaking changes are expected and
>   desired
> - failures that need misuse, malice, a bypassed rule, a bug in a third-party tool, or a race
>   between two manual steps
>
> Make sure there is no major version bump in any of the packages or modules.
>
> Find alternative solutions or well known generic patterns that would make the plan smaller —
> fewer mechanisms, fewer states, fewer refusals — and suggest them.
>
> Report every important issue you are sure of — not only the top few — each with options to solve
> it, the scenario that triggers it, and how often it happens (every release, sometimes, only on
> misuse). If you are not sure whether something is an issue, investigate more. Avoid nitpicks or
> minor style issues unless they have a meaningful impact on readability or maintainability. Do not
> summarize what is sound about the plan. Keep each issue concise. Focus on behaviour and design in
> the plan itself, not on implementation details; never point to source code or line numbers.
>
> If you find no issues, say exactly that.

## Final report

Lead with the verdict:

- **Ready** — when the last review returned no issues, examples included, or only issues that are
  Hypothetical or lie in machinery the chain check settled.
- **Not ready** — three rounds ran and real issues remain; list them.

Then **What changed**: compare the refined plan with the original and list only what moved in one
of four groups, one line each — before → after, and the decision, name or removal that caused it:

- **Public contract** — manifest kinds, keys and annotations, controller and SDK interfaces, wire
  formats.
- **Visible surface** — names, CLI commands and flags, env vars, on-disk files, diagnostic codes a
  user sees.
- **New maintenance work** — workflows, checks, state files, anything someone keeps working; these
  match the ledger.
- **User procedures** — steps an author, operator or maintainer must now take, or no longer takes.

Leave out fixes, filled gaps, wording and added examples — an example counts only when it shows
surface the original lacked. When nothing in the four groups moved, say so in one line.

Then, briefly: the rounds run, each decision and removal made (one sentence each), each name chosen
(with the plan's name it replaced, if any), and any user questions — asked, not answered.

Then **Machinery added**: every ledger entry still in the plan, with the real failure it prevents,
so the user can strike any of them.

Then **Hypothetical issues**, one line each: the issue and why its failure is not real.

Then **Alternatives not taken**, one line each: the alternative and the plan choice it would replace.

Then **Held for you**: for each, the decider's full answer or the obligation not brought in, the
simpler option the plan now carries, and what the simpler option gives up — so the user can opt back
into the larger one.
