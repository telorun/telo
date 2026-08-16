# Telo-native release versioning

## Problem

A Telo module's published artifact **embeds its dependencies**. Two ways: esbuild inlines a
sibling library's source into the controller bundle (`@telorun/sql` into `sql-postgres`,
`kv-store-sql`, `sql-sqlite`), and `telo publish` canonicalizes each relative `imports:` source to
the sibling's current version and pins it to a hash of that sibling's `telo.yaml`. npm does not
have this property — a dependent's tarball does not contain its dependency — which is why
changesets treats "bump the dependents" as a courtesy, while here it is a correctness requirement.

Neither ledger can see it. Changie has no dependency graph at all. Changesets' graph is
`package.json` deps and stops at the npm boundary; it never reaches `metadata.version`. So
publishing `sql` moved no dependent, and their artifacts and pins went inconsistent. The only
thing that sees the coupling today is `cli/nodejs/src/bundle/payload-drift.ts`, which compares
bytes against the registry **at release time, after the fact**, and fails the whole release
telling you to hand-write a fragment per dependent.

Two ledgers with different vocabularies, neither of which knows the graph, and a byte check that
only speaks up once it is too late.

## Solution

One release system in the Telo CLI, over the **modules** discovered inside a declared workspace —
`Telo.Library` and `Telo.Application` alike, since both are modules in the loader's sense and both
publish to a registry. A module has **one version**, stamped into every manifest it owns —
`telo.yaml`, `nodejs/package.json`, `rust/Cargo.toml` — and one changelog. `@telorun/kernel`,
`cli`, `sdk`, `analyzer` and the other infrastructure packages own no module manifest and stay on
changesets.

Two mechanisms with distinct jobs:

- **Payload digest — did this module's artifact change?** Exact, from the bytes. It catches an
  inlined sibling, a lockfile-only transitive bump, and a shared-library fix alike. Same primitive
  as today's `computeFilesIntegrity`.
- **Edge graph — why, and at what level?** It attributes a changed payload to an originating module
  so the bump can mirror that module's level. Edges come from the **actual build** — the kernel's
  own controller builder, whose metafile inputs are attributed to their owning module — plus in-repo
  relative `imports:`, read through the analyzer's real loader.

A digest that moved with no attribution — a third-party dependency, or a changesets-owned package
inlined into a module — resolves to patch and is *reported as unattributed*, never silently.

Both halves are computed in one pass and recorded in a committed ledger, `.changes/ledger.yaml`:
per module, its version and its per-layer integrity **as published**. That is the load-bearing
property: **the PR gate and the publish gate compute the same number.** Today they do not, which is
the bug.

Commands: `telo release add` writes a fragment; `status` explains what would bump and why;
`check` is the CI gate; `apply` produces the Version PR — versions into every manifest a module
owns, changelogs, PURL sync, ledger update, fragments consumed. `telo publish` keys off version
movement as it does now.

### A pin is authored, not discovered

"The same number" is only true if the published bytes are a pure function of the commit, and today
the manifest layer is not. `pinImports` (`cli/nodejs/src/commands/publish.ts`) *fetches* each remote
dependency's published `telo.yaml` to derive its hash, is best-effort — an unresolvable import is
warned and shipped unpinned — and re-serializes the document only when at least one pin was
actually written. So one commit yields different manifest bytes depending on network reachability
and on what happens to be published, which is exactly the credential-less case the ledger exists to
serve.

The fix is to move pinning from publish-time discovery to **authoring time**, which is where it
already belongs conceptually: this plan's own rule says a pinned registry ref is the statement "I am
not affected until I choose to be". That is a deliberate act, so its hash is authored state, not a
publish-time side effect. `telo install` and `telo upgrade` already rewrite `imports:` pins and
gain writing the integrity alongside; `pinImports` keeps the code path it has for an
already-pinned import (which it deliberately never overwrites) and degrades from discovery to
**verification** — fetch, compare, hard-fail on mismatch. Best-effort disappears, which also
retires a piece of error swallowing the repo's own rules forbid.

Two consequences make the bytes deterministic. Canonical re-serialization becomes unconditional, so
output no longer depends on whether a pin happened to be written. And an in-repo sibling's pin is
computed from the *local* canonicalized bytes in topological order — the dependency's post-bump
manifest is derived, never fetched — so a whole release batch is plannable offline without
simulating a publish against a registry.

**The publish destination is the third input, and the ledger records it.** Canonicalizing a relative
`imports:` source rewrites it to `<registry base>/<sibling>@<version>`, so the manifest layer's bytes
are a function of the commit *and* of where the module publishes — and nearly every standard-library
module has a relative sibling import, so this is the common case rather than an edge one. Today that
base lives only in the ambient `TELO_OCI_REGISTRY` the release job sets, which a fork running the PR
gate does not have. So `.changes/ledger.yaml` carries it beside the modules: it is a property of the
recorded digests, not of the working copy, which is what keeps `check` reproducing publish's number
with no environment and no credentials. It stays out of `telo-workspace.yaml` — a publish
destination is a release-job concern that must keep degrading to the flag, and the ledger is where
the digests it explains already live.

### The payload is built by the kernel, not staged by a package manager

Digesting a payload requires the payload, and today the controller layer is read off disk as a
prebuilt `.mjs` that is gitignored and produced by `pnpm run build:bundles` — 56 per-module `build`
scripts each restating the esbuild flags. So a gate that has to compute the shipped bytes would
depend on a package manager having been run first, and on 56 copies of a flag set agreeing with the
kernel's.

The kernel already builds a controller from TypeScript source: `source-bundle-builder.ts` is the
exact analogue of the Rust `napi-loader`, running `CONTROLLER_BUNDLE_OPTIONS` over `local_path` with
a content-addressed cache and a recorded metafile. What is missing is only that publish reads the
prebuilt `path=` file instead of asking for it. Routing the controller layer through the builder
makes the shipped bytes and the digested bytes the same bytes by construction, retires the esbuild
half of every module `build` script (the `tsc -p tsconfig.lib.json` type-check half stays), and
hands the edge graph its metafile from the same run.

One consequence has to be deliberate: esbuild is an **optional** dependency, and a host without it
takes a documented fallthrough to the prebuilt file (`canBuildFromSource` →
`ControllerEnvMissingError`). On the publish and release paths that fallthrough becomes a hard
failure — selecting a stale bundle there would digest and ship something other than the source.

### The ledger is a cache; the registry is the authority

A committed digest can disagree with what is actually published — a hand edit, an `apply` whose
publish then failed, a push made outside the pipeline. So the ledger is never the authority. It is
a *local, credential-free cache of the registry's answer*, and the layering is explicit: `check`
reads the ledger because a PR gate must run on a fork with no secrets, while `telo publish` reads
the registry, which it already does. They compute the same number, so a drifted ledger surfaces at
publish — the one point that has credentials to reconcile it — and `telo release verify` performs
that reconciliation on demand, in the release job and on a schedule. A missing ledger entry is not
drift: it means nothing is published, which is the correct reading for a new module.

**A toolchain bump moves every digest, and that is the right answer.** If the pinned esbuild emits
different bytes, every consumer genuinely receives different code, so every module genuinely needs
a version. What matters is that this costs nobody any hand-written prose: it lands in the design's
existing *unattributed* case — digest moved, no fragment, no in-repo edge — and resolves to a patch
across the affected modules automatically.

That case forces a correction to what the gate enforces. `check`'s job is **not** "did a human
write prose for every module that moved" — under a toolchain bump that would demand sixty
fragments. Its job is "can a complete, consistent plan be formed", and it fails only when one
cannot: a fragment naming an unknown module, a major-inducing kind, or a manifest version and
ledger entry that disagree. Nothing ships to nobody, because every drifted module gets a bump
either way.

What a fragment is genuinely required for is the **changelog**, and that is a third question with a
third mechanism: a module whose *own files* changed made a semantic change that deserves a written
entry, while a module that drifted only through propagation or the toolchain does not. So the
path-scoped changed-files rule survives — but demoted. Today it decides the version, which is why
its guesswork (`docs/` vs `tests/` vs `nodejs/`, `bundlesAController`) has to be sound and is not.
Here it decides only whether a changelog line is requested, so a false positive costs one sentence
rather than a spurious republish.

### The workspace root

Every path in this design — a module key, a ledger entry, a fragment's `modules:` — is relative to
something, and today nothing defines what. The existing scripts anchor on their own location on
disk (`resolve(dirname(fileURLToPath(import.meta.url)), "..")`), which works only because they live
in the repo they version; a CLI subcommand invoked from an arbitrary directory has no such
self-location.

So a workspace declares itself with a `telo-workspace.yaml` at its root, found by walking up from
the cwd. **Its location is the anchor**, and it carries one thing: `modules`, the subtrees that may
hold them. That is not derivable — 50 manifests outside `modules/` and `apps/` carry a
`metadata.version` (38 under `examples/`, 12 under `templates/`), so a whole-tree scan makes every
example a released module, while the current globs are this repo's layout hardcoded into a CLI
feature meant to serve any module repo.

**The file is optional, and `telo release` is the only thing that reads it.** Without one, `run`,
`check`, `publish`, `install`, `upgrade`, `migrate`, `module` and every other command behave
exactly as they do today, and the kernel is untouched — it receives resolved options from the CLI
and never looks for the file. Only `telo release` requires it, and its absence is an actionable
error naming the file to create, never a guess at the layout. That is what keeps a single-manifest
repo, a bare `examples/` directory and a third-party module checkout working with nothing added:
Telo is a runtime first, and a workspace is a release-time convenience laid over it.

This is a standing constraint, not a property of the current scope. Every future consumer must
degrade to today's behaviour when the file is absent — `.env` layering falls back to the manifest's
own directory, a publish destination to the flag or environment, import overrides to none. A
concern that *cannot* degrade does not belong in this file, because putting it there would make
every existing standalone manifest require a workspace to keep working.

It stays scoped to that. Other workspace-level concerns are real — layering `.env` / `.env.local`
from the root down rather than reading only the manifest's own directory (`run.ts` does the latter,
which is why `apps/authoring-agent/.env.local` and `examples/.env.local` are each duplicated into a
subdirectory by hand) and local import overrides — but each is its own change, and the anchor is
what they will need first. The publish destination is deliberately not among them: it lands in the
ledger, beside the digests it explains. Anything added later must be **true of the whole tree, not derivable from it, and harmless
by its absence**; a cache path is derivable from the anchor and a toolchain pin already lives in
`package.json` / `Cargo.toml`, so neither qualifies.

Discovery then filters within those subtrees: a module is a directory holding a `telo.yaml` whose
**module doc** carries a `metadata.version` — not any manifest in the directory, which would read
`apps/hub/test-suite-e2e.yaml`'s `version: 1.0.0` as a second module, and not a listed directory
with no manifest at all, which is how `apps/hub-web` and `apps/telo-editor` fall out.

Modules ship two different artifact kinds, and the digest has to mean something for both. The kind
is derived, keeping discovery configuration-free: a `Dockerfile` beside the manifest makes it an
**image module** (`apps/hub`, `apps/authoring-agent`), and its absence a **registry artifact
module**. One primitive over two file sets — `computeFilesIntegrity` across the layers `telo
publish` builds, or across the directory minus its `.dockerignore` exclusions, which is already the
authored statement of what the image contains. Without this, apps would have no digest and no
metafile edges, and would silently fall back to the changed-files rule this plan demotes to
changelog duty. As apps become publishable to OCI as well, the two kinds converge and the
distinction narrows to which file set is digested.

De-inlining sibling modules — making `@telorun/sql` and friends `--external` and resolving them
through the import graph — is **its own plan**, `plans/deinline-sibling-modules.md`, sequenced
after this one. It is not a prerequisite, and folding it in here would have undercut the model it
sits beside: once siblings are external a dependent's payload stops moving when its dependency
changes, so the digest would no longer cover this plan's central propagation case and the whole
burden would shift to the `imports:` graph.

The model splits along the established browser-safety line. `analyzer/nodejs/src/release/` holds
module identity, fragment parsing, the edge graph, level propagation and version planning — pure
data in, plan out, so the telo editor can answer "what does changing this library bump?".
`cli/nodejs/src/release/` holds the evidence collection (driving the kernel's controller builder,
workspace and git reads, file writing) and the commands. Version rewriting reuses `yaml-source-edit.ts`, the existing
style-preserving byte-splice primitive, so a bump lands as a one-line diff rather than a
re-serialized file.

Retired: `.changie.yaml` and its generator, `.changes/<project>/` version ledgers,
`changie-release.mjs`, `check-changie-fragments.mjs`, `check-no-major-module-bump.mjs`,
`version-packages.mjs`, the `build:bundles` script and the esbuild half of every module's own
`build`. `module-publish-order.mjs` folds into the release model, its regex import parser replaced
by the analyzer's loader. `payload-drift.ts` stays as the publish-time backstop and should now never
fire.

Changesets keeps the infrastructure packages and gives up the modules, which is a config change plus
a gate change: every package under `modules/*/nodejs/` joins `.changeset/config.json`'s `ignore`
list, and `check-changeset-status.mjs` excludes the same set or it fails every module PR. The set is
closed under the dependency relation — nothing outside `modules/` depends on any of them, and the
only published→published edges (`@telorun/http-server` → `@telorun/http-dispatch`, `@telorun/sql-sqlite`
→ `@telorun/sql`) have both ends inside it — so changesets' rule that a tracked package may not
depend on an ignored one is satisfied without exceptions. That deliberately removes the private
`-build` propagation changesets performs today: propagating a shared-library fix into the modules
that inline it is what the digest and the edge graph now do, from the bytes rather than from
declared deps.

## Decisions

- **One vocabulary: module.** A `Telo.Application` is a module in the loader's sense — module doc,
  module scope, imports, `metadata.name` as the kind prefix — and apps become publishable to a
  registry too, so the release system's noun and the hub's converge. Rejected: a separate "release
  unit", which was a second name for a concept `kernel/specs/module-artifact.md`, `telo module
  versions` and the hub's `module_versions` table already name, with nothing releasable that is not
  a module and no module that is not releasable.
- **One version per module**, across `telo.yaml` / `package.json` / `Cargo.toml`. The npm and
  module versions of `sql` have already drifted apart under two ledgers; a single version is what
  makes the polyglot story coherent. Costs a one-time jump for the 14 module-owned packages that
  still publish to npm — `@telorun/sql` goes 0.12.1 → 0.21.0, and the others similarly — which is
  accepted rather than smoothed: pre-1.0, and a version that means two things is worse than a
  version that skips. The module Rust crates are `version = "0.0.0"` today and start being stamped,
  which moves `Cargo.lock` with them.
- **Edges come from the build's own metafile, not from `package.json` deps.** A declared-deps
  graph cannot see `--external`, so `@telorun/sdk` — declared by 54 modules, inlined by none —
  would bump the entire standard library on every SDK change. An externals list restated outside
  the build script is a second copy of the build's truth, the exact drift class this plan ends.
  With metafile inputs, the SDK's absence falls out rather than being special-cased.
- **Digest and graph are two mechanisms, not one.** The digest alone cannot say *at what level*;
  the graph alone cannot see a lockfile bump. Each covers the other's blind spot, and the seam
  between them is reported rather than papered over.
- **Committed ledger, no base-ref diff.** It answers "does this differ from what is published at
  my current version", so it needs no merge base, works on a shallow clone or a credential-less
  fork, and deletes `releaseAccountedFor`. Rejected: digesting HEAD against the merge base, which
  needs a second build tree and answers "changed since main" rather than "changed since release".
- **The ledger is a cache and the registry is the authority**, reconciled at publish, which already
  reads the registry. Rejected: treating the committed digest as authoritative — a hand edit or a
  failed publish would then be undetectable, and a byte-equality gate that can be wrong about the
  bytes is worse than no gate.
- **Three questions, three mechanisms**: the digest decides *whether* a module bumps, the graph
  decides *at what level*, and the path-scoped changed-files rule decides only *whether a changelog
  entry is requested*. Today that last rule decides the version, which is why its guesswork has to
  be sound and is not; demoting it means a false positive costs a sentence, not a republish.
- **An in-repo relative import is a release edge; a pinned registry ref is not.** `apps/hub`
  pinning `oci://…/sql@0.12.0` is precisely the statement "I am not affected until I choose to
  be" — moving it is `telo upgrade`'s job.
- **A propagated dependent mirrors its dependency's level**, joined as the maximum over multiple
  paths. A module that inlines a breaking change is itself breaking for its consumers. Pre-1.0
  breaking stays a minor, and a major-inducing kind stays a hard error as it is today.
- **Pins are authored and verified, never discovered at publish.** It is what makes the published
  bytes a pure function of the commit, and therefore what makes "the same number" true rather than
  aspirational; it also retires `pinImports`' best-effort branch, which swallowed an unresolvable
  import into a silently unpinned publish. Rejected: (a) scoping the digest to local payload layers
  and inferring manifest change from the declared graph — it reintroduces a derived heuristic for
  the one thing the digest was meant to settle exactly; (c) recording the digest pre-pin and
  reconciling only at publish — the two gates then knowingly compute different numbers, which is
  the defect being fixed.
- **The ledger records the registry base the digests were taken against.** Canonicalization writes
  the destination into the manifest layer, so without it the two gates compute the same number only
  when they happen to share an environment variable — which a credential-less fork does not. It
  belongs to the ledger rather than to `telo-workspace.yaml` because it explains the digests stored
  beside it, and because a publish destination has to keep degrading to the flag.
- **The kernel builds a module's controller on the publish path, as it already does on the run
  path.** It makes the digested bytes and the shipped bytes the same bytes, rather than two
  esbuild invocations that must be kept agreeing; it removes a package-manager prerequisite from a
  gate; and it gives the edge graph its metafile for free. Consequence, taken deliberately: the
  optional-esbuild fallthrough to a prebuilt `path=` file becomes a hard failure here, since
  digesting a stale bundle is the one outcome this whole design exists to prevent.
- **The Merkle pin channel stays.** Removing it means loosening `imports:` to ranges resolved at
  load, which abandons the `import pin → telo.yaml → blob digest → layer contents` chain. Embedding
  the dependency's identity is the reproducibility guarantee, not an accident to be optimized away.
- **Artifact kind is derived from a `Dockerfile`'s presence, and an image module digests the file
  set its `.dockerignore` defines.** One mechanism over two file sets keeps "the digest decides
  whether a module bumps" true for every module. Rejected: leaving apps out of the digest, which
  would make the demoted changed-files rule authoritative again for a third of the set; and parsing
  Dockerfile `COPY` directives, when the ignore file is already the authored answer. The ignore file
  is named `Dockerfile.dockerignore` on both image modules today, not `.dockerignore`.
- **An image module's base image is outside its digest, accepted.** `apps/hub` derives from
  `telorun/node:<version>-slim`, so a kernel change alters the image while a digest over the app's
  own file set does not move. Chasing the base reference is out of scope because the exposure it
  would close is already closed elsewhere: every app image publishes `:latest` + `:sha-<short>` on
  each push, so a kernel change reaches the deployed app regardless, and the immutable `:<version>`
  tag is the thing a version move is for.
- **Discovery reads the module doc's `metadata.version`, not any manifest in the directory** — the
  looser rule admits `test-suite-e2e.yaml` as a module.
- **De-inlining sibling modules is a separate, later plan.** It is larger than the plan it was
  embedded in, needs machinery this one does not introduce (a library layer role and entry-point
  locator for the controller-less modules `codec`, `http-dispatch`, `kv-store`, `type`; a
  specifier→alias mapping), and it moves propagation off the digest and onto the graph — a change
  to this plan's spine that deserves its own argument.
- **Fragments are plain YAML validated by the analyzer, not a `Telo.*` kind.** They are build-time
  repo state with no controller and no capability; a kernel kind for a file the runtime never
  loads is scope creep.
- **Modules are discovered, not registered**, which removes a generated config file and its CI
  drift check. **A module's key is its workspace-relative directory path**, never a bare name:
  changie keys on the bare directory name, so a library and an app sharing one would silently share
  a fragment — a hazard its own source calls out and leaves open. A path is already unique and
  already the thing the ledger, the fragment and the diagnostics all have to name.
- **The marker is optional and read only by `telo release`.** Its absence changes nothing else —
  no command, no kernel behaviour — so a single-manifest repo needs no workspace to run, check or
  publish, and every future consumer must degrade to today's behaviour without it. A concern that
  cannot degrade is disqualified from the file, since admitting one would retroactively require a
  workspace of every standalone manifest that works today.
- **The workspace marker is the anchor, and naming subtrees is workspace-level configuration while
  registering individual modules is not.** That is where changie's generated `projects:` list went
  wrong and why it needed a CI drift check; naming subtrees needs no such policing. Rejected as
  anchors: the git root, which makes the answer depend on VCS and breaks in a tarball, a vendored
  copy or a submodule; and `pnpm-workspace.yaml`, which is Node-specific in a polyglot runtime.
  The name is hyphenated rather than `telo.workspace.yaml`: across ecosystems a second root file
  either folds its role into the extension (`go.work`, `Cargo.lock`) or hyphenates
  (`pnpm-workspace.yaml`, `dune-project`), and the three-segment `tool.role.ext` form is a
  JavaScript idiom with essentially no presence elsewhere. Telo needs `.yaml` as a real extension,
  which leaves the hyphen.
- **The marker is flat YAML, not a `Telo.Workspace` kind.** A kernel kind would need an exception
  to the rule that every module file opens with exactly one `Telo.Application` or `Telo.Library`
  doc, plus a `builtins.ts` entry mirrored in the Rust half — to buy nothing, since the CLI parses
  the file and passes the resolved values into the kernel instance's options, so the kernel never
  discovers or parses it. Same reasoning and same file family as the fragments.
- **A `module.version` CEL binding is added** so a manifest can read its own version instead of
  restating it. `apps/hub` duplicates its version in `serverInfo.version`, kept in sync only by a
  file-global regex and a hand-maintained `versionLines: {hub: 2}` count. Rejected: a per-module
  list of extra version sites, which reintroduces exactly the configuration drift being deleted.
- **Fragment shape is changesets' (one file, several modules, one body) with changie's `kind:`
  vocabulary**, so one cross-cutting change is one file and the kind still drives both the level
  and the changelog section.

## Example after the change

**The workspace root anchors every path below.** It names the subtrees that may hold modules, and
nothing else:

```yaml
# telo-workspace.yaml — its location is the anchor
modules:
  - modules/*
  - apps/*
```

**A module's key is its workspace-relative path.** Nothing registers the set — `modules/sql` is a
module because `modules/sql/telo.yaml` carries a `metadata.version`, and that one field is both the
declaration and the current value:

```yaml
# modules/sql/telo.yaml — unchanged; this is what makes `modules/sql` a module
kind: Telo.Library
metadata:
  name: SQL
  version: 0.13.1
```

The committed ledger records what is published, so every gate below runs with no network call:

```yaml
# .changes/ledger.yaml
# The base every digest below was taken against — canonicalization writes it into
# the manifest layer, so it is part of what the digests mean.
registry: oci://ghcr.io/telorun
modules:
  modules/sql:
    version: 0.13.1
    layers:
      manifest: sha256-4f1c…
      controller/js: sha256-9ab7…
  modules/sql-postgres:
    version: 0.6.2
    layers:
      manifest: sha256-2d80…
      controller/js: sha256-c114…
```

An author fixes `modules/sql/nodejs/src/query.ts` and writes one fragment. `modules:` maps each
directly-changed module to its kind; the kind drives both the level and the changelog section, and
a cross-cutting change lists several modules in the one file:

```yaml
# .changes/pending/sql-parameter-binding.yaml
modules:
  modules/sql: Fixed
body: Parameters are bound positionally on every dialect.
```

`telo release status` builds each module's payload, digests it, compares against the ledger, and
attributes what moved:

```
modules/sql             0.13.1 → 0.13.2  Fixed — declared
modules/kv-store-sql    0.7.0  → 0.7.1   Fixed — inlines modules/sql/nodejs/src/query.ts
modules/sql-postgres    0.6.2  → 0.6.3   Fixed — inlines …/query.ts; imports ../sql
modules/sql-repository  0.4.0  → 0.4.1   Fixed — imports ../sql
modules/sql-sqlite      0.7.0  → 0.7.1   Fixed — inlines …/query.ts; imports ../sql
modules/test            0.9.3  → 0.9.4   patch — payload changed, unattributed
                                          (inlines packages/glob, not a workspace module)
```

`telo release check` is the same computation with an exit code. It does not fail merely because a
payload moved — `modules/test` above is planned and released without anyone writing prose for it.
It fails when no consistent plan can be formed (a fragment naming an unknown module, a
major-inducing kind, a manifest version disagreeing with its ledger entry), and it asks for a
changelog entry when a module's *own* files changed with no fragment naming it. `telo release
apply` writes each new version into every manifest its module owns — `modules/sql/telo.yaml`,
`modules/sql/nodejs/package.json`, and a `rust/Cargo.toml` where one exists — appends to the five
changelogs, updates the ledger, and deletes the consumed fragment. `telo publish` then pushes
exactly those modules, and `payload-drift.ts` finds nothing to report.
