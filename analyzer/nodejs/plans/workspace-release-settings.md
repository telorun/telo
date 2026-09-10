# Workspace settings — per-subtree `release:`, and an `env:` block

## Problem

`telo-workspace.yaml` carries one field, `modules:`, and everything else `telo
release` needs is either a constant compiled into the CLI or a value that reaches
it from outside the workspace. Four consequences, all measured.

**A workspace cannot publish to more than one destination.** A module's ref is
`<registry>/<its own directory name>`, and the base is one per workspace —
`--registry`, `TELO_OCI_REGISTRY`, or the one the ledger recorded. So a repo whose
modules publish under different bases has to be split into several workspaces,
one per base. The integrations repo is split four ways for exactly this: four
`telo-workspace.yaml` files with identical bodies, four `.changes/` directories,
four ledgers recording `oci://ghcr.io/telorun/{aws,google,jetbrains,rancher}`.
The four copies have already drifted — three of them still cite the `aws` example
in their header comment, unedited from whichever was copied first.

Splitting also splits three things that are not release concerns, because the
marker's location anchors all of them: the `.telo` cache (four caches in one repo,
so every shared dependency is fetched and stored four times), the bound on `telo
run`'s `.env` / `.env.local` walk-up, and module keys.

**Which paths inside a module are not worth a changelog line is a compiled-in
constant, and it is anchored wrong.** The set is `docs/`, `plans/`, `tests/`,
`README.md`, `CHANGELOG.md`, matched against the module-relative path with the
pattern anchored at the module root. A module that nests any of them one level
deeper is not matched, so a test-only edit is reported as a semantic change and
`CHANGELOG_ENTRY_REQUESTED` asks for prose describing something no consumer can
observe. Nine modules in this repo keep a vitest suite at `nodejs/tests/`; one app
keeps its manifests at `chat/tests/`; the integrations repo has the same shape at
`aws/lambda/nodejs/tests/`. All of them are flagged today. Widening the constant
fixes those and leaves the second half: the set is this repo's layout convention
shipped to every Telo workspace, and a workspace that keeps specs in `spec/`, or
ships its docs inside its artifact, has no way to say so.

**One module's destination is asserted in three places, and only the tree's shape
keeps them agreeing.** Discovery assigns `<base>/<directory name>`. The payload
builder derives a relatively-imported sibling's by applying the import path to the
*importer's* destination, and refuses outright a module claimed twice with
different answers. The module publisher re-derives
`$TELO_OCI_REGISTRY/<directory name>` in a shell script of its own. All three
agree today only because every module that relatively imports another sits beside
it at the same depth under one base. Give a subtree its own base and the first two
disagree on the first cross-subtree import; the third does not disagree at all —
it silently publishes everything to one base.

**A field that only one command reads sits at the top level, so every other
consumer has to fabricate it.** The runner seeds a marker into every session
workspace purely to anchor the `.telo` cache, and writes `modules: ["*"]` with a
comment saying so: release scope, read by `telo release` alone, which never runs
in a session — written anyway because an empty list is a parse error, and a file
this repo's own tooling would reject is not one to seed into a user's workspace.
Both backends ship that fabricated line into every session.

## The shape

```yaml
# telo-workspace.yaml — the anchor. Its LOCATION is what module keys, ledger
# entries and fragment paths are measured from, and where the `.telo` cache
# lives. Every FIELD lives in a block scoped to what it governs.

release:
  # Defaults for every module below; an entry may override any of them.
  registry: oci://ghcr.io/telorun
  ignore:
    - "**/tests/**"
    - "**/docs/**"
    - "**/plans/**"
    - "**/README.md"
    - "**/CHANGELOG.md"

  # The subtrees that may hold modules — a place to look, never a module: what
  # makes a directory a module is its `telo.yaml`. One gitignore-style list, so
  # the LAST entry matching a module is where its settings come from. A bare
  # string is an entry with no overrides.
  modules:
    - modules/*
    - apps/*

    - path: vendor/aws/*
      registry: oci://ghcr.io/telorun/aws

    - path: vendor/acme/*
      registry: oci://registry.acme.internal/platform
      ignore:
        - "**/tests/**"
        - "**/__snapshots__/**"
        - "spec/**"

env:
  # How far up `telo run` walks collecting env files. Gitignore-style,
  # workspace-relative, matched against each ancestor DIRECTORY as the walk
  # climbs; the nearest match stops it. Absent: the walk stops at this file,
  # which is what it does today.
  roots:
    - vendor/*

  # Which files it collects in each directory, later winning. Absent: the two
  # below, which is what is hardcoded today. Filenames, never paths.
  files:
    - .env
    - .env.local
```

`modules/ai` publishes to `ghcr.io/telorun/ai` and ignores the `release:` block's
own set. `vendor/aws/s3` publishes to `ghcr.io/telorun/aws/s3` and inherits that
same set, because its entry declares only `registry:`. `vendor/acme/billing`
publishes to `registry.acme.internal/platform/billing` and ignores only its own
three, so a `docs/` edit there does ask for a fragment.

## One rule for the whole file

**Its location is the anchor, and every field lives in a block scoped to what it
governs.** `release:` is what `telo release` reads — where modules are, where they
publish, which of their paths are not release-relevant. `env:` is what `telo run`
reads when it resolves a manifest's environment.

That rule is why `modules:` moves. It is a release inventory, not an inventory of
manifests: it exists so a whole-tree scan does not read every example and every
cached `.telo/manifests` copy as something to version and publish, and it is
explicitly not read by anything else — the env walk refuses to consult it, which
is why a manifest under `examples/`, in no release subtree, still gets the full
walk. Leaving it at the top level made it look like a fact about the tree, which
is what pushed the runner into declaring release scope it has no use for.

The blocks are named for what they govern rather than for the command that reads
them, because a name survives a second reader and a command name does not. Both
happen to have one reader today.

`ignore` reads as *release ignores changes here*, not *these are excluded from the
release*: the module still bumps, still publishes, still gets a ledger entry. The
name deliberately does not bind to the changelog, so a second path-based release
input would need no second key.

## Cascade

`release:`'s own keys are the defaults; a `modules:` entry overrides them by
declaring the same key. The merge is **key-wise** and each key's value **replaces
whole**. A list is never unioned across levels, so the set in force is always
exactly one authored list and is readable in one place — the same reason the
built-in default is replaced rather than extended when a workspace declares its
own.

- `ignore`: built-in default → `release.ignore` → the entry's `ignore`. `[]` is a
  declaration that nothing is ignored.
- `registry`: the entry's `registry` → `release.registry` → `--registry` →
  `TELO_OCI_REGISTRY` → the base the ledger recorded.

**That registry order is a change, not a restatement.** Today the ledger's
recorded base *wins* over the flag and the variable, and a disagreement between
them throws before any evidence is collected — which is why
`LEDGER_REGISTRY_MISMATCH` exists in the planner and is unreachable. After this
the ledger is last, because a workspace that authors its destination has said
where it publishes and a cache of a past answer must not outrank it. A
disagreement stays an error but becomes a **per-module** diagnostic under that
same code, so the run produces a plan carrying the error instead of aborting with
no plan at all — which is what lets a workspace merging four vendor ledgers see
every module's verdict in one pass. The reason is unchanged: canonicalization
writes the destination into the manifest layer, so digests taken against two bases
are not comparable.

The ledger stays a record rather than a setting. Where a workspace authors
nothing, the base each module's own ledger entry records is what the PR gate
resolves against — that gate runs with no flag, no environment variable and no
credentials — and *no destination is known* is raised per module, for one with
neither an entry nor an authored base, rather than once for the whole run.

`env:` does not cascade: it is flat. Its only keying is directories, and a
filename convention that differs per subtree is not a thing.

## The built-in `ignore` default

Every pattern gains a `**/` prefix. The anchoring *is* the defect, so anchoring
some patterns and not others reproduces it partially. A module that genuinely
ships a directory named `docs` inside its payload stops being flagged for editing
it — that is the over-report trade this rule already chose when it was demoted
from deciding versions, and it is now a workspace's to override.

## Discovery, attribution and overlap

Discovery is unchanged in method — a pruned walk for `telo.yaml`, then matching
against the patterns — but it now records *which entry* matched each module,
because that is what the module's settings are resolved from.

**The last matching entry supplies them**, which is the rule the list already has:
it is one gitignore-style list evaluated last-match-wins, and a negation entry is
an exclusion that therefore supplies nothing — a module the last match excludes is
not a module of this workspace at all. Refusing an overlap instead would be wrong
twice over: it makes the obvious authoring move — `modules/*` followed by
`modules/sql` carrying an override — unexpressible, and it leaves a `!` entry with
no coherent reading. Deriving a *prefix* from an entry is what is genuinely
unsound, and it appears nowhere in this design: gitignore patterns do not all have
one, which is why discovery walks for manifests rather than expanding patterns
against the filesystem.

**Changed-file attribution moves to the nearest enclosing module**, matching how
build inputs are already attributed. It currently takes the first key that
prefixes the path, which is the shortest — harmless while every module resolves
the same settings, wrong the moment a nested module is judged against an enclosing
entry's `ignore` list.

## Destinations: one per module, and imports that agree

A relatively-imported sibling's destination is derived by applying the import path
to the importer's own, on the importer's host. That is the transport's rule and it
is what ref canonicalization writes into the published manifest. Discovery
independently assigns that same sibling `<its entry's registry>/<its directory
name>`. When the two disagree, the payload builder refuses the module, and its
message is about a manifest being published to two places rather than about the
workspace file that said so.

So: **a relative import between two workspace modules is valid only when the
importer's derived ref for it equals the destination that module is independently
assigned.** Equal registries are necessary and not sufficient — two modules under
one base at different directory depths derive differently too. Reported at plan
time as `IMPORT_DESTINATION_CONFLICT`, naming both modules, the derived ref and
the assigned one, before any payload is built. A relative import to a directory
that is not a workspace module is untouched: nothing else claims it, so the
derived ref stands.

This is a real restriction and it is stated rather than worked around. Making the
builder take the sibling's own assigned destination instead would put a ref in the
artifact that the transport's resolution rule does not produce — the manifest
would say one thing and every consumer resolving relatively would compute another.

**And two modules must not resolve to one ref.** A destination is the base plus
the module's own directory name, so `vendor/aws/storage` and
`vendor/google/storage` inheriting one `registry:` land on a single artifact.
Nothing catches that today and nothing would: the payload builder's refusal is
keyed by manifest and detects one module claimed by two destinations, never two
modules claiming one, while the ledger keys by module key — so both entries would
record digests for the same published artifact and reconciliation could never
settle. It is unreachable only because every registry module currently sits at one
depth under one base with a unique directory name, which is precisely the
assumption this plan removes. Reported at plan time as `DESTINATION_COLLISION`,
naming both module keys and the ref they share, with both remedies in the message:
rename a directory, or give one of the subtrees its own `registry:`. It costs
nothing extra — the assigned destinations are already computed for `telo release
order`, so one derivation feeds that payload and both of these checks.

## Publishing

`telo release order` emits `{ key, destination }` per module rather than a bare
key list, and the module publisher reads the destination from it instead of
re-deriving `$TELO_OCI_REGISTRY/<directory name>`. The script already states the
principle in its own comment — ordering comes from the release model so the import
graph is never re-derived here — and the destination is the one fact it still
derives on its own. `TELO_OCI_REGISTRY` keeps its present job: it is the gate
(unset skips the publish pass entirely) and the seed for a workspace that authors
no `release.registry`.

Without this the multi-destination workspace is unpublishable in the way hardest
to notice — it would plan four bases and push all four to one.

## The `env:` block

Today `telo run` walks up from the manifest to the directory holding the marker,
collecting `.env` then `.env.local` in each directory, nearer winning over
farther, with the real process environment outranking everything.

**`env.roots` is how far.** Gitignore-style, workspace-relative, matched against
each ancestor **directory** as the walk climbs; the nearest match stops it. Two
matches need no refusal — unlike two `modules:` entries, which contradict about a
destination, two bounds differ only in tightness and the nearest is the answer.

It exists because collapsing four vendor workspaces into one widens that walk from
`integrations/<vendor>/` to `integrations/`, so a repo-root `.env` would reach
every vendor's app. Tightening the default instead is not available: this repo
keeps a root `.env` and a root `.env.local`, both read by every module's run.
Declaring no roots is therefore today's behaviour exactly.

**`env.files` is which.** An ordered list whose order is precedence *within one
directory*, later winning — the array order the walk already applies. It does not
touch directory precedence, and it cannot express the process environment
outranking all of them, which stays fixed. Entries are filenames: a `/` or a glob
is an error, because a path would let one entry reach outside the bound `roots:`
exists to state. `[]` means collect nothing — a workspace that forbids dotenv
files and takes its environment from the real one only.

Both lists **replace rather than extend** their default, the rule `ignore`
follows, so a workspace adding `.env.production` writes all three names.

**What the run path reads, and what a bad parse does.** `telo run` now reads
*fields* of the marker where it previously read only its location — the one
invariant this plan retires, deliberately, because the alternative is a credential
boundary nobody can write down. It consumes `env:` alone, so strictness is scoped
to the caller rather than to the file: a diagnostic anchored anywhere else — a
typo under `release.modules`, a block this command has no interest in — is printed
on stderr and does not stop the run. Aborting every app in a workspace over a
release typo is not a trade to make silently, and the lenient-reader / strict-half
split makes this a policy per caller rather than new machinery.

**A diagnostic anchored inside `env:` fails the run**, naming the file and the
key. Degrading to the marker-wide bound there would *widen* the walk — a vendor
app silently picking up a repo-root `.env`, the leak this block exists to prevent
— and a block that opted into a boundary and got nothing is a defect, not a
default. That is the posture `ERR_SCHEMA_PROJECTION_UNRESOLVED` already takes one
level down.

**An unknown top-level block is a warning**, so the next block ships without
breaking runs on today's CLI. An unknown key *inside* a known block stays an
error, and so does an unknown top-level key that is a near-miss of a known block
(`relase:`) — that is the typo whose settings would otherwise go silently
unapplied.

## Editing the marker

**Before.** The marker is not a manifest — it declares no `kind:`, which is
exactly how the editor decides a YAML file is Telo's — so it gets nothing: no
completion, no diagnostics, no hover. Every mistake in it surfaces as a `telo
release` failure, on the first problem only, with no position, and not until
someone runs a command. This plan roughly triples the file's surface — three
blocks, ten keys, three pattern lists — so this is the moment to fix that rather
than after.

**The parser gains a diagnostic half.** It throws on the first problem today,
which is the right shape for a command and useless to an editor: all problems are
wanted, each with a path and a severity. The reader returns the config plus
diagnostics — the lenient-reader / strict-half split every other vocabulary here
has. The CLI still exits on the first error, so its behaviour is unchanged; what
it gains is the ability to name several.

**The shape is declared as data** — one JSON Schema in the analyzer, read by both
the strict half and the completion list. That is the arrangement the schema
keyword vocabulary and the value-type entries already use, for the same reason:
two hand-maintained copies of a key list drift, and the drift is silent in the
worst direction — an editor offering a key the checker rejects.

Diagnostics, split by whether the file is unreadable or merely inert:

- `WORKSPACE_UNKNOWN_KEY` (error) — at any of the three levels, naming the
  near-miss where there is one. No `DiagnosticFix`: a key rename is not a
  whole-value replacement for one node, which is the only repair that primitive
  carries.
- `WORKSPACE_MODULES_MOVED` (error) — top-level `modules:`, naming the move. The
  same message the CLI raises, on the key.
- `WORKSPACE_INVALID_VALUE` (error) — a wrong type, an entry that is neither a
  string nor an object carrying `path:`, an `env.files` entry containing `/` or a
  glob, an empty `release.modules`.
- `WORKSPACE_ENTRY_MATCHES_NOTHING` (warning) — a `release.modules` pattern under
  which no directory holds a `telo.yaml`, or an `env.roots` pattern matching no
  directory. This is the typo the four-way split hid for months.
- `WORKSPACE_ENTRY_SHADOWED` (warning) — an entry every one of whose modules a
  later entry also matches. Last-match-wins makes it inert, so its `registry:`
  applies to nothing. The overlap rule made visible instead of refused.
- `WORKSPACE_MARKER_SHADOWED` (warning) — a marker with another above it, naming
  the outer path: everything beneath this one takes a different cache root,
  different module keys and a different release scope. That is the integrations
  repo's whole problem, reported in the file that causes it.

Completion: the keys of each level from the schema; `env.files` values from the
two defaults; `release.registry` from the base `.changes/ledger.yaml` records,
because that value is already written down and retyping it differently is what
`LEDGER_REGISTRY_MISMATCH` exists to catch; and `release.modules` / `env.roots`
values from **directories in the workspace** — ones holding a `telo.yaml` for the
first, any for the second. That last one is the completion worth having and it
needs a capability the browser-safe half must not have, so it arrives as an
environment hook the host supplies, the way import upgrades take their version
lookup. A host that cannot list directories passes none and loses only that list.

**One reporter, deliberately.** VS Code could get the structural half free by
contributing the schema under `yamlValidation`, which would also serve users
without this extension. Not done: both reporters would then squiggle every
structural mistake twice, and the two messages that matter most — the moved key,
and "declares no `release.modules`" — are ones a JSON Schema cannot phrase. The
schema stays internal.

**Studio is out of scope, structurally.** The session marker is excluded from the
editor's workspace sync in both directions, so the editor never holds the file.

## Ledger

**Every entry records its own `registry:`, unconditionally** — one field per
module, no top-level default and no delta encoding. Recording it only where it
differs from a top-level base reads as tidier and switches the guard off exactly
where it is wanted: a workspace whose entries each author a destination has no
meaningful top-level base, an absent one already means *nothing has been published
yet*, and the agreement check returns early on that — so the multi-destination
workspace this plan exists to enable would be the one workspace whose bases are
never compared. The file is generated and never hand-maintained, so the redundancy
costs nothing, and it removes the "differs from what?" question and the
absent-versus-unknown conflation together.

Three consequences follow. `telo release verify` reconciles **per module** rather
than against one resolved base. The ledger rung of the registry cascade is per
module, and so is *no destination is known*. And the top-level `registry:` becomes
a **legacy form the reader accepts and never writes**, applied to every entry —
the credential-free PR gate reads whatever ledger is committed on the branch, and
that stays in the old shape until a release regenerates it.

`.changes/ledger.yaml` rejects an unknown field exactly as the marker does, so the
per-entry key widens that parser too.

## What does not change

The marker's location semantics — cache root, key anchor, and the `.env` walk's
bound where `env.roots` is absent — are untouched, as are `telo check`, `telo
publish`, `telo install`, `telo upgrade`, `telo migrate`, `telo module` and the
kernel. Parsing stays in the browser-safe half, because the editor answers "what
does changing this library bump?" from the same model; finding the file on disk
stays where it is. `modules:` keeps its meaning, its gitignore-style patterns and
its bare-string spelling — only its location in the file moves.

## Older CLIs, and the moved key

The workspace parser rejects an unknown field, so a workspace declaring `release:`
or `env:` fails on every CLI released before this lands, naming the key. The cost
is bounded in a way a module manifest's is not: the file is repo-private, never
published, consumed by no one else's runtime, and the only affected reader is a
locally pinned CLI. `requires:` does not cover it and is not extended to it — a
marker that has to declare a runtime floor to be read at all is a marker that
cannot be read to find the floor.

**`telo run` on an older CLI is unaffected**, which is worth stating rather than
leaving to inference now that this plan gives the run path a reason to parse:
before it lands, that path never parses the marker at all — it takes the location
and nothing else — so a workspace adding `env:` keeps running apps on a pinned
older CLI, in a session container as much as on a laptop. Only that CLI's `telo
release` breaks, and it breaks on the file it is the sole reader of.

Moving `modules:` is the one breaking edit this plan imposes on workspaces that
would otherwise need none. **No second spelling is kept**: top-level `modules:`
becomes a recognized-and-moved key whose message names the move, rather than a
generic unknown-field rejection, and a workspace fixes it once. A permanent dual
spelling for one field would be worse than a one-time edit, and this file has
never carried one.

`telo release` over a marker with no `release:` block fails with "declares no
`release.modules`" — clearer than today's "`modules` is empty", and it is exactly
the state a session marker is in.

## Migration

**This repo.** One edit: `modules:` moves under `release:`. It declares no
`registry:`, no `ignore:` and no `env:` block, so every other behaviour — the plan,
the ledger, the `.env` walk — is unchanged, and the widened `ignore` default
covers the nine `nodejs/tests/` modules and `apps/authoring-agent/chat/tests/`.

**The runner.** The seeded session marker drops `modules: ["*"]` and carries
comments only. That line exists solely because an empty list is a parse error
today; under this shape a marker with no blocks is valid, and the runner stops
shipping a release claim it never meant into every user's workspace on both
backends.

**The integrations repo.** Four anchors collapse to one at the repo root with four
override entries under `release.modules`, plus `env.roots: [vendor/*]`, which
reproduces the per-vendor `.env` bound the four markers gave. Module keys gain
their vendor prefix (`s3` → `aws/s3`), so the four `.changes/` directories merge
into one with both the pending fragments and every ledger entry re-keyed, and four
`.telo` caches become one. Its vendors do not relatively import across vendor
boundaries; where one did, `IMPORT_DESTINATION_CONFLICT` names it and the import
becomes a pinned remote ref, which is what a dependency across a publish boundary
is.

## Verify

1. A branch changing only `apps/authoring-agent/chat/tests/*.yaml` or a module's
   `nodejs/tests/*.test.ts`: `telo release check` reports no
   `CHANGELOG_ENTRY_REQUESTED`. Adding an edit to that module's `telo.yaml`
   brings it back.
2. This repo's workspace file with `modules:` moved and nothing else added:
   `telo release check` produces the same plan and the same ledger it does today,
   `telo release apply` writes an unchanged ledger, and a `telo run` under
   `modules/` loads the same env files in the same order.
3. A marker still carrying top-level `modules:`: `telo release` fails naming the
   move, not "unknown field".
4. A marker with no `release:` block at all — the runner's seed: `telo run`
   anchors its cache there and runs; `telo release` fails with "declares no
   `release.modules`".
5. `release.ignore: []`: a `docs/`-only edit is reported.
6. An entry declaring only `registry:`: its modules still ignore the block's set —
   the proof that the cascade merges key-wise.
7. `modules/*` followed by `modules/sql` carrying an override: `modules/sql`
   resolves the override, every other module the general entry.
8. A single anchor over the integrations layout: each module's planned destination
   equals the ref its vendor workspace publishes today, the merged ledger
   reconciles against the registry with no drift, and `telo release order` emits
   those same destinations.
9. A relative import from a module in one entry to a module in an entry with a
   different `registry`: `IMPORT_DESTINATION_CONFLICT` at plan time, naming both
   modules and both refs, with no payload built.
10. A workspace whose ledger records one base while `release.registry` names
    another: `LEDGER_REGISTRY_MISMATCH` per module, in a plan that is still
    produced.
11. `env.roots: [vendor/*]`: a run under `vendor/aws/s3` loads `vendor/aws/.env`
    and not the repo-root one; a run under `modules/`, matched by no pattern,
    still walks to the marker.
12. `env.files: [.env, .env.local, .env.production]`: all three are collected per
    directory with `.env.production` winning; `env.files: []` collects none and
    the run sees only the real environment; an entry containing `/` is rejected.
13. A marker open in the editor with two unknown keys and a wrong-typed
    `registry:`: three diagnostics, each on its own key. `telo release` over the
    same file still exits on the first.
14. A marker still carrying top-level `modules:`, open in the editor: one
    diagnostic on that key naming the move — not the cascade of unknown-key
    errors the block-shaped keys below it would otherwise produce.
15. `release.modules: [modules/*, apps/*, tooling/*]` in this repo:
    `WORKSPACE_ENTRY_MATCHES_NOTHING` on `tooling/*` alone. `modules/*` placed
    before a later `modules/**`: `WORKSPACE_ENTRY_SHADOWED` on the first. A
    marker with another above it: `WORKSPACE_MARKER_SHADOWED` naming the outer.
16. Completion at `release.modules` offers directories holding a `telo.yaml`, at
    `env.roots` any directory, at `release.registry` the ledger's recorded base;
    with no directory-listing hook supplied, the key completions still work and
    only the path lists are absent.
17. A marker with a typo under `release.modules` and a valid `env:` block: `telo
    run` prints the diagnostic and runs the app; `telo release` over the same file
    fails. A typo *inside* `env.roots`: the run fails naming the key, rather than
    walking to the marker on a bound it could not read.
18. An unknown top-level block: a warning, and both `telo run` and `telo release`
    proceed. `relase:` — a near-miss of a known block — is an error in both.
19. Two modules whose directories share a name, inheriting one `registry:`:
    `DESTINATION_COLLISION` at plan time naming both keys and the shared ref,
    before any payload is built.
20. A ledger whose entries each record their own base, one disagreeing with its
    entry's `release.registry`: `LEDGER_REGISTRY_MISMATCH` for that module alone,
    and `telo release verify` reconciles the others against their own bases. A
    ledger still carrying only a top-level `registry:`: read as every module's
    base, with the next `apply` writing the per-entry form.
