---
description: "One release flow for npm packages, Rust crates, Docker images, Helm charts and Telo modules: one version and one changelog per unit, bumps decided from what actually ships, candidates, and publishing in dependency order."
---

# Versioning and releases

A project rarely ships one kind of thing. A typical one ships npm packages, Rust
crates, Docker images, Helm charts and Telo modules, and `telo release` versions all
five with the same four moves: **describe** a change, **plan** what bumps,
**apply** the versions, **publish** in dependency order.

This page is the tour. [Releasing modules](../extend/releasing-modules.md) is the
reference for every command and the ledger, and [Workspaces](./workspaces.md)
for every key of the marker. The planner is also a standalone package for
projects with no Telo in them — see [Without Telo](#without-telo).

## What counts as one thing: a unit

A **unit** is a directory with one version, one changelog (`<unit>/CHANGELOG.md`)
and one place to describe changes, however many packages it ships. Each package is
an **anchor**: an ecosystem plus a directory inside the unit.

| Ecosystem | An anchor is | The version lives in | A change is seen in | Published to |
| --- | --- | --- | --- | --- |
| `npm` | a directory with a `package.json` | `version` | what the package manager would pack | the package registry, as the package says |
| `cargo` | a directory with a `Cargo.toml` | `package.version`, and its `Cargo.lock` entry | what `cargo package --list` selects; for a binary or linked library, also every external package it links | the crate's own registry |
| `docker` | a directory with a `Dockerfile` | nowhere by default — the unit's other anchor, or a `version:` the unit declares | the build context minus its ignore file, plus the Dockerfile | `<registry>/<name>`, tagged with the unit's version |
| `helm` | a directory with a `Chart.yaml` | `version` and `appVersion` | what `helm package` includes | `<registry>/<chart name>` |
| `telo` | a directory with a module `telo.yaml` | `metadata.version` | the manifest and every controller, library and asset layer | `<registry>/<directory name>` |

The units of a workspace are listed in its `telo-workspace.yaml`. One unit can hold
several anchors:

```yaml
release:
  maxBump: minor
  ecosystems:
    telo: { registry: oci://ghcr.io/acme }
    docker: { registry: ghcr.io/acme }
    helm: { registry: oci://ghcr.io/acme/charts }
  units:
    # An npm package and its Rust twin: one version, one changelog.
    - { path: core, ecosystem: { npm: nodejs, cargo: rust }, version: nodejs/package.json }

    # A package, the image built from it and its chart.
    - path: apps/api
      ecosystem: { npm: ., docker: { ".": { context: . } }, helm: chart }
      version: package.json

    # A module that also ships its image.
    - { path: apps/worker, ecosystem: [telo, docker] }

    # Every directory under modules/ is a Telo module.
    - { path: modules/*, ecosystem: telo }
```

So `core` is one component with one version across `nodejs/package.json` and its
crate, and `apps/api` releases with one changelog entry whether the change was in
TypeScript, the Dockerfile or the chart.

## Describing a change

Every change to a released unit ships a **fragment** — one file, one body, any
number of units:

```console
$ telo release add --unit core --kind Fixed \
    --body "A stop between started and idle is no longer lost."
```

The kind sets the level and the changelog section.

| Kind | Level |
| --- | --- |
| `Added`, `Deprecated` | minor |
| `Fixed`, `Security` | patch |
| `Changed`, `Removed` | major |

`release.maxBump` caps the level. A pre-1.0 project sets `minor` and ships a
breaking change as an `Added` that describes the break; a plan needing more is
refused. Never write the file by hand — the command serializes the body safely.

A fragment only says **what to write in the changelog**. Whether a unit bumps at
all is not up to it.

## What decides a bump

Three separate questions, three separate mechanisms:

- **Whether** a unit bumps: the digest of what it ships, compared with the digest
  recorded when it was last published. A Dockerfile edit, a crate fix, a chart
  value, an inlined sibling's source and a lockfile bump that reaches a linked
  binary each move a digest, whichever paths a pull request touched.
- **At what level**: the fragments, then the dependency edges. A dependent bumps
  at its dependency's level — a package whose `package.json` says `workspace:*`,
  a crate with a path dependency, a module importing a sibling by relative path,
  an image whose build context holds another unit's version file. Edges are read
  from the files, never declared.
- **What is said about it**: the fragment. A unit that changed with no fragment
  still releases, as an *unattributed* patch, and `check` warns that a changelog
  entry was requested.

Units that must move together are a **group** (`release.groups`): every member
releases at the highest level any of them needs. A workspace that keeps a core
package and its client on one version lists them as one group, and a fix in either
gives both the same new version.

## Reading a plan

`telo release status` prints, per unit, the current version, the planned one, the
level and **why**:

```console
$ telo release status
core         1.4.2 → 1.5.0   minor — declared  [platform]
client       1.4.2 → 1.5.0   minor — group platform  [platform]
apps/api     2.0.3 → 2.1.0   minor — imports core; holds the version of core
apps/worker  0.9.0 → 0.9.1   patch — payload changed, unattributed
```

- **declared** — a fragment names the unit.
- **imports X** — a dependency of the unit is bumping, so it bumps at the same level.
  `imports` covers an npm `workspace:` range, a crate's path dependency and a
  module's relative import alike.
- **holds the version of X** — the unit ships another unit's version file. An
  image whose build context contains `core`'s `package.json` changes when `core`
  does.
- **group platform** and `[platform]` — the unit shares a version with its group.
  Nothing fragment-worthy happened in `client`; it moves because `core` did.
- **payload changed, unattributed** — the digest of what the unit ships moved and
  nothing explains it, so it ships as a patch and nobody has to invent prose.

A change to one anchor moves every anchor of its unit to the same number: a
crate-only fix in `core` bumps `nodejs/package.json` and `rust/Cargo.toml`, and a
Dockerfile-only fix in `apps/api` bumps its npm package, its chart and its image
tag together.

On a pull request, `telo release check` is the gate. It needs no credentials and
no merge base, because it compares digests with the committed
[ledger](../extend/releasing-modules.md#the-ledger). It fails when no consistent
plan can be formed — a fragment naming a unit that does not exist, a level above
`maxBump`, a unit whose version files disagree, an anchor with nowhere to publish.
A payload that moved with nothing to explain it is not a failure; it ships as an
unattributed patch.

## Applying and publishing

`telo release apply` writes the plan into the tree:

- the new version into every anchor's version file — `package.json`, each
  `Cargo.toml` *and* its `Cargo.lock` entry, `Chart.yaml`'s `version` and
  `appVersion`, a module's `telo.yaml`;
- a new entry on top of each unit's `CHANGELOG.md`;
- the digests of what will be published into `.changes/ledger.yaml`;
- and it deletes the fragments it consumed.

Then `telo release tag` tags the commit `<unit key>@<version>` for each unit the
plan moved (`core@1.5.0`), and `telo release order` says what to publish:

```console
$ telo release order
core         cargo   core/rust       1.5.0
core         npm     core/nodejs     1.5.0
client       npm     client          1.5.0
apps/api     npm     apps/api        2.1.0
apps/api     docker  apps/api        2.1.0  ghcr.io/acme/api
apps/api     helm    apps/api/chart  2.1.0  oci://ghcr.io/acme/charts/api
modules/sql  telo    modules/sql     0.31.4 oci://ghcr.io/acme/sql
```

One row per unit and anchor, a dependency before its dependents, each with the
directory to publish from, its version and — for `telo`, `docker` and `helm` — its
destination. A publish script walks the rows and dispatches each on its ecosystem:
npm packages through the package manager, modules through `telo publish`, images
with their unit's version as the tag, charts with their `Chart.yaml` version.
Publishing a row twice is safe: a registry that already holds the version skips it.

## In CI

- **On a pull request:** `telo release check`.
- **To release:** when `telo release status` plans a unit, run `telo release apply`,
  commit the result and open a release pull request.
- **After it merges:** `telo release tag`, push the tags, then publish each
  `order` row from its `path`.

Where the release branch lives, who triggers it and how a failed run is recovered
are choices of the project; the planner only decides what bumps and in which order
to publish.

## Release candidates

`telo release apply --candidate` versions each planned unit `<final>-rc.<k>`
(`1.5.0-rc.0`) and consumes no fragment, so the final is planned later from the
same fragments. `k` is per unit and rises only when what the unit ships differs
from its last candidate, so the next candidate republishes only what moved. There
is no state file: whether a release is a candidate is the caller's, per call.

Publish candidates under a dist-tag named by the id (`rc`) and leave `latest`
alone, so consumers who do not ask for a prerelease never see one.

## Without Telo

A project with no modules uses the same planner as `telo-release`
(`@telorun/release` on npm, MIT):

```sh
npm install --save-dev @telorun/release
```

```yaml
# telo-workspace.yaml
release:
  maxBump: minor
  units:
    - { path: packages/*, ecosystem: npm }
    - { path: services/api, ecosystem: { npm: ., docker: . }, version: package.json }
```

`npx telo-release add | status | check | apply | tag | order | verify` behave as the
commands above, over `npm`, `cargo`, `docker` and `helm`; `telo release` is the
same tree with the `telo` ecosystem added. Coming from changesets,
`npx telo-release adopt changesets` converts the setup once.

## Where next

- [Releasing modules](../extend/releasing-modules.md) — every command, the
  ledger, candidates, `requires:` floors and restricting a published version.
- [Workspaces](./workspaces.md) — every key of `release:`, anchors, per-ecosystem
  destinations and how a unit's version is resolved.
