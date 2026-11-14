# Releasing

Main is where work lands and publishes nothing. A release is cut from main into a `release/<major>.<minor>` branch, published as release candidates (`-rc.N`) from that branch, finished into a final, and then patched from the same branch until the next cut. A release may also be cut straight to its final, with no candidates. Every publish runs from a release branch, with that branch's own workflow files.

The examples follow one timeline: `0.84.2` is the newest final, `release/0.85` is in candidates, and main is working towards `0.86.0`.

One command plans every release: `telo release` (the planner is `@telorun/release`) versions the npm packages, crates, images, charts and modules of this repository as release units, each with one version and one changelog. Its guide is [Releasing modules](docs/extend/releasing-modules.md) and the marker is [Workspaces](docs/guides/workspaces.md). This file covers when units publish and how main records them.

## The cycle

```
main ── cut ──► release/0.85 ── rc.0 ── rc.1 ── finish ── 0.85.0 ── 0.85.1 ── modules ── …
   ▲   (no PR)                  (one release PR each: chore(release): version)
   │                            (no record)                 │         │         │
   │                                     tagged on its publication commit, then
   │                                     dispatch Record release (main's copy)
   │                                                        │         │         │
   └──────── one record PR, rebuilt each time: chore(release): record <newest tag> on main
```

Branch history never merges into main. Main learns what shipped from a generated **record** of the branch's newest release tag, one standing PR per line, landed by squash. Nothing is a merge commit.

Every branch imports the working copy: an example, starter, app or blueprint imports a module of the release workspace by relative path, on main and on every `release/*` branch alike, and the static checks refuse a pinned one (`pnpm run imports -- --as=relative --check`; drop `--check` to rewrite). Pins to published artifacts exist only in a release's tags, which name its publication commit (below).

### Cut

```
gh workflow run cut-release.yml --ref main
```

`Start release candidates` takes no input and opens no PR. It creates `release/0.85` at the main commit it was dispatched on and dispatches the new branch's Publish, which opens the first release PR. The minor is the one main's release plan reaches. Main is not changed: the branch carries the pending `.changes/pending/*` fragments, and main drops them only when it records the release that consumed them. Until then main keeps them and reports the recorded version with `+unreleased`, so modules at `>=unreleased` keep loading on it. Meanwhile the gate does not count them: on main `telo release check --carried-by <live branch>` drops every fragment the live branch carries (the same file at the cut, or picked onto the branch since), so a main PR cannot rely on one to cover its own change.

It refuses, naming the cause, when:

- it is not run on main;
- the live branch is in candidates (`release/0.85 is in candidates (0.85.0-rc.1). Finish it before cutting 0.86.`);
- the live branch holds a pending fragment not yet published (`release/0.85 holds unreleased changes (…)`), since the branch would freeze with it stranded;
- main does not record the live branch's newest non-rc release tag (`Error: main does not record v0.85.1. Merge "chore(release): record v0.85.1 on main" first.`): the record's own check, run against main's tip, would still change a file;
- a Publish run of the live branch is still in progress, since it may yet tag a release; dispatch the cut after it completes;
- main's release plan moves the telo line by only a patch, or not at all;
- `release/<x.y>` already exists.

With no `release/*` branch yet, the live-branch checks pass.

**A cut is not undone.** A premature cut ships through its candidates to a final. Nothing deletes a release branch or withdraws a cut; if the cut was a mistake, finish it and release the next one.

### Candidates

A release opens one PR on its branch, the **release PR** (`release-version/release/0.85`, `chore(release): version`), built by the branch's Publish run whenever `telo release status` plans a unit. It runs `telo release apply --candidate`, which versions every planned unit as `<final>-rc.<k>` — line and non-line units alike, a polyglot unit's npm package and crates together, images and charts with their units — and consumes no fragment, so the fragments stay for the final. **Candidacy is derived, never stored**: the branch is in candidates while `v0.85.0` does not exist and its open release PR's head carries no final versions; there is no state file to create or delete. `k` is per unit, shared within a group, and rises only when a layer of the unit changed since its last candidate, so the next candidate republishes only units that moved. The release job checks out with `TELO_BOT_TOKEN`, so the release PR is pushed by the bot and its required checks start without a re-run; `telo release check` does not check coverage on a PR from a `release-version/*` or `release-record/*` branch, since it consumes the fragments.

Merging a release PR publishes the candidate `0.85.0-rc.N`. When the telo line moved, the run is tagged `v0.85.0-rc.N`; a candidate run that moves only other units is tagged `packages-0.85-rc.<n>` or `modules-0.85-rc.<n>`. Every moved unit is tagged `<unit key>@<version>` (`kernel@0.85.0-rc.1`) on the release commit before anything publishes, and the release tag goes on the candidate's publication commit, whose imports pin the candidate module versions:

- npm packages under the `rc` dist-tag;
- modules at their `-rc.<k>` versions, so a candidate can be installed and run as its final will be; a candidate version never moves a module's OCI `latest`;
- the built-in vocabulary at `oci://ghcr.io/telorun/telo@0.85.0-rc.N`;
- kernel images `telorun/node:0.85.0-rc.N`, with the `-slim` and `-rust-<version>` variants;
- the images and charts of the units the candidate moved, tagged with their unit's `-rc.<k>`;
- on the GitHub pre-release `v0.85.0-rc.N`: the standalone CLI installers, the VS Code `.vsix` and the docs site build `site-next.tar.gz`.

A candidate publishes no Marketplace extension, no Studio, no `latest`, `<major>` or `<major>.<minor>` pointer, no telo.sh redirect, and is never recorded on main. `npm i @telorun/cli` keeps installing `latest`; candidates are opt-in. Prereleases are inert to consumers: `telo upgrade` and the editor read a prerelease's `restrictions:` only with `--include-prerelease`, the editor's version catalog never selects a candidate engine, and the hub indexes final versions only (it never tracks a candidate's built-in vocabulary).

A fix PR into the branch leads to the next candidate. The branch's full CI (macOS, Windows, Bun, Docker-image manifests) gates every PR into it.

### Finish

```
gh workflow run finish-release.yml --ref release/0.85
```

Builds the final release PR itself, pushed with `TELO_BOT_TOKEN`: it runs the branch's version step (`telo release apply`) and opens `chore(release): version` from `release-version/release/0.85`, writing `0.85.0` into every planned unit, its changelog entries and the ledger. An open rc release PR (rc.1 or later; the first candidate must have published) becomes the final: its fragments ship in `0.85.0` and that rc is never published. A second dispatch rebuilds the same PR. While the PR is open, a fix merged into the branch rebuilds it as the final, because its head now records final versions, which is what ends candidacy; closing the PR goes back to candidates (the next rebuild is an rc). It refuses on a ref that is neither main (below) nor a `release/*` branch (`Error: Publish final release runs on main or on a release/* branch in candidates; feat/x is neither.`), on a branch that has published no candidate (`Error: release/0.85 has published no candidate yet. …`), and on a branch that has published its final (`Error: release/0.85 has published 0.85.0 and takes patches only.`). It also refuses while a Publish run of the branch is still in progress; dispatch it after that run completes.

Merging that release PR publishes the final `0.85.0` in one run (the order is under [The publication commit](#the-publication-commit)):

- npm under `latest`, then the `rc` dist-tag moved to the final;
- the modules the PR versioned;
- the publication commit, tagged `v0.85.0` (and `modules-0.85-1` when modules published), and the Record release dispatch (below);
- `telorun/node:0.85.0` with the variants, and the `latest`, `<major>.<minor>` and `<major>` tags, each only if no higher final names the same scope;
- once the artifact check passes, each built from the tag: the images of the hub, docker-runner, k8s-runner, hub-web and authoring-agent, and the hub and k8s-runner charts when their unit's version moved;
- Studio: desktop builds, the web image and chart, `studio-web.tar.gz` on the release, and Studio pages;
- the VS Code Marketplace, forward only;
- the standalone CLI, the telo.sh redirect (forward only), and the GitHub Release `v0.85.0` marked latest unless a higher one is;
- `site-root.tar.gz` on the release, and the docs deploy.

### Straight to the final

```
gh workflow run finish-release.yml --ref main
```

Dispatched at main, `Publish final release` cuts the next release with no candidates. It makes every check `Start release candidates` makes, with the same refusals and messages (above): the live branch must not be in candidates, hold unreleased changes, be unrecorded on main or have a Publish run in progress, main's release plan must move the line by a minor, and `release/<x.y>` must not exist. Then, once `0.85.0` has shipped and main records it, it creates `release/0.86` at the main commit it was dispatched on, versions that commit from its pending fragments and opens `chore(release): version` from `release-version/release/0.86` into it, writing `0.86.0` for the line and every other unit the plan moves. Nothing is versioned as a candidate on this path.

Merging the PR publishes the final `0.86.0` exactly as a finish over candidates does (the list above), and the branch then takes patches. Until then:

- a Publish run of the new branch waits while the PR is being opened, and a Publish run rebuilds the open PR as the final, a fix merged into the branch included;
- closing the PR goes back to candidates: the branch's next Publish run opens an rc release PR, and the release continues from Candidates;
- a second dispatch at main refuses, because `release/0.86` is now the live branch and holds the fragments the PR versions (`Error: release/0.86 holds unreleased changes (…). Publish them before cutting 0.87.`); dispatch it at the branch only once it is in candidates.

The cost is that no candidate exercises what is published before the pointers move: the npm packages, the kernel and app images, the standalone CLI, the `.vsix`, Studio and the docs site are first built from this branch by the very run that moves `latest`, the Marketplace and `/`, and no `/next/` preview is served. What still gates them is the branch's full CI on the release PR, and the artifact check on what is built from the tag.

### Patches

After the final the branch takes patches: write `Fixed` fragments there, so it never plans a version main's next cut will plan. Patches (`0.85.1`) publish directly through the same release PR, with no candidate, and move the same pointers a final does.

### The one live branch

Only the newest `release/*` branch publishes: candidates, then its final, then patches until the next cut. A branch is frozen when a newer `release/*` ref exists, and every job of its Publish run refuses as its first step (`release/0.84 is frozen: release/0.85 was cut from main. Land the fix on release/0.85.`).

**A fix for the shipped release during candidates.** While `release/0.85` is in candidates, `release/0.84` is frozen. A fix for `0.84.x` lands on `release/0.85` and reaches users at its final, `0.85.0`; there is no `0.84.3`. Security fixes included; when a fix cannot wait, finish the candidates sooner.

## Modules

Modules are units like any other, and they publish in every run that moves them, candidates included: a module's candidate version (`1.2.0-rc.1`) is pushed beside the line's candidate, so the release tag's consumers resolve every pin. A module adopting grammar of the release in candidates holds `requires: telo: ">=unreleased"` (written by `telo release floor`, never by hand) and is tried through relative imports in the checkout; `telo release apply` rewrites every `>=unreleased` in the workspace's module manifests, `restrictions:` entries included, to the surface of the `telo` group's planned version, and `telo publish` refuses one still present. A candidate's floor equal to the line's surface is measured with the newest published `<surface>-rc.N` CLI.

The release PR versions everything. The branch's Publish run builds it whenever `telo release status` plans a unit — pending fragments, drift, or both — with `telo release apply` (`--candidate` in candidates); its body lists the declared changes above the plan generated from `telo release status`. Merging it publishes npm, then the modules, then the charts and images, in one run; there is no separate module PR. A run that publishes, for the first time, module versions its commit moved is the module release `modules-<major>.<minor>-<n>` (`modules-0.85-1`; `modules-0.85-rc.1` for a candidate), `n` counting that branch's module releases, tagged with the run's other tags on its publication commit.

The release PR's CI is the branch's full CI plus one gate, `pnpm run check:release-imports`: `telo release imports --as=published --dry-run` over the four consumer roots fails when an import would stay relative for any reason but its version awaiting this release's publish — a module whose changes its version does not carry. So the publication commit made after the merge can fail only on a registry error, which a re-run heals.

Main publishes no image; a release branch's Publish run moves an image's `latest` only forward, on a final version no released one of the unit exceeds (a candidate moves none). Each app image's `latest` follows the image's own unit version.

## The publication commit

The **release commit** of a release is the merge of its release PR, on the branch. Its **publication commit** is a child of it that no release branch holds (`stable` points at the newest final's), `chore(release): publish v0.85.1`, whose only change is `telo release imports --as=published` over `examples/`, `starters/`, `apps/` and `blueprints/`. Every tag of a release, a candidate's included — `v<x.y.z>`, `modules-<x.y>-<n>`, `packages-<x.y>-<n>`, each with `-rc.` before the number for a candidate — is placed on it, so a tag carries pins to published artifacts while every branch keeps relative imports; when the rewrite changes nothing the tags name the release commit. Its tree is a function of the release commit and the registry's immutable pins, and its author, committer and dates are fixed (the bot, the release commit's committer date), so a re-run makes the same commit and finds its tags in place. A fix pushed onto the branch after its release PR merged does not hide the release: while no tag names the version commit, the Publish run at the fix's tip still releases it (classification, the moved module versions and the release notes read the newest `chore(release): version` commit), and the tags then go on the tip's publication commit. Once a tag names it, a later tip releases nothing.

A tag's release commit is the commit it points at, unless that is a publication commit (its subject names the publication and its diff respells import lines only), in which case it is its first parent. Record release, the cut's refusal, the release channel, the numbering of `modules-` and `packages-` tags and every image or Studio job asking "did this release move my version" read a tag that way, so a tag made on its release commit reads the same.

### The run order

Merging a release PR runs one Publish, in order:

0. every moved unit tagged `<unit key>@<version>` on the release commit (a unit's tag is the one the links in its published package name);
1. npm;
2. modules, so every floor names a published telo;
3. the publication commit;
4. every tag of the release and the GitHub Release as a draft, then the Record release dispatch (never for a candidate); once the artifact check passes, the `stable` branch (finals and patches only);
5. the artifact check;
6. the app images and charts, Studio (finals and patches only), the site, the standalone CLI and the `.vsix`, each checking out the tag; the standalone CLI's job promotes the GitHub Release.

The kernel images and the built-in vocabulary are built from npm, after step 1, and wait for nothing else. A module or packages release runs the same order without the kernel images, the standalone CLI, the `.vsix`, Studio and the site; its app images and charts are built on the branch's last released telo.

### The artifact check

`Check the published release` checks the publication commit as a user receives it: a fresh checkout with no `.telo` cache, `telo check` over the four roots, and the example, starter and blueprint suites. It gates step 6 only. The tags and the record are already out, because they say what was published: a red check leaves the release tagged and recorded with no images, Studio, site, installers or `.vsix`, and the GitHub Release a draft. A re-run that passes completes it after a flake; a defect is fixed by the next patch.

### Failures before the tag

Steps 1–3 are idempotent: a re-run skips what npm and the registry already hold and makes the same publication commit. A run that cannot complete them leaves an npm version or module versions with no tag (Recovery). The next release PR — which pending drift or fragments open by themselves — ships the fix, and its tag records both.

### Rehearsal

```
pnpm run publication-commit -- --release <commit> --tag <tag> --dry-run
```

From a checkout of the release commit, installed and built (`pnpm install && pnpm -r build`), with `TELO_OCI_REGISTRY` set as Publish sets it, this builds the publication commit of a release whose modules are published and prints its diffstat and what each tag would do, pushing nothing. The command runs in that checkout, the same place the release PR's gate and `telo publish` build in, because a controller bundle records the path of each inlined dependency relative to its build root and digests differently in any other tree. It refuses, naming why, a `HEAD` that is not `--release`, a change to a tracked file and an untracked manifest under the consumer roots; it rewrites the consumer manifests in place, writes the commit through a private index, and restores the manifests before it returns, so the checkout, `HEAD` and the index end as they began. Run against the release commit of the live line's newest tag, it rehearses steps 3 and 4 with no publish.

## Record

Main's ledger, changelogs and versions must hold what shipped, because the next cut plans versions from them and main's own checks (floors judged against published CLIs, fragment coverage) read main's files. After every final, patch, packages-only and module release — never a candidate — Publish dispatches **Record release** (`record-release.yml`, main's own copy) with the new tag. It runs main's scripts on main's tip and rebuilds one PR per line, `chore(release): record v0.85.1 on main` from `release-record/release/0.85`, pushed with `TELO_BOT_TOKEN` so it starts checks:

- It always records the branch's **newest non-rc tag** — `v<x.y.z>`, `packages-<x.y>-<n>` or `modules-<x.y>-<n>`, newest by its release commit's place in the branch's history, and on one release commit `modules` over `packages` over `v` — since the branch is linear and that tag holds every earlier release's state. A tag containing `-rc.` is refused, as is a tag the live branch does not reach; an older tag of the line records the newest, and the PR's title names the tag recorded.
- It **copies** from that tag's release commit, for every unit present on main, the unit's version into every version location (each anchor's `package.json`, `Cargo.toml` and `Cargo.lock` entry, `Chart.yaml`, `telo.yaml`), its `CHANGELOG.md` and its `.changes/ledger.yaml` entry; it **deletes** each fragment the tag released — one of the same path and content that was at the cut or was written on the branch since, and that the tag no longer holds. A same-named file with other content is not released and stays.
- It **computes**, never copies, floors: `telo release floor` runs on main's tree after the copy, so a `>=unreleased` for grammar the release shipped becomes its number, while one for main-only grammar stays. It takes one floor from the tag rather than computing it, because measurement cannot: a `>=unreleased` in a module's `requires.telo` or `restrictions:` entry that the release resolved on its branch becomes the bound the tag holds at the same place (a restriction matched by its index and `reason`), whatever fragments main still holds pending. A restriction is invisible to `telo release floor`, and one left at `>=unreleased` in a dependency held every dependent's measured floor there through its import closure. It writes no pin: main's imports stay relative.
- **Land it with a squash.** Merge it after the line's last module tag so one record covers them; every later tag rebuilds the same PR. While it is open main is stale, and `Start release candidates` refuses, as does `Publish final release` at main.
- A main edit that conflicts with an open record PR is fixed by dispatching Record release again, never by hand.

Main records a tag when running the record's copy-and-delete half against main's tip finds nothing to change; no marker file is kept, and the same test makes a re-dispatch idempotent.

**Transition.** `release/0.133` keeps the pipeline it was cut with — separate module and import-sync PRs, tags on release commits — and the first line on this flow is the next cut. A record of a `0.133` tag repins nothing on main and reads the tag as its own release commit; where that branch's Publish dispatches no record, dispatch it by hand after each of its releases: `gh workflow run record-release.yml --ref main -f tag=<tag>`. `0.133` cannot be rehearsed: its ledger was written by an older CLI.

A publish that released npm packages but did not move the CLI, outside candidates, is tagged `packages-<major>.<minor>-<n>` (`n` counted like `modules-*`), and is recorded like the others. 

### Fixes land on main first

Every fix lands on main first, pipeline repairs included. When a release needs it, open a PR into `release/0.85` made with `git cherry-pick -x <main commit>`, carrying the main PR's fragment file unchanged so it counts once. Main and the branch hold the same relative imports, so on every line but `release/0.133` a pick applies without import-line conflicts. The record deletes the fragment from main when the release that consumed it is recorded. After the final the branch takes patches, so a main fragment of kind `Added` is recreated as `Fixed` in the pick; main's original is then released again by the next line, one duplicate changelog line.

```
git switch -c pick/fix-retry release/0.85
git cherry-pick -x 3f9a1c2
gh pr create --base release/0.85
```

The single exception: a change lands on the branch alone when main's code already differs so that the fix does not apply. That PR names the main commit that superseded it. Branch content never reaches main.

## Where workflows live

- A run triggered on `release/*`, by a push or by a dispatch at that ref, uses **that branch's files**: its workflows, scripts and CLI. A change the live branch needs, a pipeline fix included, lands on main first and reaches the branch as a cherry-pick PR (above).
- `cut-release.yml`, `finish-release.yml` and `record-release.yml` keep their files on main because GitHub dispatches only workflows present on the default branch. `finish-release.yml` is dispatched at the release ref, and runs the branch's copy of its scripts, or at main for a release straight to its final, and runs main's; `record-release.yml` is dispatched at main and runs main's.
- `retry-publish.yml` (read from main) re-runs the failed jobs of a failed `Publish` or `Publish Docker Images` run on `main` or `release/*`, at the run's own commit, up to three attempts in total.
- Publish's jobs: `release` (the unit tags and npm), `release-pr` (the release PR, on every run, from what `telo release status` plans), `publish-modules`, `publish-builtins`, `publication` (the publication commit, every tag, the draft GitHub Release), `record` (never for a candidate), `artifact-check`, `stable` (the branch, after the check passes), then the called workflows.
- `pages.yml`, `publish-docker.yml`, `cli-standalone-release.yml`, `vscode-release.yml`, `studio-release.yml` and `studio-pages.yml` are called by `publish.yml`, so they are the branch's own copies too. Each checks out the release tag, on the release's publication commit. `publish-docker.yml` is called twice: `images: kernel` on the run's commit, and `images: apps` at the tag once the artifact check passed.

## Pointers move only forward

A publish never moves a pointer that already holds a higher version: npm `latest` and `rc`, Docker `latest`, `<major>.<minor>` and `<major>`, Studio pages, the Marketplace, the telo.sh redirect, GitHub's latest release, the docs site and the `stable` branch. Pointers are compared against the repository's own final tags, so re-running an old publish moves nothing. A package with no final yet keeps `latest` at its newest candidate.

**`stable`** is a branch holding one ref: the publication commit of the newest final release (`v<x.y.z>`, patches included). A URL into it, `https://raw.githubusercontent.com/telorun/telo/stable/examples/<name>/telo.yaml`, serves the example as that release's tag does, with pins to published artifacts, and a clone of it runs the examples as published. Publish force-pushes it in the `stable` job, once the artifact check has passed on that commit (`scripts/release-stable.mjs`); a failed push fails that job and blocks nothing else; a candidate, a `modules-*` or `packages-*` release, and an older final never move it, and nobody commits to it. It exists from the first final released by a Publish that has the step; before then, seed it once, before the ruleset exists or with the bot's token: `git push --force origin <vtag>^{commit}:refs/heads/stable`.

```
$ npm view @telorun/cli dist-tags
{ latest: '0.84.2', rc: '0.85.0-rc.1' }
```

## The docs site

- Each candidate, final and patch builds the site from its own tag, examples index and `llms.txt` included, and attaches it to its GitHub Release: `site-next.tar.gz` for a candidate (base URL `/next/`, with a banner naming the release it previews), `site-root.tar.gz` for a final or patch (base URL `/`).
- The deploy composes the newest final's `site-root.tar.gz` at `/` and, only while a candidate of a later release is open, that candidate's `site-next.tar.gz` at `/next/`. A final or patch deploys `/` alone, which is how `/next/` goes away. The `github-pages` environment must allow `release/*`.
- Nothing deploys on a push to main: a docs fix reaches `/next/` with the next candidate and `/` with the next final or patch. Earlier releases are not served; their docs are the `docs/` tree at their tag on GitHub.

## Version numbers

A build has two versions. Its **surface** is the manifest generation `requires: telo:` is checked against; its **identity** is what `--version` (Node and Rust CLI), npm, the language-server handshake and the built-in vocabulary tag report. Neither reads a release plan: every build reports the recorded version of the analyzer unit (`analyzer/nodejs/package.json`) as `V+unreleased`, and only a package's own `prepack` embeds exactly `V` (its `postpack` restores every file it wrote), so a published package reports its version and a checkout never claims to be one. The surface is the triple of `V`. A candidate's recorded version is `0.85.0-rc.N`, so its surface is `0.85.0`. Rust twins are anchors of their unit and carry its version exactly.

```
$ npx @telorun/cli@0.85.0-rc.1 --version
0.85.0-rc.1
$ git switch release/0.85 && pnpm install && pnpm run telo --version    # after rc.1's release PR merged
0.85.0-rc.1+unreleased
$ git switch release-version/release/0.85 && pnpm install && pnpm run telo --version    # the final release PR's head
0.85.0+unreleased
$ git switch main && pnpm install && pnpm run telo --version            # after the cut, before 0.85.0 is recorded (main is unchanged)
0.85.0+unreleased
```

`telo release check` fails a `>=unreleased` floor in a plan that moves no telo version, since no release would carry the syntax it waits for. Floor verification (`telo release check`, `telo publish`) skips candidates when it names the latest published telo, except a candidate of the line's own surface, which `telo publish` measures with the newest published candidate CLI.

Known limit: main reports the recorded version's surface until `0.85.0` is recorded, so a module adopting main-only grammar in that window measures `>=unreleased` and the number is written by the next release PR.

## The first cut

`0.84.2` was published from main, so no `release/*` branch exists and its GitHub Release carries no `site-root.tar.gz`. In order:

1. The CI selection, the link rewrite and `pnpm run check:links` land on main.
2. Bootstrap the docs site: `gh workflow run pages.yml --ref main -f tag=<newest v* final tag>` attaches `site-root.tar.gz` to that release (it deploys nothing), so the first candidate's deploy has a `/` to compose.
3. The release workflows land on main, the maintainer setup below is done, and the first `Start release candidates` runs.

## Recovery

- **A Publish run failed.** `retry-publish.yml` re-runs its failed jobs up to three times. Otherwise re-run the failed run from the Actions page: it runs at its own commit and every step derives its work from what is already published, the publication commit included.
- **The artifact check failed.** The release is tagged and recorded, and nothing is built from its tag. Re-run the failed job after a flake; ship a defect's fix as the next patch.
- **Tags are missing after a publish.** Dispatch Publish at the branch (`gh workflow run publish.yml --ref release/0.85`). It tags the moved units again and makes the same publication commit and finds or creates its tags — the `modules-<x.y>-<n>` tag is re-derived from the module versions the tip commit moved, whether or not that run pushed them, and reuses a tag already on the release or its publication commit; the GitHub Release and the record dispatch are idempotent. This classifies the branch tip, so it heals a release only while the tip is the release commit; after later commits, make the publication commit and its tags by hand from a checkout of the release commit, installed and built, as in the rehearsal: `GH_TOKEN=<bot token> GITHUB_REPOSITORY=telorun/telo pnpm run publication-commit -- --release <sha> --tag <tag> --push`, then dispatch Record release with the tag.
- **Published to npm and modules, no tag.** The run failed before its tags. A re-run at the same commit heals it; so does a fix pushed onto the branch, since the tip's run still finds the unreleased version commit beneath it. A re-run does not heal it when the failing step is the pipeline's own: fix it on main, cherry-pick it to the branch, and the run at that tip tags the release. The next release PR, which the branch's pending fragments or drift open by themselves, ships the fix, and its tag records both releases. To tag the stranded release itself, make its publication commit and tags by hand as above: `v<x.y.z>` when it moved the line, else `packages-<x.y>-<n>`, plus `modules-<x.y>-<n>` when it published modules, each with the next unused `n`, and `telo release tag` on the release commit for the unit tags.
- **The record PR is missing, stale or conflicts.** Dispatch Record release again: `gh workflow run record-release.yml --ref main -f tag=modules-0.85-2`. It rebuilds the PR from main's tip; nothing is edited by hand.
- **A cut opened no release PR.** Dispatch Publish at the branch: `gh workflow run publish.yml --ref release/<x.y>`.
- **A release straight to its final created the branch but opened no release PR.** The branch exists, so the dispatch at main is not repeated: dispatch Publish at the branch as above. It opens an rc release PR, and the release continues through candidates.
- **A Docker image of a published version is missing.** Dispatch `publish-docker.yml` at the release tag, naming the half: `gh workflow run publish-docker.yml --ref v0.85.1 -f images=apps` (`kernel` for the `telorun/node` tag set, `all` for both). It rebuilds the release tag set of an already-published CLI version, and the app images from the tag's pinned tree.

## Maintainer setup, by hand

- Required checks for `main` and `release/*`, including `macOS: core unit tests` and `Windows: core unit tests`. The full macOS and Windows unit and manifest jobs, Bun and the Docker-image manifests run and gate only on a PR or push to a `release/*` branch; on main they are skipped, which a required check accepts. Nothing runs on a schedule.
- The rulesets let the release workflows create `release/*` refs, the release tags `v*`, `modules-*` and `packages-*`, **and the unit tags `<unit key>@<version>`** (`kernel@0.85.0`, `packages/glob@1.2.3`, `apps/studio@0.38.0` — a ref path with slashes; a tag ruleset matching `*@*` covers them), including tags pointing at a commit no branch holds (the publication commit). **Verify that on the first final of this flow**: it has not been exercised yet. No merge commit is ever needed, so `main` may require linear history. No other bypass: every change to `main` or a `release/*` branch lands through a PR.
- Secrets `TELO_BOT_TOKEN` (the release PR, pushed by Publish's release jobs and by Publish final release, `release/*` refs, the unit tags, the publication commit and its tags, the Record release dispatch and its PR, so they start checks) and, optionally, `VSCE_PAT` (the Marketplace; without it the final's `.vsix` is only attached to its GitHub Release and is uploaded to the Marketplace by hand), beside the existing registry, npm and Cloudflare ones.
- A ruleset on `stable` lets only the release bot (`TELO_BOT_TOKEN`) create, update and force-push it, and blocks everyone else.
- The `github-pages` environment allows deployments from `release/*`.
- The release PR and the record PR are opened by the bot, so the required checks run on them; `telo release check` skips coverage for their head branches (`release-version/*`, `release-record/*`). A ruleset or auto-merge rule written for the old release PR head (`changeset-release/*`) must name `release-version/*` instead.

## Links

Links in tracked markdown are relative paths to tracked files; GitHub resolves them against the ref being viewed, the site build turns them into site links or `blob/<tag>/…` links, and npm and `.vsix` packing rewrite them to `blob/<unit key>@<version>/…` — the unit tag of the package being published, which exists before it publishes. Module files hold no reference into the repository tree: they link to `https://telo.run/…` pages or to another module's hub page (`https://hub.telo.run/module/oci/ghcr.io/telorun/<name>/`), never to `telo.run/next/`. `pnpm run check:links` enforces it in the static checks.
