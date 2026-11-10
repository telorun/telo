---
sidebar_label: Releasing Modules
slug: /extend/releasing-modules
description: "Version and publish the modules of a workspace with telo release: the workspace marker, change fragments, the ledger, and why a dependent's version moves when a sibling's bytes do."
---

# Releasing modules

`telo release` versions the modules of a **workspace**. It exists because a Telo
module's artifact *embeds its dependencies*: esbuild inlines a sibling library's
source into the controller bundle, and publishing pins each relative import to a
hash of that sibling's manifest. npm has no such property — a dependent's tarball
does not contain its dependency — so where npm treats "bump the dependents" as a
courtesy, here it is a correctness requirement.

## The workspace

A workspace declares itself with a `telo-workspace.yaml` at its root. **Its
location is the anchor**: every module key, ledger entry and fragment path is
relative to that directory.

```yaml
# telo-workspace.yaml
release:
  modules:
    - modules/*
    - apps/*
```

`release.modules` names the subtrees that may hold modules. That is not
derivable — a whole-tree scan would read every example, starter and cached
`.telo/manifests/**` copy as a released module. It sits inside `release:` because
that is what it is: a release inventory, not an inventory of manifests.

**The file is optional, and so is every block in it.** `check`, `publish`,
`install`, `upgrade`, `migrate` and `module` behave identically without one, and
the kernel only ever reads its location. `telo run` reads the location too, plus
an `env:` block if one is declared — see [Workspaces](../guides/workspaces.md)
for every key the file carries, including per-subtree publish destinations.

Within those subtrees, **a module is a directory holding a `telo.yaml` whose
module doc carries a `metadata.version`**. Nothing registers the set. A module's
key is its workspace-relative path (`modules/sql`), never a bare name — two
directories in different subtrees can share a name, and a path cannot.

A `Dockerfile` beside the manifest makes a module an **image module**; its
absence, a **registry artifact module**. That decides only which file set is
digested.

## The three questions

| Question | Mechanism |
| --- | --- |
| *Whether* a module bumps | the **payload digest**, exact, from the bytes |
| *At what level* | the **edge graph** — declared fragments, then propagation |
| *Whether a changelog line is requested* | the path-scoped **changed-files** rule |

The digest is what sees a change no path rule can: an inlined sibling's edit, a
fix in a shared TypeScript library, a transitive bump the lockfile alone moved.
The graph is what says a `Fixed` on `modules/sql` makes `modules/sqlite` a
`Fixed` too. And the changed-files rule — which used to decide the version, and
whose guesswork therefore had to be sound — now only asks for prose, so a false
positive costs one sentence rather than a spurious republish.

Edges come from two places:

- **Inlined files**, read from the controller build's own **metafile**. A
  declared-dependency graph cannot see `--external`, so `@telorun/sdk` (declared
  by 54 modules, inlined by none) would otherwise bump the whole standard
  library on every SDK change.
- **In-repo relative `imports:`**. A pinned remote ref is deliberately *not* an
  edge: pinning is the statement "I am not affected until I choose to be", and
  moving it is `telo upgrade`'s job.

A payload that moved with nothing to attribute it to — a third-party dependency,
a changesets-owned package, a toolchain bump — takes a **patch** and is reported
as *unattributed*. It is never silent, and it never asks anyone to write prose.

## The ledger

`.changes/ledger.yaml` records, per module, its version and its per-layer
integrity **as published**, plus the registry base those digests were taken
against.

```yaml
modules:
  modules/sql:
    version: 0.21.0
    registry: oci://ghcr.io/telorun
    layers:
      manifest: sha256-4f1c…
      controller/js: sha256-9ab7…
```

Every entry records its own base, because a workspace may publish its subtrees to
different ones.

That is what lets the PR gate and the publish gate compute **the same number**.
The gate reads the ledger, so it needs no merge base, no shallow-clone
workaround and no credentials — a fork's PR runs the identical computation the
release job runs.

**The ledger is a cache; the registry is the authority.** A committed digest can
disagree with what is published (a hand edit, an `apply` whose publish then
failed, a push made outside the pipeline), so `telo publish` still reads the
registry and `telo release verify` reconciles the two on demand. A *missing*
entry is not drift — it means nothing is published, which is the right reading
for a new module.

`verify` compares **the ledger against the registry**, not your working copy
against it. Those are different questions: the working copy differs from what is
published on any commit after a release, which is normal and is what `check`
plans a bump for.

One key is deliberately outside that reconciliation. The `manifest` digest has no
entry in the published `layers:` index — that index lives inside `telo.yaml`, so
it cannot carry that file's own digest — and the index is what `verify` reads. It
stays in the ledger regardless: it is the only thing that sees a **manifest-only
change** (a schema edit, a new kind, a dependency's version moving into a pin),
none of which touch a controller byte. So `verify` compares and rewrites the
layers the registry can answer for and preserves that one; `apply` is what writes
it.

The base is recorded because canonicalization writes the destination into every
relative import, so digests taken against another base are digests of different
bytes.

### Seeding it

An empty ledger is a valid state: every module reads as never-published, so
nothing drifts and only declared fragments and their propagation appear in a
plan. That is correct but blind — the digest half of the system is switched off
until the ledger knows what is out there. Seed it once, against the registry:

```console
$ telo release verify --write --registry oci://ghcr.io/telorun
```

That is also the repair for a ledger that has drifted out of step with what is
actually published. It records everything the registry can answer for; the
`manifest` digest is filled in by the first `apply`, and until then `check`
reads its absence as drift and plans a patch — the safe direction, since a bump
that was not needed costs a version while a missed one ships to nobody.

## Writing a fragment

```yaml
# .changes/pending/fixed-parameters-are-bound-positionally.yaml
modules:
  modules/sql: Fixed
body: Parameters are bound positionally on every dialect.
```

One file, several modules, one body — so a cross-cutting change is one fragment
rather than one per module repeating a sentence. The `kind:` drives both the
level and the changelog section:

| Kind | Level |
| --- | --- |
| `Added`, `Deprecated` | minor |
| `Fixed`, `Security` | patch |
| `Changed`, `Removed` | major — **rejected** |

Modules are intentionally pre-1.0, so a breaking change ships as a minor
(`Added`, with the break described in the body). A major-inducing kind is a hard
error.

Write one with:

```console
$ telo release add --module modules/sql --kind Fixed \
    --body "Parameters are bound positionally on every dialect."
```

## The commands

```console
$ telo release status     # what would bump, and why
$ telo release check      # the same computation, with an exit code
$ telo release order      # modules in publish order (a dependency first)
$ telo release apply      # write versions, changelogs and the ledger
$ telo release verify     # reconcile the ledger against the registry
$ telo release stage      # fetch and verify the files `sources:` declares
$ telo release floor      # measure and write each module's requires.telo
```

`status` prints the plan with its attribution:

```
modules/sql             0.21.0 → 0.21.1  patch — declared
modules/kv-store-sql    0.7.0  → 0.7.1   patch — inlines modules/sql/nodejs/src/query.ts
modules/sql-repository  0.4.0  → 0.4.1   patch — imports modules/sql
modules/test            0.9.3  → 0.9.4   patch — payload changed, unattributed
```

**`check` does not fail because a payload moved.** Under a toolchain bump every
module's digest moves; demanding sixty hand-written fragments for that would be
a tax on nobody's behalf. It fails when no consistent plan can be formed:

- a fragment naming a module that does not exist,
- a major-inducing kind,
- a manifest version that disagrees with its ledger entry,
- digests taken against a different registry base,
- a source built from a crate (`build: { cargo: <dir> }`) whose recorded
  `build.inputs` no longer match the crate's tracked files, the files of the path
  crates it reaches, the lock packages they reach and the cargo configuration that
  applies to the build — or that records none. Rebuild the files and run
  `telo release stage --pin`. See
  [Native Files](./native-files.md#prebuilds-of-your-own-crates).

It *warns* — `CHANGELOG_ENTRY_REQUESTED` — when a module's own files changed and
no fragment names it.

`check` also verifies every module's `requires.telo`: `REQUIRES_FLOOR_TOO_LOW` when the
floor is below what published telo releases need to read the module, and
`REQUIRES_FLOOR_TOO_HIGH` when it is above (a `>=unreleased` that a published
release now accepts, a number raised by hand). Each names the measured value.

`floor` measures the lowest published telo that reads each module (or `--module <dir>`)
with the published CLI, siblings first (a dependent is never below the floors of the siblings it
imports by relative path), and writes it into `requires.telo`: a version,
`>=unreleased` when no published telo reads the syntax yet, or no `requires:` when the oldest
telo that reads `requires:` accepts it. It writes nothing if the registry cannot be reached.
Nobody types `requires.telo` in a workspace; what measurement cannot see is a
[`restrictions:` entry](./declaring-runtime-requirements.md#restrictions). The version step
that follows `changeset version` rewrites every `>=unreleased` in the manifests, entries
included, to the version it gave the telo line, and `telo publish` refuses one still present.

`apply` writes the new version into every manifest the module owns
(`telo.yaml`, `nodejs/package.json`, `rust/Cargo.toml`), appends to each
changelog, re-records the ledger with the digests of what will actually be
published, and deletes the fragments it consumed. Version rewriting is a
byte-splice over the author's own text, so a bump lands as a one-line diff
rather than a re-serialized file.

A module with a Rust half also has its entry moved in the `Cargo.lock` that
records the crate — its own, else the nearest one above it. A lockfile left
behind still names the version the crate had, so every `cargo --locked`
invocation has to re-resolve, which means reaching the network, which `--locked`
forbids: the build fails on whichever machine runs a locked cargo command before
an unlocked one has silently repaired the file.

`stage` fetches the prebuilt files a module's `sources:` block declares from
their pinned upstream archives and verifies each against its `sha256` and
executable bit; a file already on disk and matching its pin is not fetched.
`stage --pin` fetches every file entry and writes those pins into `telo.yaml`
first, as a byte splice, together with the build-input digest of each source
built from a crate, and writes nothing unless the edited manifest reads back with
exactly those pins. `--module <path>` narrows either to named modules. A kernel
running from a source checkout stages the one file it needs on first use, so
running a manifest needs no `stage`; publish, which reads every tuple, does. See
[Native Files](./native-files.md#where-the-files-come-from-sources).

## When modules publish

Modules publish from a release branch (`release/<major>.<minor>`), never from `main`, and only after that branch's final:

- **No module publishes during candidates.** A release opens one PR on its branch, `chore(release): version`, and in candidates (the branch holds `.changeset/pre.json`) it versions npm packages only, so every floor a module declares (`requires: telo:`) names a published telo. A module adopting grammar of the release in candidates holds `>=unreleased` until the final's version step writes the number, and is tried in the checkout through relative imports.
- **From the final on** the same release PR also runs `telo release apply` whenever the branch holds pending changesets, module drift or both; merging it publishes npm and then the changed modules in one run. Each such release is tagged `modules-<major>.<minor>-<n>` (`n` counts the branch's module releases) on the release's publication commit, and recorded on `main` by a generated pull request (`chore(release): record <tag> on main`), which copies the published versions, changelogs and ledger entries and deletes the fragments the release consumed, so the ledger on `main` holds every published version and the next cut never plans one twice.
- **A fragment a release branch already carries plans nothing on main.** `telo release status`, `check` and `apply` take `--carried-by <ref>`: a pending fragment of the same path and content at that ref's merge base with `HEAD`, or written on it since, is dropped from the plan. CI passes the live `release/*` branch when the tree checked is main's, so a fix picked onto the branch with its fragment does not plan a second release of it on main.
- **Image modules** build their images in the same Publish run: `:latest` moves only forward and only on a final, patch or module release; a push to `main` publishes no image.
- **Module docs link only to `https://telo.run/…` pages or another module's hub page** (`https://hub.telo.run/module/oci/ghcr.io/telorun/<name>/`), never into the repository tree, so a module's bytes do not depend on which release publishes it. `pnpm run check:links` refuses the rest.

The whole procedure, with recovery, is in [RELEASING.md](../../RELEASING.md).

## Restricting a published version

A published `telo.yaml` is fixed: consumer pins hash it and publish refuses different bytes at the
same version. So a ceiling found after publishing (a telo release or a Node major that breaks the
module) is stated by publishing a later version whose `restrictions:` entries cover the broken ones:

```yaml
version: 1.2.1
restrictions:
  - versions: ">=1.2.0"
    requires: { telo: "<0.122.0" }
    reason: Lookup never returns on telo 0.122.0 and later; a fix ships in 1.3.0.
```

- A restriction only changes selection. A pin on the covered version keeps loading, because the
  gate reads that version's own bytes; `telo upgrade` and the editor skip it and name the reason.
- The fixed later version is selected as usual: a release whose own range accepts the runtime and
  which no newer entry covers.
- A range with no upper bound runs through the declaring version: `">=1.2.0"` written at 1.2.0
  covers 1.2.0 and 1.2.1 once `telo release apply` moves the document to 1.2.1, and no further.
- An entry a later version omits still holds. Lifting is restating the key from a later version
  with an entry covering the same versions (`">=1.2.0 <=1.2.1"` with `telo: ">=0.121.0"`); a key
  not restated keeps its older statement.

See [Declaring runtime requirements](./declaring-runtime-requirements.md#restrictions).

## Consumers in the same repository

An example, a starter, an application or a blueprint that lives beside the
modules it uses imports each of them in one of two forms: by relative path, which
loads the working copy, or by the published reference with its integrity pin,
which loads what the registry serves. `telo release imports <manifests..>
--as=published|relative` writes every import of a workspace module in the
manifests you name in one form or the other:

- `--as=relative` writes the path from the manifest's directory to the module's
  directory (`../../modules/sql`, no `telo.yaml`) for every import whose
  repository is a workspace module's publish destination, whatever version it
  names.
- `--as=published` writes `<destination>@<version>#<pin>` for the module's
  version in the tree, the pin read from the registry. It asks the release plan
  first: a module the plan bumps has a published artifact that is not the working
  copy, so its import is written relative and the plan's reason is printed
  (`kept relative — modules/sql has an unreleased change (0.27.0 → 0.27.1: declared)`);
  so is a version the registry does not have yet. Either makes the command exit 1,
  with every other import still written.

A dependent held back by a sibling says so: `imports modules/sql` in the reason
names the module that has to ship first. An import of the module a manifest sits
inside — the module's own test or fixture, a blueprint's `example/` — is always
written relative. Imports of modules outside the workspace, image modules and a
library nested below the importer are left alone, and so are the manifests the
named ones reach: a released module's own relative imports are what its release
is planned along. `--check` writes nothing and exits 1 listing every import not in
the requested form; `--dry-run` shows the rewrites. The edit splices only each
`source:` value, so the two directions give each other's bytes back.

In this repository every branch holds the relative form, and the static checks
refuse a pinned import of a workspace module. The published form exists only in a
release's tags: after its modules publish, the release run commits
`--as=published` over the consumer roots on a commit no branch holds and tags it.

`telo upgrade --pin-local` is a deprecated alias of `--as=published`, kept for
one release.

## Reading your own version

A manifest can read the module doc's metadata instead of restating it:

```yaml
serverInfo:
  name: telo-hub
  version: !cel "module.version"
```

`module.<field>` is typed per field and closed, so `module.verison` is a
diagnostic rather than an empty string at runtime. An imported library reads its
**own** metadata, not its importer's. The loader's derived stamps (`source`,
`sourceLine`, and the analyzer's indices) are not exposed.

The field must be a CEL slot (`x-telo-eval`) like any other expression.

## What publishing assumes

Two of the release system's invariants are enforced at publish:

- **Every remote import carries an author-written pin.** `telo install` and
  `telo upgrade` write it. Publishing an unpinned remote import is refused
  rather than resolved over the network — that is what makes the published bytes
  a pure function of the commit, and it retires a best-effort branch that
  shipped a silently unpinned artifact whenever a fetch failed. Existing pins
  are *verified* against the registry, and a mismatch is fatal.
- **The controller is built from source, by the kernel.** The `path=` file in a
  working copy is a gitignored build artifact; reading it would digest and ship
  bytes other than the source the manifest names. On this path a host without
  esbuild is a hard failure, not a fallthrough.
- **A workspace module's imports name where their targets publish.** A relative
  import of another workspace module is written as that module's assigned
  destination — `oci://ghcr.io/telorun/sql@<version>#<pin>` from
  `blueprints/agent-app`'s `../../modules/sql`, though the blueprint publishes
  under `oci://ghcr.io/telorun/blueprints` and one level deeper — using the
  registry cascade `telo release` uses. So modules at any depth and under any
  base import each other relatively. `telo publish` refuses a destination
  other than the one the workspace assigns the module (`destination_mismatch`),
  and before a real push refuses a sibling that is not published
  (`sibling_not_published`) or that the registry serves with other bytes than
  the pin derived from the working copy (`import_pin_mismatch` — the sibling
  needs a new version). A manifest outside any release workspace keeps deriving
  a sibling's ref from its own destination and the import's path.

## Libraries inside a module's directory

A library whose manifest lies inside the directory of the module being published
(`./chat` holding a `telo.yaml`, or `./ordering.yaml` beside it) ships **inside that
module's artifact**, not as an artifact of its own. "Inside" is decided at publish
from paths on disk, against the module named on the `telo publish` command line —
so a nested library importing another library elsewhere under the same directory
embeds it too — and no new manifest key marks it.

- The published import stays relative and pinned: `source: ./chat#sha256-<hash>`,
  the hash of the nested library's own published `telo.yaml`. Its manifest rides in
  the module's manifest layer at its path (`chat/telo.yaml`, `ordering.yaml`).
- The nested library keeps its own `layers:` index: its controllers, library entry
  points, assets and `LICENSE` are layers of its own, pushed into the module's
  repository and listed in the module's OCI manifest.
- A nested directory belongs to its library: the module's `files:` / `assets:`
  patterns do not select files under it.
- A nested library needs no `metadata.version`.
- An import leaving the module's directory names a separate artifact: the
  target's assigned destination inside a release workspace, the module's own
  destination with the import's path applied outside one.

Three refusals follow. `telo publish` refuses (`import_nested`) a module importing a
library that lies inside *another* module's directory — it has no artifact of its
own; move the library out of that directory to share it. `telo release` refuses
the same import at plan time, and any relative import leaving the module for a
manifest the workspace does not release (`IMPORT_TARGET_NOT_RELEASED`). And it
refuses a workspace module whose directory lies inside another workspace module
that imports it, naming the workspace entry to drop. Changes to a nested library
move the enclosing module's digest and version.

## Staged files

A file a `sources:` entry stages is digested from its **pin**, not from disk, by
every command that computes a payload digest — `status`, `check`, `apply`,
`order`. A layer's `integrity` is one line per entry, and a pinned file
contributes exactly the line its bytes would, so a tree where nothing is staged —
a fork's PR checkout, a fresh clone — computes the same `integrity` publish
derives from the staged bytes and the registry serves.

A layer's `blob` addresses framed bytes and cannot be computed from a pin, so a
layer holding a staged file takes a stand-in: `sha256:` plus the hex form of its
integrity digest, deterministic on every tree. Only the `manifest` ledger digest —
the one entry `verify` never reconciles — sees it.

`telo publish` does not fetch. It reads every staged file off disk, verifies it
against its pin, and frames the real bytes, so every `blob` and every sibling pin
it ships names bytes the registry holds. The module publish job runs
`telo release stage` over the modules it pushes and every in-repo module they
import — a dependent's pin is derived from its sibling's published bytes —
before pushing anything. Publish refuses:

- a staged file that is missing or whose bytes or executable bit do not match its
  pin (run `telo release stage`), or that carries no pin (run `--pin`);
- a `native:` path, or a platform-qualified controller candidate's `path=`, that
  no source stages and git does not track — a binary nobody committed and nothing
  fetches is one the next checkout cannot reproduce;
- a `sources:` block that does not read, including a source naming no notices,
  and a source entry nothing in the manifest names.

The published `telo.yaml` carries no `sources:` block. It is removed, as
`include:` is, before any dependent derives its pin from the text, so editing only
a source's `url` — a moved mirror, the same bytes — moves no digest and bumps
nothing. Each source's notice files ship in the `common` layer, and a staged
file an `assets:` pattern selects in the `assets` layer, with no `files:` entry.

A `LICENSE` file at the module root ships in the `common` layer the same way, so
the artifact carries the text `metadata.license` names. Keep it beside
`telo.yaml`: a license file in a parent directory is outside the module and is
not published. `telo package` carries it into a packaged application too.

## npm packages

`@telorun/kernel`, `cli`, `sdk`, `analyzer` and the other infrastructure
packages own no module manifest and stay on **changesets**. Every package under
`modules/*/nodejs/` is on the module ledger instead — its version is its
module's, written by `telo release apply` — and is listed in
`.changeset/config.json`'s `ignore` so the two systems never write the same
field.

Most of those packages are private: the controller is bundled into the module
artifact, so nothing is fetched at load and there is no tarball to push. A module
that cannot be bundled — one whose driver resolves a native binary relative to
its own package directory — names `pkg:npm/<name>@<version>` in `controllers:`
instead, and that tarball has to exist for any consumer outside this checkout.

**`telo publish` pushes it**, before the manifest that names it, and skips it
when npm already has that exact version. It is the same step `--skip-controllers`
turns off. Being on the module ledger, the pin, the package and the module all
carry one version: `telo release apply` rewrites the module's own `pkg:npm` pin
along with `metadata.version`, and publish refuses when the three disagree rather
than shipping a manifest that names a tarball nobody has. That is the failure
this closed — an npm-delivered module went on pointing at a years-old version of
itself after its package moved to the module ledger and no publisher took over.
