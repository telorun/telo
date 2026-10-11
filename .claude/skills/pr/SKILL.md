---
name: pr
description: Run only when the user types /pr. Never invoke it yourself, whatever the task.
argument-hint: nothing (every change in the working tree), or which part of the working tree to land (`for phase 1`, `the stdlib changes`), plus anything the commit message or PR body should say
---

The user has a change in the working tree and is away. You carry it to "a green PR", alone. The
user's invocation is the authorization for this skill's branch creation, staging, commit, rebase
onto `origin/main`, push, amend and force-push — for this change and its branch only. Merging is
never yours.

## 1. Establish the change

- **The branch is the current one only when it fits the change.** It fits when its name describes
  this change and it holds no other work. It does not fit when:
  - it is `main`;
  - its name is about something else;
  - a pull request from it was already merged or closed (`gh pr list --head <branch> --state all`)
    — a branch whose work has landed is finished, whatever it is called.

  When it does not fit, create one named for the change and carry the working tree onto it:
  `git fetch origin main`, then `git switch -c <type>/<short-kebab-name> origin/main`. If git
  refuses because the working tree does not apply there, or the current branch holds commits that
  are neither on `origin/main` nor part of this change, stop and report: the change cannot be
  separated from that work without guessing. The report names the branch you created and why the
  old one did not fit. An open pull request from the current branch for this same work is the
  branch fitting — the commit joins it, and no second pull request is opened.
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
  - **Working files ride along with every scope.** The user edits them in parallel with whatever
    is being built and needs them committed each time, so stage every changed one — modified,
    deleted and untracked alike — whatever the scope names and whether or not it relates to it:
    - every `CLAUDE.md`, at any depth;
    - everything under `.claude/` that git does not ignore (skills, agents, decider lenses,
      hooks, agent identity, `settings.json`);
    - everything under any `plans/` directory, at any depth.

    They are never attributed, never a reason to stop, and exempt from the stand-alone check
    below. What git ignores (`.claude/loops/`, `.claude/worktrees/`) is never forced in.
  - **Files that belong to no scope of the work** stay out, and the report names them. Examples:
    scratch files, tool configuration outside `.claude/`.
  - **Check the split by reading it.** The staged scope must stand on its own. If a staged file
    references something only a left-out file provides (an import, a kind, a function, a route),
    the split is wrong: report it and stop.
- **Never stage anything outside the change**, except the working files above and a fix this
  skill makes to that change.

## 2. Commit, push, open the PR

- **Commit** with a short conventional message (`feat(scope,scope): what changed`) that describes
  the staged change. Working files that rode along do not shape the subject; they name the commit
  only when they are all of it (`chore(claude): …`, `docs(plans): …`). Add **no** `Co-Authored-By`
  footer.
- **Bring the branch up to date with `origin/main` before every push** — the first one, and each
  force-push after it. `git fetch origin main`, then `git rebase origin/main`; a branch that
  already contains `origin/main`'s head needs nothing. A pull request that is behind `main` is
  tested against code that no longer exists, and one that conflicts cannot be merged at all.
  - **A conflict whose resolution is not in doubt** (both sides added different entries to the
    same list, a lockfile to regenerate with `pnpm install`) is resolved, and the report says
    which files. Re-run what the conflicted files' tests cover before pushing.
  - **Any other conflict:** `git rebase --abort`, then stop and report the files and the two
    sides. Never pick a side to get past it.
- **Push** with `git push -u origin <branch>`; once the branch has been rebased after a push,
  `git push --force-with-lease origin <branch>`.
- **Open the PR** against `main` with `gh pr create`. The body is:
  - what the change does, stated as behaviour;
  - when working files rode along with a named scope, one closing line saying so (`Also carries
    unrelated updates to plans and Claude guidance.`), so a reviewer does not look for their
    connection to the change.

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
    `git commit --amend --no-edit` (still no footer), bring the branch up to date with
    `origin/main` as in step 2, and `git push --force-with-lease origin <branch>`. **Never add a new commit** to fix CI. Then
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
- **A pull request that reports conflicts with `main`, or falls behind it while its checks run,**
  is brought up to date as in step 2 and force-pushed with lease; then restart the watch.
- **Stop once every check is green**, skipped ones included, and the pull request has no conflict
  with `main`.

## Report

End with one message:
- the PR URL;
- the branch, and when you created it, why the one you started on did not fit;
- each rebase onto `origin/main` that changed the branch, and any conflict you resolved;
- when you staged the scope yourself, the files you staged, the working files that rode along,
  and the changed files you left out;
- each CI round (what failed, what you amended);
- the final state of every check.

A stop for any other reason gets the same message, saying where it stopped and why.

## Never

- Merge a PR, or push to `main`.
- Commit anything outside the change: the whole working tree, or the scope they named plus the
  working files that ride along, plus fixes to it and to the flaky tests its CI exposes.
- Leave a changed working file (`CLAUDE.md`, `.claude/`, `plans/`) uncommitted.
- Guess a file into or out of a named scope.
- Add a new commit to fix CI; amend instead.
- Push a branch that does not contain `origin/main`'s head.
- Commit onto a branch whose pull request has already been merged or closed.
- Use `git stash`, or look through commit history to decide anything.
