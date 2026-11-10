---
status: draft
priority: medium
depends-on: [2026-11-10-relative-imports-on-main.md]
packages: [analyzer, cli, ci, scripts, apps, docs]
---

# Release candidates publish modules

## Before

- A candidate `X.Y.Z-rc.N` publishes npm under `rc`, kernel images, the built-in vocabulary, the standalone CLI, the `.vsix` and `/next/`, but no modules and no app images. Its tag's consumers import the working copy relatively, so a candidate cannot be installed and run as the final will be.
- `telo upgrade` and the editor read a newer prerelease's `restrictions:` wherever no final speaks for the key, so a published module prerelease would narrow what third parties are offered.
- The hub indexes every version of a module; only the built-in vocabulary is filtered to finals.

## After

### Candidate module versions

- In a candidate's release PR, `telo release apply --candidate` versions every module the release plan bumps against its last final as `<the final the plan assigns>-rc.<k>`. `k` is per module: `1` the first candidate in which the module is bumped, and one higher in a later candidate only when the module's payload digest differs from its last candidate's. A module whose payload did not move keeps its candidate version and is not republished. A module the plan does not bump keeps its final version.
- `--candidate` consumes no fragment: the PR body lists them, and module changelogs are written once, by the final's `telo release apply`.
- The ledger plans from finals only. A candidate records its published version and per-layer integrity beside the module's entry, under `candidate: { version, layers }`; `telo release status --candidate` compares the payload against it to decide `k`; the final's `telo release apply` removes it. `telo release check` accepts a manifest version equal to the entry's `candidate.version`. `Record release` still refuses an rc tag, so main never holds a candidate entry.
- If a final assigns a different version than a candidate named (a fragment removed or re-levelled), the candidate's `-rc.<k>` simply names a final that is never published.

### Publishing a candidate

- A candidate's Publish run publishes the candidate module versions after npm, makes a publication commit like a final's, and tags `v<X.Y.Z>-rc.N` on it, so the rc tag's consumers are pinned to published candidate artifacts. Its app images are built from that tag, tagged with their module's exact `-rc.<k>` version and moving no pointer.
- A module's OCI `latest` tag is not moved by a candidate version.
- A candidate's version step writes `>=unreleased` as the line's surface `X.Y.Z`, which every candidate CLI reports. During candidates, `telo publish`'s floor check accepts a floor equal to the line's surface and runs the newest published candidate CLI of that surface; with none published it refuses, naming the surface.
- What a candidate publishes beside that is unchanged: npm under `rc`, kernel images, the built-in vocabulary, the standalone CLI, the `.vsix` and `/next/`. No Studio, no Marketplace, no pointer.

### Module prereleases are inert

- No selector reads a module prerelease unless asked: `telo upgrade` and the editor stop reading a newer prerelease's `restrictions:`, and only `telo upgrade --include-prerelease` sees prereleases at all. A restriction first published in a candidate takes effect when the final repeats it.
- The hub tracks final module versions only, the rule it applies to the built-in vocabulary extended to every module, and drops any prerelease version it already indexed.

### Documentation

- `RELEASING.md` (what a candidate publishes, the candidate module versions), the releasing-modules guide, the release model guide, the CLI package guide, the hub's guide.
- Changesets for `@telorun/analyzer` (selection), `@telorun/cli`, `@telorun/language-host`; a fragment for the hub.

## Verify

- On a scratch fork with its own registry and npm scope, merging an rc release PR publishes each bumped module at `<final>-rc.1`; the rc tag's consumers pin exactly those versions, `telo check` on them with an empty cache resolves every pin, and the rc app images run on them.
- The next candidate republishes only the modules whose payload moved, at `-rc.2`; the others keep `-rc.1` and their pins; the final publishes final versions with one changelog entry per fragment and removes every `candidate:` from the ledger.
- After a candidate, the hub lists no `-rc` module version, and `telo upgrade` and the editor give a third-party consumer the same selection as before it; `telo upgrade --include-prerelease` offers the candidate.
- During candidates, `telo publish` of a module whose floor is the line's surface succeeds against the newest published candidate CLI of that surface, and is refused when none is published.
- No module's OCI `latest` names a candidate version.
