---
sidebar_label: Runtime Requirements
slug: /extend/declaring-runtime-requirements
description: "Declare the Telo versions a module is verified against with a requires: block, so an older runtime reports one clear MODULE_REQUIRES_NEWER_RUNTIME instead of blaming the module's syntax, and telo upgrade never selects a version your runtime cannot read."
---

# Declaring runtime requirements

A module declares which versions of Telo it is verified against, in a top-level
`requires:` block:

```yaml
kind: Telo.Library
metadata:
  name: SQL
  version: 0.9.0
requires:
  telo: ">=0.80.0"
```

## Why

Telo closes every extension vocabulary and rejects an unknown token. That is right
for a typo and wrong for a version — both are "a string I do not recognise", and the
checker cannot tell them apart. So when a module adopts new syntax, an older runtime
rejects it *and blames the module's author*: an unknown `use` token, an object where a
zone annotation expects a pointer, an unexpected key on a built-in schema. Every one of
those messages is true and none of them names the actual cause.

Declaring the range fixes both halves. `telo upgrade` stops selecting versions your
runtime cannot read, and when you reach one anyway — a hand-written pin, a ref copied
from the hub — you are told exactly that, instead of meeting a schema error inside a
module you do not own.

The same rule drives every upgrade affordance in an IDE: the Telo editor's Imports view
and the VS Code import lenses read each candidate version's own `telo.yaml`, newest
first, and offer the newest one your Telo can host. A newer version that was held back
is named along with the reason, so a pin never becomes a silent ceiling; a version list
offered for a deliberate pick still shows every version, marking the ones that need a
newer Telo rather than hiding them. A candidate that cannot be read or reached is never
treated as incompatible.

## The grammar

Each axis is a semver range, and **every bound must be testable**.

- **`^` and `~` are rejected.** Pre-1.0 both allow only a single minor (`^0.40.0` is
  `>=0.40.0 <0.41.0`), and Telo ships breaking changes as minor bumps deliberately — so
  the caret reading is correct and useless: it pins your module to one release
  generation. Write `>=0.40.0`.
- **A bare version is rejected.** Semver reads `0.80.0` as an exact pin, which is the
  same trap in a different costume.
- **`||`, hyphen ranges and wildcards are rejected.** Verification runs the CLI *at* the
  range's lowest and highest bound, and a disjunction has neither.
- **An upper bound must name a version that already exists**, checked when you publish.
  Predicting a future break is a claim nobody can make honestly.

Open above is the normal shape. A closed bound earns its place in one case: a module
known broken on a newer Telo that will not be fixed. Publishing a patch bounded below
that release makes `telo upgrade` report *no compatible version* rather than handing a
consumer a confusing failure.

## Host axes

Requirements on the machine rather than on Telo nest under `host:`:

```yaml
requires:
  telo: ">=0.85.0"
  host:
    node: ">=20.0.0"
```

**`node` is the only host axis today, and that is deliberate**: an axis exists only
once something compares it. A declared requirement nothing checks is worse than none
— it validates, it reads as protection, and it protects nobody. `rustc` arrives with
the slice that builds controller crates and can compare it; until then, writing it is
reported as an unknown axis rather than silently accepted.

They are nested because `nodejs` and `rust` are already *kernel labels* elsewhere in
Telo (an `imports:` entry's `runtime:`), so a top-level `node:` would read as the Node
kernel rather than the Node.js runtime. Position disambiguates where no word can.

The tiers also differ in how they are established: `telo` is verified by running the
CLI, while a host axis is asserted by you and compared against the version the running
host reports. An IDE checks neither host axis, because it is not the host — it speaks
for the Telo surface and nothing else, and a host requirement it cannot judge still
surfaces at the load gate when the manifest actually runs.

`telo` is always checked first. That is what keeps the block extensible: a module using
an axis introduced in Telo 0.85 also requires `telo: ">=0.85.0"`, so an older runtime
fails on the version and never has to interpret an axis it has never heard of.

## One scale, every kernel

There is no separate range per kernel. `telo` names the **manifest surface generation** a
runtime implements — one scale reported by the Node kernel, the Rust kernel and any
future Go kernel alike, independent of each one's own crate or package version. Writing
bounds per kernel would restate one fact several times, and would ask you to assert
things about kernels you have never run.

A kernel that implements only a *subset* of a generation claims none and skips the check.
A version expresses *older*, not *smaller*.

## Verifying it

The claim is verified by running the CLI at each edge of your declared range:

```
npx @telorun/cli@0.80.0 check modules/sql/telo.yaml
```

Green means the declaration is true; red at the low edge means you adopted syntax that
version cannot read. Two edges bound the whole range rather than sampling it, because
syntax support is monotonic — a construct added in 0.43 works in 0.44 and later. For a
range open above the high edge is HEAD, which your ordinary check already covers.

This runs automatically in two places:

- **`telo publish`** — as a preflight, so a published range is a verified one. A refuted
  range is fatal; a CLI that could not be installed warns, since an unverified claim is
  not a disproven one and blocking a publish on registry reachability trades one failure
  for a worse one.
- **`telo release check`** — over every module in the workspace, batched by edge, so a
  standard library declaring one or two distinct lower bounds costs one or two runs.

In a workspace where modules import siblings by relative path, propagation is automatic:
when a sibling adopts new syntax, every dependent fails its own edge check until its
range moves too.

### Declaring a release that has not happened yet

Adopting new syntax means declaring the version that will carry it — which, on the commit
that does so, is not published. That is the expected state, not a mistake, and it is
reported as its own outcome rather than as a failed install:

```
·  telo 0.79.0  1 module pending — not published yet (latest: 0.78.0)
```

No CLI is fetched: an unpublished version has one possible outcome, and npm's `ETARGET`
arrives wrapped in install noise indistinguishable from being offline. The latest
published version is printed beside the bound because that is what makes a **typo**
visible — `>=0.790.0` next to a latest of `0.78.0` reads wrong at a glance, where "could
not run" would read the same for a typo and for tomorrow's release.

`pending` is informational in `telo release check` and **fatal in `telo publish`**. The
asymmetry is the release order: npm publishes before modules do, so by the time a module
is pushed its declared floor exists. If it does not, the release is out of order, and the
module would land at the registry declaring a minimum no runtime can satisfy — which
every consumer's `telo upgrade` would then refuse.

Two things this does not cover. A version *below* the latest that is nevertheless absent
(yanked, never published) still reports as "could not run": that is honest, and guessing
at why it is missing would be a second rule with nothing behind it. And when npm cannot
be reached at all, nothing is classified — a guess about what exists is worse than the
run's own verdict.

## Who declares

**Libraries declare always, and open above.** The lower bound moves only when
verification forces it, so the standing value is whatever release the module was last
verified against — read it as *"the oldest runtime we support and test"*, not *"the
oldest that would technically work"*.

**Applications may declare, and should when distributed** — a template, an example, a
deployed app. An application has no importer, so its block buys a version-attributed
message for its own operators plus the CI check, rather than a contract anyone resolves
against. It is not derivable from its imports: an app's *own* syntax is visible nowhere
else.

A module that declares nothing carries no requirement. That is permanent for everything
published before this mechanism existed, and correct — none of it uses syntax that did
not yet exist.

One caveat worth knowing: the block itself needs a Telo new enough to recognise it. Module
documents are closed schemas, so a manifest declaring `requires:` is a schema error on any
Telo released before the block existed. That is the one break this mechanism cannot explain
away — and from here on it is what explains every other one.

## What this is not

`requires:` is what must be true **before Telo can run the manifest at all**. A tool the
*work* depends on — ffmpeg, a headless browser — is a different thing: unverifiable,
unbounded, and carrying a per-platform install action. That belongs in a resource kind
provisioned through `telo install`, not here.

It also does not make anything work. An old runtime cannot execute semantics it lacks;
this makes the failure early, singular, and correctly attributed.
