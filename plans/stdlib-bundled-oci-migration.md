# Standard library: npm controllers → bundled OCI artifacts

## Problem

The standard library delivers controllers two ways. Six modules bundle their
controller inside the module artifact (`pkg:telo/local/js`); forty-five publish
an `@telorun/<name>` npm package and reference it as `pkg:npm`. The npm half
carries costs the bundled half does not: a module's version is split across two
ledgers (changesets for the package, changie for `metadata.version`) kept in sync
by a script; a consumer needs an npm registry reachable at run time to load a
module it already fetched from OCI; and the delivery mode is tied to the Node
ecosystem, which contradicts the polyglot goal. Bundling is already the stated
direction — this makes it the only direction for the standard library.

## Solution

**Forty modules swap controller delivery.** Each module's `nodejs/` package
becomes a private, unpublished `@telorun/<name>-build` package whose only jobs
are declaring the dependencies esbuild inlines and type-checking the sources —
the shape `modules/kv-store-memory/nodejs` already has. Its `telo.yaml` rewrites
each `controllers:` PURL from
`pkg:npm/@telorun/<name>@<ver>?local_path=./nodejs#<export>` to
`pkg:telo/local/js?path=./nodejs/<file>.mjs&local_path=./nodejs/src/<file>.ts`
— and that is the whole manifest change. The npm fragment named a package export
subpath; a bundle needs none, since the whole module is the controller. Nothing
about the resolution path is new: `telo publish` already partitions the payload
into layers and `BundleControllerLoader` already materializes them. The
`local_path` qualifier is the dev-mode source (see Development flow); it is inert
in a published artifact, which ships no `src/`.

The six modules that already bundled gain `local_path` on the same footing —
without it a clean checkout cannot run them at all, since their `.mjs` is a
gitignored build artifact.

**Five of the forty keep publishing their package, reduced to a contract.**
`ai`, `cache`, `sql`, `embedding` and `vector-store` each carry controllers *and*
the TS surface a third-party backend of their abstract compiles against —
`SqlConnectionBase`, `isCacheStore`, the embedding prompt helpers, the metadata
filter types. Their controllers move into bundles like every other module's; the
package keeps publishing with the controller subpaths dropped and only the
contract exports left. Same reason the four no-controller libraries below keep
publishing, and the same audience: a manifest author imports the kinds, a
controller author installs the package.

**A bundled controller no longer has to be restated in `files:`.**
`partitionLayers` currently fails the publish when a candidate's `path=` entry
point is not selected by `files:`, which would put a `files:` line restating
`controllers:` on every migrated module. The requirement is an implementation
choice, not a normative one: `kernel/specs/module-artifact.md` §1 defines a
controller layer as the entry-point files of the candidates sharing a selector
plus what their siblings claim, and names `files:` only in the definition of
`common`. So `cli/nodejs/src/bundle/partition-layers.ts` drops the check and
unions each claim's entry into the payload instead, with the symlink-confinement
guard — today inside `selectFiles` — extended to cover implicitly added entries.
`files:` keeps its role for assets, static files and sidecars. Existing bundled
modules need no republish: their `files:` selects the same single file, so the
partition is byte-identical and the declaration merely becomes redundant.

**Four shared TS libraries keep publishing and keep their changesets.** `codec`,
`http-dispatch`, `kv-store` and `type` declare no controller — they are pure TS
libraries inlined into each consumer's bundle, as `@telorun/kv-store` already
is — so nothing about them changes. Their npm package carries no module code to
begin with: it is the **TS surface a controller author compiles against** — the
store contract and `KeyedClaim`, the encoder contract, the dispatch and schema
helpers — while the *kinds* those surfaces belong to travel over OCI as usual.
Two audiences, two channels: a manifest author imports the kinds, a controller
author installs the package, exactly as they already install `@telorun/sdk`. It
is a public surface, not an internal one — a third-party `KvStore.Store` backend
needs it to build, and that is the whole reason they keep publishing. Nothing
*loads* them from npm: no PURL names them, so the runtime never fetches them.
Thirty-five packages stop publishing in total; nine keep publishing as pure
contract surfaces (these four plus the five above).

**Bundling freezes every inlined dependency, so publish gates on bytes rather
than on a ledger.** Today a `pkg:npm` controller is installed on the
*consumer's* machine, so the controller package's own dependency ranges resolve
fresh and a patched `fastify` / `ioredis` / `pg` reaches consumers with no
republish. After the migration those versions are baked into the shipped blob at
publish time, and a change to any of them — a shared TS library, a direct
dependency, a transitive one moved only by the lockfile — alters the bytes of a
dozen published modules while touching no file under any of their directories
and moving no package version. No path-scoped rule and no version ledger can see
that, which is the one failure mode a version number exists to prevent.

The artifact already carries the exact answer: each layer's `integrity` digest is
a framing-independent hash of its contents. So `telo publish` **builds the
controller layer, compares its digest against the last published version's
`layers:` entry, and refuses to publish changed bytes at an unchanged
`metadata.version`** — naming the module and the digest that moved. This is
exact rather than inferred: it fires for a `codec` fix, a lockfile bump, and a
sibling source edit alike, and it cannot fire spuriously, because identical bytes
are identical bytes. It replaces the auto-fragment heuristic entirely (see
Releases).

**Five modules stay on npm.** `sql-sqlite`, `image` and `pdf` load native
`.node` binaries; `starlark` loads a `.wasm` resolved relative to
`import.meta.url`; `http-server` inlines `@scalar/fastify-api-reference`, which
reads `dist/js/standalone.js` relative to its own module URL. They are one
problem, not two: a flattened bundle looks for that file beside the *bundle*,
where it is not — and the failure is a runtime "file not found" at first use, not
a build error, so nothing catches it earlier. Each needs platform-qualified
controller layers, an `assets:` layer, and source changes to resolve payloads
through `ctx.resolveModuleFile`. That is genuinely new ground and is deferred to
a follow-up.

**No name joins the collapsed realm — the three kernel importers lose the
import instead.** `assert`, `otlp` and `test` reach into `@telorun/kernel` /
`@telorun/analyzer` for three separable things, and each gets a home that leaves
`REALM_COLLAPSE_NAMES` as `["@telorun/sdk"]`:

- `otlp` needs exactly one class, `RecordBuffer` — the bounded sink buffer of
  logging spec §10.3. The three other names it imports from the kernel
  (`LogSinkInstance`, `SinkBufferPolicy`, `DEFAULT_BUFFER_POLICY`) are already
  SDK-owned and reach it through `kernel/nodejs/src/logging/log-sink.ts`, a
  re-export shim whose own comment states the rule: the sink contract lives in
  the SDK so a third-party sink is written as an ordinary module rather than
  against a kernel-internal type. `RecordBuffer` is the piece that did not move
  with it, so it moves now — to `@telorun/sdk`, beside the policy types it
  already depends on. The kernel's own console and file sinks keep one spelling
  through the same shim.
- `test` needs to run a child manifest and `assert`'s `Manifest` kind needs to
  analyze one. Both are the host's own manifest machinery, so the SDK grows a
  seam for it (below).
- The other seven `Assert.*` kinds — `Equals`, `Contains`, `Matches`, `Schema`,
  `Events` and the comparison helpers — depend on nothing but the SDK today and
  are untouched.

**The SDK gains a runtime seam: run a manifest, analyze a manifest.**
`ctx.runtime.run(source, { env })` loads and starts a child manifest isolated
from the caller's and resolves — once the child has **started**, not once it has
finished — to `{ stdout, stderr, exitCode }`: the two streams are `Stream<string>`
(the SDK's own transport-neutral primitive) and `exitCode` is a promise that
settles at completion. Resolving early is what lets the caller consume output
while the child runs, which is the whole point of returning streams.
`ctx.runtime.check(source, { desugarImports })` runs the static-analysis pass and
resolves to the diagnostics plus the load error, if any. Both result shapes are
declared in the SDK as plain serializable data, so no kernel or analyzer class
crosses the boundary and the seam is implementable by a kernel in any language.

Output is a stream rather than a captured string or a caller-supplied sink. It
keeps Node's `Writable` out of the contract just as effectively — `test`'s
`BufferedWritable` and `assert`'s hand-rolled `LocalFileSource` both still go
away — but it leaves the buffer-vs-forward-vs-both decision with the caller,
which a returned string forecloses. That decision is load-bearing for the first
consumer: `test` forwards a single test's output to `ctx.stdout` live *and*
retains it to print on failure, and today it can only do one or the other
because the choice is made at the call. Returning a stream is also what keeps a
long-running child from buffering without bound, which a supervisor or a
workflow engine running an open-ended sub-manifest requires and a `string` field
cannot express. A convenience that drains a stream to a string composes on top;
the reverse does not. The kernel implements it over the
`Kernel` / `LocalFileSource` / `Loader` / `StaticAnalyzer` it already owns; it
depends on `@telorun/analyzer` today, so nothing new enters its closure.
Isolation mode is deliberately the kernel's choice — an in-process child kernel
now, a subprocess later — which is what turns the process-global host-env state
into an implementation detail rather than a reason to share a module realm.

The seam is generic, not test-shaped: a workflow engine running sub-manifests, a
supervisor, the hub validating a published module and CI tooling all want one
half or the other.

**The kernel builds a local module's controller from source, so nothing has to be
built by hand.** `BundleControllerLoader` learns a `local_path` qualifier naming
the controller's TypeScript entry point. When the declaring module carries **no
artifact handle** and `local_path` resolves on disk, the loader bundles it with
esbuild and imports the result; otherwise the loader falls through to `path=`,
unchanged. The guard is the **absence of an artifact**, not the shape of the
base URI: a published module served from the on-disk manifest cache has a local
base too, so testing the base alone would put a published module on the dev path
and have it fail only because its `src/` happens not to be there. An artifact
handle means the payload is the layer, full stop. This is the third
instance of a pattern the kernel already runs twice, not a new capability:
`NapiControllerLoader` does exactly this for `pkg:cargo` (`local_path` present ⇒
build the crate, cache on the canonical source path, share one build between
concurrent callers, fail fast in `resolve()` and defer the build into the
`importInstance()` thunk), and `bundle-builder.ts` already invokes esbuild at
load time to collapse an npm controller's dependency tree. The new loader path
reuses both shapes. `tsc` leaves the run path entirely and stays a type-check on
the CI path and in the editor.

**Module authors leave changesets; `version-packages.mjs` keeps only PURL-sync.**
Changesets keeps `kernel`, `sdk`, `cli`, `analyzer`, `templating`, `packages/*`,
`k8s-runner`, `editor` and the four shared libraries. No module author writes a
changeset any more — a module's own controller change takes a hand-written
changie fragment.

- **PURL-sync stays.** It still fires for the four Tier C modules that keep a
  pinned `pkg:npm` candidate: without it a controller npm bump leaves the
  manifest pinned to the previous version, so the module publishes new and loads
  old. For a bundled module it is already a no-op — no `pkg:npm` PURL matches —
  so the step needs no scoping, only retention, and it retires itself when Tier C
  lands.
- **Auto-fragment goes.** It inferred "this module's bundle changed" from "this
  module's `nodejs` package version moved", which after the migration is a proxy
  for a dependency bump — and a proxy that misses a lockfile-only move and fires
  on a version bump that changed no emitted byte. The publish-time digest gate
  above decides the same question from the bytes themselves, so the inference has
  nothing left to add.

`scripts/check-changie-fragments.mjs` gains the gate for the author-visible half:
a change under `modules/<name>/**` that **reaches the published artifact**
requires a pending fragment for `<name>`. That qualifier carries the rule.
Excluded: docs, plans and READMEs (nothing a consumer receives); `nodejs/` for a
module that delivers no bundled controller, where it is a pure npm package
governed by changesets and the artifact is `telo.yaml` plus what `files:` selects
— asking for a fragment there would bump `metadata.version` and republish bytes
that did not move, the spurious churn the digest gate exists to avoid; and a
module whose version already moved on the branch or that does not exist at the
base ref, a release already accounted for and a new module with no published
predecessor to fail to reach. A module that *does* bundle a controller has its
sources as bundle inputs, so `nodejs/**` counts there. The digest gate covers the other half — everything
that changes a bundle from outside the module's own directory — and it is the
backstop for both, since it runs on the artifact that is actually about to ship.

One CI adjustment falls out. `pnpm changeset status --since` fails a PR that
changed a versionable package while carrying no changeset at all, and a private
package is versionable by default — which is what keeps the `-build` dependents
bumping. After the migration a module-only PR (fragment, no changeset) is the
common case, so the step moves behind `scripts/check-changeset-status.mjs`, which
computes the changed set from the diff, treats a changed private `-build` package
as satisfied by its module's changie fragment, and fails only for a changed
*published* package with no changeset. It computes the set itself rather than
parsing `changeset status --output`, which writes no report on the failing path —
the only path this gate cares about.

`scripts/publish-packages.mjs` gains one pass. `--skip-controllers` and layer
bundling are untouched, but the script's two existing gates (version moved,
version absent from OCI) both *skip* a module already published at its current
version — which is exactly the module a shared-library fix silently changed. A
third pass runs `telo publish --dry-run` over every skipped module, so the digest
comparison happens and the release fails loudly instead of shipping the fix to
nobody.

Each migrated module takes a hand-written `Added` fragment, so its
`metadata.version` bumps minor for the first npm-less release; the
`partition-layers` change and the publish digest gate take a changeset against
`@telorun/cli`, the `local_path` loader change one against `@telorun/kernel`,
and the runtime seam
plus the `RecordBuffer` move one against `@telorun/sdk` and `@telorun/kernel`
together — all minor. Already-published
`@telorun/<module>` packages are left on npm untouched, so manifests pinned to an
older module version keep resolving. `NpmControllerLoader` stays in the kernel —
third-party modules may still ship `pkg:npm`, and the four deferred modules do.

Delivered as one PR.

## Decisions

- **The kernel builds from source rather than a manual build step preceding every
  run.** Requiring `pnpm run bundle` before `telo run` would be a real regression
  against today, where an npm-backed module loads straight from `src/*.ts` under
  Bun. Building in the loader keeps the zero-step loop and costs nothing extra,
  since the build is lazy per kind and cached.
- **`local_path` names a source, rather than making the `.ts` a second
  `controllers:` candidate.** A candidate list falls through only on
  `ControllerEnvMissingError`, and a `.ts` file that exists on disk raises a
  syntax error under Node instead — so the fallthrough would not fire. A
  qualifier on the one candidate also keeps a single PURL describing both modes,
  as `pkg:cargo` does.
- **esbuild through the kernel's existing `optionalDependency`, not a downloaded
  bundler.** It is already installed with `@telorun/cli` today (via
  `@telorun/kernel`), so the dev build adds no bytes; npm resolves only the
  host's platform binary (~12 MB, not 26 × that); and it is the same bundler
  `telo publish` uses, so the bundle a contributor runs is the bundle that ships.
  A downloaded rsbuild would add tens of megabytes beside the esbuild already
  present, put a second bundler in the repo, and reintroduce dev/production
  divergence. "Same bundler" has to mean the same *version*, not just the same
  name — matching flags across two esbuild releases does not give matching bytes,
  and the whole point is that a bug reproducible in the shipped bundle is
  reproducible in development. The version is declared once as a pnpm catalog
  entry that the kernel and every module's build package reference, so it cannot
  drift between them.
- **A production install needs no bundler, and neither does a built working
  copy.** esbuild is *optional*, so an install that skips optional dependencies
  still loads published artifacts, which ship prebuilt bundles. Its availability
  is therefore checked at **resolve** time and selects between the two branches
  of the same PURL: bundler present ⇒ build from `local_path`, absent ⇒ import
  `path=`. Deciding it lazily inside the build would turn "no bundler" into a hard
  failure standing next to a perfectly good `.mjs` — and the candidate list could
  not rescue it, because the fallback belongs to this candidate, not a sibling.
  A build *failure* still propagates: that is user code, not a missing
  environment.
- **Controller entry points become implicit rather than keeping `files:` as the
  single payload declaration.** Requiring both means every module restates in
  `files:` what `controllers:` already says, and the publish-time error exists
  only to catch the omission. The cost is that a module declaring no `files:`
  has no route into the artifact for a file its entry point emits alongside
  itself — a code-split chunk or a sourcemap. Not live: `--bundle` without
  `--splitting` emits exactly one file per entry point, which is what every
  module does, and a module that later splits declares `files:` again.
- **`assert`, `otlp` and `test` migrate rather than being deferred.** Leaving
  them out would keep the entire npm publish path alive for the three modules
  every test manifest imports, retiring the machinery for nobody.
- **They migrate through a seam rather than a wider realm collapse.** Collapsing
  `@telorun/kernel` and `@telorun/analyzer` would make kernel internals an
  unversioned ABI between a published artifact and whatever kernel loads it:
  today those modules pin a compatible range through npm, and after collapse
  they would bind to the host's copy with no constraint expressible and a
  mismatch surfacing as a `TypeError` inside a controller. It would also
  contradict the rule that realm collapse is for names where identity is
  load-bearing — `assert` uses the analyzer as pure functions over manifest
  text, with nothing `instanceof`-checked across the boundary. A versioned SDK
  contract carries the same coupling explicitly.
- **The seam is a capability, not a `Telo.TestSuite` doc kind, and neither
  module becomes a kernel primitive.** `Telo.Application` / `Telo.Library` is a
  structural split — runnable root vs importable unit — and it is exhaustive; a
  test suite already *is* an application (`test-suite.yaml` is one today). "Test
  suite" is a domain label, and a third root kind would make every root-kind
  check three-way in the loader, analyzer, editor and hub, with
  `Telo.Benchmark` / `Telo.Migration` following the same argument. Making
  `Test.Suite` / `Assert.*` kernel built-ins would put a test runner and an
  assertion library into every language's conformance surface; the established
  answer for a kind needing a per-runtime implementation is a second controller
  candidate (`starlark` ships `pkg:telo/local/js` and `pkg:cargo` side by side).
  A `telo test` verb that discovers manifests by the kind inside them stays
  available later without any grammar change.
- **`RecordBuffer` lands in the SDK rather than a new `@telorun/logging`.** The
  shared sink-side surface is one dependency-free class; a package for it costs
  a version ledger, a changeset per change and another `-build` dependency to
  relocate what the SDK's charter already claims — `Stream` and `InvokeError`
  are the precedent for concrete classes living there. A logging package is
  worth revisiting when the encoders become shareable; `otlp` hand-rolls its own
  today.
- **Old npm packages are left published, not deprecated or unpublished.**
  Deprecation warns consumers of pinned older manifests that are working
  correctly; unpublishing breaks them.
- **`NpmControllerLoader` is retained.** Dropping npm from the standard library
  is a delivery choice; removing the loader would be a breaking change to
  third-party modules and is a separate decision.
- **Tier C is deferred rather than attempted with a workaround.** Vendoring every
  platform's binary into one neutral layer would make every consumer download
  every platform. Platform-qualified layers are the designed answer and deserve
  their own change.
- **Shared TS libraries are inlined per consumer, not realm-collapsed.** They
  carry no cross-boundary identity — the resources they operate on are Telo
  instances duck-typed through the invocation contract — so duplication costs
  bytes and nothing else. Realm collapse is reserved for names where identity is
  load-bearing.
- **Republish propagation is decided from bytes, not from a version ledger.**
  Inlining moves the coupling from load time to build time; it does not remove
  it, and every inlined dependency inherits the problem, not just the four TS
  libraries — a lockfile-only bump of a transitive `fastify` dependency changes a
  dozen modules' bundles while moving no version and touching no file any of them
  owns. A ledger can only ever approximate that set: it misses what no version
  records and fires on version moves that changed no emitted byte. Comparing the
  built layer's `integrity` against the last published one answers the question
  directly, and the digest is already in the artifact for exactly this kind of
  verification. Keeping the four libraries on npm is therefore justified by
  their being a **public TS surface a third-party controller author compiles
  against** — which stands on its own — and no longer by propagation signalling.
- **`version-packages.mjs` keeps PURL-sync and loses auto-fragment.** "Modules
  leave changesets" describes who *writes* a changeset, not what the release step
  computes, and a Tier C module's PURL falling behind its own npm package is
  still outside any author's view and silent when missed. Auto-fragment answered
  the propagation question by proxy and the digest gate now answers it directly;
  keeping both would mean two mechanisms disagreeing about when a republish is
  needed. PURL-sync needs no scoping to survive: it matches nothing in a bundled
  manifest, so it retires itself when Tier C lands.
- **The dev-build cache is keyed on the full input set rather than staleness-
  checked.** The bundle's inputs are a graph spanning the module's own sources,
  the shared TS libraries and the dependency tree, so any check anchored on the
  entry point is wrong for the most common edit — a sibling file or a shared
  library. Signing the metafile's full input set makes a changed input a different
  key, so there is nothing to invalidate and nothing to get wrong. It also makes
  the cross-process race benign, which matters because the test suite spawns a
  kernel process per manifest and an in-process single-flight gate cannot see
  them. The signature is **stat-based (path, size, mtime), not content-based**:
  the set spans a whole dependency tree, where a few thousand stats cost less than
  the build they avoid and hashing every byte would cost more. The trade is a
  checkout that restores identical files rebuilding rather than hitting the cache;
  it never costs correctness of what ships, since a published artifact never takes
  this path. Each build prunes the bundle it replaced, so a long-lived checkout
  does not accumulate one `.mjs` per save.
- **Watch mode reads the same input set.** A local module's controller is built
  from its sources, so an edit there has to trigger the restart an edit to
  `telo.yaml` already does — and the set that matters is the build's, not the
  entry point's directory, which would both miss a shared library one directory
  over and sweep in `dist/`. The controller PURLs come from the manifests the
  loader already parsed rather than a rescan of the text, so a PURL wrapped across
  lines cannot silently drop out of the watch set.
- **The runtime seam returns streams rather than captured strings.** Both keep
  Node's `Writable` out of the contract, but a string is produced only at the
  end, so it forecloses the tee `test` needs: forward a run's output live *and*
  retain it to print on failure. `Stream` is already the SDK's transport-neutral
  primitive for exactly this and is implementable by a kernel in any language.
  Draining to a string composes on top of a stream; the reverse does not.
- **What bounds an unread child is `cancel()`, not the stream.** Withholding a
  `Writable`'s write callback only moves chunks into its own unbounded internal
  buffer, and a controller writing to `ctx.stdout` never awaits `drain` — so
  "streams give backpressure" would have been a guarantee the implementation does
  not deliver. `RuntimeRun.cancel()` is the real bound, and it is on the contract
  from the start rather than added later: termination is the first thing a
  supervisor or a workflow engine running an open-ended sub-manifest needs, and
  retrofitting it onto a published SDK interface would be a breaking change.
- **The five abstract-bearing modules keep publishing rather than going private
  with the rest.** `ai`, `cache`, `sql`, `embedding` and `vector-store` each
  export a TS contract their own backends compile against, in-repo and out. Taking
  them private would work inside the workspace and silently close the door on a
  third-party `Cache.Store` or `Sql.Connection`, which is the same argument that
  keeps `codec` and `kv-store` published — the only difference is that these five
  also carry controllers, and those move into bundles either way.
- **`assert` and `test` reach the analyzer and the kernel through the seam rather
  than inlining them.** Inlining is what the shared TS libraries do and it would
  compile here too, but it changes what the modules assert *about*: `Assert.Manifest`
  would check a manifest against an analyzer copy frozen into its own bundle at
  publish time, not the analyzer the running kernel uses, and `Test.Suite` would
  run tests on a second kernel rather than the host's. The seam is what keeps both
  pointed at the host.

## After the change

A module's `nodejs/` loses its `dist/` and its changesets-generated
`CHANGELOG.md`, and — for `test`, `otlp` and `assert` — its `@telorun/kernel` /
`@telorun/analyzer` dependency, leaving `@telorun/sdk` as the only `@telorun/*`
name any migrated module keeps external at bundle time. It gains the emitted
`nodejs/*.mjs` — build artifacts already
covered by `modules/*/nodejs/*.mjs` in `.gitignore` and never committed. Its
`tsconfig.lib.json` flips to `noEmit: true`, the shape the six bundled modules
already have: `tsc` becomes a pure type-check with nothing to emit. The module's
own root `CHANGELOG.md` stays — changie owns it.

### Development flow

**There is no build step.** `pnpm run telo ./manifest.yaml` on a fresh clone
works after `pnpm install`, as it does today. Editing a controller's `src/*.ts`
and re-running picks the change up. The `build:bundles` prestep on the root
`test` script goes away rather than growing to cover every module.

What makes that work is the loader. A module resolved from a local path carries
`local_path` on its controller PURL, so `BundleControllerLoader` finds the
TypeScript entry beside the manifest and bundles it with esbuild into the
kernel's cache. The build is deferred into the `importInstance()` thunk, so it is
paid on a kind's first instantiation rather than at boot, and only for the kinds
a manifest actually uses — a manifest importing three modules pays three builds
of roughly 20 ms each, then cache hits. A published module never takes this path:
it arrives with an artifact handle, so the prebuilt bundle in the controller
layer is imported directly.

**The cache is content-addressed, and written atomically.** The output path is
`<hash>.mjs`, where the hash covers **every input esbuild's metafile reports** —
the module's own `src/**`, the shared TS libraries it inlines, and its
dependencies — not just the entry point. That is the difference between correct
and subtly wrong: the bundle is a graph, so an mtime check anchored on the entry
serves a stale controller after an edit to a sibling file or to `codec`, which is
the same silent-stale-copy failure the digest gate exists to prevent,
reintroduced in the loop where it is least visible. Content-addressing removes
the staleness question rather than answering it — a changed input is a different
key, so there is nothing to invalidate.

It also removes a race the single-flight gate cannot cover. `pnpm run test`
spawns a fresh kernel **process** per test manifest, so the contention is between
processes, not between instantiations inside one; an in-process gate leaves two
kernels writing the same output while a third imports it half-written. The napi
loader gets away with process-local dedupe only because cargo locks its own
target directory, and esbuild has no equivalent. With a content-addressed path
plus write-to-temp-then-rename, a cross-process race degrades to a duplicate
build of identical bytes — wasted milliseconds, never a torn import. The
in-process single-flight stays as the cheap common-case win.

`telo check` is unaffected in either mode — `analyzeOnly` stops before module
instantiation, so static analysis never resolves a controller, let alone builds
one.

Watch mode needs nothing new in the kernel. `telo run --watch` already restarts
the kernel on change, and a fresh process rebuilds whatever sources moved. The
only change is adding each local module's controller sources to the watched set
so an edit under `src/` triggers the restart that an edit to `telo.yaml` already
does.

Type-checking leaves the run path. `tsc` no longer gates running a manifest; it
runs per module under `pnpm -r build` on CI and continuously in the editor, where
each module's `tsconfig.json` is unchanged and `tsconfig.lib.json` is now
`noEmit` — except for the five contract modules, whose `dist/` *is* their
published surface and which still emit. A type error surfaces in the editor and
in CI but no longer blocks an inner-loop run — deliberate, since esbuild strips
types without checking them and the two were previously coupled only by sharing a
script.

`pnpm run build:bundles` (`pnpm --filter "./modules/**" run build`) materializes
every module's bundle through its own `build` script — ~1 s for all of them. It is
no longer on anyone's inner loop: it exists so CI and `telo publish` can
materialize every bundle up front, and as the escape hatch for reproducing
exactly what ships.

Those scripts and the kernel's dev build **must pass the same esbuild options**,
or the bundle a contributor runs is not the bundle that ships. The kernel's set
lives in one place (`CONTROLLER_BUNDLE_OPTIONS`, `source-bundle-builder.ts`) and
the `build` scripts mirror it flag for flag. Two of them are not optional:

- `--banner:js` defining `require` in module scope, so esbuild's `__require`
  shim — emitted for any bundled CJS dependency — resolves instead of throwing
  "Dynamic require of X is not supported" under Node. Bun tolerates its absence,
  which is exactly why it has to be verified on both.
- `--conditions=source`, so an inlined workspace TS library resolves to its
  `src/` rather than its `dist/`. Without it, building a controller depends on
  having built every library it inlines — which is the build step this design
  exists to remove, and which fails on a fresh clone with "Could not resolve".
  Every inlined package declares `source` ahead of `import` in its `exports`;
  `dist/` remains what an npm consumer gets, and what `tsc` still emits for the
  nine packages that publish.

The options are folded into the dev cache key too, so changing them invalidates
cached bundles the same way an edited source does.

### Consumers

A consumer importing `std/run@0.14.0` from OCI receives one artifact: the
manifest layer carrying `telo.yaml`, and a `js` controller layer carrying the
bundles. Nothing is fetched from npm at any point in load, and the only version
a consumer ever names is `metadata.version` — whether the change behind it was
written in that module or inlined into its bundle from a shared library.
