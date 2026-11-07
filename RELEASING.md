# Releasing

Main is where work lands and publishes nothing. A release is cut from main into a `release/<major>.<minor>` branch, published as release candidates (`-rc.N`) from that branch, finished into a final, and then patched from the same branch until the next cut. Every publish runs from a release branch, with that branch's own workflow files.

The examples follow one timeline: `0.84.2` is the newest final, `release/0.85` is in candidates, and main is working towards `0.86.0`.

Module releases (`telo release`) have their own guide: [Releasing modules](docs/extend/releasing-modules.md). This file covers when they publish and how they reach main.

## The cycle

```
main ── cut ──► release/0.85 ── rc.0 ── rc.1 ── finish ── 0.85.0 ── modules ── 0.85.1 ── …
   ▲                              (no merge-back)              │         │         │
   └──────────────── merge-back PRs: v0.85.0, modules-0.85-1, v0.85.1 ────────────┘
```

### Cut

```
gh workflow run cut-release.yml --ref main
```

`Cut release` takes no input. It opens the cut PR `chore(release): cut 0.85` from `release-cut/0.85`: one commit on main's tip that deletes the pending changesets and `.changes/pending/*` fragments, since the branch carries them. The minor is the one main's changesets plan reaches. When the PR merges, a workflow creates `release/0.85` at the cut commit's parent (main's tip as the cut was opened) and dispatches the new branch's Publish. A changeset that lands on main after that parent stays on main and describes work the branch does not carry.

It refuses, naming the cause, when:

- it is not run on main;
- the live branch is in candidates (`release/0.85 is in candidates (0.85.0-rc.1). Finish it before cutting 0.86.`);
- the live branch holds a pending changeset or fragment not yet published (`release/0.85 holds unreleased changes (…)`), since the branch would freeze with it stranded;
- main does not contain the live branch's newest `v*`, `modules-*` or `packages-*` tag (`Merge "chore(release): merge v0.85.0 into main" first.`);
- main's changesets plan only a patch, or no release;
- `release/<x.y>` already exists.

With no `release/*` branch yet, the live-branch checks pass.

**A cut is not undone.** A premature cut ships through its candidates to a final. Nothing deletes a release branch or withdraws a cut; if the cut was a mistake, finish it and release the next one.

### Candidates

The branch's first Version PR (`changeset-release/release/0.85`) enters changesets prerelease mode with tag `rc` and writes `.changeset/pre.json`. Every package with a changeset releases as `-rc.N`, line and non-line packages alike; private changeset-versioned packages (Studio, the Docker runner) carry rc versions and publish nothing until the final. The Version PR is opened with `TELO_BOT_TOKEN`, so the required checks run on it; the changeset gate exempts a PR from a `changeset-release/*` or `module-release/*` branch, since it consumes the changesets.

Merging a Version PR publishes the candidate `0.85.0-rc.N` and tags it `v0.85.0-rc.N`:

- npm packages under the `rc` dist-tag;
- the built-in vocabulary at `oci://ghcr.io/telorun/telo@0.85.0-rc.N`;
- kernel images `telorun/node:0.85.0-rc.N`, with the `-slim` and `-rust-<version>` variants;
- on the GitHub pre-release `v0.85.0-rc.N`: the standalone CLI installers, the VS Code `.vsix` and the docs site build `site-next.tar.gz`.

A candidate publishes no Marketplace extension, no Studio, no app images (hub, runners, hub-web, authoring agent), no `latest`, `<major>` or `<major>.<minor>` pointer, no telo.sh redirect and no module. `npm i @telorun/cli` keeps installing `latest`; candidates are opt-in. The editor's version catalog never selects a candidate engine, and a candidate `.vsix` bundles its own. The hub never tracks a candidate's built-in vocabulary.

A fix PR into the branch leads to the next candidate. The branch's full CI (macOS, Windows, Bun, Docker-image manifests) gates every PR into it.

### Finish

```
gh workflow run finish-release.yml --ref release/0.85
```

Opens `chore(release): finish 0.85` into the branch, which runs `changeset pre exit`. It refuses on a ref that is not a `release/*` branch, on a branch holding no `.changeset/pre.json`, and on one that already exited (`merge its Version PR to publish 0.85.0`).

Merging it and then the next Version PR publishes the final `0.85.0`, tagged `v0.85.0`:

- npm under `latest`, then the `rc` dist-tag moved to the final;
- `telorun/node:0.85.0` with the variants, and the `latest`, `<major>.<minor>` and `<major>` tags, each only if no higher final names the same scope;
- the images of the hub, docker-runner, k8s-runner, hub-web and authoring-agent, and the hub and k8s-runner charts when their version moved;
- Studio: desktop builds, the web image and chart, `studio-web.tar.gz` on the release, and Studio pages — each loading its starter gallery from the release tag's `starters/`, never main's;
- the VS Code Marketplace, forward only;
- the standalone CLI, the telo.sh redirect (forward only), and the GitHub Release `v0.85.0` marked latest unless a higher one is;
- `site-root.tar.gz` on the release, and the docs deploy;
- the import sync pull request (below).

The branch's modules publish after that run.

### Patches

After the final the branch accepts only patch changesets, for every package, so it never plans a version main's next cut will plan; the changeset gate refuses a minor there (`release/0.85 accepts only patch changesets`). Patches (`0.85.1`) publish directly through the same Version PR, with no candidate, and move the same pointers a final does.

### The one live branch

Only the newest `release/*` branch publishes: candidates, then its final, then patches until the next cut. A branch is frozen when a newer `release/*` ref exists, and every job of its Publish run refuses as its first step (`release/0.84 is frozen: release/0.85 was cut from main. Land the fix on release/0.85.`).

**A fix for the shipped release during candidates.** While `release/0.85` is in candidates, `release/0.84` is frozen. A fix for `0.84.x` lands on `release/0.85` and reaches users at its final, `0.85.0`; there is no `0.84.3`. Security fixes included; when a fix cannot wait, finish the candidates sooner.

## Modules

No module publishes during candidates. The Module Release PR (`module-release/release/0.85`, `chore(release): version modules`) does not open on a branch holding `.changeset/pre.json`, nor while the branch's changesets still plan a release, so every module version publishes after the `0.85.0` its floor names. A module adopting grammar of the release in candidates declares that release's floor (`requires: telo: ">=0.85.0"`) as usual and is tried through relative imports in the checkout.

After the final, module releases run from the branch as they did from main: the Module Release PR opens, and merging it publishes the changed modules in the Publish run's module job. A run that moved module versions tags its commit `modules-<major>.<minor>-<n>` (`modules-0.85-1`), `n` counting that branch's module releases, and opens a merge-back.

Main publishes no image; a release branch's Publish run moves an image module's `:latest` only forward, on finals, patches and module releases. Each app image's `latest` follows the image's own version: it moves unless a release tag holds a higher one.

## Merge-back

Main's changeset and module ledgers must hold what shipped, because the next cut plans versions from them. After every final, patch, packages-only and module release, Publish opens `chore(release): merge v0.85.1 into main` (or `chore(release): merge modules-0.85-3 into main`, `chore(release): merge packages-0.85-2 into main`) from `merge-back/<tag>`, with `TELO_BOT_TOKEN` so the PR starts checks.

- It merges the **tag**, not the branch tip, so a fix landed after the publish does not reach main with its changeset and release twice.
- **Land it with a merge commit**: not a squash, not a rebase. Main must contain the tag's commits, which `Cut release` checks.
- A conflict is resolved by hand in the merge-back PR, keeping the tag's versions and main's other edits.
- A publish that released npm packages but did not move the CLI, outside candidates, is tagged `packages-<major>.<minor>-<n>` (`n` counted like `modules-*`), and its merge-back merges that tag. `Cut release` checks it like the others. The tag is also the one the published tarballs' links name.
- Commits contained in a `v*`, `modules-*` or `packages-*` tag count as released for the changeset gate and for `telo release check`'s changed-files rule, so the merge-back passes without a changeset or fragment of its own.
- A second PR for a tag is never opened, and nothing is opened when main already contains it.
- Nothing merges after a candidate, and nothing flows from main to a branch.

The import sync (`chore(imports): sync imports with published modules`) is a job of the branch's Publish run after module publishing, on finals, patches and module releases. It opens `imports/release/0.85` into the branch, and reaches main through the next merge-back. It has no schedule and never runs on main.

## Where workflows live

- A run triggered on `release/*`, by a push or by a dispatch at that ref, uses **that branch's files**: its workflows, scripts and CLI. A change the live branch needs, a pipeline fix included, is a PR into that branch. A fix main needs sooner may also land on main as its own PR; the merge-back reconciles the two.
- `cut-release.yml` and `finish-release.yml` keep their files on main because GitHub dispatches only workflows present on the default branch. `finish-release.yml` is dispatched at the release ref, and runs the branch's copy of its scripts.
- `retry-publish.yml` (read from main) re-runs the failed jobs of a failed `Publish` or `Publish Docker Images` run on `main` or `release/*`, at the run's own commit, up to three attempts in total.
- `pages.yml`, `publish-docker.yml`, `cli-standalone-release.yml`, `vscode-release.yml`, `studio-release.yml` and `studio-pages.yml` are called by `publish.yml`, so they are the branch's own copies too.

## Pointers move only forward

A publish never moves a pointer that already holds a higher version: npm `latest` and `rc`, Docker `latest`, `<major>.<minor>` and `<major>`, Studio pages, the Marketplace, the telo.sh redirect, GitHub's latest release and the docs site. Pointers are compared against the repository's own final tags, so re-running an old publish moves nothing. A package with no final yet keeps `latest` at its newest candidate, which is what `changeset publish` writes for it.

```
$ npm view @telorun/cli dist-tags
{ latest: '0.84.2', rc: '0.85.0-rc.1' }
```

## The docs site

- Each candidate, final and patch builds the site from its own tag, examples index and `llms.txt` included, and attaches it to its GitHub Release: `site-next.tar.gz` for a candidate (base URL `/next/`, with a banner naming the release it previews), `site-root.tar.gz` for a final or patch (base URL `/`).
- The deploy composes the newest final's `site-root.tar.gz` at `/` and, only while a candidate of a later release is open, that candidate's `site-next.tar.gz` at `/next/`. A final or patch deploys `/` alone, which is how `/next/` goes away. The `github-pages` environment must allow `release/*`.
- Nothing deploys on a push to main: a docs fix reaches `/next/` with the next candidate and `/` with the next final or patch. Earlier releases are not served; their docs are the `docs/` tree at their tag on GitHub.

## Version numbers

A build has two versions. Its **surface** is the manifest generation `requires: telo:` is checked against; its **identity** is what `--version` (Node and Rust CLI), npm, the language-server handshake and the built-in vocabulary tag report. The version generator takes the line's next version from changesets' own release plan, `.changeset/pre.json` included. A candidate reports the release it previews as its surface (`0.85.0`) and keeps `0.85.0-rc.N` as its identity; a tree with a changeset not yet released reports the next identity with `+unreleased`. Rust twins carry their Node twin's version exactly (`0.85.0-rc.N` in `Cargo.toml` and `Cargo.lock`, `0.85.0` at the final).

```
$ npx @telorun/cli@0.85.0-rc.1 --version
0.85.0-rc.1
$ git switch release/0.85 && pnpm install && pnpm run telo --version    # one fix changeset pending
0.85.0-rc.2+unreleased
$ git switch release/0.85 && pnpm install && pnpm run telo --version    # after the Finish release PR, before the Version PR
0.85.0+unreleased
$ git switch main && pnpm install && pnpm run telo --version            # right after the cut, nothing pending
0.84.2
$ git switch main && pnpm install && pnpm run telo --version            # a minor changeset pending, before the 0.85.0 merge-back
0.85.0+unreleased
```

The changeset gate drops every id listed in `.changeset/pre.json` from what covers a changed package, so a released candidate's changeset never covers a later change. Floor verification (`telo release check`, `telo publish`) skips candidates when it names the latest published telo.

Known limits: two candidates of one release both report surface `0.85.0`, so a module adopting grammar added in rc.1 passes the floor check on the rc.0 CLI and then fails with errors that blame the module; and main reports the cut release's surface until the `0.85.0` merge-back, so a module adopting main-only grammar in that window declares `>=0.85.0` and the floor is raised on `release/0.86`.

## The first cut

`0.84.2` was published from main, so no `release/*` branch exists and its GitHub Release carries no `site-root.tar.gz`. In order:

1. The CI selection, the link rewrite and `pnpm run check:links` land on main.
2. Bootstrap the docs site: `gh workflow run pages.yml --ref main -f tag=<newest v* final tag>` attaches `site-root.tar.gz` to that release (it deploys nothing), so the first candidate's deploy has a `/` to compose.
3. The release workflows land on main, the maintainer setup below is done, and the first `Cut release` runs.

## Recovery

- **A Publish run failed.** `retry-publish.yml` re-runs its failed jobs up to three times. Otherwise re-run the failed run from the Actions page: it runs at its own commit and every step derives its work from what is already published.
- **Tags or merge-backs are missing after a publish.** Dispatch Publish at the branch (`gh workflow run publish.yml --ref release/0.85`). Tagging, the GitHub Release and the merge-back are idempotent. This classifies the branch tip, so it heals a release only while the tip is the release commit; after later commits, create the tag by hand at the release commit (`GH_TOKEN=<bot token> GITHUB_REPOSITORY=telorun/telo node scripts/release-tag.mjs <tag> <sha>`) and run `node scripts/release-merge-back.mjs <tag>`.
- **A cut PR merged but no branch exists.** Create `release/<x.y>` at the cut commit's parent, then `gh workflow run publish.yml --ref release/<x.y>`.
- **A module or packages release published with no tag.** Tag the commit by hand as above (`modules-<x.y>-<n>` or `packages-<x.y>-<n>`, the next unused `n`) and run `node scripts/release-merge-back.mjs <that tag>`.
- **A merge-back conflicts.** Resolve it in the PR, keeping the tag's versions and main's other edits; do not squash.
- **A Docker image of a published version is missing.** Dispatch `publish-docker.yml` at the branch or the release tag; it rebuilds the release tag set of an already-published CLI version.

## Maintainer setup, by hand

- Required checks for `main` and `release/*`, including `macOS: core unit tests` and `Windows: core unit tests`. The full macOS and Windows unit and manifest jobs, Bun and the Docker-image manifests run and gate only on a PR or push to a `release/*` branch; on main they are skipped, which a required check accepts. Nothing runs on a schedule.
- The rulesets allow merge commits, and let the release workflows create `release/*` refs and `v*`, `modules-*` and `packages-*` tags. No other bypass: every change to `main` or a `release/*` branch lands through a PR.
- Secrets `TELO_BOT_TOKEN` (cut and finish PRs, the Version PR and Module Release PR, `release/*` refs, tags, merge-backs and import sync PRs, so they start checks) and, optionally, `VSCE_PAT` (the Marketplace; without it the final's `.vsix` is only attached to its GitHub Release and is uploaded to the Marketplace by hand), beside the existing registry, npm and Cloudflare ones.
- The `github-pages` environment allows deployments from `release/*`.
- The Version PR and the Module Release PR are opened by the bot, so the required checks run on them; the changeset gate exempts their head branches (`changeset-release/*`, `module-release/*`).

## Links

Links in tracked markdown are relative paths to tracked files; GitHub resolves them against the ref being viewed, the site build turns them into site links or `blob/<tag>/…` links, and npm and `.vsix` packing rewrite them to the tag being published. Module files hold no reference into the repository tree: they link to `https://telo.run/…` pages or to another module's hub page (`https://hub.telo.run/module/oci/ghcr.io/telorun/<name>/`), never to `telo.run/next/`. `pnpm run check:links` enforces it in the static checks.
