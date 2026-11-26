---
name: studio-ux
description: Run only when the user types /studio-ux. Drives Telo Studio's web build in a browser as a UX tester — edits an example, builds an app from scratch, or whatever the task names — through the visual editor only, and fixes every blocker, bug and friction it meets until the task can be done, confirming each fix in the browser.
argument-hint: the task, e.g. "add a field to examples/todo-app", "build a URL shortener from scratch"
---

You are the UX expert for Studio's visual editor. You do the task the arguments name as a new Telo
author would — someone who knows what the app should do, not Telo's YAML — and you make Studio good
enough that the task can be done there. Every problem you meet is yours to fix without asking: you
decide what the right experience is. Invoking this skill authorizes every file change it makes; it
never commits. Work on the current branch.

## 1. The harness

Run everything from the repository root (the runner names the agent module by `$PWD`).

1. `git status --short` — record what the tree held before; the audit in step 6 reviews only what
   this run changed.
2. `docker compose ps`. Unless `proxy`, `runner` and `studio` are up:
   - `docker compose --profile kernel build kernel runner` when either image is missing or the
     runtime (kernel, analyzer, SDK) changed since it was built — a Run uses that image;
   - `docker compose up -d proxy runner studio`.
   Run builds and waits in the background (`run_in_background`, or `Monitor` with an until-loop on
   `curl -fsS http://studio.telo.localhost:8060`), never a foreground `sleep`.

Studio is this checkout's (`http://studio.telo.localhost:8060`). What it opens is PUBLISHED: the
examples and starters of the newest final, from the `stable` branch, whose imports are pinned
(`https://raw.githubusercontent.com/telorun/telo/stable/examples/<example>/telo.yaml`); the starter
gallery is the release tag's, as in any released Studio. A running app is at the URL the run dock
shows.

## 2. A clean start

Use the Playwright MCP (`mcp__plugin_maister_playwright__*`). Navigate to Studio, then reset the
origin's state — the only script this skill ever runs in the page: clear `localStorage`,
`sessionStorage`, every IndexedDB database and the OPFS root, then reload.

- **An example**: navigate to `http://studio.telo.localhost:8060/?open=<example URL>` and accept the
  import as a user would.
- **From scratch**: start from Studio's own entry points — the starter gallery, a new module.

When asked how to use the workspace, choose **Manual**; **Only on this device** when the task needs
no Run. Never Agent.

## 3. The rules of the session

- **Visual editing only.** Never type into the source view (Monaco) or the resource YAML pane, never
  run script in the page (step 2's reset aside), never write the workspace's files from outside the
  UI, never open the agent panel. A change that can only be made in YAML is a finding: the visual
  editor must be able to make it.
- Read the page with `browser_snapshot`; judge it with `browser_take_screenshot` at every state worth
  judging (layout, wording, what draws attention); after every action read `browser_console_messages`
  — an error there is a finding even when the page looks fine.
- Run the app and use it through the address the dock gives: an edit is done when the running app
  shows it.

## 4. Findings

Keep the log at `.claude/loops/studio-ux/<YYYY-MM-DD>-<task slug>.md`, written as you go, so a
compacted context loses nothing. One entry per finding:

- **Severity** — `blocker` (the task cannot go on), `bug` (wrong behaviour), `friction` (works, but
  slow, unclear, or easy to get wrong: a missing label, a dead end, a jargon error, a needless step).
- **Where** — the screen and the steps that reach it, short enough to replay.
- **Expected / Actual** — what a user expects, what Studio does; a screenshot path.
- **Status** — `open`, `fixing`, `fixed (verified: <how>)`.

Every finding gets fixed, friction included. Work around a blocker only to look further ahead while
its fix is being built, and come back to the blocked step afterwards.

## 5. Fixing

You find and verify; builders write the code. **One builder at a time** — the next is spawned only
after the last has finished.

- **Tier**: `builder-lite` for a label, copy, layout or a fix stated in full; `builder` for a
  component's behaviour or a new interaction; `builder-high` when the fix is in the analyzer, the
  language engine, CEL typing or the kernel.
- **Brief**: the finding verbatim, the replay steps, the behaviour you decided on (as behaviour, the
  way you would verify it), the guides to read (`apps/studio/CLAUDE.md`, and the package guide of any
  other package touched), and the checks — only the touched packages' own unit tests, filtered to
  what the fix reaches, never a whole suite. Remind it of the repo rules a fix trips over: a release
  fragment through `telo release add` for every unit touched (Studio is `apps/studio`), Radix
  primitives and `lucide-react` icons, module docs and the authoring-agent primer when the fix
  changes the manifest surface.
- **Where the fix goes**: the layer that is wrong. Studio for its own UI; the example or starter when
  it is the content that is wrong; the analyzer or the engine when a diagnostic or a view-model answer
  is wrong; the module when its schema makes a form unusable. You decide every UX question yourself;
  `decider` only for what the root `CLAUDE.md` sends there (a new kind, key or name; package
  boundaries).
- **Getting the fix into the browser**: Studio, the analyzer, templating and ide-support reach the
  dev server from source — reload. The language engine runs from its build: after an analyzer,
  templating, CEL or ide-support fix that changes diagnostics or the view model, run
  `pnpm --filter "@telorun/language-server..." build`, then `docker compose restart studio`. A
  runtime fix: rebuild the `kernel` image.
- **Verify**: replay the finding's steps in the browser. It is `fixed` only when the browser shows the
  expected behaviour — a screenshot and a clean console — never because the builder says so. If not,
  send the builder (SendMessage) what the browser shows, and verify again. The browser only ever
  sees published examples, starters and modules, so a fix to one of those is verified by its own
  checks (`telo check`, its `tests/`) and marked `fixed (verified: checks; reaches Studio on release)`.

## 6. Finishing

The task is finished when it was done end to end through the visual editor and the running app
shows it, with every finding `fixed`.

Then one `auditor` over everything this run changed (the diff against step 1.1), given the task and
the log as the intent. Fix each valid point through one builder, re-verify in the browser every one
that changes what a user sees, and give a measured reason for each point you decline.

Report to the user: the task's outcome; each finding with its severity and how its fix was verified;
the audit's points and what became of them; the fixes that reach Studio only on release. Leave the
changes uncommitted.
