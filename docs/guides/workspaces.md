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
changelog fragment — is relative to it.

**For a deployment**, the marker decides where `telo install` writes the cache and
where `telo run` looks for it: an image that copies only the app directory ships
no cache at all, and one that copies the marker must copy the `.telo` tree beside
it. `TELO_CACHE_DIR` overrides both — see
[where the cache lands](/deploy/docker#where-the-cache-lands).

The file is **optional**, and so is every block in it. A marker whose whole
content is comments is a valid one: it anchors the cache and bounds the env walk,
which is all a session workspace ever needs.

## Every field lives in a block scoped to what it governs

`release:` is read by `telo release` — where modules live, where they publish,
which of their paths are not release-relevant. `env:` is read by `telo run` when
it resolves a manifest's environment. Nothing reads across: a run never consults
`release.modules`, which is why a manifest under `examples/`, in no release
subtree at all, still gets the full env walk.

Here is every key, with the default each omission falls back to.

```yaml
# telo-workspace.yaml — the anchor. Its LOCATION is what module keys, ledger
# entries and fragment paths are measured from, and where the `.telo` cache
# lives. Every FIELD lives in a block scoped to what it governs. Every block,
# and every key in it, is optional.

# ── how `telo release` behaves ───────────────────────────────────────────────
release:
  # Publish destination base. A module's ref is `<registry>/<its own directory
  # name>`. Omitted: --registry, then TELO_OCI_REGISTRY, then the base each
  # module's own ledger entry recorded.
  registry: oci://ghcr.io/telorun

  # Paths under a module whose changes are not release-relevant, so no changelog
  # fragment is asked for. Module-relative, gitignore-style. Declaring it
  # REPLACES the built-in default (shown here verbatim); `[]` ignores nothing.
  ignore:
    - "**/tests/**"
    - "**/docs/**"
    - "**/plans/**"
    - "**/README.md"
    - "**/CHANGELOG.md"

  # The subtrees that may hold modules — a place to look, never a module: what
  # makes a directory a module is its `telo.yaml` carrying `metadata.version`.
  # Workspace-relative, gitignore-style, LAST match wins.
  modules:
    # Bare string: an entry with no overrides. Inherits both keys above.
    - modules/*
    - apps/*

    # A `!` entry is an exclusion. It supplies nothing — a module the last
    # match excludes is not a module of this workspace at all.
    - "!modules/scratch"

    # Object form. `path:` is required; `registry:` and `ignore:` override the
    # block's, key-wise. This one overrides only the destination, so it still
    # ignores the block's five patterns above.
    - path: vendor/aws/*
      registry: oci://ghcr.io/telorun/aws

    # Overriding both. This subtree ignores only its own three patterns, so a
    # `docs/` edit here DOES ask for a fragment.
    - path: vendor/acme/*
      registry: oci://registry.acme.internal/platform
      ignore:
        - "**/tests/**"
        - "**/__snapshots__/**"
        - "spec/**"

    # A later, more specific entry overriding one module inside a subtree an
    # earlier entry already matched. Legal — last match wins.
    - path: modules/sql
      ignore: []

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

Most workspaces need far less. A single-destination repo is two keys:

```yaml
release:
  modules:
    - modules/*
    - apps/*
```

## Two rules to keep in mind

**A declared list replaces its default; it never extends it.** Adding
`.env.production` means writing all three entries, `.env.local` with its
`sensitive: true`, and adding one `ignore`
pattern means writing the whole set. The set in force is then always exactly one
authored list, readable in one place, rather than something you have to assemble
from a built-in you cannot see.

**`release:`'s own `registry:` and `ignore:` are defaults its entries override,
key-wise.** An entry naming only `registry:` keeps the block's `ignore:`, and the
other way round.

## Where modules publish

A module's ref is its registry base plus its **own directory name** — so
`vendor/aws/s3` under `oci://ghcr.io/telorun/aws` publishes to
`oci://ghcr.io/telorun/aws/s3`. Two rules follow, and `telo release` checks both
before it builds anything:

- **Two modules must not resolve to one ref.** `vendor/aws/storage` and
  `vendor/google/storage` inheriting a single base would overwrite one artifact
  (`DESTINATION_COLLISION`). Rename a directory, or give one subtree its own
  `registry:`.
- **A relative import must agree about where its target publishes.** Publishing
  rewrites `imports: ../sql` to the ref the importer's own path yields, so a
  relative import that crosses a registry boundary would name a module nobody
  pushes (`IMPORT_DESTINATION_CONFLICT`). Across a publish boundary, use a pinned
  remote import — which is what such a dependency is.

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
runs them alongside the editor: a `release.modules` entry that discovers no
module (`WORKSPACE_ENTRY_MATCHES_NOTHING`), one every later entry re-claims or
every later `!` removes (`WORKSPACE_ENTRY_SHADOWED`), and a marker nested under
another (`WORKSPACE_MARKER_SHADOWED`). They are warnings — an inert entry is not
a reason to fail a release — but they are never only a squiggle.

If you are moving from a marker that carried a top-level `modules:` list, indent
it under `release:`. `telo release` names the move rather than reporting an
unknown field.
