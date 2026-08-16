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
modules:
  - modules/*
  - apps/*
```

`modules:` names the subtrees that may hold modules. That is not derivable — a
whole-tree scan would read every example, template and cached
`.telo/manifests/**` copy as a released module.

**The file is optional, and `telo release` is the only thing that reads it.**
`run`, `check`, `publish`, `install`, `upgrade`, `migrate` and `module` behave
identically without one, and the kernel never looks for it. A single-manifest
repo, a bare `examples/` directory and a third-party module checkout all keep
working with nothing added.

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
The graph is what says a `Fixed` on `modules/sql` makes `modules/sql-sqlite` a
`Fixed` too. And the changed-files rule — which used to decide the version, and
whose guesswork therefore had to be sound — now only asks for prose, so a false
positive costs one sentence rather than a spurious republish.

Edges come from two places:

- **Inlined files**, read from the controller build's own **metafile**. A
  declared-dependency graph cannot see `--external`, so `@telorun/sdk` (declared
  by 54 modules, inlined by none) would otherwise bump the whole standard
  library on every SDK change.
- **In-repo relative `imports:`**. A pinned registry ref is deliberately *not* an
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
registry: oci://ghcr.io/telorun
modules:
  modules/sql:
    version: 0.21.0
    layers:
      manifest: sha256-4f1c…
      controller/js: sha256-9ab7…
```

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

One key is deliberately outside that reconciliation. The `manifest` digest is
**locally derived and unverifiable**: the published `layers:` index lives inside
`telo.yaml`, so it cannot carry that file's own digest, and hashing what the
registry serves would not match either, because the transport injects the index
at push time. It stays in the ledger regardless — it is the only thing that sees
a **manifest-only change** (a schema edit, a new kind, a dependency's version
moving into a pin), none of which touch a controller byte. So `verify` compares
and rewrites the layers the registry can answer for and preserves that one;
`apply` is what writes it.

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
- digests taken against a different registry base.

It *warns* — `CHANGELOG_ENTRY_REQUESTED` — when a module's own files changed and
no fragment names it.

`apply` writes the new version into every manifest the module owns
(`telo.yaml`, `nodejs/package.json`, `rust/Cargo.toml`), appends to each
changelog, re-records the ledger with the digests of what will actually be
published, and deletes the fragments it consumed. Version rewriting is a
byte-splice over the author's own text, so a bump lands as a one-line diff
rather than a re-serialized file.

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

## npm packages

`@telorun/kernel`, `cli`, `sdk`, `analyzer` and the other infrastructure
packages own no module manifest and stay on **changesets**. Every package under
`modules/*/nodejs/` is on the module ledger instead — its version is its
module's, written by `telo release apply` — and is listed in
`.changeset/config.json`'s `ignore` so the two systems never write the same
field.
