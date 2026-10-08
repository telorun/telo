---
name: pr
description: Run only when the user types /pr. Never invoke it yourself, whatever the task.
argument-hint: nothing (every change in the working tree), or which part of the working tree to land (`for phase 1`, `the stdlib changes`), plus anything the commit message or PR body should say
---

The user has a change in the working tree and is away. You carry it to "a green PR", alone. The
user's invocation is the authorization for this skill's staging, commit, push, amend and
force-push — for this change and this branch only. Merging is never yours.

## 1. Establish the change

- **The branch is the current one.** Refuse to start on `main`: say so and stop.
- **Without an argument naming a scope, the change is everything in the working tree:** staged,
  unstaged and untracked alike. Stage all of it (`git add -A`). What is already staged says
  nothing about what the user meant to leave out. With a clean tree, say so and stop.
- **With an argument naming a scope** (`for phase 1`, `the stdlib changes`), stage exactly that
  scope yourself:
  - **Work out what the scope means** from what the repo records about the work. That means the
    active loop file under `.claude/loops/` (its queue, PR split and *For the user* notes), the
    plan the work follows, and the conversation. Then work out which changed files
    (`git status`, untracked included) belong to it.
  - **Reset the index first,** so what was staged before cannot leak into the scope: unstage
    everything. Then stage the scope's files, and only them.
  - **A file you cannot attribute with confidence** is never guessed into or out of the scope.
    That includes a file whose changes belong to both scopes, which cannot be split without an
    interactive hunk picker. Stop and report the file and why, with nothing committed and the
    index as you found it.
  - **Files that belong to no scope of the work** stay out, and the report names them. Examples:
    unrelated tool configuration, scratch files, loop artifacts under `.claude/loops/`.
  - **Check the split by reading it.** The staged scope must stand on its own. If a staged file
    references something only a left-out file provides (an import, a kind, a function, a route),
    the split is wrong: report it and stop.
- **Never stage anything outside the change**, except a fix this skill makes to that change.

## 2. Commit, push, open the PR

- **Commit** with a short conventional message (`feat(scope,scope): what changed`) that describes
  the staged change. Add **no** `Co-Authored-By` footer.
- **Push** with `git push -u origin <branch>`.
- **Open the PR** against `main` with `gh pr create`. The body is:
  - what the change does, stated as behaviour.

  Add **no** attribution line (no "Generated with Claude Code" footer).

## 3. Keep CI green

- **Watch the PR's checks** with `gh pr checks <n>`. The first poll is **10 minutes** after the
  push, then every **minute**, until no check is pending. Use a background watch that wakes you,
  never a foreground sleep. Run this in the background (`run_in_background`), with the PR's
  number in place of `<n>`; it prints the final table of checks and exits, which is what wakes
  you:

  ```sh
  sleep 600; while true; do out=$(gh pr checks <n> 2>&1); if echo "$out" | grep -qE "\bpending\b|\bqueued\b|in_progress"; then sleep 60; else echo "$out"; break; fi; done
  ```- **A failing check:** read its log with `gh run view --log-failed` and find the cause.
  - **A fix inside this change:** make it, re-run the failing suite locally, then
    `git commit --amend --no-edit` (still no footer) and
    `git push --force-with-lease origin <branch>`. **Never add a new commit** to fix CI. Then
    restart the watch from the 10-minute first poll.
  - **A flaky test** — one that fails, then passes on a re-run of the same commit, whether or not
    this change touched it — is fixed in this PR, not re-run until it happens to pass. Find why it
    is non-deterministic (a timing window, shared state between cases, a port or file two tests
    both use, an order it assumes). Fix the test, or the code when the race is real, and run it
    locally enough times to show it now holds. Then amend and force-push with lease like any other
    fix, and say what the flake was in the report. A flake you cannot make deterministic is
    reported with its failing log line and your finding; do not paper over it with retries or
    longer timeouts alone.
  - **A failure outside this change** — an infrastructure error, a check that also fails on
    `main`: re-run it once with `gh run rerun --failed`. If it fails again, stop and report it
    with its log line; do not fix other code to get green.
  - **The same check failing after three amend rounds:** stop and report. Grinding is not
    progress.
- **Stop once every check is green**, skipped ones included.

## Report

End with one message:
- the PR URL;
- when you staged the scope yourself, the files you staged and the changed files you left out;
- each CI round (what failed, what you amended);
- the final state of every check.

A stop for any other reason gets the same message, saying where it stopped and why.

## Never

- Merge a PR, or push to `main`.
- Commit anything outside the change: the whole working tree, or the scope they named, plus fixes
  to it and to the flaky tests its CI exposes.
- Guess a file into or out of a named scope.
- Add a new commit to fix CI; amend instead.
- Use `git stash`, or look through commit history to decide anything.
