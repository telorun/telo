# Lazy controller loading + per-controller bundles

## Problem

On a k8s session pod the dependency cache is baked correctly: `telo install` →
`/telo-cache`, reused read-only, every controller resolves `source: cache`, no
re-download. The pain is **cold-start boot latency**, and it has two compounding
causes:

1. The kernel **eagerly loads a controller for every `Telo.Definition`** in the
   import graph at init — even kinds the app never instantiates. A SQLite-only
   app still pays ~2.6s to import `pg` (pure JS) because `@telorun/sql` declares
   a Postgres connection kind.
2. Each load reads a **large loose-file `node_modules` tree cold** off the image
   overlay filesystem (hundreds of tiny stats/reads), with native bindings
   `dlopen`'d on top.

## Solution

Two composing layers. **Lazy loading is the universal, language-agnostic
baseline**; **bundling is a Node-only accelerator** for the JS that remains.

### Phase 1 — Lazy controller loading (kernel)

Today every `Telo.Definition` **loads and registers** its controller eagerly at
its own init:
[resource-definition-controller.ts](../src/controllers/resource-definition/resource-definition-controller.ts)
calls `ctx.registerController` → [kernel.ts:165](../src/kernel.ts#L165), which
both stores the controller and fires its `register()` hook. This runs in Phase 5
init, *after* static analysis. A missing controller at instantiation is a **hard
throw** in `_createInstance` ([kernel.ts:906](../src/kernel.ts#L906)) — there is
no return-null retry for it (that retry exists only for `create()` deferring on
unready dependencies). So Phase 1 is not flipping one branch; it adds a new async
path. Split a definition's controller handling into three stages:

1. **Resolve — eager (Definition.init).** Definition.init keeps verifying its
   `controllers` candidate list is *hostable* (package/bundle present, format
   this kernel can host) but stops before importing/evaluating the module. This
   preserves today's early, clear "this kind's controller can't load" failure at
   boot for the common cases (bad PURL, env-miss, missing package/bundle), which
   a full deferral would push to mid-run. Cache-hit verification only, so
   read-only-safe. The npm loader already separates this (`installPackage`
   cache-check) from the import (`loadFromInstall`); the bundle loader's
   existence/format check likewise precedes its `import()`.
2. **Import + register — lazy (first instantiation).** The module is imported,
   evaluated, and `register()` fired the first time a resource of that kind
   reaches `_createInstance`. `_createInstance` gains a **new branch**: on a
   missing controller for a kind whose definition resolved a controller, trigger
   a **memoized, single-flighted per-kind** import+register, then re-resolve and
   proceed. Genuinely-unknown kinds (abstract, or no definition) keep throwing.
   Schema baking (`precompileDefinitionSchemas`, which reads definition schemas
   from `staticManifests`, not loaded controllers), reference validation, and the
   `analyzeOnly` bake are unaffected — they never needed the controller instance.
3. Definitions whose kind is never instantiated never import their controller.
   `telo install` still bakes the full npm cache — lazy changes only import
   timing, not what is installed.

This requires splitting `ControllerLoader.load` into a **resolve** step and an
**import** step, and threading the lazy import+register into the async create
phase. That integration with the multi-pass create/init loop — not a one-line
change — is the real risk in Phase 1.

**`register()` invariant.** The controller instance only exists after import, so
lazy import means lazy `register()`. `register()` already runs in Phase 5 *after*
static analysis today (via `registerController`), so **analyzability is not at
risk** — the analyzer relies on definition metadata, not `register()` effects.
The residual risk is *cross-kind* ordering: a controller whose `register()`
produces state another resource consumes during init. Committed invariant:
**`register()` must not have effects consumed before its own kind's first
instantiation.** Implementation audits existing controllers' `register()` usage
against this; any that violate it keep importing eagerly at Definition.init.

### Phase 2 — Transparent npm-controller bundling (kernel)

A purely kernel-side load-time optimization layered on the npm loader. The
controller PURL stays `pkg:npm/...` **everywhere — locally and after publish**;
there is no `pkg:telo` rewrite, no `nativeDependencies` field, and no publish /
registry change. Bundling is an accelerator over npm resolution, transparent to
authors and consumers.

How it works, per controller (subpath):

- **Inspect → build → import.** After the npm loader installs / verifies the
  package (unchanged — the full dependency tree lands in `.telo/npm` as today),
  the import step checks for a cached bundle keyed by `(package, version,
  subpath)`. Present → `import()` it. Absent, with esbuild available on a writable
  cache → **build it** (esbuild the package's resolved entry for that subpath)
  into `.telo/npm/.telo-bundles/<alias>.mjs`, then import. esbuild absent, or a
  read-only FS with no cached bundle → **fall back to today's loose
  `loadFromInstall`**. A pure accelerator that never blocks.
- **Externals auto-detected at bundle time.** An esbuild plugin marks a bare
  import **external** when its resolved package ships a `.node` (or carries
  `gypfile` / `binary` / prebuild markers); the realm names
  (`REALM_COLLAPSE_NAMES`) are always external. Everything else inlines. No
  declaration — the native set is read from the **real installed tree**. Because
  the **full npm install is kept**, every auto-externalized native is already on
  disk: externals ⊆ install **by construction**, so the externals/install
  divergence that forced the old declared-allowlist apparatus simply cannot occur.
- **Externals resolve for free.** The cached bundle lives *inside* the install
  root (`.telo/npm/.telo-bundles/`), so Node's normal walk-up resolves both
  `@telorun/sdk` (realm) and the native externals from the existing
  `.telo/npm/node_modules`. No symlink bridge.
- **Parity is automatic.** The bundle is built from the *same pinned npm package*
  (`pkg:npm/...@version`) in every environment, so "works under `telo run`" and
  "works after publish" are the same bytes by construction — nothing to keep in
  sync, no sandboxing tricks, no smoke-import gate. A `local_path` dev build vs a
  registry build differ only as far as the *source* already differs today (the
  existing npm-publish reality), never because bundling introduced a new path.
- **Where it builds.** `telo install` builds the bundles into the bake (writable),
  so the runtime imports a single baked file. `telo run` builds-on-demand and
  caches when writable. Composes with Phase 1: only *instantiated* kinds are ever
  imported, and each such import reads one bundle instead of a cold loose tree.

Tradeoff: the **full npm tree stays on disk** beside the bundle (`pg`'s loose
files, unused). The latency win (import one bundle, not hundreds of cold files)
is fully preserved; the disk-slimming of the earlier `pkg:telo` design is dropped
as an optional future follow-on (prune inlined-JS deps post-bundle), not needed
for the goal.

Net: `pg`'s ~2.6s cold import collapses to one bundled file; `better-sqlite3`
stays a single external `dlopen` from the installed tree; the controller PURL and
the publish flow are untouched.

## Decisions

- **Lazy is the baseline, bundling the accelerator — not either/or.** Lazy works
  for every controller language/runtime (a kernel decision about *when* to
  load); bundling only helps JS. Rejected "build-time used-only bundle instead of
  lazy": Node-only, bake-path-only, and conservative about reachability where
  runtime lazy is exact.
- **Lazy trigger = a new `_createInstance` branch, not a reused seam.** The
  missing-controller case throws today (the only return-null retry is the
  `create()`-deferral path), so Phase 1 introduces an async import+register
  integrated into the create phase, memoized + single-flighted per kind. This
  integration with the multi-pass init loop is the main Phase 1 risk — it is
  explicitly *not* a one-line change.
- **Resolve eagerly, import lazily — to keep errors early.** Verifying a
  controller candidate is hostable at Definition.init (without importing)
  preserves today's boot-time failure for unhostable/missing controllers while
  still skipping the expensive import/eval of unused kinds. Requires splitting
  the loader into resolve + import. Rejected *full* deferral (resolve included):
  it would move common "controller can't load" failures from boot to
  arbitrarily-late mid-run (deepest for kinds created in on-demand scopes),
  regressing the surface-errors-early goal. Accepted residual: failures that only
  manifest at module eval (a broken body, missing export) still surface at first
  use.
- **`register()` becomes lazy with the import; invariant instead of ordering.**
  The instance doesn't exist until import, so `register()` can't stay eager
  without killing the win. Safe because `register()` already runs after static
  analysis today — analyzability is unaffected. The committed invariant is no
  cross-kind `register()` effects consumed before that kind's first
  instantiation, verified by auditing existing controllers; violators stay eager.
- **Bundling is transparent over npm — the PURL never changes.** A controller is
  `pkg:npm/...` locally and after publish; the bundle is a load-time cache the
  loader builds and consults, not a delivery format. Rejected the `pkg:telo` +
  publish-rewrite design: it gave the *same controller two PURLs* (source locally,
  bundle after publish), which is exactly the divergence — and the surprise — we
  set out to remove. As a bonus this drops the entire publish / registry tar.gz /
  consumer-extraction body of work and the dependence on bundle-controllers.md
  steps 5–7.
- **Per-controller (subpath) bundles, never per-module / whole-app.** A single
  bundle that pulls every kind in evaluates them all on import — eager by
  construction, exactly what Phase 1 removes. One bundle per controller subpath
  composes with lazy loading.
- **Natives auto-detected, full install kept — no declaration.** The esbuild
  plugin externalizes any package that ships a `.node` (read from the real
  installed tree); the full npm install stays on disk, so every external is
  present and externals ⊆ install by construction. Rejected the declared
  `nativeDependencies` allowlist + slimmed install: it created an externals-vs-
  install gap (review point 3) that only existed *because* the install was
  slimmed. Keeping the full install makes auto-detection safe and the declaration
  redundant. Accepted tradeoff: inlined-JS deps sit unused on disk; pruning them
  is an optional future slim, not needed for the latency win.
- **Parity is structural, not enforced.** Building from the same pinned npm
  package in every environment makes local and published execution identical bytes
  by construction — so there's no need for a smoke-import gate, sandboxed
  resolution, or build-once-ship-the-bundle machinery (all of which the old design
  needed precisely because it ran source one way and a bundle another). No bundle
  is ever shipped in a registry artifact; each environment builds its own from the
  pinned package and gets the same result.
- **The bundler lives in the kernel, esbuild lazy-optional.** It sits in the npm
  loader's import step, beside the loaders that already build on the fly
  (`npm install`, `cargo build`), so programmatic `Kernel` users get bundling too
  — not a CLI-only capability. esbuild is imported on demand and env-misses to the
  loose-import fallback if absent, so consumers that can't or won't bundle still
  run. Rejected `@telorun/cli` home: it would strand programmatic users and split
  the build-on-the-fly symmetry the npm/napi loaders establish.
- **`telo install` keeps the full install; it additionally builds bundles.**
  Phase 1 does not touch `telo install`. Phase 2 leaves the npm install exactly as
  today (full tree) and adds a bundle-build pass into the bake, so the runtime
  imports one baked file per used controller. No native-fetch or slimming change —
  the natives are already in the full install.
- **Plan lives in `kernel/nodejs/plans/`** — lazy loading (the load-bearing
  piece) is kernel-centric, and the bundling delta extends the kernel-side
  `bundle-controllers.md`.

## Example after the change

A manifest imports `@telorun/sql` (which declares both Postgres and SQLite
connection kinds) but instantiates only SQLite:

- **Boot:** the kernel registers both connection definitions (metadata only). It
  instantiates the SQLite connection → lazy-loads *that* controller, importing its
  cached bundle (`.telo/npm/.telo-bundles/...`, one file) and `dlopen`ing the
  external `better-sqlite3` from `.telo/npm/node_modules`. The Postgres controller
  and `pg` are **never imported**. The controller PURL is the same
  `pkg:npm/@telorun/sql@...` it always was.
- **Latency:** the ~2.6s `pg` cold import disappears entirely (never loaded); the
  SQLite path drops from a loose-file tree to one bundle + one native `dlopen`.
- **No esbuild present (or read-only, no cached bundle):** the loader falls back
  to today's loose `loadFromInstall` — slower, but identical behavior. Lazy
  loading still skips `pg` regardless.

## Sequencing

1. **Phase 1 lazy loading** — independent of bundling, ships first, helps every
   runtime immediately. Land + test before touching the bundle path.
2. **Phase 2 transparent npm-controller bundling** — kernel-only, no publish /
   registry work (independent of bundle-controllers.md steps 5–7). Lands as:
   (a) `buildControllerBundle()` in the kernel — esbuild (lazy-optional) with the
   native-externalizing plugin, content-addressed output under
   `.telo/npm/.telo-bundles/`; (b) the npm loader's import step inspects for a
   cached bundle and builds-on-demand, falling back to loose `loadFromInstall`;
   (c) `telo install` adds the bundle-build pass to the bake. The PURL, publish
   flow, and manifest schema are untouched.

## Testing

- **Kernel (Phase 1):** a kind whose definition is imported but never
  instantiated loads no controller (assert via the `ControllerLoaded` event
  stream); a kind instantiated N times concurrently imports its controller once
  and fires `register()` once; an **unhostable/missing** controller still fails
  at boot (eager resolve) even when the kind is never instantiated, while a
  module that only throws at eval surfaces at first instantiation; `analyzeOnly`
  still bakes every definition schema with no controller imported; audit that no
  shipped controller's `register()` has effects consumed before its kind's first
  instantiation.
- **Bundling (Phase 2):** a controller with a third-party JS dep bundles to one
  file that inlines the dep and resolves `@telorun/sdk` correctly (`Stream`
  identity preserved); a controller with a native dep externalizes it (the bundle
  does not inline the `.node`) and the native `dlopen`s from `.telo/npm` at import;
  the bundle is content-addressed by `(package, version, subpath)` and reused on
  the second load.
- **Fallback (Phase 2):** with esbuild absent, or a read-only FS and no cached
  bundle, the loader serves the loose `loadFromInstall` path with identical
  behavior — bundling never blocks a run.
- **Parity (Phase 2):** the bundle built under `telo run` is byte-identical to the
  one `telo install` bakes for the same pinned package (same `(package, version,
  subpath)` → same content hash); the PURL is unchanged across both.
- **End-to-end:** a SQLite-only manifest boots without `pg` being imported
  (event stream shows no Postgres controller load) and runs from the SQLite
  bundle + external `better-sqlite3`; a Postgres manifest works via its bundle +
  external `pg`.
