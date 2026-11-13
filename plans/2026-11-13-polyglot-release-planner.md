---
status: done
priority: medium
depends-on: []
tracking: feature/effective-kind-schema
packages: [release, analyzer, cli, kernel, cel, sdk, templating, message-format, language-server, ide-support, hub, studio, ide-vscode, ci, scripts, docs]
refinement: not-started
---

# One polyglot release planner, replacing changesets

## Problem

- Two release systems version this repo. Changesets versions the npm packages; `telo release` versions modules. Both write `version` fields in the same `package.json` files, held apart by a ~130-entry `ignore` list in `.changeset/config.json`.
- Changesets cannot see code inlined into a bundle. `@telorun/language-server` keeps a hand-written `teloInlines` list that its build checks against the esbuild metafile after the fact, and a lockfile-only bump inside a bundle releases nothing.
- Rust twins are versioned by a script that reaches into changesets' private release-plan packages after `changeset version`; a change made only in a Rust crate releases nothing. Helm chart versions are stamped by another script.
- Every build computes the line's next version from the pending changesets (`TELO_SURFACE_VERSION`, the engine identity, `+unreleased`), so each dev build assembles a changesets plan.
- Candidates live in a state file (`.changeset/pre.json`) created and deleted per release. They publish no modules, so an rc tag cannot be installed and run as its final will be. Meanwhile `telo upgrade` and the editor read a newer prerelease's `restrictions:`, and the hub indexes every prerelease.
- A module becomes an image module because a `Dockerfile` sits beside it — inferred, not declared — and an npm package that also ships an image (`apps/k8s-runner`) releases on its npm payload alone.
- The planner that does see bytes (`telo release`) knows only modules and is Sustainable Use code inside the analyzer and CLI, so no plain Node project can use it.

## Surface

**Added**
- `@telorun/release` — new MIT npm package at `release/nodejs/`: the planner, the `npm` / `cargo` / `docker` / `helm` adapters, the command tree; off the telo version line.
- `helm` ecosystem — a Helm chart anchored at a directory holding `Chart.yaml`; `apply` writes the unit's version to its `version` and `appVersion`, and it publishes to an OCI chart registry.
- `telo-release` — its bin; `telo release` minus the `telo` ecosystem.
- `telorun-release` — its Rust twin crate at `release/rust/`.
- `release.units` — the one list of release units in `telo-workspace.yaml`; string-or-object entries, `!` excludes, last match wins; a unit's key is its workspace-relative path, and a directory is at most one unit.
- `release.units[].ecosystem` — the ecosystems a unit ships through, each served by an adapter the host registered: a name (`npm`), an order-free set (`[npm, docker]`), or a map of ecosystem → anchor, anchor list, or anchor → settings map (`{ npm: nodejs, cargo: [rust, rust/value], docker: { ".": { context: "." } } }`); an anchor is a literal directory inside the unit holding exactly one package of that ecosystem, and the name and set forms mean anchor `.`; absent means the unit declares its own `version` and `payload`.
- `release.units[].version` — where the unit's version lives: a file a handler reads (`package.json`, `Cargo.toml`, `telo.yaml`, a plain version file) or `{ file, pointer }` into JSON / YAML / TOML; required unless exactly one anchor's ecosystem defaults a version location.
- `release.units[].payload` — a declared file set, patterns or `{ command }` printing unit-relative paths; one more layer beside the ecosystems' own; required when no anchor contributes a layer.
- `release.units[].metafile` — a bundler metafile whose entries are inline edges.
- `release.units[].versionFiles` — patterns or `{ path, pointer }` of further files carrying the unit's version; a `Cargo.toml` also moves its `Cargo.lock` entry.
- `release.ecosystems` — per-ecosystem defaults `{ <ecosystem>: { <key>: … } }` for any key that ecosystem reads; an anchor's settings override them, then the adapter's own rungs below the marker (only `telo`: `--registry`, `TELO_OCI_REGISTRY`, the ledger's recorded base). No ecosystem key sits flat on a unit entry.
- `registry` — a publish base read by `telo` (destination `<registry>/<unit directory name>`), `docker` (`<registry>/<name>`) and `helm` (`<registry>/<Chart.yaml name>`), per anchor or in `release.ecosystems.<ecosystem>`; `npm` and `cargo` read none — the package says where it goes.
- docker `name` — the image repository name, default the anchor directory's basename.
- docker `context` — the workspace-relative build context directory, default the anchor directory; the ignore file is `<Dockerfile>.dockerignore` beside the Dockerfile, else `<context>/.dockerignore`, its patterns anchored at the context.
- `release.groups` — named groups whose member units share one version.
- `release.maxBump` — the highest bump allowed (`major` by default); block, then entry.
- Ledger layers `<ecosystem>: { <anchor>: <digest> }` — one per anchor; a module's own layer keys under `telo: { ".": … }`; a declared payload under the reserved key `payload`.
- `telo release apply --candidate[=<id>]` — versions each planned unit `<final>-<id>.<k>` (default id `rc`).
- `candidate: { version, layers }` — ledger record beside a unit's final entry.
- `telo release adopt changesets` — one-time import of a changesets setup.
- `telo release tag` — tags the commit it runs at `<unit key>@<version>` for each unit the last apply moved (candidates included); Telo runs it on the release commit and pushes the tags before anything publishes, since the publication commit only exists after modules publish.
- `<unit>/CHANGELOG.md` — one changelog per unit at its directory (`kernel/CHANGELOG.md`, `cel/CHANGELOG.md`, …).
- `WORKSPACE_ECOSYSTEM_UNAVAILABLE` — an entry names an ecosystem this host registered no adapter for, naming the host that serves it.
- `WORKSPACE_UNIT_VERSION_UNRESOLVED` — no `version:`, and zero or several anchors whose ecosystem defaults a version location.
- `WORKSPACE_UNIT_PAYLOAD_EMPTY` — a unit with no layer, naming the fixes (list the ecosystem it ships through, declare `payload:`, or exclude it with `!`).
- `WORKSPACE_ANCHOR_INVALID` — an anchor that is a pattern, leaves the unit, or is not recognised on a literal unit path.
- `WORKSPACE_ANCHOR_CLAIMED` — one package directory claimed by two units, naming both.
- `UNIT_VERSION_MISMATCH` — `telo release check` finds a unit whose version locations disagree.
- Tags `modules-<x.y>-rc.<n>` / `packages-<x.y>-rc.<n>` — a candidate run that does not move the line.
- Branch `release-version/<release branch>` — the release PR head.
- `apps/studio/Dockerfile.dockerignore`, `apps/docker-runner/Dockerfile.dockerignore`, `apps/k8s-runner/Dockerfile.dockerignore`, `apps/hub-web/Dockerfile.dockerignore` — each root-context image's digested context.
- `release/` in the MIT directory list.

**Changed**
- `telo release add --module <path>` → `--unit <path>`; a polyglot component is addressed by its parent directory (`--unit kernel`).
- `telo release order` emits one row per unit and anchor, `{ key, ecosystem?, path, version, destination?, group? }`, units in edge order; `path` is the directory to publish from.
- `telo release status` prints per unit: current → planned version, cause (fragment, edge, unattributed), group.
- `telo release verify` works per layer; a layer with no read-back (`docker`, a declared `payload`) keeps its digest and is reported unverifiable.
- `telo release check` — the one PR gate for every unit; `CHANGELOG_ENTRY_REQUESTED` covers every unit.
- `WORKSPACE_UNKNOWN_KEY` — also a key none of the entry's ecosystems reads, or a key an anchor's ecosystem does not read at that anchor or under `release.ecosystems.<ecosystem>`, naming the ecosystem.
- `WORKSPACE_ANCHOR_INVALID` — also a docker `context` that is a pattern, leaves the workspace, or is not a directory.
- `NO_DESTINATION_KNOWN` — also a `telo`, `docker` or `helm` anchor whose cascade ends with no `registry`, reported by `telo release check`, `order` and `verify`; the destination-collision check covers every `order` row.
- A module with a `Dockerfile` is an image only when its entry lists `[telo, docker]`; it then publishes both its module artifact and its image.
- The `telo` ecosystem finds a module's npm and Cargo packages from its controller locators' `local_path` and its `sources:` `build.cargo` crates, no longer from fixed `nodejs/` and `rust/` subpaths.
- `TELO_SURFACE_VERSION` — the triple of the line's recorded version, not of the next one.
- Engine identity — `V+unreleased` in every build except a package's `prepack`, which embeds exactly `V` and whose `postpack` restores every file it wrote.
- Published npm package and `.vsix` markdown links — name `blob/<unit key>@<version>/…` instead of `v<line>`, `packages-<x.y>-<n>` or `main`.
- `requires: telo: ">=unreleased"` — rewritten by `telo release apply` (candidate or final) to the surface of the `telo` group's planned version.
- Package `CHANGELOG.md` — first heading `# Changelog`, new entries in the module changelog format.
- `v<X.Y.Z>-rc.<k>` — made only when the line moved, on a publication commit pinning candidate module versions.
- `telo upgrade`, the editor — a prerelease's `restrictions:` are read only with `--include-prerelease`.
- Hub — indexes final module versions only and drops prereleases it indexed.
- `telo publish` during candidates — a floor equal to the line's surface is measured with the newest published candidate CLI of that surface.

**Removed**
- `release.modules`, `release.registry` — refused naming `release.units` and `release.ecosystems` (the `WORKSPACE_MODULES_MOVED` precedent); a flat `registry:` on a unit entry is refused too.
- `.changeset/` (`config.json`, `pre.json`, change files), `@changesets/cli`, `changesets/action`.
- `teloInlines` in `package.json`.
- `TELO_PACK_LINKS_TAG` — packs no longer read a link tag from the environment.
- `kernel/nodejs/CHANGELOG.md`, `sdk/nodejs/CHANGELOG.md`, `cel/nodejs/CHANGELOG.md`, `templating/nodejs/CHANGELOG.md`, `analyzer/nodejs/CHANGELOG.md`, `cli/nodejs/CHANGELOG.md`, `message-format/nodejs/CHANGELOG.md` — moved up into their unit's `CHANGELOG.md`.
- Branches `changeset-release/*`; root scripts `version-packages` and `release`; the CI step "Check changeset status".

## Solution

**One planner, below everything that uses it.** `@telorun/release` holds the release model — units, fragments, ledger, edge graph, groups, version planning, changelogs, candidates — with a browser-safe main entry (the editor still answers "what does this change bump?") and a Node-only entry holding evidence (git reads, ledger store, carried changes), the adapters' evidence halves and the command tree. `@telorun/cli` mounts that tree as `telo release` and registers the `telo` adapter (its pure half in the analyzer, its evidence half in the CLI) plus the Telo-only subcommands `floor`, `stage`, `imports` and the `requires:` checks. A plain Node project installs `@telorun/release` alone: no kernel, analyzer, CEL engine or Sustainable Use code. The moved code is relicensed MIT. `cli/rust` hosts `telo release` through `telorun-release`, which ships twins of the `npm`, `cargo`, `docker` and `helm` adapters; until `cli/rust` registers `telo` it is polyglot debt, as `telo publish` is.

**A unit is one component, shipped through its anchors.** A unit is a directory with one version, one changelog and one fragment target, however many packages it ships. Each package is an anchor: an ecosystem plus a literal directory inside the unit, recognised there by that ecosystem's adapter (`npm`: a `package.json` with a version; `cargo`: a `Cargo.toml`; `docker`: a Dockerfile; `helm`: a `Chart.yaml`; `telo`: a module doc with a version). The core never branches on an ecosystem's name: each adapter defaults an anchor's version location and payload, contributes the schema of its own entry keys, and adds only what no declaration can hold — a computed payload (a module's built layers) and read-back. "Adapter" is the tool's word for the code serving an ecosystem and never appears in the marker. Adapters are registered in-process by the host program, never discovered from installed packages, so the Rust twin does the same.
- **Version** — a declared `version:` wins; otherwise the one anchor whose ecosystem defaults a location (`docker` defaults none). Zero or several is `WORKSPACE_UNIT_VERSION_UNRESOLVED` — never a precedence by list order. `apply` writes the version to every anchor's location and every `versionFiles` entry; the ledger records it but is never its source, and `telo release check` refuses a unit whose locations disagree (`UNIT_VERSION_MISMATCH`).
- **Payload** — each anchor contributes one layer, and a declared `payload:` one more. A private npm package supplies its version location and edges but no layer and no publish row; a unit left with no layer is `WORKSPACE_UNIT_PAYLOAD_EMPTY`. Every layer resolves to a file set digested by the module digest function (sorted unit-relative path, executable bit, content hash) — never archive bytes. A `{ command }` runs in the unit's directory and prints paths; a non-zero exit, a missing file, a duplicate, or a path outside the workspace fails the plan.
- **Modules list no anchors.** The `telo` adapter reads a module's npm and Cargo packages from the module doc itself — the nearest `package.json` / `Cargo.toml` at or above each controller locator's `local_path` inside the module, and each `sources:` `build.cargo` crate — so the marker never restates what the manifest says.

**The marker.** `telo-workspace.yaml`'s `release:` block holds `units`, `groups`, `ignore` and `maxBump`; its location stays the anchor for unit keys, fragments and the ledger. `telo-release` reads only that block. The editor validates it as the core schema plus each registered adapter's fragment, per entry.

**One rule for every unit.** Whether a unit bumps is decided by the digests of its layers at its recorded version, compared with the ledger. Fragments describe the change; a changed unit with no fragment ships as an unattributed patch and warns `CHANGELOG_ENTRY_REQUESTED`. Edges are never declared by hand: import edges come from adapters (`workspace:` and rewritten plain ranges, cargo path dependencies, module relative imports) and from one generic rule — any version location of another unit inside a unit's payload (its `version` file, its anchors' locations, its `versionFiles`), never the unit's own — and always bump the dependent at its dependency's level; a `metafile:` gives inline edges, which explain drift the digest already saw. A group releases every member at the highest level any needs; a level above `maxBump` is refused.

**The shipped adapters.** `npm` drives npm, pnpm, yarn (classic and berry) and bun, picked from `packageManager`, else the one lockfile present (two is an error); its layer is the `pack` file set; it refuses a packed `package.json` still holding a `workspace:` or `catalog:` range, rewrites a dependent's plain range on a sibling it bumps, and reads back from the registry (checking `dist.integrity` for transport only, then digesting the unpacked set). `cargo` supplies `cargo package --list` — on an anchor with a `bin`, `cdylib`, `staticlib` or `dylib` target, its `Cargo.lock` entry is the sorted `name version source` identities of the external packages in its normal + build closure across all features and platforms (from `cargo metadata`), so a lockfile-only bump releases the binaries that link it, while a library-only anchor carries none — the `Cargo.toml` version with its `Cargo.lock` move, path-dependency edges, and crates.io read-back unless `publish = false`; an anchor is exactly one crate and never covers crates beneath it. `docker` reads its ignore file with Docker's rules anchored at the declared `context`; its layer is the context minus ignored paths plus the Dockerfile and its ignore file, the base image outside it; it defaults no version location, and has no read-back; it is the only reader of a docker context. `helm`'s layer is the file set `helm package` includes, decided by the chart's `.helmignore` (which only it reads); its version location is `Chart.yaml` `version`, and `apply` also writes `appVersion`, since a chart anchored in a unit deploys that unit's version; it reads back by pulling the chart from its OCI registry and digesting the unpacked set.

**Candidates, with no state.** `apply --candidate` versions each planned unit `<final>-<id>.<k>`; `k` is per unit, shared within a group, and rises only when a layer differs from the unit's `candidate:` record. A candidate consumes no fragment and leaves the final entry alone, so a plain `apply` always plans the final from final entries plus every pending fragment and removes the candidate records. Candidate versions publish under the dist-tag `<id>` and never move a module's OCI `latest`.

**Changelogs** — one per unit at `<unit>/CHANGELOG.md`, written by one writer in the module format; changesets-written history stays below it untouched.

**Adopting.** `adopt changesets` writes a `release.units` entry with `ecosystem: npm` per package, `fixed` groups → `release.groups`, `ignore` → `!` entries, each pending change file → one fragment naming the same units with the same body and id (`major`/`minor`/`patch` → `Changed`/`Added`/`Fixed`), seeds the `npm` layers through `verify --write` (candidate records included), refuses `linked` groups, deletes `.changeset/`, and lists the CI steps and dependencies it did not rewrite.

**This repo after the change.**
- The line's polyglot components are one unit each: `kernel`, `templating`, `analyzer`, `message-format` as `{ npm: nodejs, cargo: rust }`; `cel` with `cargo: [rust, rust/value]`; `sdk` with `cargo: [rust, rust/core, rust/macros]` plus `payload: [rust/abi/**]` — `telorun-abi` is never versioned (ABI generation) but an ABI-only change releases the line; `cli` with `cargo: [rust, rust/desktop-host]`, so a fix made only in `telo-desktop-host` releases the CLI. Each declares `version: nodejs/package.json`. `packages/language-server` (with its `metafile`) and `packages/ide-support` are `ecosystem: npm`. The `telo` group lists these unit keys; the `telo` adapter knows the surface group as the group holding the unit whose npm anchor is `@telorun/analyzer`. `release` is `{ npm: nodejs, cargo: rust }`, off the line.
- `release.ecosystems` sets `telo` → `oci://ghcr.io/telorun`, `docker` → the image base the workflows push to, `helm` → `oci://ghcr.io/telorun/charts`. `modules/*` are `ecosystem: telo`; `blueprints/*` and the Tesseract family override `registry` at their `telo` anchor; `apps/hub` is `{ telo: ., docker: ., helm: chart }` and `apps/authoring-agent` `[telo, docker]`; `apps/studio` and `apps/k8s-runner` are `{ npm: ., docker: { ".": { context: "." } }, helm: chart }` with `version: package.json`, and `apps/docker-runner` and `apps/hub-web` `{ npm: ., docker: { ".": { context: "." } } }`, their `Dockerfile.dockerignore` anchored at the repo root — a Dockerfile- or chart-only fix releases each with one changelog entry. Images and charts publish from their `order` rows to their resolved destinations, replacing `stamp-chart-version.mjs` and the hand-written helm steps. `ide/vscode` declares `version: package.json` and `payload: { command: vsce ls }`. Every other published package is `ecosystem: npm`; `maxBump: minor`.
- Every embedded version is read from the unit's recorded version: a package's `prepack` embeds exactly `V` (writing only inside its own directory, restored by `postpack`), every other build `V+unreleased`, and none plans. A `>=unreleased` floor in a plan that does not move the `telo` group fails `telo release check`.
- A release PR exists when `telo release status` plans a unit. Telo's own scripts decide candidacy — a branch is in candidates while `v<x.y>.0` is absent and its open release PR's head carries no final versions — and pass `--candidate`. Publish walks `telo release order`, dispatching each row on `ecosystem` and publishing from its `path`; it emits the moved units read from the release commit. A candidate gets a publication commit like a final, so its tag's consumers pin published candidate modules; its images are tagged with their unit's `-rc.<k>` and move no pointer. Tags: `v<line version>` when the line moved, else `packages-…` / `modules-…`; Record release skips every tag containing `-rc.`.
- Prereleases are inert to consumers: the `telo upgrade`, editor and hub rows above.
- Cutover runs `adopt changesets`, the marker rewrite, the ledger re-key to nested layers and the changelog moves on main and on the live release branch in one pair of PRs, so fragment ids match and `--carried-by` and Record release keep working.

**Docs.** A standalone guide in `release/nodejs/README.md`; the release model guide moves to `release/`; `RELEASING.md`, the releasing-modules guide, the workspaces guide, and CLAUDE.md's "Versioning & releases" (the twin rule stated as one unit with anchors) and "Licensing" rewritten; a benefits-ledger entry under "For module authors" (the npm packages, crates and images beside a workspace's modules are versioned by the same command); the authoring-agent primer checked.

## Decisions

- **The generic planner is its own MIT package beneath the analyzer and CLI** — in the CLI, a plain Node user would install the kernel under Sustainable Use, and no MIT consumer could use it.
- **The digest decides, fragments describe** — intent-only planning (changesets) cannot see inlined code or lockfile-only bumps.
- **A missing fragment warns, for every unit** — the digest still releases the change.
- **Builds never compute the next version** — a payload embedding a planned version makes the plan depend on itself and forces every dev build to pack.
- **Candidacy is a flag per call, not repo state** — a state file is a second source for a fact the caller holds, and brings back `pre.json`'s churn.
- **A unit is data; ecosystems only default it** — a closed list of artifact types makes every ecosystem a release of the planner and puts a discriminator in a generic tool; a fully declared model cannot express module layers or read-back.
- **One unit, many ecosystems** — an npm package and its image, or a Node package and its Rust twin, are one component; two units for one version are two ledger entries recording one fact, with two changelogs and two fragment targets. Groups stay for distinct components.
- **A polyglot component's packages are anchors, not version files** — a version file outside every payload releases nothing, so a Rust-only change would never ship.
- **The version is resolved, never chosen by order** — with zero or several defaulting anchors the unit declares `version:`; any automatic precedence is list order under another name.
- **An anchor is one package and covers nothing beneath it** — implicit coverage would need an exclusion mechanism (`sdk/rust/abi`) and misreads the repo-root Cargo workspace.
- **Modules list no anchors** — the module doc's controller locators already say where its packages are; a marker copy would drift.
- **`ecosystem` is declared, never inferred** — a Dockerfile beside a module no longer makes it an image.
- **Adapters are registered by the host program** — discovery from `node_modules` cannot be ported to the Rust twin.
- **One `release.units` list, modules included** — two lists would be two cascades for one concept.
- **Edges are never declared by hand** — they would duplicate what `package.json` and `Cargo.toml` hold and drift into missed bumps.
- **Charts are an ecosystem, not version files** — a chart is published with its own destination and can be read back; as `versionFiles` it would get neither and leave the push in hand-written workflow steps. `helm` ships with the tool because charts and images usually come as a pair.
- **Images keep the `docker` adapter; vsix needs none** — copying ignore rules into the marker drifts from the real file, while `vsce ls` already lists the payload.
- **Read-back is an adapter answer only** — rebuilding a payload from a fetched artifact is format knowledge a declared command could only claim.
- **A payload is a file set, never archive bytes or `dist.integrity`** — compression framing must not move it.
- **Ledger layers nest by ecosystem and anchor** — no key is a string that has to be parsed apart.
- **The changelog lives at the unit** — one inside an anchor would need a rule picking the anchor.
- **`maxBump` is declared, default no cap** — Telo sets `minor`; a project at 2.x needs majors.
- **One marker, one anchor** — a separate tool file gives two anchors that can disagree.
- **Changesets is converted once (`adopt`), not read forever** — that keeps two fragment formats for one fact.
- **Telo's tags and candidacy rule stay in its workflow** — a generic tool must not know release branches or the `v` spelling.

## Complete example

A plain pnpm monorepo replacing changesets, `telo-workspace.yaml`:

```yaml
release:
  maxBump: minor
  ecosystems:
    docker: { registry: ghcr.io/acme }
    helm: { registry: oci://ghcr.io/acme/charts }
  units:
    - { path: packages/*, ecosystem: npm }
    - { path: packages/bundle, ecosystem: npm, metafile: dist/meta.json }
    - { path: apps/api, ecosystem: { npm: ., docker: ., helm: chart }, version: package.json }
    - path: engine
      ecosystem: { npm: nodejs, cargo: [rust, rust/core] }
      version: nodejs/package.json
    - { path: extension, version: package.json, payload: { command: vsce ls } }
  groups:
    core: [packages/core, packages/client]
```

Then `npx telo-release adopt changesets` once; `telo-release add --unit engine --kind Fixed --body "…"` per change; `telo-release apply --candidate` and the publish for a candidate; `telo-release apply`, `telo-release tag` and the publish for the final — `apps/api`'s image is tagged with its `package.json` version and its chart's `version` and `appVersion` carry it, and `engine`'s npm package and crates carry one version.

## Verify

- `@telorun/release` imports no `@telorun/analyzer`, `kernel`, `cli`, `templating` or `cel`; its main entry builds for the browser without polyfills; its core names no adapter or ecosystem file outside its adapters; `check:licenses` passes.
- A test host registers an unshipped fixture adapter and releases its unit with no planner change.
- A fixture repo per package manager is released by `telo-release` with only `release.units` in its marker; its packed manifests hold concrete versions.
- `apps/k8s-runner` is one unit with layers `npm` and `docker`: a Dockerfile-only change plans one bump and one `CHANGELOG.md` entry; `order` gives two rows with one version; `verify --write` refreshes `npm` and reports `docker` unverifiable. A `Chart.yaml`-only or template-only change to `apps/k8s-runner` plans one bump, writes its version into `version` and `appVersion`, and adds a `helm` row to `order`; `verify --write` reads the chart back from the registry. `apps/studio` releases on a Dockerfile-only change with no group in the marker. Swapping `[npm, docker]` to `[docker, npm]` changes no plan.
- A change confined to `cel/rust/value`, `sdk/rust/abi` or `cli/rust/desktop-host` opens a release PR that bumps the line; `--unit kernel/nodejs` is refused as no unit; `order` emits two Cargo rows for `cli`, each with its own `path`.
- After `apply`, every anchor's manifest and `Cargo.lock` entry carries its unit's version, `sdk/rust/abi` keeps its own, and `cargo --locked` builds offline; hand-editing one twin's version fails `telo release check` with `UNIT_VERSION_MISMATCH`.
- A napi directory listing `[npm, cargo]` with no `version:` is refused with `WORKSPACE_UNIT_VERSION_UNRESOLVED`; a private npm-only entry with `WORKSPACE_UNIT_PAYLOAD_EMPTY`.
- Moving a module's controller to `./node/` (locator updated) is still versioned with no marker change; no `telo` adapter code reads a Dockerfile.
- `ide/vscode` gives the same digest on two runs, equal to the digest of its unpacked `.vsix`.
- `telo-release` on this repo's marker reports `WORKSPACE_ECOSYSTEM_UNAVAILABLE` at each `telo` entry; `registry` on an npm entry is `WORKSPACE_UNKNOWN_KEY`; `release.modules` is refused naming `release.units`.
- A change confined to the analyzer plans a bump of `@telorun/language-server` through the metafile, with no list naming that edge; a lockfile entry inlined into the language server opens a release PR; bumping `packages/lib` plans the image whose root build context holds `packages/lib/package.json` at lib's level, naming lib as the cause.
- No file reads `@changesets/*`; `.changeset/`, `teloInlines` and `stamp-chart-version.mjs` are gone; no ledger key joins an ecosystem and a path.
- A dev build reports `<package.json version>+unreleased` and reads no plan; the PR gate's `npm` layer digest equals what `verify` computes from npm.
- Planning a candidate twice from one ledger gives the same `-rc.<k>`; the next candidate republishes only units whose layers moved; the final writes one changelog entry per fragment and removes every `candidate:` record.
- A candidate moving only modules makes no `v*-rc` tag; an rc tag's consumers resolve every pin with an empty cache; no module's OCI `latest` names a candidate; the hub lists no `-rc` module version; `telo upgrade` offers one only with `--include-prerelease`.
- Adopting on this repo plans the same versions changesets' own release plan yields for the same pending set; main and the release branch hold identically named fragments.
