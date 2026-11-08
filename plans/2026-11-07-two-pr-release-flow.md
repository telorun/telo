---
status: done
priority: medium
depends-on: []
packages: [ci, scripts, docs]
tracking: feat/measured-floors-and-two-pr-release
---

# Two PRs per release

Reaching a final takes four PRs today: the cut PR on main, the rc Version PR, the finish PR and the final Version PR. Only the two Version PRs carry anything a reviewer reads: versions and changelogs. The cut PR only deletes from main the changesets the branch carries, and the finish PR only runs `changeset pre exit`.

After this change a release is two PRs, both `chore(release): version packages` from `changeset-release/release/X.Y`: one at `X.Y.0-rc.0`, then one at `X.Y.0`. Both start their checks without a manual re-run. The merge-backs into main and the Module Release PR are unchanged.

## Requirements

These requirements are non-negotiable. A design that breaks one is not this plan.

- At most two release PRs: one for the rc, one for the final. A fix merged after a candidate has published may open one more rc Version PR, to deliver the next candidate.
- Each of them can receive fixes.
- The whole release lives on one branch, `release/X.Y`.
- The release branch is never deleted.
- Release candidates and the final are tagged.

## Flow

Using 0.133 as the example:

1. **Cut.** Dispatch `Cut release` on main. This creates `release/0.133` at main's head, and the branch's Publish opens the Version PR at `0.133.0-rc.0`.
2. **Fix the rc.** Each fix merged into `release/0.133` rebuilds the open Version PR.
3. **Publish rc.0.** Merging the Version PR publishes `0.133.0-rc.0` and tags it `v0.133.0-rc.0`.
4. **Another candidate (optional).** A fix merged after that opens a Version PR at `0.133.0-rc.1`. Merging it publishes and tags rc.1.
5. **Finish.** After rc.0 has published, dispatch `Finish release` at `release/0.133`. This opens the Version PR at `0.133.0`, or turns an open rc Version PR (rc.1 or later) into it.
6. **Fix the final.** Each fix merged into the branch rebuilds this Version PR.
7. **Publish the final.** Merging it publishes `0.133.0` and tags it `v0.133.0`.
8. **Merge back.** Land `chore(release): merge v0.133.0 into main` with a merge commit. Then merge the Module Release PR into the branch, and land its `modules-0.133-1` merge-back the same way.
9. **Patches.** A patch changeset merged into the branch opens a Version PR at `0.133.1`. Merging it publishes `0.133.1`, tags `v0.133.1` and opens its merge-back.

## Cut without a PR

**Before:** `Cut release` opens `chore(release): cut X.Y` from `release-cut/X.Y`, which deletes the pending changesets and `.changes/pending/*` fragments from main. Merging it creates `release/X.Y` at the cut commit's parent and dispatches the branch's Publish.

**After:** `Cut release` makes the same refusals. It then creates `release/X.Y` at the main commit it was dispatched on, and dispatches the branch's Publish, which opens the rc Version PR. Main is not changed. The `release-cut/*` branch, the cut PR and the job that reacted to its merge are removed.

The released changesets and fragments leave main through the merge-backs. On the branch, the final Version PR deletes the changesets and the Module Release PR deletes the fragments. Main hasn't touched them since the cut, so `merge vX.Y.0 into main` and `merge modules-X.Y-N into main` carry the deletions over. Until then main keeps them pending, and nothing acts on them in that window, because `Cut release` refuses the next release until main contains the branch's final, `modules-*` and `packages-*` tags. If one of them is edited on main in that window, the merge-back conflicts, and the conflict is resolved there by keeping the deletion.

**`>=unreleased` floors follow the same path.** Main keeps its pending changesets after the cut, so its identity stays `X.Y.0+unreleased` and every module at `>=unreleased` keeps loading there. The branch's version step rewrites each `>=unreleased` in the module manifests to `>=X.Y.0`, and the final's merge-back brings that rewrite to main together with the changeset deletions, so main's identity and its floors become `X.Y.0` in one commit. A module manifest edited on main in that window conflicts at the merge-back: the resolution keeps main's edit and takes the branch's number only for a floor the release carries, while a `>=unreleased` written on main after the cut stays.

This flow ships in the same change that introduces measured floors, so no release is cut under the old flow while modules hold `>=unreleased`: the old cut deleted main's changesets, and every such module would fail on main until the next line changeset landed.

## Finish without a PR

**Before:** `Finish release` opens `chore(release): finish X.Y` into the branch. Merging it starts a Publish run, which opens the final Version PR.

**After:** `Finish release`, dispatched at `release/X.Y`, builds the final Version PR itself. It leaves prerelease mode, runs the branch's version step, and opens the Version PR from `changeset-release/release/X.Y`, replacing it if one is open. `.changeset/pre.json` is deleted in the same PR that writes `X.Y.0`.

- **An open rc Version PR becomes the final.** It is an rc Version PR after the first candidate published (rc.1 or later). Its changesets ship in `X.Y.0`, and that rc is never published.
- **The open PR records that the branch is going final.** Whenever a later Publish run rebuilds the Version PR, for example after a fix merges into the branch, the version step leaves prerelease mode again if the open Version PR's head has no `.changeset/pre.json`. Closing the PR goes back to candidates: the next rebuild is an rc again.
- **A second dispatch** rebuilds the same PR.
- **Refusals:** the existing refusals stay: a ref that is not `release/*`, and a branch with no `.changeset/pre.json`. The "already exited" refusal is removed, because prerelease mode now ends only inside the final Version PR. The refusal of a branch with no `.changeset/pre.json` is what makes the first candidate publish before the final: until rc.0 is merged the branch holds no `pre.json`.

## Version PR checks start on their own

**Before:** Publish's release job checks out the repo with the default token, and the changesets step pushes the Version PR with it. GitHub starts no workflow for that push, so every Version PR update needs its checks re-run by hand.

**After:** the job checks out with `TELO_BOT_TOKEN`. The push is then the bot's, and the checks start. `Finish release` pushes the same way.

## Docs

- **RELEASING.md:**
  - The cycle diagram and the Cut, Candidates and Finish sections.
  - The `TELO_BOT_TOKEN` list.
  - The recovery entry for "a cut PR merged but no branch exists". Its replacement: a cut whose Publish opened no Version PR is fixed by dispatching `publish.yml` at the branch.
- **The release bullet in the root CLAUDE.md:** neither the cut nor the finish opens a PR any more.

## Verify

**The release-script tests pin:**
- The cut's refusals are unchanged, and the branch is created at the dispatched commit with main untouched.
- The version step enters candidates on a branch's first Version PR.
- It leaves prerelease mode when the open Version PR's head has no `.changeset/pre.json`, and versions an rc again once that PR is closed.
- `Finish release` with an rc Version PR open produces `X.Y.0`, carrying that rc's changesets.
- A final's merge-back deletes the released changesets from a main that kept them.
- A final's merge-back carries the version step's `>=unreleased` → `>=X.Y.0` rewrite onto a main that kept the `>=unreleased` text, and keeps a `>=unreleased` main added after the cut.

**On the 0.133 release:**
- Dispatching `Cut release` leaves main's head unchanged and creates `release/0.133` at it.
- The rc Version PR opens at `0.133.0-rc.0`, and its checks start without a re-run.
- After rc.0 publishes, `Finish release` opens the Version PR at `0.133.0` (or turns an open rc.1 Version PR into it), with `.changeset/pre.json` deleted.
- A fix merged while it is open rebuilds it, still at `0.133.0`, now including the fix.
- Between the cut and the merge-back, main still reports `0.133.0+unreleased` and the manifest tests of a module at `>=unreleased` pass there.
- After `merge v0.133.0 into main`, no changeset released in 0.133 remains on main, and no `>=unreleased` remains for syntax 0.133 shipped.

0.132 finishes under the current flow, because its branch runs its own copies of these workflows and scripts.
