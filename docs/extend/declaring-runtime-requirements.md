---
sidebar_label: Runtime Requirements
slug: /extend/declaring-runtime-requirements
description: "Declare the Telo and Node versions a module runs on with requires: and restrictions:, so an older or newer runtime reports one clear error instead of blaming the module's syntax, and telo upgrade never selects a version your runtime cannot host."
---

# Declaring runtime requirements

A module declares the runtimes it runs on in two top-level blocks:

```yaml
kind: Telo.Library
metadata:
  name: SQL
  version: 0.9.0
requires:
  telo: ">=0.80.0"
  host:
    node: ">=20.0.0"
restrictions:
  - requires: { telo: "<0.122.0" }
    reason: Query never returns on telo 0.122.0 and later; a fix ships in 0.10.0.
```

- **`requires:`** is what must hold before the manifest can be read at all. Its `telo` bound is a
  **floor, measured by tooling**. Its `host.node` bound may have both ends.
- **`restrictions:`** is everything an author knows that measurement cannot see, each entry with a
  reason: a ceiling found after publishing, a floor the static check cannot see, a Node bound found
  later.

## Why

Telo closes every extension vocabulary and rejects an unknown token. That is right for a typo and
wrong for a version: both are "a string I do not recognise". So when a module adopts new syntax, an
older runtime rejects it *and blames the module's author*: an unknown `use` token, an object where a
zone annotation expects a pointer, an unexpected key on a built-in schema. Every one of those
messages is true and none names the actual cause.

Declaring the range turns that into one `MODULE_REQUIRES_NEWER_RUNTIME` naming the cause, and
`telo upgrade` stops selecting versions your runtime cannot host. The editor's Imports view and the
VS Code import lenses use the same rule: they offer the newest version your Telo can host, name
any newer one that was held back with its reason, and mark rather than hide versions that need a
different Telo when you pick one deliberately. A candidate that cannot be read or reached is never
treated as incompatible.

## The floor is measured, never written

In a release workspace nobody types `requires.telo`. Run:

```console
$ telo release floor
modules/geocode: (none) → >=unreleased (no published telo accepts it; 0.120.3 reports SPAN_ATTRIBUTE_MISPLACED at telo.yaml:25)
modules/geocode-cache: >=0.118.0 → >=unreleased (imports modules/geocode at >=unreleased)
modules/kv-store: >=0.112.0 unchanged
modules/console: >=0.80.0 → (none) (accepted by 0.77.0, the oldest telo that reads requires:)
```

Each module is checked as a copy by published `telo check` runs, and its floor is the lowest
published telo release that accepts it. It is one of three values:

- **`>=<version>`** — the lowest published telo that reads the module's syntax.
- **`>=unreleased`** — no published telo reads it yet: the module adopts syntax that is still
  pending. A released telo answers `MODULE_REQUIRES_NEWER_RUNTIME`; a build of the unreleased
  telo (`X+unreleased`) satisfies it. When the release branch's release PR versions the telo line, `telo release apply`
  (candidate or final) rewrites every `>=unreleased` in the workspace's manifests to the
  surface of the version it gave the telo line. A `>=unreleased` in a plan that moves no telo
  version fails `telo release check`: no release would carry the syntax it waits for.
- **absent** — every telo that reads `requires:` accepts the module, so a floor would protect
  nobody. A floor-less module is correct, not incomplete.

No published telo checks a sibling's `requires:`, so a module's floor is the highest of its
measured one and the floors of every workspace sibling it imports by relative path, transitively
(`>=unreleased` is the highest, no floor the lowest); modules are measured siblings first so the
sibling's new floor is known. If the registry cannot be reached, or a run cannot be attributed to
the manifest (a fetch of an import that failed says nothing about it), the command fails and
writes nothing.

`telo release check` verifies without writing: the CLI at the floor accepts, the release just below
it rejects (a floor equal to the highest floor among its siblings is correct though the release
below accepts), and a floor-less module is accepted by the oldest telo that reads `requires:`. A
registry that cannot be reached, or a run that cannot be attributed, fails the command with the
cause printed. It fails
with `REQUIRES_FLOOR_TOO_LOW` (the floor is below the measured one, or missing) or
`REQUIRES_FLOOR_TOO_HIGH` (a `>=unreleased` that a published release now accepts, a number raised
by hand, a floor nothing needs), each naming the measured value. After a rebase over the release that
carries your syntax, the check tells you to run `telo release floor` again.

`telo publish` refuses a manifest holding `>=unreleased` anywhere: publish after the telo release
that carries it. It also runs the published CLI at the floor, which is the only verification an
author outside a release workspace gets; those authors write their floors by hand, against
released versions.

## The grammar

`requires.telo` is **floor-only**: `">=<version>"` or `">=unreleased"`. An upper bound on `telo` in
a module's own source is `REQUIRES_INVALID`, and its message names the `restrictions:` entry to
write instead. `requires.host.node` keeps both bounds. Bounds use explicit comparators:

- **`^` and `~` are rejected.** Pre-1.0 both allow a single minor, and Telo ships breaking changes
  as minors, so the caret reading is correct and useless. Write `>=0.40.0`.
- **A bare version is rejected.** Semver reads `0.80.0` as an exact pin.
- **`||`, hyphen ranges and wildcards are rejected.**
- **An upper bound must name a version that already exists.** Predicting a future break is a claim
  nobody can make honestly.

A published manifest that still carries a `telo` upper bound from before this rule is read as it
was written, and honoured as a restriction covering that version only.

## Restrictions

An entry has three keys:

- `versions` — optional. A range of the module's own versions in the same comparator grammar. A
  version speaks for itself and earlier ones, never for a later one: a range with no upper bound is
  closed at the declaring document's own version, so `">=1.2.0"` means "1.2.0 through this
  version". An explicit upper bound above the current `metadata.version` is refused. Without
  `versions`, the entry covers only the declaring version.
- `requires` — the same shape as `requires:`, stating at least one bound. Floors and ceilings are
  both allowed; `>=unreleased` is allowed only as a `telo` floor.
- `reason` — required, shown to whoever is held back.

A malformed entry, or one that leaves the declaring version usable by no runtime, is
`RESTRICTIONS_INVALID`, refused by `telo check` and by the kernel at load.

**A floor measurement cannot see.** `CachedLookup` keeps its cache across a reload, which only the
unreleased kernel supports. Static checking accepts the module on 0.121.0, so the measured
`requires.telo` stays `>=0.121.0`, and the author states the requirement as an entry:

```yaml
requires:
  telo: ">=0.121.0"
restrictions:
  - requires: { telo: ">=unreleased" }
    reason: CachedLookup keeps its cache across a reload, which kernels before this release drop on every reload.
```

```console
$ telo run ./telo.yaml    # on telo 0.121.0
error MODULE_REQUIRES_NEWER_RUNTIME GeocodeCache requires telo '>=unreleased'; this runtime reports 0.121.0. Reason: CachedLookup keeps its cache across a reload, which kernels before this release drop on every reload. Upgrade telo.
```

Measurement replaces every bound inside an entry (a `telo` bound by the candidate floor, a host bound
by `>=0.0.0`) while keeping its keys, so `requires.telo` is the static floor alone, and syntax used
inside an entry still counts. The version step rewrites a `>=unreleased` inside an entry the same
way it does in `requires:`.

**A ceiling found after publish.** A published `telo.yaml` is fixed, so you cannot amend it. You
publish a later version whose entries cover the broken ones. See
[Releasing modules](./releasing-modules.md#restricting-a-published-version).

### What a restriction means

- **At load**, a version's range is its own `requires` narrowed by its own entries that cover it.
  The gate reads only the pinned version's own bytes, so a pinned run stays deterministic and
  works offline; a restriction a later version adds never breaks an installed pin.
- **At selection** (`telo upgrade`, the editor's lenses and version pickers), a candidate's range
  is also narrowed, per key (`telo`, `host.node`), by the covering entries of the newest *newer*
  published version that states that key. A prerelease's entries speak for no version: they are read only with `telo upgrade --include-prerelease`, and a restriction first published in a release candidate takes effect when the final repeats it.
- **Omitting** an entry from a later version lifts nothing. **Lifting** is stating the key again
  from a later version, with an entry covering the same versions.

Running above a ceiling is `MODULE_REQUIRES_OLDER_RUNTIME`, naming the reason and advising an older
runtime or another version of the module. Running below an entry's floor is
`MODULE_REQUIRES_NEWER_RUNTIME` with the entry's reason. Both suppress the module's other
diagnostics.

## Host axes

Requirements on the machine rather than on Telo nest under `host:`:

```yaml
requires:
  telo: ">=0.85.0"
  host:
    node: ">=20.0.0"
```

**`node` is the only host axis today, and that is deliberate**: an axis exists only once something
compares it. A declared requirement nothing checks is worse than none. Writing another is reported
as an unknown axis.

They are nested because `nodejs` and `rust` are already *kernel labels* elsewhere in Telo (an
`imports:` entry's `runtime:`), so a top-level `node:` would read as the Node kernel rather than the
Node.js runtime.

A host axis is asserted by you and compared against the version the running host reports; an
`host.node` bound or a Node ceiling in `restrictions:` is yours to state, since no measurement sees
it. An IDE checks neither host axis, because it is not the host; a host requirement it cannot judge
still surfaces at the load gate when the manifest runs.

`telo` is always checked first, so an axis introduced in a later Telo never has to be interpreted by
an older one.

## One scale, every kernel

`telo` names the **manifest surface generation** a runtime implements: one scale reported by the
Node kernel, the Rust kernel and any future kernel alike. The runtime packages (`@telorun/sdk`,
`@telorun/cel`, `@telorun/message-format`, `@telorun/templating`, `@telorun/analyzer`,
`@telorun/kernel`, `@telorun/cli`, `@telorun/ide-support` and `@telorun/language-server`) are
released together at one version, and their Rust twins carry the same number. So `>=0.100.0` means
telo 0.100.0 whichever of them you look at: the CLI that measures, the kernel that loads the module,
and the editor engine checking it as you type.

A kernel that implements only a *subset* of a generation claims none and skips the check. The Rust
kernel reads no `requires:` today.

## In the editor

Editors read the same ranges to decide which telo a module is edited against (the `telo.version`
setting's `auto`): a module declaring `requires: telo:` is edited against the lowest available
version its own range and its imports' ranges accept; a module declaring none stays on the editor's
bundled version when its imports accept that, else moves to the lowest version they all accept; and
when nothing satisfies them, the bundled version runs and its load gate names the module that
refuses it. `>=unreleased` is satisfied only by an unreleased engine, so the bundled engine is used.
See [Editing against a telo version](../guides/editor-telo-version.md).

## Who declares

**Libraries in a release workspace** get their floor from `telo release floor` and add
`restrictions:` for what it cannot see. **Applications** may carry the block too and should when
distributed: it buys a version-attributed message for their operators, not a contract anyone
resolves against.

A module that declares nothing carries no requirement. That is correct whenever the oldest telo
that reads `requires:` accepts it.

The block itself needs a Telo new enough to recognise it: module documents are closed schemas, so a
manifest declaring `requires:` or `restrictions:` is a schema error on any Telo released before the
block existed.

## What this is not

`requires:` is what must be true **before Telo can run the manifest at all**. A tool the *work*
depends on, such as ffmpeg or a headless browser, is a different thing: unverifiable, unbounded, and
carrying a per-platform install action. That belongs in a resource kind provisioned through
`telo install`.

It also does not make anything work. An old runtime cannot execute semantics it lacks; this makes
the failure early, singular, and correctly attributed.
