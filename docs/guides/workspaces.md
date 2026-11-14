---
description: "Declare a repo as a Telo workspace with telo-workspace.yaml: one module cache, where modules live and publish, which paths are not release-relevant, and how far a run may look for .env files."
---

# Workspaces

A repo holding more than one Telo module or application declares itself a
**workspace** with a `telo-workspace.yaml` at its root.

**Its location is what matters most.** The kernel walks up from an entry manifest
looking for it and anchors the module cache (`.telo`) at the directory that holds
it, so every app in the repo resolves a shared dependency once into one cache
instead of once per app. The same location bounds the walk that collects `.env`
files, and every path the release system names — a module key, a ledger entry, a
changelog fragment, a unit's version — is relative to it.

**For a deployment**, the marker decides where `telo install` writes the cache and
where `telo run` looks for it: an image that copies only the app directory ships
no cache at all, and one that copies the marker must copy the `.telo` tree beside
it. `TELO_CACHE_DIR` overrides both — see
[where the cache lands](/deploy/docker#where-the-cache-lands).

The file is **optional**, and so is every block in it. A marker whose whole
content is comments is a valid one: it anchors the cache and bounds the env walk,
which is all a session workspace ever needs.

## Every field lives in a block scoped to what it governs

`release:` is read by `telo release` — what the workspace releases, where each
thing publishes, which paths are not release-relevant. `env:` is read by `telo run` when
it resolves a manifest's environment. Nothing reads across: a run never consults
`release.units`, which is why a manifest under `examples/`, in no release
subtree at all, still gets the full env walk.

Here is every key, with the default each omission falls back to. For how the
`release:` block is used end to end, see
[Versioning and releases](./versioning-and-releases.md).

```yaml
# telo-workspace.yaml — the anchor. Its LOCATION is what unit keys, ledger
# entries and fragment paths are measured from, and where the `.telo` cache
# lives. Every FIELD lives in a block scoped to what it governs. Every block,
# and every key in it, is optional.

# ── how `telo release` behaves ───────────────────────────────────────────────
release:
  # The highest bump a release may make: patch, minor or major (the default).
  # A plan that needs more is refused (`MAX_BUMP_EXCEEDED`). A unit entry may
  # set its own.
  maxBump: minor

  # Paths under a unit whose changes are not release-relevant, so no changelog
  # fragment is asked for. Unit-relative, gitignore-style. Declaring it
  # REPLACES the built-in default (shown here verbatim); `[]` ignores nothing.
  ignore:
    - "**/tests/**"
    - "**/docs/**"
    - "**/plans/**"
    - "**/README.md"
    - "**/CHANGELOG.md"

  # Per-ecosystem defaults: any key an ecosystem reads at an anchor may be set
  # here instead, and an anchor's own settings override it.
  ecosystems:
    telo: { registry: oci://ghcr.io/telorun }
    docker: { registry: ghcr.io/telorun }
    helm: { registry: oci://ghcr.io/telorun/charts }

  # The release units. A unit is a directory with one version, one changelog
  # (`<unit>/CHANGELOG.md`) and one fragment target; its key is its
  # workspace-relative path. Bare string or object, LAST match wins, a `!`
  # entry excludes. A directory is at most one unit.
  units:
    # A Telo module: `ecosystem` names the ecosystem, anchor `.`.
    - { path: modules/*, ecosystem: telo }
    - "!modules/scratch"

    # Object form. This subtree overrides the destination at its `telo` anchor.
    - path: vendor/aws/*
      ecosystem: { telo: { ".": { registry: oci://ghcr.io/telorun/aws } } }

    # One unit, several ecosystems: an npm package and its Rust twin share ONE
    # version and one changelog. Anchors are literal directories inside the
    # unit. `version` says which file holds the version, because two anchors
    # keep one.
    - path: kernel
      ecosystem: { npm: nodejs, cargo: [rust, rust/macros] }
      version: nodejs/package.json

    # A package with an image and a chart beside it. `context` is the
    # workspace-relative build context; `name` the image repository name.
    - path: apps/api
      ecosystem:
        npm: .
        docker: { ".": { context: ., name: api } }
        helm: chart
      version: package.json

    # No ecosystem: the unit declares its version and what it ships.
    - path: ide/vscode
      version: package.json
      payload: { command: pnpm exec vsce ls --no-dependencies }

    # A bundled package: a bundler metafile whose inputs from other units are
    # inline edges.
    - { path: packages/language-server, ecosystem: npm, metafile: dist/meta.json }

    # A change only to this subtree's docs DOES ask for a fragment here.
    - path: vendor/acme/*
      ecosystem: telo
      ignore: ["**/tests/**"]

  # Units sharing one version: every member releases at the highest level any
  # member needs.
  groups:
    core: [packages/core, packages/client]

# ── how `telo run` resolves a manifest's environment ─────────────────────────
env:
  # How far up the `.env` walk may climb. Workspace-relative, gitignore-style,
  # matched against each ancestor DIRECTORY; the nearest match stops the walk.
  # Omitted: the walk stops at this file.
  roots:
    - vendor/*

  # Which files are collected in each directory, later winning within one
  # directory. Each is a filename, or `{ name, sensitive }` for a file holding
  # values that must not be committed or synced. Declaring it REPLACES the
  # default (`[.env, { name: .env.local, sensitive: true }]`); `[]` collects
  # none. Filenames only — a `/` or a glob is an error.
  files:
    - .env
    - .env.production
    - name: .env.local
      sensitive: true
```

Most workspaces need far less. A single-destination repo of modules is two keys:

```yaml
release:
  ecosystems:
    telo: { registry: oci://ghcr.io/acme }
  units:
    - { path: modules/*, ecosystem: telo }
```

### What a unit entry holds

- **`path`** — the directory, or a pattern of them. A directory is at most one unit.
- **`ecosystem`** — what the unit ships through, each served by an adapter the host
  registered: `telo` (modules), `npm`, `cargo`, `docker`, `helm`. A name (`npm`),
  an order-free set (`[npm, docker]`) or a map of ecosystem to anchor, anchor list,
  or anchor to settings (`{ npm: nodejs, cargo: [rust, rust/value] }`). An
  **anchor** is a literal directory inside the unit holding exactly one package of
  that ecosystem, recognised by its adapter (`npm`: a `package.json` with a
  version; `cargo`: a `Cargo.toml`; `docker`: a Dockerfile; `helm`: a `Chart.yaml`;
  `telo`: a module doc with a version); the name and set forms mean anchor `.`.
  An anchor is one package and covers nothing beneath it. Absent: the unit
  declares `version:` and `payload:` itself. A module lists no anchors for its own
  npm and Cargo packages; they are read from the module doc.
- **`version`** — where the version lives: a file a handler reads, or
  `{ file, pointer }` into JSON, YAML or TOML. Required unless exactly one anchor's
  ecosystem defaults a location (`docker` defaults none). Every anchor's location
  and every `versionFiles` entry is written with it, and `telo release check`
  refuses a unit whose locations disagree.
- **`payload`** — a declared file set, patterns or `{ command }` printing
  unit-relative paths, one more layer beside the ecosystems' own. Required when no
  anchor contributes a layer (a private npm package supplies its version, not a
  layer).
- **`metafile`** — a bundler metafile whose entries are inline edges.
- **`versionFiles`** — patterns or `{ path, pointer }` of further files carrying the
  unit's version; a `Cargo.toml` also moves its `Cargo.lock` entry.
- **`ignore`**, **`maxBump`** — as the block's, for this entry.

An ecosystem's own keys sit at an anchor or in `release.ecosystems.<ecosystem>`,
never flat on the entry: `registry` for `telo`, `docker` and `helm` (the base
a package publishes under — `<registry>/<unit directory name>`, `<registry>/<name>`
and `<registry>/<Chart.yaml name>`; `npm` and `cargo` read none, since the package
says where it goes), docker `name` (default the anchor directory's name) and
docker `context` (default the anchor directory; the ignore file is
`<Dockerfile>.dockerignore` beside the Dockerfile, else `<context>/.dockerignore`,
its patterns anchored at the context). A key none of the entry's ecosystems reads
is `WORKSPACE_UNKNOWN_KEY`, naming the ecosystem.

## Two rules to keep in mind

**A declared list replaces its default; it never extends it.** Adding
`.env.production` means writing all three entries, `.env.local` with its
`sensitive: true`, and adding one `ignore`
pattern means writing the whole set. The set in force is then always exactly one
authored list, readable in one place, rather than something you have to assemble
from a built-in you cannot see.

**`release:`'s own `ignore:` and `maxBump:` are defaults its entries override,
key-wise, and an ecosystem key an anchor does not set falls back to
`release.ecosystems.<ecosystem>`.** Below that, the adapter's own rungs apply —
for `telo` only: `--registry`, `TELO_OCI_REGISTRY`, then the base the module's own
ledger entry recorded.

## Where units publish

A module's ref is its registry base plus its **own directory name** — so
`vendor/aws/s3` under `oci://ghcr.io/telorun/aws` publishes to
`oci://ghcr.io/telorun/aws/s3`; an image is `<registry>/<name>`, a chart
`<registry>/<Chart.yaml name>`. A `telo`, `docker` or `helm` anchor whose cascade
ends with no `registry` is `NO_DESTINATION_KNOWN`, reported by `check`, `order` and
`verify`. Two rules follow, and `telo release` checks both before it builds
anything:

- **Two units must not resolve to one ref** — the check covers every `order` row. `vendor/aws/storage` and
  `vendor/google/storage` inheriting a single base would overwrite one artifact
  (`DESTINATION_COLLISION`). Rename a directory, or give one subtree its own
  `registry:` at its anchor.
- **A relative import leaving a module must name a module the workspace
  releases.** Publishing writes `imports: ../../modules/sql` as the ref the
  workspace assigns `modules/sql`, whatever base and depth the importer sits at,
  so a target the workspace does not release — a library inside another
  module's directory, say — has no ref to write (`IMPORT_TARGET_NOT_RELEASED`).

## Bounding what a run can read

By default `telo run` walks from the manifest up to the marker, collecting the
env files it finds, with a nearer file winning over a farther one and the real
process environment winning over all of them.

`env.roots` draws a tighter line. It is what keeps a vendor subtree's apps from
picking up a repo-root `.env` in a monorepo that holds several teams' work:

```yaml
env:
  roots:
    - vendor/*
```

A run under `vendor/aws/s3` now stops at `vendor/aws/`, and one under `modules/`
— matched by no pattern — still walks to the marker.

## Sensitive env files

A sensitive env file holds values that must not be committed or synced. With no
`files:` declared, `.env.local` is the sensitive one and `.env` is not — nothing
changes for a workspace that declares nothing. With `files:` declared, a file is
sensitive only when its entry says so, and no filename is special:

```yaml
env:
  files:
    - .env
    - name: .secrets
      sensitive: true
```

`sensitive` takes `true` or `false`. An unknown key in an entry
(`sensitve: true`) is `WORKSPACE_UNKNOWN_KEY` and a wrong type is
`WORKSPACE_INVALID_VALUE`, both inside `env:`, so `telo run` refuses on them.

These read the mark:

- **`telo env template`** writes every secret and every need field marked
  sensitive to the LAST sensitive entry of `env.files`, and everything else to
  the last entry that is not. When the workspace declares no entry of the kind a
  value needs, it refuses and names what to add. It warns when a sensitive file
  it wrote is not ignored by git.
- **`telo run`** warns when a `secrets:` entry, or a need field marked
  sensitive, takes its value from a file that is not:
  `[env] secret DB_PASSWORD is set in ./.env, which env.files does not mark
  sensitive — move it to a sensitive file`. The run proceeds.
- **Studio's Variables tab** writes a new secret to the LAST sensitive entry
  beside the manifest, refuses naming `env.files` when there is none, and shows
  `telo run`'s warning on a secret's row.
- **Telo Cloud working copies, Copy to Telo Cloud project and agent sync** leave
  every sensitive file out — judged by the nearest `telo-workspace.yaml` at or
  above the file, `.env.local` where none governs — so it is never committed,
  copied into a project or synced into an agent's session.

The mark has nothing to do with log redaction, which follows what a manifest
declares as secret wherever the value came from.

**telo 0.120.0 is the first release that reads the object form.** An older
`telo run` refuses a marker using it (`WORKSPACE_INVALID_VALUE` inside `env:`),
and a marker has no `requires:` to say why — so upgrade every machine and image
that runs the workspace before writing an entry as `{ name, sensitive }`.

## What happens when the file is wrong

`telo release` refuses on any error in it. `telo run` is scoped to `env:`: a
problem anywhere else is printed and the run proceeds, because aborting every app
in a workspace over a release typo is not a trade worth making. A problem *inside*
`env:` does stop the run — falling back to the marker-wide bound would widen the
walk, which is the opposite of what the block was written to do.

An unrecognized top-level block is a warning, so a marker written for a newer
telo still runs on an older one; a near-miss of a known block (`relase:`) is an
error, because its settings would otherwise go silently unapplied.

Three checks need to see the repo rather than just the file, and `telo release`
runs them alongside the editor: a `release.units` entry that discovers no
unit (`WORKSPACE_ENTRY_MATCHES_NOTHING`), one every later entry re-claims or
every later `!` removes (`WORKSPACE_ENTRY_SHADOWED`), and a marker nested under
another (`WORKSPACE_MARKER_SHADOWED`). They are warnings — an inert entry is not
a reason to fail a release — but they are never only a squiggle.

If you are moving from a marker that carried `release.modules` and `release.registry`
(or a top-level `modules:` list), write the same subtrees as `release.units` entries
with `ecosystem: telo` and the base under `release.ecosystems.telo`. `telo release`
names the move (`WORKSPACE_MODULES_MOVED`) rather than reporting an unknown field, and
refuses a flat `registry:` on a unit entry the same way.
