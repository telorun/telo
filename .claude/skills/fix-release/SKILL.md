---
name: fix-release
description: Run only when the user types /fix-release. Finds what is red on the live release line (release branch, release PR, record PR), fixes it with a PR into main plus a cherry-pick PR into the release branch, and watches CI until green. Never merges.
argument-hint: nothing (newest `release/*`), a line (`0.139`), or a failing run / PR URL
---

The invocation authorizes branches, commits, pushes, PRs, re-runs of failed jobs and Record release dispatches. Never merge or publish — give the user the command. Follow `RELEASING.md`. Work in `.claude/worktrees/fix-release`.

1. Check the newest runs on `release/<x.y>`, its release PR and its record PR.
2. A flake gets one re-run; a repeat is a defect. A failed job's log is readable before its run ends: `gh api --allow-escape-sequences repos/<owner>/<repo>/actions/jobs/<id>/logs`.
3. Fix each defect with a PR into main and its cherry-pick PR into the release branch.
4. Watch both until green (at most three fix rounds), then re-run the originally failing run.
5. Report briefly: line state, causes, PRs, what is left for the user.
