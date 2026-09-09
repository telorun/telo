# Workspace release settings — a per-subtree `release:` block

## Problem

`telo-workspace.yaml` carries one field, `modules:`, and everything else `telo
release` needs is either a constant compiled into the CLI or a value that reaches
it from outside the workspace. Two consequences, both measured.

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
`aws/lambda/nodejs/tests/`. All of them are flagged today.

Widening the constant fixes those and leaves the second half of the problem: the
set is this repo's layout convention shipped to every Telo workspace, and a
workspace that keeps specs in `spec/`, or ships its docs inside its artifact, has
no way to say so.

## The shape

```yaml
# The release anchor. Its LOCATION is what module keys, ledger entries and
# fragment paths are measured from, what bounds `telo run`'s `.env` /
# `.env.local` walk-up, and where the `.telo` cache lives.
#
# Top level carries what the workspace IS; `release:` carries how `telo release`
# behaves. A `modules:` entry may carry its own `release:` block, which merges
# key-wise over this one: a key it declares replaces that key entirely, a key it
# omits is inherited.
release:
  # Where modules publish. A module's ref is `<registry>/<its own directory
  # name>`. The ledger still records the base each module's digests were built
  # against, and still errors on a disagreement.
  registry: oci://ghcr.io/telorun

  # Changes under these paths are not release-relevant, so `telo release check`
  # does not ask for a changelog fragment naming the module. Module-relative and
  # gitignore-style — unlike `modules:` below, which is workspace-relative.
  # Declaring it replaces the built-in default; `[]` ignores nothing. It does NOT
  # decide what ships: `files:` and `assets:` on each module do that.
  ignore:
    - "**/tests/**"
    - "**/docs/**"
    - "**/plans/**"
    - "**/README.md"
    - "**/CHANGELOG.md"

# The subtrees that may hold modules — a place to look, never a module: what
# makes a directory a module is its `telo.yaml`. A bare string is an entry with
# no overrides. Two patterns matching one module is refused, not merged.
modules:
  - modules/*
  - apps/*

  - path: vendor/aws/*
    release:
      registry: oci://ghcr.io/telorun/aws

  - path: vendor/acme/*
    release:
      registry: oci://registry.acme.internal/platform
      ignore:
        - "**/tests/**"
        - "**/__snapshots__/**"
        - "spec/**"
```

`modules/ai` publishes to `ghcr.io/telorun/ai` and ignores the workspace set.
`vendor/aws/s3` publishes to `ghcr.io/telorun/aws/s3` and inherits that same set,
because its entry never mentions `ignore:`. `vendor/acme/billing` publishes to
`registry.acme.internal/platform/billing` and ignores only its own three, so a
`docs/` edit there does ask for a fragment.

## Why a block rather than two top-level keys

Both fields are read by one command, both cascade identically, and both are
settings rather than facts about the tree. The marker's own admission rule — a
field must be true of the whole tree, not derivable from it, and harmless by its
absence — is what has kept this file from becoming a config dump, and it admits
facts only. The block is the quarantine that lets settings arrive without eroding
it: the top level keeps stating what the workspace *is*, and `release:` states how
one command behaves. `modules:` stays outside the block because it is discovery —
where modules live in this workspace — which any future consumer would want, not
just release.

`ignore` reads as *release ignores changes here*, not *these are excluded from the
release*: the module still bumps, still publishes, still gets a ledger entry. The
name deliberately does not bind to the changelog, so a second path-based release
input would need no second key.

## Cascade

The block **merges key-wise**; each key's value **replaces whole**. A list is
never unioned across levels, so the set in force is always exactly one authored
list and is readable in one place — the same reason the built-in default is
replaced rather than extended when a workspace declares its own.

- `ignore`: built-in default → workspace `release.ignore` → entry
  `release.ignore`. `[]` is a declaration that nothing is ignored.
- `registry`: entry `release.registry` → workspace `release.registry` →
  `--registry` → `TELO_OCI_REGISTRY` → the base the ledger recorded.

The ledger stays last in that order, and stays a record rather than a setting: the
PR gate runs with no flag, no environment variable and no credentials, so the
recorded base is what it resolves against. The existing disagreement check is
unchanged in meaning and becomes per module — an authored or requested base that
differs from the one a module's digests were recorded against is
`LEDGER_REGISTRY_MISMATCH`, because canonicalization writes the destination into
the manifest layer and digests taken against two bases are not comparable.

## The built-in default

Every pattern gains a `**/` prefix. The anchoring *is* the defect, so anchoring
some patterns and not others reproduces it partially. A module that genuinely
ships a directory named `docs` inside its payload stops being flagged for editing
it — that is the over-report trade this rule already chose when it was demoted
from deciding versions, and it is now a workspace's to override.

## Discovery and ambiguity

Discovery is unchanged in method — a pruned walk for `telo.yaml`, then matching
against the patterns — but it now records *which entry* matched each module,
because that is what the module's settings are resolved from.

Two entries matching one module is refused at workspace load, with the module and
both patterns named. For a list this could be a merge; for a destination it is a
contradiction, and publishing to a guessed registry is not something to be clever
about. It is a defect in the workspace file rather than a finding about a release,
so it fails the load the way the other workspace-config errors do and takes no
diagnostic code.

## Ledger

An entry records its own `registry:` only where it differs from the ledger's
top-level one, so a workspace with a single destination has an empty ledger diff
and the integrations ledger gains four lines. The per-module value is what the
disagreement check compares against.

## What does not change

The marker's location semantics — cache root, `.env` bound, key anchor — are
untouched, as is `telo run`, `telo check`, `telo publish` and the kernel. Parsing
stays in the browser-safe half, because the editor answers "what does changing
this library bump?" from the same model; finding the file on disk stays where it
is. `modules:` keeps its meaning and its bare-string spelling.

## Migration

**This repo.** Nothing. Its two entries publish to one base, the bare-string form
means "no overrides", and the widened default covers the nine `nodejs/tests/`
modules and `apps/authoring-agent/chat/tests/`. The file is byte-identical.

**The integrations repo.** Four anchors collapse to one at the repo root with four
override entries. Module keys gain their vendor prefix (`s3` → `aws/s3`), the four
`.changes/` directories merge into one with pending fragments renamed to the new
keys, and four `.telo` caches become one. One behavioural change deserves a
decision rather than discovery: a run inside `aws/s3` today stops its `.env`
walk-up at `integrations/aws/`, and under one anchor it also reads
`integrations/.env` — vendor credentials become repo-wide.

**Older CLIs.** The workspace parser rejects an unknown field, so a workspace
declaring `release:` fails on every CLI released before this lands, naming the
key. The cost is bounded in a way a module manifest's is not: the file is
repo-private, never published, consumed by no one else's runtime, and the only
affected reader is a locally pinned CLI. `requires:` does not cover this file and
is not extended to it — a marker that has to declare a runtime floor to be read at
all is a marker that cannot be read to find the floor.

## Verify

1. A branch changing only `apps/authoring-agent/chat/tests/*.yaml` or a module's
   `nodejs/tests/*.test.ts`: `telo release check` reports no
   `CHANGELOG_ENTRY_REQUESTED`. Adding an edit to that module's `telo.yaml`
   brings it back.
2. This repo's workspace file, unmodified: `telo release check` produces the same
   plan and the same ledger it does today, and `telo release apply` writes an
   unchanged ledger.
3. A workspace declaring `release.ignore: []`: a `docs/`-only edit is reported.
4. An entry declaring only `release.registry`: its modules still ignore the
   workspace set — the proof that the block merges key-wise.
5. A single anchor over the integrations layout: each module's planned
   destination equals the ref its vendor workspace publishes today, and the
   merged ledger reconciles against the registry with no drift.
6. Two entries matching one module: workspace load fails naming the module and
   both patterns.
7. A workspace whose ledger records one base while `--registry` names another:
   `LEDGER_REGISTRY_MISMATCH`, per module, as today.
