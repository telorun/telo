---
status: approved
priority: medium
depends-on: []
packages: [analyzer/nodejs, kernel/nodejs, cli/nodejs, scripts, packages/editor-protocol, packages/language-host, packages/language-server, packages/ide-support, apps/hub, apps/studio, apps/authoring-agent, docs]
---

# Measured floors and post-publish restrictions

## Problem

**The floor is a guess.** A module adopting new syntax writes `requires: telo: ">=X"`, where `X` is the last published telo plus the strongest pending changeset bump at the moment of writing. That number goes wrong three ways:

- a release lands while the branch is open, and after a rebase `X` names a published release that lacks the syntax — caught only when that CLI rejects the file statically;
- a stronger bump lands later, and `X` names a version that is never published;
- no telo-line changeset is pending yet, so `X` is the current version and the edge check reports it passed without running anything.

**A published range cannot be amended.** A published `telo.yaml` is fixed: consumer pins hash it, and publish refuses different bytes at the same version. Publishing a patch with an upper bound does not help: `telo upgrade` walks newest-first, skips the bounded patch and selects the older open-ended version — the broken one.

## Solution

Two mechanisms, split by what each bound protects:

- **The floor stays in `requires.telo`, and tooling computes it.** It rises only when the module's own bytes need it. Every number is either measured against a published release or written by the step that creates the release.
- **Ceilings move out of the manifest into restrictions**: small OCI artifacts attached to a published module version, which may only narrow its range. The CLI reads them from the registry, every editor host through the manifest caches.

### The floor

**Grammar.** `requires.telo` is floor-only.

- It is `">=<version>"` or `">=next"`. `next` means "the telo release that carries the pending telo-line changesets".
- An upper bound in a module's own source is `REQUIRES_INVALID`, and its message names `telo module restrict`. An upper bound in an already-published manifest is still read and honoured.
- An `X+unreleased` build satisfies `next`. A released telo answers `MODULE_REQUIRES_NEWER_RUNTIME` for it.
- Editor `auto` version selection treats `next` as satisfied only by an unreleased engine.

**`telo release floor [--module <dir>]`** writes the floor of each workspace module. Modules are measured in import order, siblings first, so a dependent sees its sibling's new floor.

1. A module whose floor is `next` is left alone.
2. If the published `@telorun/cli` at the current floor accepts the module (`telo check`, with the same attributable-output rule the edge check uses today), the floor is unchanged.
3. Otherwise the floor becomes the lowest published release that accepts the module. It is found by binary search over published, non-prerelease versions between the current floor and the latest; support only grows in newer versions.
4. If no published release accepts it, the floor becomes `>=next`.
5. A module declaring no floor is searched from the oldest published CLI that accepts a `requires:` block. That version is a constant, found once by execution during implementation.
6. The manifest is measured as it will be written, with the candidate floor in place.
7. A floor is never lowered.
8. If the registry cannot be reached, or a run cannot be attributed to the manifest, the command fails and writes nothing.

**`telo release check`** runs the same measurement without writing. It fails with `REQUIRES_FLOOR_STALE` when a module's floor differs from the computed one, naming the computed value and `telo release floor`. This replaces today's "refuted" outcome for a floor that is too low. For a `next` module that the latest published CLI already accepts, it prints one informational line, because such a floor is needed by nothing the static check sees.

**The version step** (`version-packages`, after `changeset version`) rewrites every `>=next` in the workspace's module manifests to the version it just assigned the telo line, splicing the text so the layout is kept. The rewritten modules then move on the module track as usual.

**`telo publish`** refuses a manifest whose floor is `next` or that declares an upper bound. It keeps the existing preflight that runs the CLI at the floor, which is the only verification a third-party author outside a release workspace gets. Those authors keep writing floors by hand, against released versions, as they do today.

**The one hand-written case.** A requirement the static check cannot see, such as a controller relying on newer kernel behaviour while an old analyzer reads the manifest silently, is raised by hand to `>=next`. It is never a number, and measurement never lowers it.

### Restrictions

**Shape.** A restriction is an OCI artifact manifest pushed into the module version's repository:

- artifactType `application/vnd.telo.restriction.v1`;
- `subject`: the published version's OCI manifest digest;
- config and its single layer: the OCI empty descriptor;
- annotations:
  - `run.telo.restriction.telo` — a range in the `requires` comparator grammar (`<0.120.0`, `>=0.125.0`, or both). Absent on a pure retraction.
  - `run.telo.restriction.reason` — required, shown to whoever is held back.
  - `run.telo.restriction.supersedes` — optional: the digest of one earlier restriction of the same subject.

**Meaning.**

- The active restrictions are those no other restriction of the same subject supersedes.
- A version's effective range is its manifest range narrowed by the range of every active restriction.
- A restriction can only narrow, so nothing can widen past the range verified at publish. Superseding an active restriction retracts it, and superseding a retraction reinstates what it retracted.

**Discovery.** Through the OCI 1.1 referrers endpoint, falling back to the referrers tag schema (a `sha256-<hex>` tag holding an index) when the registry has no endpoint. GHCR is expected to need the fallback.

**`telo module restrict <ref> [--versions <range>] --telo <range> --reason <text>`** pushes one restriction per selected published version: the version in `<ref>`, or every published version in `--versions`. `--retract <restriction digest> --reason <text>` pushes a superseding restriction with no range. `--dry-run` and `-o json` behave as they do for `telo publish`.

It refuses:
- a bound that names no published `@telorun/cli` version;
- a range that does not narrow the version's current effective range ("changes nothing");
- a range that would leave the version usable by no telo (deprecate the module instead);
- a `--retract` naming nothing active on that subject.

On the tag fallback it updates the index by read-modify-write. Concurrent restricts of one version are not supported.

**The load gate.** The analyzer's requires reader takes a version's restrictions beside its manifest and computes the effective range: one function, used by the CLI, the kernel, the editor engine and `telo upgrade`.

- Running above a ceiling (from a restriction, or from an already-published manifest's upper bound) is `MODULE_INCOMPATIBLE_WITH_RUNTIME`, an error that names the reason and advises an older telo or another version of the module.
- A restriction raising the floor gives `MODULE_REQUIRES_NEWER_RUNTIME`, with the restriction's reason in the message.
- Both suppress the module's other diagnostics, as today's gate does.
- Today a runtime above an upper bound gets `MODULE_REQUIRES_NEWER_RUNTIME` and "Upgrade telo". That wording is replaced by the new code.

### Where restrictions are read

**One file in both caches.** Every cached module version gets `.telo-restrictions.json` beside its `telo.yaml`, at the existing cache key layout's version directory, in the hub's bucket and in the local `.telo/manifests/` alike.

- Contents: `{ "restrictions": [{ "digest", "telo"?, "reason", "supersedes"? }] }`, sorted by digest.
- It is written for every version, an empty list included. A missing file means unknown, and unknown is never incompatible.
- `telo publish` refuses a module with its own file at that name, as it refuses one named after a `.siblings.json` sidecar.

**The CLI and kernel.**
- `telo install`, `telo upgrade` and cache revalidation read restrictions from the registry with each manifest and write the file.
- `telo upgrade` reads each candidate's restrictions from the registry, and its held-back report names the reason.
- `telo run` and `telo check` read the cached file, so the gate needs no network. A packaged application carries the file in its payload's `cache/`.
- A change to the file invalidates the cached analysis verdict, so a stamp can never skip a new restriction.

**`telo module versions --digests`** reports each version's `restrictions` (the same list). The hub's ingest reads them from there, still one process per module.

**The hub** writes `.telo-restrictions.json` for every tracked version on each tracking pass when its content changed, served with `Cache-Control: max-age=300`. A version's `telo.yaml` stays immutable.

**Editor hosts and Studio.** The engine is I/O-free, so restrictions cross the editor protocol as a new host-served request, added within generation 2 and advertised by capability:

- `telo/restrictions` `{ ref }` → the version's restriction list, or `null` when unknown.
- Browser hosts (Studio web, through its configured manifest-cache base) serve it from the bucket file.
- Node hosts serve it from `.telo/manifests/`, then the registry.
- An engine whose host does not advertise it treats every version as unknown.
- Upgrade affordances, version pickers, editor `auto` selection and the engine's load gate all read the effective range through it.
- Local and unpublished modules have no restrictions.

## Delivery

- Run `telo release floor` once over the workspace in this change. Every module whose floor moves, or which gains one, gets a `Fixed` fragment through `telo release add`.
- Changesets: one for the telo line (analyzer, kernel, cli, ide-support, language-server), plus `@telorun/editor-protocol`, `@telorun/language-host` and `@telorun/studio`. The hub releases on its own track.
- Docs:
  - `docs/extend/declaring-runtime-requirements.md` is rewritten around measured floors, `next` and restrictions.
  - `docs/extend/releasing-modules.md` gains `telo release floor`.
  - `packages/editor-protocol/README.md` gains `telo/restrictions`.
- Guides:
  - The root `CLAUDE.md` § Changing the grammar becomes "run `telo release floor`", and § Declared runtime requirements is updated.
  - The analyzer and CLI guides' `requires:` sections are updated.
  - The authoring-agent primer's `requires:` passages, and the hub's library-design guide where it mentions `requires:`, are updated.
- Benefits ledger: the existing "Runtime requirements" entry is extended. Floors are computed for you, and a published version can be restricted after the fact without a new release.
- Polyglot debt: `cli/rust` owes `telo release floor` and `telo module restrict` as it owes `telo publish`. The Rust kernel reads no `requires:` today, so it is unaffected.

## Verify

**Floor**
- A module adopting unreleased builtins syntax: `telo release floor` writes `>=next`. `telo release check` passes. The npm Version PR rewrites it to the same version it gives `@telorun/cli`.
- Rebasing that branch over an unrelated release changes nothing.
- A description-only change leaves the floor alone. `telo release check` on an unchanged module costs one CLI run per distinct floor.
- A floor set too low by hand fails `telo release check` with `REQUIRES_FLOOR_STALE` and the computed value.
- A dependent of a sibling at `>=next` is measured to `>=next`.
- `telo publish` refuses `>=next` and refuses an upper bound. `telo check` reports an upper bound in a module's own source as `REQUIRES_INVALID`.
- An already-published manifest declaring an upper bound still refuses a telo above it, with `MODULE_INCOMPATIBLE_WITH_RUNTIME`.

**Restrictions**
- Publish a version with `>=0.80.0` and `telo module restrict` it `<0.120.0`.
  - On telo 0.120, `telo upgrade` skips it and names the reason.
  - A run of an app pinned to it fails with `MODULE_INCOMPATIBLE_WITH_RUNTIME` after the next `telo install`, and offline from the cached file.
  - Its `telo.yaml` pin is unchanged, existing installs still verify, and nested-library references into the artifact still resolve.
- Retract it: the version is selected again. Supersede the retraction: it is held back again.
- `telo module restrict` refuses a range that changes nothing, an empty range and a bound naming an unpublished telo.
- Against `ghcr.io`, the restriction is pushed and discovered through the tag fallback.

**Hub and editors**
- After the hub's next pass, `https://manifests.telo.sh/oci/<host>/<repo>/<version>/.telo-restrictions.json` lists the restriction.
- Studio web on telo 0.120 does not offer the version and shows the gate diagnostic on an existing pin.
- With the file deleted, Studio treats the version as unknown and offers it.
- A packaged application built after a restriction carries the file and refuses at start, with no network.
