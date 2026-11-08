---
status: draft
priority: medium
depends-on: []
packages: [ci, cli, scripts, docs]
---

# Release without merge-backs

## Before

A release branch holds release-only state: consumed changesets and fragments, bumped versions, changelogs, the module ledger, `>=unreleased` floors rewritten to a number, pinned imports. The next cut plans from main, so that state must travel back. Every final, patch, packages-only and module release opens a merge-back PR that merges the branch's history into main, and the sync-imports PR rides the next one. The rules around it are the pain: merge commit only, a linear-history ruleset that blocks `gh pr merge`, tag-containment refusals at the next cut and in the gates, conflicts on same-named fragments and manifests edited on both sides, and a recovery procedure per failure. A normal release is five to six PRs.

## After

Branch history never merges into main. Main receives released state as a **generated record**: one standing PR per release line, rebuilt from the branch's newest release tag and landed by squash. Main's checks (floors judged against published CLIs, changeset coverage, example and starter pins) read main's own files, so main must hold what was published; a record commit gives it that without any ancestry requirement.

- **Record release.** Workflow `record-release.yml` ("Record release"), dispatched by the branch's Publish with the new tag after every non-rc release, or by hand with a tag to refresh it. It regenerates the head `release-record/release/<x.y>` and its one PR, titled `chore(release): record <tag> on main`, using main's own scripts on main's tip:
  - copies from the tag: each package's `version`, each module's `metadata.version` and companion version files, each `CHANGELOG.md`, each `.changes/ledger.yaml` entry, for artifacts present on main;
  - deletes the changesets and fragments that are released (below);
  - computes, never copies, floors and pins: runs `telo release floor` and `telo upgrade --pin-local` on main's tree after the copy, so a `>=unreleased` for shipped grammar becomes the published number while a `>=unreleased` for main-only grammar and a relative import of unshipped work stay.
- **Which tag.** The newest non-rc tag on the branch: `v<x.y.z>` (final or patch), `packages-<x.y>-<n>` or `modules-<x.y>-<n>`. An rc tag `v<x.y.z>-rc.N` never triggers or feeds a record; the branch is linear, so the newest tag holds every earlier release's state.
- **Released.** A changeset or fragment on main is released when it is absent from main, or when, at any commit of the live branch between its merge-base with main and its newest non-rc tag, a file of the same name and blob was deleted — a history walk, so a changeset created on main after the cut, cherry-picked and consumed on the branch still counts. The merge-base is stable because main never receives branch commits. One definition serves the record run, the cut, the changeset gate and `telo release check`; those two read `origin/release/*`. A same-named fragment with different content is not released.
- **Cut.** `Cut release` creates the branch from the dispatched commit as today. It refuses while main does not record the live branch's newest non-rc tag. Main records a tag when running the record's copy-and-delete half against main's tip finds nothing to change; no marker file is kept, and the same test makes a re-dispatch idempotent.
- **Fixes.** Every fix lands on main first, pipeline repairs included. When a release needs it, the maintainer opens a PR into `release/<x.y>` made with `git cherry-pick -x <main commit>`, carrying the main PR's changeset or fragment file unchanged so it counts once. A change lands on the branch alone only when main's code already differs so the fix does not apply; that PR names the main commit that superseded it. Branch content never reaches main. After a final the branch accepts only patch changesets, so a main `minor` changeset is rewritten as a patch for the pick; main's original is released again by the next line, one duplicate changelog line.
- **Gates.** The head prefix `release-record/` joins `changeset-release/` and `module-release/` in the release-machinery exemption of the changeset gate and `telo release check`. The tag-containment rule is removed from both.
- **Removed.** The Publish merge-back job, `scripts/release-merge-back.mjs`, `merge-back/*` branches, the merge-commit-only requirement and its ruleset allowance, the cut's "main does not contain" refusals, and the merge-back recovery entries. The branch keeps its own `chore(imports): sync imports with published modules` PR into the branch; main's pins come from the record.

Constraint stated once: no git merge of release content, into main or into a new branch. A merge carries source as well as state, so every patch whose fix main also has would conflict, and branch-only content would leak into the next line.

Cost accepted: after a publish, main is stale until the record PR is merged (the window a merge-back has today), and a later main edit that conflicts with an open record PR is fixed by re-dispatching, never by hand.

## Usage

Cut refusal while the previous release is not recorded:

```
$ gh workflow run cut-release.yml
Error: main does not record v0.85.1. Merge "chore(release): record v0.85.1 on main" first.
```

Recovery after a conflicting main edit, or a missed dispatch:

```
$ gh workflow run record-release.yml -f tag=modules-0.85-2
```

Backporting a fix (hard case: after the final the branch takes patch changesets only, so a main `minor` changeset is rewritten as a patch in the pick; main keeps its original, which the next line releases again):

```
$ git switch -c pick/fix-retry release/0.85
$ git cherry-pick -x 3f9a1c2
$ sed -i 's/: minor/: patch/' .changeset/retry-backoff.md
$ git commit -am "fix(sdk): retry backoff (patch for 0.85)"
$ git push -u origin pick/fix-retry && gh pr create --base release/0.85
```

## Operator flow

1. Work lands on main by PR from a feature branch (changeset or fragment, `telo release floor`).
2. Dispatch `Cut release` on main. It creates `release/<x.y>` from main's tip; no PR.
3. The bot opens the rc Version PR from `changeset-release/release/<x.y>` into `release/<x.y>`; merge it. Fixes: PR from `pick/<name>` into `release/<x.y>` (cherry-picked from main). Repeat.
4. Dispatch `Finish release` on `release/<x.y>`. It opens the final Version PR from `changeset-release/release/<x.y>` into `release/<x.y>`; merge it. Publish runs on the branch, tags `v<x.y.z>`, and dispatches Record release.
5. The bot opens the Module Release PR from `module-release/release/<x.y>` into `release/<x.y>`, and the sync-imports PR into `release/<x.y>` if imports changed; merge each. Each module publish tags `modules-<x.y>-<n>` and dispatches Record release again.
6. Record release opens the record PR from `release-record/release/<x.y>` into `main`; squash-merge it. Merge it after the last module tag so one record covers the line; a later tag rebuilds the same PR.
7. Patches: the fix PR goes from a feature branch into `main` first; then PR from `pick/<name>` into `release/<x.y>`; merge the Version PR (`changeset-release/release/<x.y>` into `release/<x.y>`), which tags and re-dispatches Record release; squash-merge the rebuilt record PR into `main`.

Two dispatches; every PR goes into `release/<x.y>` except the fix PR and the record PR, which go into `main`. Nothing is a merge commit.

## Documents to update

`RELEASING.md` (flow, main-first rule and its single exception, merge-back section replaced by the record, recovery as a re-dispatch), the "Versioning & releases" section of the root `CLAUDE.md`, the release-model guide's merge-back paragraph, `docs/extend/releasing-modules.md`, and the cut, finish, publish and record workflow comments.

## Verify

- After a final, a patch and a module release, exactly one PR targets main, it squash-merges green, and main's history stays linear.
- Merging an rc Version PR dispatches no record run.
- A record made after `modules-0.85-2` holds the npm versions of the preceding patch.
- A module adopting grammar in 0.85 reads `>=0.85.0` on main after the record merges; one adopting main-only grammar after the cut still reads `>=unreleased`; `telo release check` is green on the record PR.
- With nothing else merged, the next cut's Version PR plans versions above the last release, and its changelogs hold the previous line's entries.
- A fix merged on main and picked to the branch ships in a patch and is not in the next line's changelog a second time.
- A same-named fragment on main with different content is still released by the next line.
- While a record PR is open, a main PR relying on a backported changeset to cover its package fails the gate.
- Re-dispatching after a conflicting main edit yields a mergeable PR with no hand edits.
- The cut refuses with the message above until the record is merged.
- A recovery from a failed Publish is a re-dispatch of `record-release.yml`, with no merge-back step.
