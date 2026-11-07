---
status: approved
priority: high
depends-on: []
packages: [.github/workflows, scripts, cli/nodejs, analyzer/nodejs, packages/language-host, apps/hub, apps/authoring-agent, ide/vscode, pages, docs, modules]
---

# Release branches and release candidates

## Problem

A pull request waits 34–40 minutes for CI, and longer when a flaky macOS job is re-run: 7 of the last 40 PR runs needed a second attempt, each costing another full run. Every PR runs the whole matrix — macOS and Windows unit and manifest tests, Bun, and the manifest suite inside the Docker image — although only Linux on Node is stable enough to gate a merge.

Every merge to main also publishes: the npm Version PR, module artifacts, Docker images, the standalone CLI, Studio, the VS Code extension, the docs site, Studio pages, the hub and the import sync all run from main. Main is unstable by design, yet it is the release, and nothing is ever published for a maintainer to try before users get it. 274 links (`github.com/telorun/telo/blob/main/…`) point readers at that unstable tree.

## Solution

The examples follow one timeline: `0.84.2` is the newest final, `release/0.85` is in candidates, and main is working towards `0.86.0`.

### PR checks are Linux on Node, plus a core check on macOS and Windows

- **Before:** every PR runs the whole matrix.
- **After:** a PR to main (and a push to main) runs the static and release checks, the Linux Node manifest tests, the Linux unit tests, Rust, the Postgres and package integration tests, the end-to-end and authoring-agent workflows, and two new jobs, `macOS: core unit tests` and `Windows: core unit tests`. The two new jobs run the unit tests of the analyzer, kernel and CLI only, when the diff reaches them.
- **Release only:** the full macOS and Windows unit and manifest jobs, Bun, and the Docker-image manifests run and gate every PR and push on a `release/*` branch. On a PR to main they start and report skipped, as selected-out jobs do today. Nothing runs on a schedule.
- **By hand:** the maintainer updates the branch-protection required checks for `main` and `release/*`. The rulesets allow merge commits and let the release workflows create `release/*` refs and `v*` and `modules-*` tags; no other bypass is granted, so every change to `main` or a `release/*` branch lands through a PR.

### One release branch at a time

**Cut.** `Cut release` (a manual workflow on main, taking no input) opens the cut PR from `release-cut/<major>.<minor>`: one commit on main's tip T that deletes T's pending changesets and `.changes/pending/*` fragments, since the branch carries them. The minor is the one main's changesets release plan reaches at T. When the cut PR merges, a workflow creates `release/<major>.<minor>` at T, the cut commit's parent, and dispatches the new branch's Publish workflow, which opens its first Version PR. A changeset that landed on main after T stays on main, describing work the branch does not carry.

```
$ gh workflow run cut-release.yml --ref main
✓ Created workflow_dispatch event for cut-release.yml at main
$ gh run view --log
cut	Cut	Opened #812 "chore(release): cut 0.85" at 4e1c9a7 (parent 9b02f3d): 14 changesets and 9 module fragments removed.
cut	Cut	release/0.85 is created at 9b02f3d when #812 merges.
```

`Cut release` refuses, naming the cause, when the live branch is in candidates, when the live branch holds a pending changeset or fragment (the branch is about to freeze, so it would be stranded), when main does not contain the live branch's newest `v*` or `modules-*` tag, or when main's changesets plan only a patch. Five attempts to cut 0.86 — during the 0.85 candidates, with a fix merged on `release/0.85` but not yet published, after `0.85.0` ships but before its merge-back lands, before a module release's merge-back lands, and on a patch-only main:

```
$ gh workflow run cut-release.yml --ref main
✓ Created workflow_dispatch event for cut-release.yml at main
$ gh run view --log-failed
cut	Check	Error: release/0.85 is in candidates (0.85.0-rc.1). Finish it before cutting 0.86.
$ gh run view --log-failed
cut	Check	Error: release/0.85 holds unreleased changes (.changeset/quiet-lamps-glow.md). Publish them before cutting 0.86.
$ gh run view --log-failed
cut	Check	Error: main does not contain v0.85.0. Merge "chore(release): merge v0.85.0 into main" first.
$ gh run view --log-failed
cut	Check	Error: main does not contain modules-0.85-3. Merge "chore(release): merge modules-0.85-3 into main" first.
$ gh run view --log-failed
cut	Check	Error: main's changesets plan 0.85.1, a patch. Add a minor changeset before cutting.
```

A cut is not undone. A premature cut ships through its candidates to a final; `RELEASING.md` states this limit.

**Candidates.** The branch's first Version PR enters changesets prerelease mode with tag `rc` (it writes `.changeset/pre.json`; `initialVersions` lists every workspace package — three shown here — and `changesets` the ids already released). Every package with a changeset releases as `-rc.N`, line and non-line packages alike; private changeset-versioned packages (Studio, the Docker runner) carry rc versions and publish nothing until the final. Merging a Version PR publishes candidate `0.85.0-rc.N`, tagged `v0.85.0-rc.N`:

- npm packages under the `rc` dist-tag;
- the built-in vocabulary at `oci://ghcr.io/telorun/telo@0.85.0-rc.N`;
- kernel images `telorun/node:0.85.0-rc.N` (and slim variants);
- the standalone CLI, the VS Code `.vsix` and the site build `site-next.tar.gz` on a GitHub pre-release `v0.85.0-rc.N`.

No module publishes during candidates (below). A fix PR into the branch leads to the next candidate.

```json
{
  "mode": "pre",
  "tag": "rc",
  "initialVersions": { "@telorun/cli": "0.84.2", "@telorun/kernel": "0.84.2", "@telorun/editor-protocol": "1.3.0" },
  "changesets": ["brave-otters-sing", "quiet-lamps-glow"]
}
```

**Finish.** `Finish release` is dispatched at the branch ref and opens a PR that exits prerelease mode; it refuses on any ref that is not a `release/*` branch holding `.changeset/pre.json`:

```
$ gh workflow run finish-release.yml --ref release/0.85
✓ Created workflow_dispatch event for finish-release.yml at release/0.85
$ gh run view --log
finish	Finish	Opened #830 "chore(release): finish 0.85" into release/0.85: changeset pre exit; the next Version PR publishes 0.85.0.
$ gh workflow run finish-release.yml --ref main
✓ Created workflow_dispatch event for finish-release.yml at main
$ gh run view --log-failed
finish	Check	Error: Finish release runs on a release/* branch in candidates; main is not one.
$ gh workflow run finish-release.yml --ref release/0.84
✓ Created workflow_dispatch event for finish-release.yml at release/0.84
$ gh run view --log-failed
finish	Check	Error: release/0.84 holds no .changeset/pre.json, so it is not in candidates.
```

The next Version PR publishes `0.85.0`, tagged `v0.85.0`: npm under `latest`, `telorun/node:0.85.0`, the standalone CLI, the Studio web build and the site build `site-root.tar.gz` on the GitHub Release `v0.85.0`, the hub and runner images, and the import sync. The branch's modules publish next.

**One live branch.** Only the newest `release/*` branch publishes: it takes candidates, then its final, then patches until the next cut. A branch is frozen when a newer `release/*` ref exists; its Version PR and publish job refuse. A fix merged into `release/0.84` after the cut:

```
$ gh run list --workflow publish.yml --branch release/0.84 --limit 1
X  fix(http-server): keep-alive timeout  Publish  release/0.84  push  9311804772
$ gh run view 9311804772 --log-failed
release	Check	Error: release/0.84 is frozen: release/0.85 was cut from main. Land the fix on release/0.85.
```

A fix for the shipped release found during candidates — a security fix included — lands on the candidate branch and reaches users at its final; `RELEASING.md` states this route and its limit.

**Patches.** After its final the branch accepts only patch changesets, for every package, so it never plans a version main's next cut will plan. Patches (`0.85.1`) publish directly, with no candidate.

```
Error: release/0.85 accepts only patch changesets; @telorun/editor-protocol has a minor (.changeset/brave-otters-sing.md).
```

**Merge-back.** Every module release from a `release/*` branch tags its commit `modules-<major>.<minor>-<n>`, `n` counting that branch's module releases. After every final, patch and module release, the Publish workflow opens "chore(release): merge v0.85.1 into main" (or "chore(release): merge modules-0.85-3 into main") with `TELO_BOT_TOKEN`, merging the tag rather than the branch tip; it lands with a merge commit. So main's ledger, which the next cut plans module versions from, holds every published module version. Nothing merges after a candidate, and nothing flows from main to a branch.

- A conflict is resolved by hand in the merge-back PR, keeping the tag's versions and main's other edits.
- Commits contained in a `v*` or `modules-*` tag count as released for the changeset gate and for `telo release check`'s changed-files rule, so the merge-back passes the gate. The gate diffs against the PR's base branch, not main.

### Where workflows live

- A workflow triggered on `release/*` — by a push, or dispatched at that ref — runs only that branch's files: its workflows, scripts and CLI. A change the live branch needs, a pipeline fix included, is a PR into that branch. A fix main needs sooner may also land on main as its own PR; the merge-back reconciles the two.
- `retry-publish.yml` (now `branches: [main, 'release/*']`) only re-runs the failed run, at its own commit, up to 3 attempts.
- The import sync is a job of the branch's own Publish workflow, after module publishing, on finals and patches only. It opens `imports/release/<major>.<minor>` into the branch, reaching main through the merge-back; it has no schedule and never runs on main.
- `Cut release` and `Finish release` keep their files on main, since GitHub dispatches only workflows present there; `Finish release` runs at a release ref.

### Shared pointers move only forward

Only one branch publishes, so its Publish workflow moves every shared pointer itself:

- npm: candidates publish under `rc`, finals and patches under `latest`, after which `rc` is moved to the final so `@rc` never resolves below `latest`. A package with no final yet keeps `latest` at its newest candidate, which is what `changeset publish` writes for it.
- On finals and patches only: `telorun/node:latest` (and slim variants), Studio pages, the VS Code Marketplace, and the GitHub Release marked latest.
- The docs site (below).

A publish never moves a pointer that already holds a higher version, so re-running an old publish moves nothing.

```
$ npm view @telorun/cli dist-tags
{ latest: '0.84.2', rc: '0.85.0-rc.1' }
```

Image modules no longer move `:latest` on every push to main; their release guide says so.

### Version numbers

- **Surface and identity.** A candidate build reports the release it previews as its manifest version: the value `requires: telo:` is checked against is `0.85.0`. Its identity stays `0.85.0-rc.N`: npm, `--version` (Node and Rust CLI), the language-server handshake and the built-in vocabulary tag. A tree whose surface is not its package version, or with a changeset not yet released, reports the next identity with `+unreleased`. Kernel and analyzer comparisons are unchanged.
- **Rust twins** carry their Node twin's version exactly — `0.85.0-rc.N` in `Cargo.toml` and `Cargo.lock` during candidates, `0.85.0` at the final.
- **The version generator takes the line's next version from changesets' own release plan**, `.changeset/pre.json` included, so the two cannot disagree; in prerelease mode the surface is that version's triple.
- **The changeset gate** drops every changeset id listed in `.changeset/pre.json` from what covers a changed package, so a released candidate's changeset never covers a later change.
- **Floor verification.** When `telo release check` / `telo publish` verify floors against the previous published CLI, they skip candidates.

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

### Modules publish after the final

- **No module publishes during candidates.** The Module Release PR does not open on a branch holding `.changeset/pre.json`, nor while the branch's changesets plan is not empty, so the final's module versions publish after `0.85.0` and every floor they declare names a published telo. Within one Publish run, module publishing follows npm publishing.
- A module adopting grammar of the release in candidates declares that release's floor, as today, and is tried in the checkout through relative imports.
- After the final, module releases publish from the branch as they do from main today, each tagged and merged back (above).
- The hub never tracks a candidate tag of the built-in vocabulary, so the newest telo it knows is always a final.

### Candidates are opt-in

- `npm i @telorun/cli` installs `latest`; a package's candidates are opt-in once it has a final.
- The editor's version catalog never selects a candidate engine. A candidate `.vsix` bundles its own engine.

### The docs site serves the final at `/` and the candidate at `/next/`

- Each candidate, final and patch builds the site from its own tag, examples index and `llms.txt` included, and attaches it to its GitHub Release: `site-next.tar.gz` for a candidate, `site-root.tar.gz` for a final or patch. The base URL is fixed at build.
- The branch's Publish deploys the site composed of the newest final's `site-root.tar.gz` at `/` and, while a candidate is open, its `site-next.tar.gz` at `/next/`. The docs deploy no longer runs on a push to main, so a docs fix reaches `/next/` with the next candidate and `/` with the next final or patch.
- The `/next/` build shows a banner naming the release it previews, linking to `telo.run/`.
- Earlier releases are not served; their docs are the `docs/` tree at their tag on GitHub.

### Links are relative in source, resolved by what publishes them

- **Source links are relative paths** to tracked files. GitHub resolves them against whatever ref is being viewed, so a link to a file added on main works on main.
- **The site build** turns a link to a page it renders into a site link, and a link to any other file into `blob/<tag being built>/…` / `tree/<tag being built>/…`.
- **npm and `.vsix` packing** rewrite relative links to the tag of the version being published.
- **Module files hold no reference into the repository tree.** Links stay relative inside the module and leave it only as a docs page (`https://telo.run/…`) or another module's hub page (`https://hub.telo.run/module/oci/ghcr.io/telorun/<name>/`), so a module's bytes never depend on which release publishes it. The Tesseract language-module generator emits the tesseract module's hub page. A page a module doc must reach that the site does not render is added to the site — today `sdk/rust/README.md`, linked from the starlark docs.
- **`pnpm run check:links`**, in the static checks, refuses outside the changelogs:
  - any absolute link into `github.com/telorun/telo/{blob,tree}/…` at any ref, and `raw.githubusercontent.com/telorun/telo/…`;
  - a relative link whose target is not a tracked file;
  - in a module's files: a relative link leaving the module root, and a `telo.run/next/` link.

Before, in `docs/extend/manifest-migrations.md`, `modules/tesseract-lang/deu/README.md` and `modules/http-server/docs/host-routing.md`:

```markdown
The entries live in [`analyzer/migrations/`](https://github.com/telorun/telo/tree/main/analyzer/migrations).
See the [language list](https://github.com/telorun/telo/blob/main/modules/tesseract/docs/languages.md).
Hosts supply the address as described in [providing needs](https://github.com/telorun/telo/blob/main/docs/guides/providing-needs.md).
```

After:

```markdown
The entries live in [`analyzer/migrations/`](../../analyzer/migrations/).
See the [language list](https://hub.telo.run/module/oci/ghcr.io/telorun/tesseract/).
Hosts supply the address as described in [providing needs](https://telo.run/guides/providing-needs).
```

On `telo.run/next/`, built from `v0.85.0-rc.1`, the first link reads `https://github.com/telorun/telo/tree/v0.85.0-rc.1/analyzer/migrations/`.

```
$ pnpm run check:links
docs/guides/tracing.md:42  https://github.com/telorun/telo/blob/main/kernel/specs/tracing.md  links into the repository by URL — write a relative path
docs/guides/logging.md:7  ../../kernel/specs/loging.md  names no tracked file
modules/sqlite/docs/connection.md:12  ../../sql/docs/declarative-schema.md  leaves the module — link to https://hub.telo.run/module/oci/ghcr.io/telorun/sql/
modules/sqlite/docs/connection.md:30  https://telo.run/next/guides/logging  names a preview — link to https://telo.run/guides/logging
4 links refused
```

### The first cut

Today `0.84.2` was published from main, so no `release/*` branch exists and its GitHub Release carries no `site-root.tar.gz`. In order:

1. The CI selection, the link rewrite and `pnpm run check:links` land on main.
2. A one-time dispatch of the site build at `v0.84.2` attaches `site-root.tar.gz` to that release, so the first candidate's deploy has a `/` to compose.
3. The release workflows land on main, and the first `Cut release` runs. With no `release/*` branch, the live-branch checks (in candidates, unreleased changes, main containing its newest tags) pass.

### Documentation and bookkeeping

- The release procedure is documented in `RELEASING.md` at the repo root: cut, candidates, finish, patches, the one live branch, that a cut is not undone, the route for a fix to the shipped release during candidates, modules publishing after the final, merge-backs of `v*` and `modules-*` tags, where workflows live, and recovery.
- The root `CLAUDE.md` (CI selection; Versioning & releases; the version generator and the gate), `docs/extend/releasing-modules.md` and the analyzer-release guide (no module releases during candidates, `modules-*` tags and their merge-backs), the CLI and hub guides, the hub README and the authoring-agent primer (module links target `telo.run/` pages or hub pages) are updated.
- The change ships changesets for every changed published or changeset-versioned package, and module fragments for the modules whose links change form.

## Decisions

- **The macOS and Windows core jobs cover the analyzer, kernel and CLI only.** Those packages carry the platform-sensitive code paths, while the full suites are where the flakes live; the flakes still have to be fixed, separately, or they will block releases.
- **The full platform set runs only on release branches.** A report-only run on main asks action of nobody; breakage on main is caught where the full set gates, and fixed on the branch.
- **One live branch.** A fix for the shipped release waits for the next candidate and the final. Keeping the shipped branch live beside a candidate would need forward merges, containment checks and an owner for every shared pointer other than the branch that publishes.
- **The cut is a PR to main that drops what the branch carries, and the branch starts at the cut commit's parent T.** The gate counts any pending changeset as covering a change, so a carried changeset left on main would cover later main changes it never described; a changeset landed after T stays on main, so nothing is released twice.
- **A cut is not undone.** A premature cut ships through its candidates.
- **The merge-back merges the release tag, not the branch tip.** A fix landed after the publish would otherwise reach main with its changeset and be released twice.
- **Every module release from a branch is tagged and merged back.** The next cut plans module versions from main's ledger, so a module version published but not merged back would be planned again.
- **No module publishes during candidates.** A plain module version published from a candidate branch would reach users of the previous final untried; modules wait for the final, and candidates try them through the checkout.
- **Each branch is self-contained; workflows on main only dispatch or re-run.** A run's steps must come from the commit that produced its artifacts.
- **The candidate's manifest version is its release's triple, decided by the version generator.** Teaching the analyzer's range comparison that a prerelease meets its release was rejected: it changes kernel and analyzer semantics for a release-process concern.
- **Crates carry the candidate identity, not the triple.** The triple would make rc.0 and rc.1 indistinguishable and give one artifact two versions.
- **Known gap: two candidates of one release both report `0.85.0`.** A module adopting grammar added in rc.1 passes the floor check on the rc.0 CLI, then fails with errors that blame the module. Only someone running a candidate can hit it.
- **Known gap: main reports the cut release's surface during its candidates.** Until the `0.85.0` merge-back, main's pending minor computes `0.85.0`, so a module adopting main-only grammar in that window declares `>=0.85.0`; floor verification refuses it when it publishes from `release/0.86`, and the floor is raised there.
- **Every package releases as rc from a candidate branch.** A candidate whose engine needs an `@telorun/editor-protocol` or `@telorun/language-host` change could not otherwise be tested as one release.
- **Changesets prerelease mode is the rc engine.** A repo-owned versioner would be a second planner beside it.
- **Module links are unversioned.** Known gap: a module link to a page new in the candidate's release answers 404 on `telo.run/` until the final; candidate testers read `/next/`.
- **The candidate `.vsix` goes on the GitHub pre-release, not the Marketplace.** The Marketplace accepts only `major.minor.patch` versions.
- **Docs are built from tags, not snapshotted with Docusaurus versioning.** The site reads its pages from across the repo, so a snapshot would copy all of them at every release and leave the examples index and `llms.txt` at the latest version.
- **Merge rather than cherry-pick fixes.** A missed cherry-pick reintroduces the bug in the next release.

## Verify

A fork run exercises the workflows end to end.

- A PR to main touching only the kernel runs the macOS and Windows core jobs and reports the full macOS, Windows, Bun and Docker jobs as skipped; with no re-runs its wall-clock time equals the Linux unit job's. The first PR to a release branch runs and gates the full set.
- On a fork: the cut PR deletes T's pending changesets and fragments; a PR merged to main between the cut PR's opening and its merge is absent from `release/0.85` and its changeset is still on main; once the cut merges, `release/0.85`'s tip is T, `release/0.84` refuses its next Version PR as frozen, and `release/0.85`'s first Version PR opens with no push to the branch and writes `.changeset/pre.json`. Merging that publishes `0.85.0-rc.0` and no module, and `npm view @telorun/cli dist-tags` shows `rc: 0.85.0-rc.0` with `latest` unchanged.
- After rc.0 with no new changeset: surface `0.85.0`, identity `0.85.0-rc.0`, `Cargo.toml` / `Cargo.lock` at `0.85.0-rc.0`, and the Rust `telo --version` prints `0.85.0-rc.0`. With a pending patch the identity is `0.85.0-rc.1+unreleased`. A fix PR on the branch with no changeset fails the gate.
- Main after the cut prints the two versions shown above, and a main PR touching the kernel with no changeset fails the gate.
- During candidates no Module Release PR exists on `release/0.85`. After `Finish release`, none opens until the Version PR has published `0.85.0`; the one that then opens publishes the modules, tags `modules-0.85-1` and opens its merge-back.
- After `0.85.0`, a `Fixed` fragment on `release/0.85` publishes `console@0.20.1`, tags `modules-0.85-2` and opens its merge-back; main's ledger then holds `0.20.1`, Cut refuses until it merges, and the next cut never plans `console@0.20.1`.
- Every refusal shown above fires as shown.
- `Finish release` followed by the Version PR publishes `0.85.0`, moves npm `latest`, `rc`, Docker `latest`, Studio pages, the Marketplace and GitHub latest, and opens the merge-back PR, which passes the gate. A fix merged on the branch after that publish is absent from the merge-back. Re-running the rc.1 publish afterwards moves no pointer. No merge-back follows a candidate publish, and pushes to main publish nothing.
- A `0.85.1` patch publishes from `release/0.85` and its merge-back leaves main's package versions equal to the patch's; the next cut plans `0.86.0` for the line.
- A change to the branch's Publish, sync job or `finish-release.yml` on that branch changes that branch's next run; the same change on main does not. A failed run on `release/0.85` is re-run at its own commit.
- `pnpm run check:links` refuses each of the four links shown above. A relative link from `docs/` to a file added on main resolves on GitHub on main and on `/next/`.
- During candidates `telo.run/` serves 0.84.2 and `telo.run/next/` the newest candidate with its banner; after `0.85.0` ships `telo.run/` serves 0.85 and `/next/` is gone.
