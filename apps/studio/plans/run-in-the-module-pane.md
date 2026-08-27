# Running an application inside its own module pane

Supersedes the "UI: Deployment view" and "`RunView` is not a `ViewId`" sections of
[run-adapters.md](./run-adapters.md).

## Before

The Run control lived in the workspace top bar, beside Settings and the theme
toggle, while a run belongs to exactly one Application. Nothing in that row said
which application it would start, with which environment, or on which runner —
and it appeared, disabled, for Libraries that cannot run at all. The Deployment
tab, which decides what a run gets, sat in the module's own tab strip with no
relation to the button that consumed it, so a missing required value bounced the
user across that gap through a modal.

Starting a run then replaced the entire editor area, tab strip included: the
module's name, its views and the open-editors strip disappeared, and the output
read as a mode the window had entered rather than as this application running.

## After

Both halves live one level down, in the module's own view-tab strip.

- **The `Run` tab replaces `Deployment`**, and holds only configuration: the
  environment, the Application's declared variables and secrets, its declared
  ports, and any extra env vars. The trigger is not repeated here — it sits in
  the run bar directly above the view. A persisted `deployment` view hint is
  read as `run`.
- **A run bar sits at the right end of the same strip**, for Applications only:
  the active runner (click: opens Settings), Run/Stop, the live status chip and
  elapsed time, the recent-runs menu, and a toggle for the output dock. The
  environment is deliberately not named there — every Application has exactly
  one, so a chip for it mimicked a selector over a constant; the Run tab names
  it as its own heading, where it means something.
- **A bottom dock holds the output** — logs, events, endpoints, the Inspect
  link — pinned to the bottom of that module's pane, under the view tabs rather
  than over them. It is per Application: its open state, height and maximized
  flag follow the app, and switching modules swaps the dock's run.
- **Pressing Run does not navigate.** The dock opens on whichever view you were
  already on; collapsed it leaves a one-line status strip, and it can be
  maximized to fill the pane with the view tabs still above it.
- **Pre-flight failures render in the dock**, not as modals: an unavailable
  runner keeps its Recheck and its remedy, and missing required configuration
  offers *Fix in Run tab* — the neighbouring tab. The terms gate stays a modal:
  it is consent, not a run result.
- **The top bar keeps no run state at all.** Cross-module discovery is a live
  dot on each running Application in the module tree; running an app from the
  sidebar brings its module forward, since the output streams into that pane.

## Decisions

**Run state is keyed by Application, not by the window.** Selection, blockers,
the starting flag and dock geometry are all per app path in the run context, so
two applications can run at once and neither observes the other's dock. Global
state here is precisely what made a run a mode of the window.

**Dock geometry is in memory, not persisted.** It records where you were, which
is worth a module switch and not worth restoring against a workspace whose runs
came back as history shells.

**The environment lives in one place.** The Run tab names it and edits its
values. Repeating the name in the bar bought nothing while there is one
environment per Application, and would have to become a real selector — not a
shortcut — the day there are several.

## Verify

- Run from the Graph view: the view stays, the module tab strip and name stay,
  the dock opens below.
- Collapse the dock mid-run: a status line remains and the run keeps going.
- Switch modules and back: the same run and height return; another app shows its
  own dock or none.
- A missing required variable opens the dock with the reason and one click to
  the Run tab — no modal.
- A Library shows no run bar, no Run tab, no dock.
- With app A live, opening app B leaves A's dot showing in the sidebar and A's
  run untouched.
