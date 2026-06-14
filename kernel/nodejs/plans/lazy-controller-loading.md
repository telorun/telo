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

### Phase 2 — Per-controller bundles with native externals (publish + build)

Builds directly on [bundle-controllers.md](./bundle-controllers.md)
(`pkg:telo/local/js` delivery, `BundleControllerLoader`, realm symlinks,
registry tar.gz, esbuild publish path). Two deltas:

- **Per-controller granularity.** The publish bundler emits **one bundle per
  controller export** (`pkg:telo/local/js?path=…#export`), not one per module —
  so importing the SQLite kind never drags Postgres in. Per-module / whole-app
  bundles are rejected: they re-couple kinds and defeat lazy loading.
- **Native-external hybrid** (supersedes that plan's "refuse non-bundleable
  deps" stance). The bundler inlines the **pure-JS closure** and marks native
  packages (`*.node` deps + a module-declared native allowlist) **external**,
  alongside the already-external realm names. A bundled module declares its
  native deps in its manifest; `telo install` npm-installs **only those** into
  `/telo-cache/npm`, and `ensureRealmSymlinks`
  ([bundle-loader.ts](../src/controller-loaders/bundle-loader.ts)) is extended to
  link the declared natives next to the bundle so the bare `import` resolves.
  Native binaries are fetched by npm **at build time only** (leveraging
  prebuild-install / prebuildify / node-gyp); the runtime stays hermetic — the
  `.node` is baked into the image and just `dlopen`s.

Net: `pg` (pure JS) collapses to one file; `better-sqlite3` stays a single
external `dlopen` (irreducible); pure-JS modules (`console`, `run`) need no npm
install at all.

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
- **Per-controller bundles, never per-module / whole-app.** A single bundle that
  pulls every kind in evaluates them all on import — eager by construction,
  exactly what we're removing.
- **Native deps stay external + npm-installed at build time.** esbuild can't
  inline a platform/ABI-specific `.node`, and reimplementing prebuilt-binary
  fetch + ABI selection is large and fragile. npm at build time handles every
  native flavor uniformly and the runtime is hermetic regardless. Rejected, noted
  as future: npm-free prebuildify tarball-extract (partial — fails for
  prebuild-install packages) and Telo-owned `pkg:telo/local/napi` delivery
  (applies only to Telo-authored controllers; a separate large initiative).
- **`telo install` unchanged for the cache.** Keeps the bake hermetic and the
  change small; slimming the install to natives-only is an optional follow-on,
  not required for the latency win (the bundle's import-time win lands whether or
  not `pg` is still on disk).
- **Plan lives in `kernel/nodejs/plans/`** — lazy loading (the load-bearing
  piece) is kernel-centric, and the bundling delta extends the kernel-side
  `bundle-controllers.md`.

## Example after the change

A manifest imports `@telorun/sql` (which declares both Postgres and SQLite
connection kinds) but instantiates only SQLite:

- **Boot:** the kernel registers both connection definitions (metadata only). It
  instantiates the SQLite connection → lazy-loads *that* controller's
  `pkg:telo/local/js` bundle (one file) and `dlopen`s the external
  `better-sqlite3` from the baked npm tree. The Postgres controller and `pg` are
  **never imported**.
- **Latency:** the ~2.6s `pg` cold import disappears entirely (never loaded); the
  SQLite path drops from a loose-file tree to one bundle + one native `dlopen`.
- **Same app on a future non-Node kernel:** lazy loading still applies; the
  `pkg:telo/local/js` bundle env-misses and the candidate list falls through to a
  format that kernel can host — no kernel-specific code.

## Sequencing

1. **Phase 1 lazy loading** — independent of bundling, ships first, helps every
   runtime immediately. Land + test before touching the bundle path.
2. **Phase 2 per-controller + native-external bundling** — extends
   `bundle-controllers.md` steps 5-7 (CLI publish bundler, consumer cache
   extraction) with per-export emit, the native allowlist, natives-only
   `telo install`, and the extended symlink bridge.

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
- **Publish/build (Phase 2):** per-export bundles emitted; a controller with a
  declared native dep externalizes it (bundle does not inline the `.node`);
  `telo install` installs only the declared natives; the symlink bridge resolves
  both realm names and natives next to the bundle.
- **End-to-end:** a SQLite-only manifest boots without `pg` being imported
  (event stream shows no Postgres controller load); a Postgres manifest still
  works via its bundle + external `pg`.
