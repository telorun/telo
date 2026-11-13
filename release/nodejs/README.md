# @telorun/release

A release planner for repositories that ship through several ecosystems at once.
Each release **unit** — an npm package, a crate, an image, a chart, or several of
them — gets one version, one changelog (`<unit>/CHANGELOG.md`) and one place for
change notes. A unit bumps when the digest of what it ships moves, at the level
its change notes and its dependencies give it. It replaces changesets, and works
in any Node project: of Telo's packages it needs only `@telorun/glob`.

## Install

```sh
npm install --save-dev @telorun/release
```

Its bin is `telo-release`; the commands below are `npx telo-release <command>`
(`pnpm exec`, `yarn`, `bunx` work the same). The Rust twin, `telorun-release`
(`release/rust`), builds the same binary and answers the same vectors
(`release/conformance/`).

## The marker

Units are declared in `telo-workspace.yaml` at the repository root, under
`release:`. The file's location is the anchor for every unit key, fragment and
ledger entry.

An npm monorepo, one package per directory:

```yaml
release:
  maxBump: minor
  units:
    - { path: packages/*, ecosystem: npm }
    - { path: packages/bundle, ecosystem: npm, metafile: dist/meta.json }
  groups:
    core: [packages/core, packages/client]
```

npm, an image and a chart in one unit — one version, one changelog, so a
Dockerfile-only or chart-only change releases it:

```yaml
release:
  ecosystems:
    docker: { registry: ghcr.io/acme }
    helm: { registry: oci://ghcr.io/acme/charts }
  units:
    - path: apps/api
      ecosystem: { npm: ., docker: { ".": { context: . } }, helm: chart }
      version: package.json
```

A polyglot unit — a Node package and its Rust crates share one version:

```yaml
release:
  units:
    - path: engine
      ecosystem: { npm: nodejs, cargo: [rust, rust/core] }
      version: nodejs/package.json
```

A declared unit — no ecosystem, a version file and a file set:

```yaml
release:
  units:
    - path: extension
      version: package.json
      payload: { command: vsce ls }
```

Rules worth knowing:

- `ecosystem` is a name (`npm`), an order-free set (`[npm, docker]`), or a map of
  ecosystem to an anchor, an anchor list, or anchor → settings. An **anchor** is a
  literal directory inside the unit holding exactly one package of that ecosystem;
  the name and set forms mean anchor `.`.
- The version is the `version:` you declare, else the one anchor whose ecosystem
  defaults a version location (`docker` defaults none). Zero or several is
  `WORKSPACE_UNIT_VERSION_UNRESOLVED`, never a precedence by list order.
- Settings (`registry`; docker `name` and `context`) sit at an anchor or under
  `release.ecosystems.<ecosystem>`, never flat on a unit entry. `npm` and `cargo`
  read none.
- `groups` release every member at the highest level any needs; `maxBump` caps
  the level (`major` by default) and a plan above it is refused.
- Edges between units are never declared: they come from `workspace:` ranges,
  cargo path dependencies, any unit's version file inside another's payload, and a
  `metafile:`.
- A unit with no layer is `WORKSPACE_UNIT_PAYLOAD_EMPTY`; a package directory
  claimed by two units is `WORKSPACE_ANCHOR_CLAIMED`.
- No layer holds the workspace's `.changes/` directory (the ledger and the pending
  fragments), even a build context at the root or a `payload: ["**"]`: `apply`
  rewrites it, so a layer holding it would move with every release.

## Commands

```sh
npx telo-release add --unit packages/core --kind Fixed --body "…"   # describe a change
npx telo-release status                                             # what bumps, from what to what, and why
npx telo-release check                                              # the pull-request gate
npx telo-release apply                                              # version the final
npx telo-release apply --candidate                                  # version a candidate, <final>-rc.<k>
npx telo-release tag                                                # tag <unit key>@<version> on the release commit
npx telo-release order -o json                                      # what to publish, in order
npx telo-release verify --write                                     # reconcile the ledger with the registries
```

- **`add`** writes a fragment under `.changes/pending/` (never write one by hand).
  `--unit` takes the unit's directory and repeats for a change spanning units;
  `--kind` is `Added | Changed | Deprecated | Removed | Fixed | Security`. `Added`
  and `Deprecated` are minor, `Fixed` and `Security` patch, `Changed` and `Removed`
  major.
- **`status`** prints per unit the current → planned version, the cause (a
  fragment, an edge, or *unattributed*: the digest moved and nothing says why,
  shipped as a patch) and the group.
- **`check`** is the one PR gate. It fails when no consistent plan can be formed —
  a fragment naming no unit (`FRAGMENT_UNKNOWN_UNIT`), a level above `maxBump`
  (`MAX_BUMP_EXCEEDED`), a unit whose version locations disagree
  (`UNIT_VERSION_MISMATCH`), an anchor with no publish destination
  (`NO_DESTINATION_KNOWN`). A changed unit with no fragment only warns
  (`CHANGELOG_ENTRY_REQUESTED`) and still releases.
- **`apply`** writes every unit's version to every anchor (a `Cargo.toml` also
  moves its `Cargo.lock` entry), the changelog, and the ledger
  `.changes/ledger.yaml`, and consumes the fragments.
- **`order`** emits one row per unit and anchor in dependency order, `{ key,
  ecosystem, path, version, destination }` — publish each row from its `path`.
- **`verify`** reconciles the ledger per layer through each ecosystem's read-back
  from the registry; a layer with no read-back (`docker`, a declared payload) is
  reported unverifiable and keeps its digest. Run `verify --write` once to seed
  the ledger.
- A command line the parser refuses — an unknown command or option, a missing
  argument, a value outside its choices — runs nothing and exits 2.
- **`tag`** tags the commit it runs at `<unit key>@<version>` for each unit the last
  `apply` moved, candidates included (`--dry-run` lists them).

Options on every command: `-o json` for machine output, `--base <ref>` (the diff the
changed-files reading uses; it only decides whether a changelog entry is requested)
and `--carried-by <ref>` (drop every pending fragment that ref already carries, so a
fix cherry-picked to a release branch with its fragment plans nothing twice on main).
`release.ignore` lists unit-relative paths whose changes ask for no changelog entry
(tests, docs, READMEs and changelogs by default).

A marker naming an ecosystem the host has no adapter for is
`WORKSPACE_ECOSYSTEM_UNAVAILABLE`; the `telo` ecosystem (Telo modules) is served only
by `telo release`.

## Candidates

`apply --candidate[=<id>]` versions each planned unit `<final>-<id>.<k>` (default
id `rc`). `k` is per unit, shared within a group, and rises only when a layer
differs from the unit's `candidate:` ledger record. A candidate consumes no
fragment and leaves the final entry alone, so a plain `apply` later plans the final
from the pending fragments and removes the candidate records. Nothing is stored:
whether a release is a candidate is the caller's, per call. Publish candidate
versions under a dist-tag named by the id.

## Coming from changesets

`npx telo-release adopt changesets` once: it writes a `release.units` entry per
package, turns `fixed` groups into `release.groups` and `ignore` into `!` entries,
converts each pending change file into a fragment (`major` / `minor` / `patch`
become `Changed` / `Added` / `Fixed`), records the published npm layers, refuses
`linked` groups, deletes `.changeset/`, and lists the CI steps and dependencies it
left for you to rewrite.

## In CI

- On a pull request: `npx telo-release check`. It needs no credentials and no merge
  base — it compares digests with the committed ledger.
- To open a release PR: when `status` plans a unit, run `apply` (with `--candidate`
  while in candidates), commit the result and open the PR.
- After it merges: `tag`, push the tags, then publish each `order` row from its
  `path` with its ecosystem's own tool (`npm publish`, `cargo publish`,
  `docker push`, `helm push`). Rows already published are skipped by the
  registry, so a re-run is safe.
- Published npm links can name the tag `blob/<unit key>@<version>/…`.

## Entries

The main entry (`@telorun/release`) is the browser-safe model — plan, marker
reader, ledger, changelog — for an editor that answers "what does this change
bump?". `@telorun/release/node` holds the evidence (git, the ledger store, the
adapters' file sets and registry read-back) and the command tree a host mounts
with `releaseCommands`. Hosts register the ecosystems they serve; `telo release`
in the Telo CLI is this same tree with the `telo` ecosystem (modules) added.
