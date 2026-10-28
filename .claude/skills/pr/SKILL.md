---
name: pr
description: Run only when the user types /pr, or when the implement skill hands over a change whose fix round is done. Never invoke it yourself otherwise.
argument-hint: nothing (every change in the working tree), or which part of the working tree to land (`for phase 1`, `the stdlib changes`), plus anything the commit message or PR body should say
---

The user has a change in the working tree and is away. You carry it to "a green PR", alone. The
user's invocation — of `/pr`, or of `/implement`, which hands over to this skill — is the authorization for this skill's branch creation, staging, commit, rebase
onto the branch's base and its own remote, push, amend and force-push — for this change and its branch only. Merging is
never yours.

## 1. Establish the change

- **Start from current refs:** `git fetch origin`, before anything below is judged. Whether a
  branch fits, what it is behind and what a new one starts from are all read off what the remote
  holds now.
- **The branch is the current one only when it fits the code being delivered.** Judge the fit
  against the change itself — read the diff (`git status`, `git diff HEAD`, untracked files) and
  say in one sentence what it does — never against the fact that you are standing on the branch.
  It fits only when all of these hold:
  - it is not `main`;
  - its name, and the title and body of its open pull request when it has one, describe **all** of
    what the change does. A branch about one thing does not fit a change that does that thing and
    another: work the name and the pull request do not mention is work for a branch of its own;
  - no pull request from it was already merged or closed
    (`gh pr list --head <branch> --state all`) — a branch whose work has landed is finished,
    whatever it is called.

  **An open pull request from the current branch is not by itself a fit.** The change joins it,
  and no second pull request is opened, only when the change is that pull request's own work: a
  fix to it, a review round, the next step of what its description says. Standing on a branch
  while building something else does not make that something part of its pull request.

  **A pull request carries one commit.** A change that is the pull request's own work is folded
  into its commit, never stacked on top of it as a second one — see step 2. Two commits in one
  pull request are two pieces of work reviewed and reverted as one, which is the thing a branch
  of its own exists to prevent.

  **When in doubt, it does not fit.** A second pull request costs a reviewer little; unrelated
  work folded into an open one cannot be reviewed or reverted apart from it.
- **When the branch does not fit, create one named for the change** and carry the working tree
  onto it. Where it starts depends on what the change stands on:
  - **On `main` alone** — the usual case: `git switch -c <type>/<short-kebab-name> origin/main`.
    The pull request is opened against `main`.
  - **On the current branch's unmerged commits** — git refuses the switch above because the
    working tree does not apply to `origin/main`, or the change edits what those commits
    introduced. When the current branch has an open pull request, stack on it:
    `git switch -c <type>/<short-kebab-name>` from where you stand, and open the pull request
    against **that branch**, so its diff is this change alone. The body's first line says what it
    is stacked on. When the current branch has unmerged commits and no open pull request, stop and
    report: there is nothing to open the pull request against without publishing that other work.

    **A stacked pull request gets no CI here**: the workflows run for pull requests against `main`
    only. Run the changeset gate and the suites the change reaches locally, say in the body and in
    the report that its checks are waiting on its base, and skip step 3 — there is nothing to
    watch. Once the base merges, the next `/pr` on that branch rebases it onto `origin/main`
    (`git rebase --onto origin/main <the base's last commit>`), retargets it
    (`gh pr edit <n> --base main`) and takes it through step 3.

  Never put the change on `origin/main` by leaving part of it behind, and never guess which of
  the current branch's commits it needs. The report names the branch you created, what it starts
  from and why the old one did not fit.
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

- **One commit per pull request.** Count what the branch already holds beyond its base
  (`git rev-list --count origin/<base>..HEAD`):
  - **0** — a new commit, as below.
  - **1, and the change is that pull request's own work** — fold the change into it:
    `git commit --amend`, with the message reworded only when the commit now does more than its
    subject says. It is pushed with `--force-with-lease`.
  - **1, and the change is other work** — step 1 was misjudged: the branch does not fit. Go back
    and give the change a branch of its own.
  - **More than 1** — stop and report. The branch already holds stacked commits, and which of
    them the change belongs with is not yours to guess.
- **Commit** with a short conventional message (`feat(scope,scope): what changed`) that describes
  the staged change. Working files that rode along do not shape the subject; they name the commit
  only when they are all of it (`chore(claude): …`, `docs(plans): …`). Add **no** `Co-Authored-By`
  footer.
- **Bring the branch up to date before every push** — the first one, and each force-push after
  it. `git fetch origin`, then, in this order:
  - **its own remote**, when the branch already exists there and holds commits the local one
    lacks (`git rev-list --count HEAD..origin/<branch>` is not 0): `git rebase origin/<branch>`.
    Someone pushed to it since this checkout last saw it, and a push over that is lost work.
  - **its base**: `git rebase origin/main`, or `git rebase origin/<base>` for a branch stacked on
    another. A branch that already contains the base's head needs nothing.

  Then check it, never assume it: `git rev-list --count HEAD..origin/<base>` must print 0 before
  the push. A pull request that is behind its base is tested against code that no longer exists,
  and one that conflicts cannot be merged at all.
  - **A conflict whose resolution is not in doubt** (both sides added different entries to the
    same list, a lockfile to regenerate with `pnpm install`) is resolved, and the report says
    which files. Re-run what the conflicted files' tests cover before pushing.
  - **Any other conflict:** `git rebase --abort`, then stop and report the files and the two
    sides. Never pick a side to get past it.
- **Run the changeset gate before every push**, after the branch is up to date:
  `node scripts/check-changeset-status.mjs origin/main` — against `origin/main` for a stacked
  branch too, since that is what CI compares with. It must exit 0. It reads committed state, so
  run it after the commit, and again after each amend.
  - **A published package it names as changed with no changeset** is fixed inside the change:
    add the package to the changeset that describes that work, or write a new one under
    `.changeset/` when none does, with the bump the change calls for. An empty changeset covers
    nothing. Fold the fix into the commit (`git commit --amend --no-edit`) and run the gate again.
  - **Any other failure it reports** (a `teloInlines` list, a Rust twin's version, the ignore
    list) is fixed the same way when the change caused it, and reported when it did not.

  A push the gate would fail costs a full CI round to learn what one local command says.
- **Push** with `git push -u origin <branch>`; once the branch has been rebased after a push,
  `git push --force-with-lease origin <branch>`.
- **Open the PR** against its base — `main`, or the branch it is stacked on — with
  `gh pr create --base <base>`. The body is:
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
    `git commit --amend --no-edit` (still no footer), bring the branch up to date as in step 2, and `git push --force-with-lease origin <branch>`. **Never add a new commit** to fix CI. Then
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
  is brought up to date as in step 2 and force-pushed with lease; then restart the watch. The
  same goes for a stacked pull request and the branch it is stacked on.
- **Stop once every check is green**, skipped ones included, and the pull request has no conflict
  with its base and is not behind it.

## Report

End with one message:
- the PR URL;
- the branch, what it is based on, and when you created it, why the one you started on did not
  fit; when you stayed on the current one, the sentence that says why the change is its work;
- each rebase that changed the branch — onto its own remote or onto its base — and any conflict
  you resolved;
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
- Push a branch that does not contain its base's head, or over commits its own remote holds.
- Push while `node scripts/check-changeset-status.mjs origin/main` fails.
- Commit onto a branch whose pull request has already been merged or closed.
- Add a change to an open pull request whose description does not cover it.
- Leave a pull request holding more than one commit: fold its own work into its commit, and give
  other work its own branch.
- Use `git stash`, or look through commit history to decide anything.
