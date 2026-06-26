# @telorun/kernel

## 0.39.1

### Patch Changes

- ef511d9: Fix `ERR_RESOURCE_SCHEMA_VALIDATION_FAILED` at resource init for any kind whose
  `Telo.Definition` schema carries an inline `${{ }}` template (commonly inside a
  field's `description` / `examples`) and whose controller does not export its own
  schema. The loader precompiles such templates into CompiledValue sentinels, so
  the schema reaching AJV held a non-string `description` and meta-validation
  threw "schema is invalid: …/description must be string" on a cache miss. The
  schema validator now canonicalizes CEL/template carriers to their bare source
  text before AJV compilation: sentinels collapse to their `source`, and a raw
  exact-form `"${{ expr }}"` string is reduced to the same bare `expr`. This both
  makes the schema AJV-valid and converges the build-time warm pass (raw strings)
  and the runtime (precompiled sentinels) onto one cache key, so the runtime hits
  the warmed `__validators` entry instead of recompiling — and failing to persist
  on a read-only image — every boot. Surfaced by `std/embedding-openai`
  `EmbedOpenai.Model`.

## 0.39.0

### Patch Changes

- ebca26a: Add a `CEL_IN_NON_EVAL_FIELD` analyzer diagnostic: a `!cel` (or `${{ }}`) in a field the runtime never evaluates — one with no `x-telo-eval` and outside every `x-telo-context` / `x-telo-step-context` / `x-telo-error-context` region — is now an error instead of passing silently. This closes the static gap that let a `!cel` `concurrency` on `Run.Projection`/`Run.Iteration` read as a literal and degrade to `[null, …]` at runtime. The check resolves eval-paths from both the resource's own schema and its capability abstract (so provider fields, all implicitly `x-telo-eval`, stay live) and stops at nested inline `{ kind }` resource boundaries (their CEL is governed by their own kind).

  `x-telo-eval` path handling now lives in `@telorun/analyzer` and is re-imported by the kernel, so the runtime and the analyzer share it rather than re-implementing it. Both halves are shared: `buildEvalPaths` (schema → eval paths) and the containment rule `evalPathCovers` (does an eval path cover a concrete path). The analyzer's coverage check (`evalPathsCover`) and the kernel's compile/runtime exclusion (`isExcluded`) both route through `evalPathCovers`, so a change to the matching semantics applies to both at once. The kernel's `expandPaths` keeps its own tree-walk for expansion (it mutates the value tree, not a coverage test), structurally consistent with the shared rule because eval paths are property-only.

- d84a585: Unify glob matching across the monorepo onto a single dependency-free engine in a new `@telorun/glob` package. It exports `selectByPatterns` (plus `HARD_IGNORE` / `DEFAULT_IGNORE` / `GLOB_PRUNE_DIRS`) as the one matcher used everywhere a `.gitignore`-style pattern set is resolved: `files:` bundling (`telo publish` + the editor run bundle), `include:` expansion (kernel `LocalFileSource` + the editor adapters), and test discovery (`@telorun/test`).

  This removes four divergent implementations — the kernel's `minimatch`, the editor's hand-rolled glob→regex, the test runner's own `globToRegex`, and an `ignore`-based pass — in favor of a small matcher implementing a documented **Telo glob** subset of gitignore. The subset and its exact behavior are pinned by a language-neutral conformance suite (`packages/glob/conformance/glob.json` + `README.md`) so any runtime (Node today; Rust / Go later) can reimplement it identically rather than chasing one library's quirks. The kernel drops `minimatch` and the CLI drops its direct `ignore` dependency; the matcher lives in its own package rather than the static analyzer, so consumers depend on it directly instead of reaching into `@telorun/analyzer` for a non-analysis primitive.

  The deny set is split into a non-overridable **hard** tier (`node_modules`/`.git`/`.telo`) and a soft, opt-out-able tier (`.telobundle.*`). `applyDefaultIgnore: false` (used by `include:` resolution to reach co-located partials) now only skips the soft tier — a broad `**` `include:` can no longer recurse into the manifest cache, and resolves identically in the kernel and the editor.

- Updated dependencies [ebca26a]
- Updated dependencies [d84a585]
  - @telorun/analyzer@0.29.0
  - @telorun/glob@0.2.0

## 0.38.0

### Minor Changes

- a125804: Give resources spawned by a templated kind a hierarchical identity, so the debug graph nests them under their parent and stops collapsing collisions.

  A `Telo.Definition` with a `resources:` block (e.g. `std/crud`'s `Crud.Resource`) expands into child resources whose `kind` + `name` are identical across every instance of the kind — two `Crud.Resource`s both spawn `SqlRepo.Read.reader`. The debug stream keyed nodes by name, so those children collided and only one appeared, with no link back to the owning resource.

  - **Kernel / SDK**: every resource now carries a full hierarchical `id` (`<owner.id>/<kind>.<name>`, or `<kind>.<name>` at the top level). A template controller stamps the owning resource onto the child context it registers its `resources:` into (`EvaluationContext.owner`), so the children's `Created` / `Initialized` / `Teardown` and dispatch events carry that `owner` and a unique `id`; dependency edges are id-qualified too. `ResourceContext.ownerPrefix` exposes the composing prefix so the identity stays unique when templates nest. The dependency-edge collector also skips `schema` for the system kinds whose `schema:` is definitionally a JSON-Schema contract (`Telo.Definition` / `Telo.Abstract` / `Telo.Type`): a `{kind, name}`-shaped value in a schema `examples` block is documentation data, not a `!ref`, and previously surfaced as a phantom dependency edge (e.g. every `Telo.Definition` wiring itself to a resource named in its example). Other kinds' `schema` fields are still walked, so a genuine `schema: !ref X` resolves.
  - **Resolved properties**: each `Created` event now also carries `properties` — the resource's config "after templating", with compile-time `${{ }}` / `!cel` reduced to concrete values, resolved `!ref`s (and injected live instances) shown as `{kind,name}`, deferred runtime expressions as their `${{ source }}` text, and known secret values scrubbed to `[secret]`. The node detail panel renders it as a **Properties** section above Inputs/Outputs.
  - **Wire** (`@telorun/debug-wire`): lifecycle and dispatch payloads gain `id` on the resource `ref` and an optional `owner` pointer (`WireOwner`, `WireResourceRef`, `LifecyclePayload`); `Created` adds `properties`. Additive — a legacy producer that omits `id` falls back to name-keyed identity.
  - **Debug UI**: the Graph view keys nodes by `id` and renders a templated resource as one node with an "n internal" badge. Clicking it opens a drill-down panel showing that resource plus the children it spawned (`subtreeGraph`), wired into a tree — the children connected by their own dependency edges, and the parent linked by a dashed ownership edge only to children not already reached through a sibling (so a handler reached via the Http.Api isn't also tied directly to the parent). Drilling into a child pushes another panel onto a cascading stack (recursive to any depth); panels beneath peek out on the left and click to pop back, so the main canvas never reflows. The node-detail aside now scrolls as one unit — previously its flex body collapsed each inputs/outputs payload into a tiny nested scrollbar.

### Patch Changes

- Updated dependencies [a9ac4ba]
  - @telorun/analyzer@0.28.1
  - @telorun/templating@0.10.0

## 0.37.0

### Minor Changes

- 5ea5ff3: Reconcile module versions to one version per identity within an import graph.

  When the same `<namespace>/<module-name>` is reached at multiple versions (a diamond import), the loader now collapses them onto a single version before any controller, definition, or kind is registered — fixing the spurious `DUPLICATE_IMPORT_ALIAS` and the silent last-writer-wins controller collision that two versions of one module previously caused.

  - Same major → the highest version wins (a non-lossy hoist given the additive-only pre-1.0 policy), reported as a `MODULE_VERSION_HOISTED` warning on the lower-version import line.
  - Different major → a fatal `MODULE_VERSION_CONFLICT`; `telo run` refuses to start and `telo check` errors.
  - Same version from two sources with differing content → a `MODULE_VERSION_HOISTED` warning; identical content is deduplicated silently.

  Reconciliation lives in the shared analyzer loader, so `telo check`, the kernel runtime, and the editor all resolve the same single version. `LoadedGraph` gains `overrides` and `versionDiagnostics`.

### Patch Changes

- 5ea5ff3: Inject manifest sources into the `Loader` constructor instead of constructing built-ins inside it.

  `new Loader(...)` now takes `(sources: ManifestSource[], options?: { celHandlers? })` — the caller (composition root) decides which concrete sources exist and supplies them. The previous behaviour of self-constructing `HttpSource`/`RegistrySource` (gated by `includeHttpSource`/`includeRegistrySource` flags) and the `extraSources`/`registryUrl` init options are removed. A new exported `defaultSources(registryUrl?)` bundles the browser-safe built-ins (HTTP + registry) for the common case, so consumers compose them explicitly: `new Loader([localFileSource, ...defaultSources(registryUrl)])`.

  This removes a dependency-inversion violation: the `Loader` now depends only on the `ManifestSource` abstraction and no longer imports concrete source implementations.

- Updated dependencies [5ea5ff3]
- Updated dependencies [5ea5ff3]
  - @telorun/analyzer@0.28.0

## 0.36.0

### Minor Changes

- dded615: Templated definitions can now produce a mountable HTTP surface, and their dispatch targets are created once instead of per call.

  - **`mount:` template dispatch** — a `Telo.Definition` with `capability: Telo.Mount` may declare `mount: <child>` (sibling to `invoke:` / `run:` / `provide:`) naming a `resources:` entry that is itself a `Telo.Mount` (e.g. an `Http.Api`). The template instance's `register()` delegates to that persistent child, so a library can ship a self-contained, declarative HTTP resource. The analyzer validates the new field (`MOUNT_ON_NON_MOUNT`, `MOUNT_DISPATCHER_CONFLICT`, `MOUNT_TARGET_UNKNOWN`, `MOUNT_TARGET_NOT_MOUNTABLE`).
  - **Persistent dispatch targets** — the template controller no longer re-creates its `invoke:` / `run:` / `provide:` target on every call (`withEphemeral` is removed). Every `resources:` entry is created once at `init()` and reused; per-call data flows exclusively through the top-level `inputs:` sibling. A resource body may reference only `self`; `${{ inputs.* }}` inside a target body is no longer supported (move it to the top-level `inputs:`).
  - **Library-scoped child resolution** — a template's `resources:` are spawned in a child context rooted on the _defining_ library's module context (new `EvaluationContext.spawnChildContext()`), so their internal kind aliases and `!ref`s resolve against the library's own imports rather than the consumer's.
  - **http-server** — a route declared at `/` now sits at the mount root (`/todos` + `/` → `/todos`) instead of a trailing-slash variant Fastify treats as a distinct, unmatched URL, so collection-style mounts respond at the mount path itself.

### Patch Changes

- Updated dependencies [dded615]
  - @telorun/analyzer@0.27.0
  - @telorun/templating@0.10.0

## 0.35.0

### Patch Changes

- Updated dependencies [12f6d6f]
  - @telorun/analyzer@0.26.0

## 0.34.0

### Patch Changes

- Updated dependencies [d7fda97]
  - @telorun/analyzer@0.25.0
  - @telorun/templating@0.10.0

## 0.33.0

### Minor Changes

- 95f168e: Cache, rate-limit, and background-task primitives, plus a comprehensive URL-shortener example.

  - New `cache` family: the backend-pluggable `Cache.Store` abstract with `Cache.Lookup` / `Cache.Entry` (freshness-aware: `ttl` fresh window + optional `staleTtl` grace window, `state` of `miss`/`fresh`/`stale`) and the `Cache.View` read-through decorator (single-flight background revalidation). Backends ship as `cache-memory` (`CacheMemory.Store`) and `cache-redis` (`CacheRedis.Store`, with observable degrade-to-`fallback`).
  - New `rate-limit` module: `RateLimit.Guard`, a non-throwing sliding-window limiter whose counters live in any `Cache.Store`.
  - `run` gains `Run.Detach` (generic, zero-config fire-and-forget).
  - SDK + kernel: `ResourceContext.runDetached(fn)` runs a function detached from the caller's cancellation/trace scope; the kernel tracks each detached task against its owning resource and drains it (bounded) when that resource tears down, routing failures to the EventBus. Used by `Run.Detach` and `Cache.View`'s background revalidation.
  - `http-server`: `Http.Server.trustProxy` and a derived `request.ip` in the handler CEL context (canonical client address for rate-limit keys).

### Patch Changes

- 95f168e: Fix `ERR_RESOURCE_NOT_INVOKABLE` when mounting an imported library's `Http.Api` whose route handler is a library-internal resource.

  Phase-5 dependency injection now defers a resource whose **local** (`!ref name`) reference points at another resource that is registered in the same context but not yet initialized, mirroring the existing cross-module (`!ref Alias.name`) deferral. Previously such a local ref was silently left unresolved when create-success order diverged from init order — e.g. an importer that preloads the `Http.Api` controller lets the API create and inject before its internal handler's controller has loaded — leaving the handler slot as a raw `{kind, name}` sentinel that failed at request time. `PreInitHook` gains an `isPending` predicate so the injection walk can tell a pending dependency apart from a genuinely absent reference.

  - @telorun/analyzer@0.24.1
  - @telorun/templating@0.10.0

## 0.32.0

### Minor Changes

- a8c99ab: Generic dispatch tracing: trace every capability dispatch (invoke and run) through one instrumented chokepoint and carry trace data in a structured event payload instead of the event name.

  - Dispatch events drop the kind from the name (`<name>.Invoked` / `.Run`, plus error/cancel variants). The payload now carries `{ spanId, parentSpanId, capability, phase, outcome, ref: { kind, name }, … }`; consumers read the payload and never parse the dotted name. Lifecycle events (`Kind.name.Created` / `.Initialized` / `.Teardown`) are unchanged.
  - `run()` is now span-instrumented like `invoke()`: it mints and propagates a trace id, so Runnables (e.g. a `Run.Sequence` boot target) appear in the trace and their nested invokes re-parent correctly instead of detaching as false roots. Long-lived Services emit a `<name>.Running` start span. Run failures emit `<name>.RunFailed` (rethrown, never swallowed).
  - Invoke/run emit a `<name>.Invoking` / `.Running` start span when tracing is on.
  - SDK: new `REF_IDENTITY` / `stampRefIdentity` / `getRefIdentity`. The kernel stamps a resolved `!ref`'s kind+name onto the injected instance so `executeInvokeStep` routes pre-injected live instances through the traced chokepoint instead of calling `.invoke()` directly and escaping instrumentation.
  - The boot `targets` run is wrapped in an application span (`<appName>.Run`, `ref.kind: "Telo.Application"`), so the application is the trace root with its targets nested beneath. Pre-resolved `!ref` boot targets now dispatch through a new `EvaluationContext.runResolved` (the `run()` analog of `invokeResolved`) instead of calling `instance.run()` directly, so they emit their own run spans nested under the app.
  - A `Telo.Service`'s long-lived `run()` no longer establishes the cancellation/trace ALS scope (its token is delivered via the explicit `run(invokeCtx)` argument instead). This stops the boot scope leaking onto async resources the service creates — e.g. an HTTP server's socket — so inbound work (each request) starts as its own root trace with no inherited boot cancellation token, instead of nesting under the bootstrap trace. Runnables keep the ALS scope so their steps still nest and inherit cancellation.
  - `EventBus.emit` short-circuits in O(1) when there are no subscribers, keeping the always-through-the-chokepoint dispatch effectively free when nobody is listening.
  - OpenTelemetry-ready trace model: every span carries a `traceId` (OTel-compatible 16-byte hex), minted at the root and inherited by descendants, so an exporter groups a trace without walking the parent chain. New generic `ctx.openSpan(base, { ref, label, attributes, inbound? })` primitive opens an inbound-boundary span (capability `"request"`) that roots its own trace; `inbound` allows continuing an upstream distributed trace later. The `TracePayload` gains `traceId`, `label`, and `attributes`.
  - `http-server`: each inbound request opens a request span attributed to the `Http.Api` and labelled with the route (`"POST /feedback"`, attributes `{ method, path }`); the handler invoke and its subtree nest under it, as a trace separate from the bootstrap.
  - Trace context capture: a trace's root span carries `payload.context` — a redacted snapshot of the CEL root scope available to the trace (`variables`, `resources` snapshots, `ports`, and `secrets` with values masked to `"[secret]"`; host `env` omitted). Lets a debug consumer see what data an execution could reference beyond its own inputs/outputs. The UI renders it as an "Available context" section on the root node.

### Patch Changes

- @telorun/analyzer@0.24.1
- @telorun/templating@0.10.0

## 0.31.0

### Minor Changes

- b41012f: kernel: invocation events now carry richer debug data. `<Kind>.<Name>.Invoked` is now `{ inputs, outputs }`, and the failure/cancellation events (`InvokeFailed`, `InvokeRejected`[`.Undeclared`], `InvokeCancelled`) gain an `inputs` field — so a consumer sees what a call was given on both the success and failure paths.

  Additionally, a new opt-in **invocation tracer** (`Kernel.setTracing(true)`, flipped on by the CLI debug server while attached) mints a monotonic `invocationId` per call and emits `invocationId` / `parentInvocationId` in event **metadata**, letting a consumer rebuild the call tree. Tracing is off by default and costs nothing — the zero-allocation dispatch fast path is preserved when no consumer is watching.

  Existing event fields are unchanged, but note the **exposure expansion**: `inputs` now joins `outputs` in what a `*` event consumer receives and what the CLI's `--debug` writes to `.telo.debug.jsonl`. Payloads are not secret-redacted (the `--inspect` endpoint already warns of this), so an invoke argument carrying a resolved secret — a DB password, an API key — is now persisted where before only outputs were. This is gated on a debug consumer being attached, but it is a real widening of the on-disk surface; redaction driven by the kernel's `secretValues` is a possible follow-up.

### Patch Changes

- @telorun/analyzer@0.24.1
- @telorun/templating@0.10.0

## 0.30.2

### Patch Changes

- 912044a: Controller bundles now define `require` via a `createRequire` banner, so a bundled CJS dependency that calls `require()` of a Node builtin (e.g. `tar-stream`'s `require("events")`, `yaml`'s `require("process")`) no longer throws "Dynamic require of X is not supported" when the ESM bundle is imported. The directory-relative safety guard runs against esbuild's raw output, before the banner is prepended, so it is unaffected.

## 0.30.1

### Patch Changes

- Updated dependencies [0c16f41]
  - @telorun/templating@0.10.0
  - @telorun/analyzer@0.24.1

## 0.30.0

### Minor Changes

- cce2caa: Transparent npm-controller bundling, on by default (kill-switch: `TELO_CONTROLLER_BUNDLE=0`). The npm loader collapses a controller's loose `node_modules` dependency tree into one esbuild bundle, written next to the controller's entry, so cold-start import reads a single file instead of hundreds — cutting the boot latency that dominates baked images. The controller PURL is unchanged (`pkg:npm/...`); bundling is a load-time cache over npm resolution, not a delivery format. Native packages (and the `@telorun/*` framework + the realm `@telorun/sdk`) are auto-externalized and resolve at runtime through the entry's own `node_modules`, so the full install is kept and externals can't diverge. It's a pure accelerator: esbuild is an optional dependency imported on demand, and any miss falls back to the loose import with identical behavior — esbuild absent, a read-only cache, a symlinked (`local_path`) dev install whose realpath escapes the install root, a CJS controller entry (whose named exports esbuild can't lift), an unbundleable controller, or a controller whose bundle would resolve assets relative to its own directory (`import.meta.url` / `__dirname`), which can't be safely relocated. Cached bundles are re-checked against that last guard on load, so an unsafe one self-heals to the loose import.

### Patch Changes

- Updated dependencies [aaa760d]
- Updated dependencies [aaa760d]
  - @telorun/analyzer@0.24.0
  - @telorun/templating@0.9.0

## 0.29.0

### Minor Changes

- b4e6ac8: Lazy controller loading. A `Telo.Definition`'s controller is now imported on the first instantiation of its kind rather than eagerly at definition-init, so a manifest that imports a broad module (e.g. one declaring both a Postgres and a SQLite connection kind) no longer pays the import/eval cost of controllers it never instantiates — cutting cold-start boot latency. Hostability is still verified eagerly at definition-init (the package/bundle must resolve), so a controller that can't load at all still fails fast at boot; only the expensive `import()` and the controller's `register()` hook are deferred. The `ControllerLoading`/`ControllerLoaded` events for a kind now fire on its first instantiation, with the duration measuring just the import. `ControllerLoader` gains a `resolve()` method (resolve without importing) alongside `load()`.

## 0.28.0

### Minor Changes

- d59e847: Debug UI now links to the running application's exposed ports.

  - `@telorun/debug-ui`: `DebugPanel` takes an `endpoints` prop and renders each as
    a link in its header (tcp → clickable `http://host:port`, udp → plain label).
    New `AppEndpoint` type + `endpointHref` / `endpointLabel` helpers (browser-safe,
    no runner/kernel dependency). The standalone `DebugWatcher` sources endpoints
    from the producer's `/json/version` handshake, filling a blank host from the
    page origin so the link points where the viewer reached the server (localhost
    locally, the bound host remotely).
  - `@telorun/kernel`: new `Kernel.getResolvedPorts()` — the root Application's
    resolved `ports:` (integer + declared protocol per name), available after
    `load()`. Empty when the root declares no ports.
  - `@telorun/cli`: the `--inspect` server advertises the app's resolved ports as
    `appEndpoints` in its `/json/version` handshake. The UI now opens once the
    ports are known (deferred from server start to first load), so the discovery
    handshake already carries the endpoints.

  The editor (private) renders the same links inside `DebugPanel` from its resolved
  run endpoints, replacing the separate chips in the run-view header.

### Patch Changes

- Updated dependencies [d59e847]
  - @telorun/analyzer@0.23.2

## 0.27.0

### Minor Changes

- 9ef48a6: Move the `--debug` event log out of the kernel into the CLI. The kernel no
  longer monkeypatches `EventBus.emit` with an always-installed streaming wrapper;
  debugging is now a plain `kernel.on("*", …)` subscriber (`DebugEventSubscriber`,
  attached by the CLI only when `--debug` is set). A normal run registers no `*`
  listener, so the event bus carries zero added overhead.

  Serialization is cycle- and value-safe and logs only plain data. Stream-bearing
  payloads (e.g. an Invocable's `{ outputs: { output: Stream } }`) whose
  async-generator closures form reference cycles previously threw `cannot serialize
cyclic structures` and dropped the event. Live runtime objects — a resolved
  `!ref` is a controller instance whose `.ctx` back-references the whole Kernel —
  previously serialized into multi-megabyte heap dumps. Now: a resolved `!ref`
  renders as the `{ kind, name }` reference it stands for; every other live object
  collapses to a one-token `[ClassName]` / `[Stream]` / `[Circular]` marker;
  object/array literals still log in full.

  BREAKING (kernel public API): `EventStream`, `Kernel.enableEventStream`,
  `Kernel.disableEventStream`, and `Kernel.getEventStream` are removed. The CLI was
  the only consumer.

- 9ef48a6: Emit symmetric resource lifecycle events during init. Each resource now emits
  `<Kind>.<Name>.Created` after its instance is constructed and
  `<Kind>.<Name>.Initialized` after `init()` + `snapshot()` complete, mirroring the
  existing `<Kind>.<Name>.Teardown`. The debug event stream previously showed only
  teardown for individual resources, never their creation/initialization.

  The `Created` event advertises the resource — `{ resource: { kind, name, module },
dependencies: [{ kind, name, alias? }] }` — where `dependencies` are the resolved
  `!ref` targets in the resource's config. This is the data a debug-UI resource
  graph is built from.

## 0.26.1

### Patch Changes

- 5973024: Fix scope resolution for route handlers of an `Http.Api` (or any composer) that
  is defined in a library and mounted/consumed by another module. The library's
  inline `kind:` handlers and their `!ref`s are anonymous children of the
  declaring document and now resolve against that library's import map rather than
  the consumer's.

  - Analyzer: top-level kind validation and throws-union/`catches:` coverage now
    resolve a resource's kind aliases in its own `metadata.module` scope (falling
    back to the consumer's), mirroring the existing nested-inline and reference
    paths. This removes false `UNDEFINED_KIND` and `UNBOUNDED_UNION_NEEDS_CATCHALL`
    diagnostics for imported-library handlers.
  - Kernel: imported libraries now initialize their resources in dependency
    (topological) order, like the root context, so a dependent (e.g. an `Http.Api`
    whose inline handler is extracted to a sibling resource) no longer runs Phase 5
    injection before its dependency is created — which previously left the handler
    ref unresolved and produced `ERR_RESOURCE_NOT_INVOKABLE` at request time. A
    circular dependency purely among a library's own resources (invisible to the
    root graph) is now surfaced as `ERR_CIRCULAR_DEPENDENCY`, mirroring the root.

- a592710: Apply a `Telo.Library`'s declared `variables` / `secrets` `default:` values when
  the importer provides no override. Previously the import controller seeded the
  child scope only from the importer-supplied inputs, so a contract variable with a
  `default:` but no override reached the library's `${{ variables.X }}` templates as
  a missing key (`No such key: X` — value was an empty object `{}`), even though
  static analysis validated the reference against the defaulted contract. This
  mirrors the root Application's env defaulting; child modules remain isolated from
  the host environment, so the resolved value is the importer's override else the
  library default.
- Updated dependencies [5973024]
  - @telorun/analyzer@0.23.1

## 0.26.0

### Minor Changes

- 1ddd803: Add a single, threaded cache-root resolution and a read-only cache mode for ephemeral runs.

  - **`TELO_CACHE_DIR` reinstated** as the override for the `.telo` cache root, resolved once per load via the new `resolveCacheRoot(entryUrl)` and threaded to the manifest cache, compiled validators, analysis stamp, and npm install root — no consumer re-derives it or reads the env independently. `Kernel.load` gains a `cacheDir` option so a CLI caller resolves it once and the kernel reads no env.
  - **`telo run --no-cache-write`** (kernel `writeCache: false`) keeps the cache read-only: baked validators/manifests are still loaded, anything uncached validates in-memory, and nothing is persisted — so a read-only, ephemeral session rootfs validates without touching (or failing to write) the cache. Validation errors still surface normally.
  - **SDK**: `ResourceContext` gains `getInstallRoot()`, the threaded npm install root, so controllers honour a relocated cache root.

### Patch Changes

- @telorun/analyzer@0.23.0
- @telorun/templating@0.8.0

## 0.25.0

### Minor Changes

- c89e79b: feat(kernel,analyzer): transitive re-export of exported instances and kinds

  A `Telo.Library` may now re-export both an instance and a kind it reaches through one
  of its own imports, using plain dotted names (the `!ref` tag is not allowed in
  `exports.resources`):

  ```yaml
  exports:
    resources:
      - Migrate # export a locally-owned instance
      - Domain.Db # re-export the instance reached via this lib's `Domain` import
    kinds:
      - Greeting # export a locally-defined kind
      - Domain.Thing # re-export a kind imported from `Domain`
  ```

  A consumer importing the library as `Api` then references `!ref Api.Db` /
  `kind: Api.Thing`. Re-export composes to arbitrary depth (`app → api → domain → …`)
  because each hop just re-declares `<PrevAlias>.<Name>` / `<PrevAlias>.<Kind>`,
  and resolution stays O(1) regardless of depth: each import builds flattened export
  tables that copy the owner's terminal getter / canonical kind by reference, so a
  lookup never walks the chain. The analyzer forwards re-exported instances and kinds
  transitively (fixpoint over the import graph) so `telo check` resolves them too,
  keeping static analysis and runtime in agreement, and the `exports.kinds` gate still
  rejects kinds that aren't re-exported. Bare-string `exports.resources` entries keep
  working as local exports.

### Patch Changes

- c89e79b: fix(kernel,sql): resolve cross-module/runnable boot & step targets that passed `telo check` but failed at runtime

  Three "green check, red run" defects in cross-module dispatch:

  - A boot `target` that is a `!ref` to a `Run.Sequence` threw `Resource not found
for invocation: undefined.invoke`. The boot runner matched the inline-invoke
    branch on any target exposing `invoke()` before the runnable branch — but a
    live `Run.Sequence` instance exposes both `run()` and `invoke()`. Guard the
    inline-invoke branch with `!isRunnableInstance(target)` so a live instance runs
    via `run()`.
  - A `Run.Sequence` step `invoke: !ref X` (or boot inline-invoke) targeting a pure
    `Telo.Runnable` threw `does not have an invoke method`, even though the step
    schema explicitly accepts `telo#Runnable`. `invoke`/`invokeResolved` now fall
    back to `run()` when the resolved instance has no `invoke()` (side effects only,
    no result), honoring the declared contract.
  - `Sql` connection refs (`connection: !ref Domain.Db`) reached through a nested
    import boundary failed with `Resource 'Db' not found in module context`. The
    resolver ignored the `alias` on a cross-module ref and did a bare local lookup;
    it now routes alias-qualified refs through `resolveImportedInstance` (mirroring
    the http-client client ref).

- 1098ad0: fix(kernel): version-scope controller installs and fully warm the validator cache so read-only (k8s) boots write nothing

  Two "green install, red run" defects surfaced when running a baked image on a
  read-only rootfs (the k8s runner), where any post-`telo install` write is fatal
  (`EROFS`):

  - **Version collision in the flat install root.** When a manifest graph
    referenced the same controller npm package at two versions (e.g. an app using
    `@telorun/mcp-client@0.4.0` directly while an imported library pins `0.3.1`),
    the single flat `node_modules` could hold only one — the last `npm install
--save` clobbered the other. At runtime the definitions pinned to the missing
    version failed the install fast-path and fell into `withInstallLock`, writing
    `<root>/.lock` and aborting the boot. Each `name@version` is now installed
    under a distinct npm alias (`npm install <alias>@npm:<name>@<version>`), so all
    versions coexist in one install root — mirroring the per-`(name, version)`
    identity of a Telo module singleton, and how npm/cargo/go coexist incompatible
    versions. `@telorun/sdk` stays exempt (real name, single hoisted copy) so
    realm-collapse is unaffected.

  - **Validator cache under-warmed.** `telo install`'s analyze-only warm compiled
    only the static-analysis validators, so the runtime recompiled every
    per-resource config validator during instantiation and failed to persist them
    read-only (noisy `validator cache write failed` on stderr). The warm pass now
    pre-compiles every `Telo.Definition` schema (from the static manifests) plus
    the framework/builtin controller schemas (from the registry). The validator
    cache _key_ also normalizes CEL/template sentinels to their original `source`,
    so a schema that embeds `!cel`/`!sql` tags (in `examples`, `description`, or
    anywhere else) hashes identically whether it arrived as parse-time
    `{__tagged}` sentinels (build-time warm, raw analysis graph) or compile-loader
    `{__compiled}` values (runtime). Only the key is normalized — AJV still
    compiles the full schema, and structural keys are never dropped, so a property
    literally named `description`/`examples` keeps its own schema in the key.

- 4794671: fix(kernel,analyzer): evaluate import `variables`/`secrets` against the importer's config

  An import's `variables:`/`secrets:` values that contained CEL expressions (`${{ }}` or
  `!cel`) were baked into the child library context **verbatim** — as unevaluated
  compiled-value objects — instead of being evaluated against the importing module. So
  config could not flow from an application through intermediate libraries into leaf
  libraries: a nested `dbFile: "${{ variables.dbFile }}"` reached the leaf as an object and
  crashed the consumer (e.g. `Sql.SqliteConnection`: `path must be of type string, got
object`).

  Import inputs are now evaluated against the **importing module's `variables`/`secrets`**.
  Resolution is eager and per-hop — each importer resolves its child's inputs from its own
  already-settled config — so a value flows `app -> lib -> lib` at any nesting depth and a
  leaf reads `variables.X` as an O(1) concrete lookup, with no chain-walk.

  Import inputs are a config-only contract: the analyzer now type-checks these expressions
  against the importer's `variables`/`secrets` (catching typos and fixing the prior
  wrong-scope `!cel` false positive), and rejects `resources`/`env`/`ports` references —
  runtime value-flow surfaces are deliberately out of scope here. To pass an env-derived
  value into a library, bind it to a typed root `variables:`/`secrets:` entry and forward
  `${{ variables.X }}` / `${{ secrets.X }}`.

- Updated dependencies [c89e79b]
- Updated dependencies [4794671]
  - @telorun/analyzer@0.23.0

## 0.24.2

### Patch Changes

- 004a848: Warm analysis caches at `telo install` time so a prebuilt image boots without re-deriving them.

  `kernel.load` now accepts an `analyzeOnly` option that runs the static-analysis pre-flight and persists its caches (the `.validated.json` analysis stamp and the compiled `__validators/` schema cache) but stops before module instantiation, target wiring, and application-env resolution. It also pre-compiles the application-env residual validators (`variables`/`secrets`/`ports`), which the runtime would otherwise recompile on every boot. `telo install` invokes this offline `kernel.load` to bake the caches onto a writable filesystem, so the runtime `load()` on a read-only session rootfs hits the stamp and skips the validation walk instead of failing to persist the caches (EROFS/ENOENT) on every boot.

## 0.24.1

### Patch Changes

- 9a305e6: Resolve `!ref` sentinels inside imported `Telo.Library` resources. The
  import-controller registered a library's runtime manifests without running the
  normalization pass the root load performs, so a `!ref` between two resources in
  the same library (e.g. `Sql.Migrations.connection: !ref Db`) reached its
  controller as a raw `{__tagged, engine: "ref", source}` sentinel and Phase-5
  injection silently skipped it. The controller now normalizes child manifests in
  the library's own alias scope before registering them, threading the
  analysis-flattened graph as cross-module resolution targets so a library that
  references its own sub-imports' exports (`!ref SubAlias.name`) resolves too.

## 0.24.0

### Minor Changes

- ee8926f: Unify resource references on the `!ref` YAML tag. The object form `{ kind, name }`
  and bare-string references are removed: the analyzer rejects them up front
  (`INVALID_REFERENCE_FORM`) and `!ref <name>` / `!ref <Alias>.<name>` is the only
  authored shape. `resolveRefSentinels` now resolves `!ref` sentinels across the
  whole manifest tree (including step `invoke`s and refs nested in inline
  definitions), so every consumer sees the uniform resolved shape. The
  http-server mount slot is renamed `mounts[].type` → `mounts[].mount`, and the
  mcp transports / clients read their Phase-5-injected ref instances directly.

  Schema validation (analyzer and kernel) now drops the stale scalar `type` a ref
  slot may still pin (older published modules encode references as `type: string`)
  before running AJV, so a resolved reference object validates against a legacy
  `x-telo-ref` slot. This keeps an app that consumes a not-yet-republished
  dependency analyzable and bootable during the migration. Object-typed ref slots
  that also accept an inline value (e.g. `inputType` / `outputType`) are left
  untouched.

  `Run.Sequence` reference slots are brought onto the same enforcement path: a
  step `invoke` and a scope `targets` entry now require a `!ref` (the `targets`
  slot gains an `x-telo-ref` constraint and the `with` scope's visibility extends
  to `/targets`), so a bare-string ref at either is rejected with
  `INVALID_REFERENCE_FORM` at `telo check` — uniform with `Telo.Application`
  targets — instead of failing as an obscure runtime error. The controller reads
  the resolved reference rather than a bare name.

### Patch Changes

- ee8926f: Bundle controller loader: self-heal a stale `node_modules/@telorun/sdk` realm
  symlink instead of leaving it broken. A link that points somewhere other than
  this kernel's SDK copy — e.g. the absolute host symlink a local run writes, then
  bind-mounts into a container where that target path is absent — is now detected
  (via `lstat`/`readlink`, which `existsSync` couldn't, since it follows the link)
  and replaced. Fixes `pkg:telo/local/js` bundled controllers failing to load with
  `Cannot find package '@telorun/sdk'` under `pnpm run test:docker` after a local
  test run.
- Updated dependencies [ee8926f]
  - @telorun/templating@0.8.0
  - @telorun/analyzer@0.22.0

## 0.23.0

### Minor Changes

- 8586b39: Resolve resource references uniformly across import boundaries and execution scopes.

  - **http-server**: `mounts[].type` is now an injected `Telo.Mount` reference (`!ref <name>`, or `!ref <Alias>.<name>` for a mount exported by an imported library) instead of a dotted kind-string. The server consumes the live injected instance, so an `Http.Api` / `Mcp.HttpEndpoint` defined in another library can be mounted across the boundary. The bare `Kind.Name` string form is removed.
  - **s3**: `bucketRef` is now an `x-telo-ref: "std/s3#Bucket"` slot (`!ref <bucket>` / `!ref <Alias>.<bucket>`); controllers consume the injected `S3.Bucket` instance, so S3 operations can reference a bucket exported by another library. The `{ name }` form is removed.
  - **analyzer**: `resolveRefSentinels` recurses into `x-telo-scope` resources, so a `!ref` inside a scoped resource (e.g. a `Run.Sequence` `with:` server's mount) is canonicalized to `{kind, name}` like any top-level slot.
  - **kernel**: Phase-5 dependency injection targets the (compile-CEL-expanded) resource the controller actually receives, so injected instances reach reference fields that also carry `x-telo-eval: compile` (e.g. `Http.Server.mounts`).
  - **sdk**: `CreatedResource` gains an optional `resource`, letting a factory return the expanded manifest the controller was created with.

- 2292a84: Upgraded cel-js package to 7.6.1

### Patch Changes

- Updated dependencies [8586b39]
- Updated dependencies [2292a84]
  - @telorun/analyzer@0.21.0
  - @telorun/templating@0.7.0

## 0.22.0

### Minor Changes

- 06cfcbf: Add `telo cel functions` (list the CEL standard library — `--json` for tooling) and `telo cel eval "<expr>" [--context <json>]` (evaluate a CEL expression with the real Node handlers). Backed by a single-source CEL catalog: `@telorun/templating` now exports `celFunctionCatalog()` / `CEL_FUNCTIONS`, and `buildCelEnvironment` registers from it so the documented surface can't drift from what's registered. `@telorun/kernel` exports `nodeCelHandlers` (the Node `crypto`/`Buffer` implementations) so the CLI's eval matches a real run.

### Patch Changes

- 06cfcbf: Instantiating an abstract kind directly (e.g. `kind: Sql.Connection`) now fails with a clear message — "Kind 'X' is abstract and cannot be instantiated directly; instantiate a concrete implementation: …" — listing the concrete kinds that extend it, instead of the generic "No controller registered". Adds `AnalysisRegistry.implementationsOf(kind)`.
- 06cfcbf: Expand the CEL stdlib:

  - **Time:** `nowIso(tz?)` (ISO-8601, UTC by default or in an IANA timezone), `today(tz?)` (`YYYY-MM-DD` in that zone), `nowMillis()` / `nowSeconds()` (absolute epoch int).
  - **UUID:** `uuidv1/3/4/5/6/7()`, `uuidValidate(s)`, `uuidVersion(s)`.
  - **Strings:** `lower`, `upper`, `trim`, `replace(s, old, new)`, `split(s, sep)`.
  - **Math:** `abs`, `floor`, `ceil`, `round`, `min(list)`, `max(list)`.
  - **Collections:** `distinct`, `sort`, `reverse`, `flatten`.
  - **JSON / encoding:** `parseJson(s)`, `base64Encode/Decode`, `urlEncode/Decode`.
  - **Hashing:** `md5`, `sha1`, `sha512`, `hmac(algorithm, key, message)` (host-injected alongside `sha256`).
  - **Null handling:** `default(value, fallback)`, `coalesce(list)` — CEL has no `??`.

  Time/UUID/`nowMillis` are non-deterministic: in an `x-telo-eval: compile` field they bake once at load; use a runtime field for a fresh value per evaluation. Hashing and base64 are host-injected to keep `@telorun/templating` browser-safe (the kernel supplies Node `crypto`/`Buffer`); `buildCelEnvironment` now accepts a partial handler map. Adds `uuid` as a dependency.

- Updated dependencies [06cfcbf]
- Updated dependencies [06cfcbf]
- Updated dependencies [06cfcbf]
  - @telorun/analyzer@0.20.0
  - @telorun/templating@0.6.0

## 0.21.0

### Patch Changes

- Updated dependencies [64debb5]
  - @telorun/templating@0.5.0
  - @telorun/analyzer@0.19.1

## 0.20.1

### Patch Changes

- Updated dependencies [81ebf47]
- Updated dependencies [ea57e10]
- Updated dependencies [81ebf47]
  - @telorun/analyzer@0.19.0

## 0.20.0

### Minor Changes

- 2864c4d: Add `pkg:telo` bundled controllers. A `Telo.Definition` can declare its controller as a bundle shipped inside the module's own artifact (the Telo registry tar.gz), not fetched from an external package registry — `pkg:telo/<ns>/<name>@<ver>?format=js&path=./nodejs/script.mjs#export`. `pkg:telo` names the delivery only; the runtime is carried by `?format=` (because bundling is the one delivery not tied to an ecosystem's runtime), and the new `BundleControllerLoader` dispatches on it: `format=js` is `import()`ed directly (no install, no node_modules); `napi`/`wasm` are recognized but env-missing on this kernel today, so a mixed candidate list falls through to a sibling here or a candidate another runtime's kernel can load. Selected via the default policy's `*` wildcard (no `runtime: bundle` label — bundling isn't a runtime). Authors write a normal `import { Stream } from "@telorun/sdk"`: the loader symlinks the realm-collapse names into a `node_modules/` next to the bundle, pointing at the kernel's own copy, so standard resolution finds them on both Node and Bun (ESM resolve hooks and Bun plugins don't intercept runtime imports portably; a symlink does). The bare import resolves with no per-bundle node_modules to author and `Stream`/`InvokeError` are the kernel's own instances. (The SDK's globalThis/`Symbol.for` singletons also keep identity correct if a publish step inlines the SDK instead.)

## 0.19.0

### Minor Changes

- 5331205: Add cooperative invoke cancellation via an out-of-band `InvokeContext`.

  Every `invoke(inputs, ctx?)` now receives a second argument carrying a read-only
  cancellation token (`ctx.cancellation`): poll `isCancelled`, subscribe via
  `onCancelled`, bail with `throwIfCancelled`, or hand its `signal` to a Web API.
  The SDK exposes the source/token split (`createCancellationSource`,
  `CancellationSource`/`CancellationToken`), a never-cancellable sentinel, and the
  `isCancellationError` helper. Deadlines are scheduled cancellation
  (`source.cancelAt(epochMs)` / `cancelAfter(ms)`).

  The kernel mints one cancellation scope per invocation tree (inherited by nested
  invokes via a kernel-internal `AsyncLocalStorage`, always passed to controllers
  as the explicit argument), refuses a not-yet-dispatched invoke whose tree was
  cancelled with `ERR_INVOKE_CANCELLED`, and emits a scoped `InvokeCancelled`
  event. `Kernel.invoke(ref, inputs, opts?)` accepts `{ signal, deadlineAt }`.
  Sources are allocated lazily, so invokes that never touch cancellation pay no
  extra allocation.

  The boot `targets` run is also cancellable: `Runnable.run(ctx?)` now receives
  the token, `Kernel.cancel(reason?)` cancels the boot scope, and the CLI's
  SIGINT/SIGTERM handler calls it so Ctrl-C cooperatively stops honoring targets
  and in-flight invoke trees (then unblocks graceful exit via `forceIdle`).

  Honoring leaves: `Ai.Text` / `Ai.TextStream` / `Ai.Agent` forward the token's
  signal into the model (aborting a live LLM stream on cancel); `http-client`
  merges it with its request timeout. Triggers: `http-server` cancels on client
  disconnect and returns 499; `lambda` arms cancellation at the AWS deadline.

### Patch Changes

- @telorun/analyzer@0.18.0
- @telorun/templating@0.4.1

## 0.18.0

### Patch Changes

- Updated dependencies [d2294de]
  - @telorun/analyzer@0.18.0
  - @telorun/templating@0.4.1

## 0.17.3

### Patch Changes

- Updated dependencies [69a0a8d]
  - @telorun/analyzer@0.17.0

## 0.17.1

### Patch Changes

- Updated dependencies [c1432a6]
  - @telorun/analyzer@0.16.1

## 0.17.0

### Minor Changes

- 0cd36a1: inline imports — `imports:` map on Telo.Application / Telo.Library

  Add an optional name-keyed `imports:` map to `Telo.Application` and
  `Telo.Library` as additive sugar for separate `Telo.Import` documents. Each
  entry's key is the PascalCase alias; its value is either a bare source string
  (`Console: std/console@1.2.3`, shorthand for `{ source }`) or the full object
  form carrying `variables` / `secrets` / `runtime`. Authored `Telo.Import`
  documents keep working unchanged and both forms may coexist.

  The loader desugars inline entries into synthetic `Telo.Import` manifests via a
  new `desugarImports` `LoadOptions` flag (folded into the file cache key; mirrored
  on the SDK's `ResourceContext.loadModule` options). The flag is on for every
  resolved consumer — the kernel's analysis and runtime loads, the
  import-controller's child-module load, the analyzer, `telo check`, and the
  `Assert.Manifest` test helper — and off for the editor's round-trip view, which
  reads the raw `imports:` map and pairs manifests to YAML nodes by index. Inline
  imports therefore resolve and execute identically to authored docs.

  Adds a `DUPLICATE_IMPORT_ALIAS` diagnostic: an alias declared twice in one
  module scope (across either form) is now an error instead of silently
  shadowing.

### Patch Changes

- Updated dependencies [0cd36a1]
  - @telorun/analyzer@0.16.0
  - @telorun/templating@0.4.1

## 0.16.1

### Patch Changes

- acb8996: Make the controller installer ignore declared `peerDependencies` ranges

  The npm controller loader now passes `--legacy-peer-deps` (npm) /
  `--no-strict-peer-dependencies` (pnpm) to its `install` invocations. A pinned
  controller tarball is immutable and carries whatever `@telorun/sdk` peer range
  was current when it was published; the install root provides the kernel's own
  (newer) sdk as a `file:` dep for realm-collapse, so npm 7+'s strict peer
  resolver `ERESOLVE`-aborted when that version fell outside the old range — even
  though the sdk surface is backward compatible and the controller runs fine.
  Disregarding declared peers restores npm ≤6 behavior: the provided sdk is used
  and old version pins install regardless of how far the kernel/sdk have moved.

## 0.16.0

### Minor Changes

- 55b4ec5: Add exported resource instances: a `Telo.Library` can declare a resource and export it as a ready-made singleton via `exports.resources`, and consumers reference it across the import boundary with `!ref Alias.name` (and read value-flow exports in CEL as `${{ resources.Alias.name }}`). `std/console` now exports `writeLine` / `readLine` singletons, so a consumer can `!ref Console.writeLine` instead of declaring its own `Console.WriteLine` instance.

  Reference grammar: every `!ref` is `<Alias>.<name>`, split on the first dot — a bare name (or `Self.`-qualified) resolves locally; a non-`Self` alias resolves into that import's `exports.resources`. A resource name may no longer contain a dot (new `INVALID_RESOURCE_NAME` diagnostic), since the dot separates alias from name.

  `Self` now resolves a library's own kinds **ungated** (no longer bound to `exports.kinds`) — `exports` gates importers, not internal use — and the kernel registers `Self` in each import's child context, so a library can declare an instance of a kind it doesn't export (`kind: Self.WriteLine`).

  `std/assert` likewise exports its config-free assertions (`equals`, `matches`, `contains`) as singletons, so a test can `!ref Assert.equals` — including inside a `Run.Sequence` step — instead of declaring an `Assert.Equals` instance.

  Mechanics: the analyzer forwards a library's exported instances across the import boundary (gate = what's forwarded), and the kernel injects/boots them from the import's child context. Cross-module refs resolve on every consumption surface — Phase 5 injection (threads the alias; an unresolved ref defers to a later init pass), flat boot targets, `Run.Sequence` step invokes (via `resolveChildren` + `executeInvokeStep`), and CEL `${{ resources.Alias.name }}`. Lifecycle is unchanged — an exported instance is the import child context's existing singleton.

### Patch Changes

- adc248b: Loosen the `@telorun/sdk` peer dependency range from an exact pin to `*`.

  The sdk is a host-provided peer (the kernel supplies the single shared instance, so `Stream` and other sdk class identities stay intact for CEL's runtime type-checker). Pinning it via `workspace:*` published as an exact version, which made every sdk release fall out of range and forced a spurious major bump of all peer-dependents. Declaring the peer range as `*` (with a `workspace:*` devDependency to preserve local linking) keeps the single-instance guarantee while preventing the false major-bump cascade.

- Updated dependencies [55b4ec5]
- Updated dependencies [adc248b]
  - @telorun/analyzer@0.15.0
  - @telorun/templating@0.4.1

## 0.15.0

### Minor Changes

- ae0bf77: Add flat invoke steps and conditional `when` guards to Application `targets`, so a
  runnable app can sequence and gate boot-time work without importing `std/run`.

  Alongside the existing bare reference, a `targets` entry now accepts:

  - a gated reference `{ ref: <Runnable/Service>, when?: <CEL> }` — `run()` only when
    the guard holds;
  - an inline invoke step `{ name?, invoke: <Invocable/Runnable ref>, inputs?, when? }`
    — call an Invocable on boot, with `steps.<name>.result` plumbed into later
    targets and an optional `when` guard.

  The flat invoke leaf (`when` + `inputs` expansion + ref resolution + `retry` +
  `steps.<name>.result`) is now a single shared primitive `executeInvokeStep` in
  `@telorun/sdk`. The kernel boot runner and the `Run.Sequence` controller both
  consume it, so the leaf semantics are single-sourced — `Run.Sequence` keeps
  control flow (`if`/`while`/`switch`/`try`), `with:` scopes, and the callable
  `inputs`/`outputs` wrapper.

  The analyzer's reference-field-map descends into object `anyOf` variants on a ref
  node, so nested refs like `targets[].invoke` register and resolve; reference
  validation skips the item-level `{kind, name}` check for the inline/gated object
  forms.

  `targets` are ref-only for now: inline targets reference declared resources
  (`!ref` / `{kind, name}`); inline resource definitions remain a `Run.Sequence`
  feature. Static CEL type-checking of target `when`/`inputs` and editor support
  for the new target forms are follow-ups.

### Patch Changes

- Updated dependencies [ae0bf77]
- Updated dependencies [222b3d6]
  - @telorun/sdk@0.13.0
  - @telorun/analyzer@0.14.0
  - @telorun/templating@0.4.0

## 0.14.0

### Minor Changes

- bfe4967: Add a `ports` declaration to `Telo.Application`. `ports` is a name-keyed map
  (sibling of `variables` / `secrets`) where each entry binds a host env var to
  an inbound port the app listens on: `{ env, protocol?, default? }`, implicitly
  typed as an integer in the 1–65535 range. Values resolve at `kernel.load()` —
  mirroring the variables env-resolution path, with the same
  `ERR_MANIFEST_VALIDATION_FAILED` aggregation — and surface in a new
  `ports.<name>` CEL scope, so a binding resource reads `${{ ports.http }}` from
  a single declared source. A runner or the editor can read the exposed ports
  (and the env var that configures each) before the app starts. Application-only;
  `Telo.Library` does not declare ports.

  Also adds `x-telo-type`, a general analyzer-only value-brand annotation. A
  port's transport brands its value (`tcp → TcpPort`, `udp → UdpPort`) as a
  nominal CEL type, and a resource field can declare which brand it accepts
  (`http-server`'s `port` is branded `TcpPort`). Wiring a `UdpPort` into a
  `TcpPort`-branded field is a static analyzer error. Brands are analyzer-only —
  the value flows as a plain integer at runtime, so there is no runtime cost.

  Adds an `UNUSED_DECLARATION` warning: a declared `variables` / `secrets` /
  `ports` entry that no CEL expression references is flagged (a generic,
  table-driven pass across the three namespaces). Application-only — a
  `Telo.Library`'s `variables` / `secrets` are a controller-consumed public
  contract and are not flagged.

### Patch Changes

- Updated dependencies [bfe4967]
- Updated dependencies [1c37ee1]
  - @telorun/analyzer@0.13.0
  - @telorun/templating@0.3.1

## 0.13.2

### Patch Changes

- Updated dependencies [6ce1a52]
- Updated dependencies [6ce1a52]
  - @telorun/analyzer@0.12.1

## 0.13.0

### Minor Changes

- 7889023: Add `!ref <name>` YAML tag for resource references (additive foundation).

  - **templating**: Register a new `ref` engine alongside `cel` and `literal` so `!ref <name>` parses to a `TaggedSentinel` with `engine: "ref"` and the bare resource name as `source`. Adds `isRefSentinel(v)` to detect ref-tag sentinels. Adds a shared `ResourceRefSchema` fragment plus `MANIFEST_SCHEMA_URI` (`telo://manifest`) and `ManifestRootSchema` — the canonical JSON-Schema home for ref-shape definitions that module YAMLs can `$ref` into. The symbols intentionally omit a host-specific prefix since they live in the templating package (the only layer both analyzer and kernel depend on); the URI is the contract.
  - **analyzer**: Recognises `!ref` sentinels at every `x-telo-ref` slot. A new `resolveRefSentinels` pass runs after inline normalization and substitutes each sentinel in-place with `{kind, name}` so downstream phases (reference validation, dependency graph, kernel controllers) see a uniform shape regardless of which surface the user picked. The substitution descends the manifest tree directly and mutates the parent container — no concrete-path string round-trip — so a future change to the field-path encoding can't silently break the writer. `validate-references` emits `UNRESOLVED_REFERENCE` when a sentinel doesn't resolve locally; `dependency-graph` adds boot-order edges for sentinel-named targets. `precompile` leaves ref sentinels intact (they are identity markers, not templating values, and must reach the resolution pass before being collapsed). A new `system-kinds.ts` consolidates the kind-skip sets the three passes (`REF_VALIDATION_SKIP_KINDS`, `DEPENDENCY_GRAPH_SKIP_KINDS`, `REF_RESOLUTION_SKIP_KINDS`) draw from so the asymmetries are named, not implicit. The analyzer's AJV instance now registers `ManifestRootSchema` under `telo://manifest` so module schemas can `$ref` shared fragments without bundling their own copy. The `Telo.Application.targets[]` schema admits both the legacy string form and the post-resolution `{kind, name}` object form, so `!ref <name>` works at that slot too.
  - **kernel**: `SchemaValidator` registers the same `telo://manifest` root so resource-config validators resolve the shared `$ref`. `ResourceContext.resolveChildren` handles `!ref` sentinels that reach a controller directly — currently a stopgap for slots hidden behind a local `$ref: "#/$defs/..."` that the analyzer's field-map walker doesn't descend; see follow-up below. `Kernel.load()` normalises `Telo.Application.targets[]` entries down to bare resource names whether the source surface was a string or a sentinel-resolved `{kind, name}` object — and now throws `ERR_INVALID_VALUE` on an entry it can't normalize rather than silently dropping it.

  **Follow-up (separate PR):** enable the analyzer's reference-field-map walker to follow local `#/$defs/<name>` refs. The walker already descends `oneOf`/`anyOf`/`allOf` variant properties in this PR; the remaining gap is the early-return on `$ref` (the recursion + cycle-detection plumbing is in place but the descent branch is disabled). Turning it on without first updating `Run.Sequence`'s controller (and any other dispatcher with the same pattern) to route through `EvaluationContext.invokeResolved` regardless of Phase-5 instance injection regresses the kernel's `<Kind>.<Name>.Invoked` event emission — sequence steps call `instance.invoke()` directly when handed a live instance, bypassing the kernel's emit path. The walker fix and the dispatcher fix have to land together; once they do, the `!ref` fallback in `ResourceContext.resolveChildren` becomes dead code and can be removed (preserving the polyglot contract where every controller — Node or otherwise — sees only `{kind, name}` at ref slots).

  The legacy ref shapes (bare-name strings and `{kind, name}` objects) are unchanged and continue to work. This change is non-breaking — no existing manifests, schemas, or controllers need to migrate yet. A subsequent migration sweep will convert every module schema to `$ref: "telo://manifest#/$defs/ResourceRef"` and rewrite example/test manifests to `!ref`, after which the legacy paths can be removed.

- f3e5fbc: Make warm `telo run` ~3× faster by populating the local manifest cache automatically and deduplicating loader reads.

  - **analyzer**: `Loader.loadFile` now keys a fast path on the request URL, skipping the source `read()` round-trip when the same URL is loaded twice in one kernel lifetime. When the cache has the file in the other compile mode it reparses from cached text instead of re-reading. Previously every duplicate request re-ran the underlying `read()` — a `fetch` for `RegistrySource`, a disk read for `LocalFileSource`.
  - **kernel**: `Kernel.load()` retains the full `LoadedGraph` and exposes it via `kernel.getLoadedGraph()` so the CLI can hand it to `writeManifestCache` without re-walking the graph.
  - **cli**: `telo run` now writes through to `<entry-dir>/.telo/manifests/` after a successful first load, reusing the same `writeManifestCache` path `telo install` already uses. Subsequent runs hit the local cache and skip the registry round-trip — without requiring an explicit `telo install`. Cache writes are best-effort: read-only filesystems (e.g. baked Docker images) log a warning and continue.

- f3e5fbc: Three further warm-startup optimisations that, layered on top of the manifest-cache write-through, pull warm `telo run hello-world` from ~300 ms to ~215 ms.

  - **#1 — analyzer / kernel**: the kernel exposes a `BuiltinControllerContext.isImportValidatedAtLoad(url)` (kernel-internal, not on the public `ResourceContext`) so built-in controllers can ask whether the kernel's load-time analyzer pass already covered a URL. The `Telo.Import` controller now skips its per-import `new StaticAnalyzer().analyze(...)` when the import was part of the entry graph (the common case — every transitive import is). Adds `Loader.canonicalize(url)` and `Kernel.isImportValidatedAtLoad(url)` as the underlying primitives.
  - **#9 — analyzer / kernel**: hash-keyed analysis cache. `analyzer.analyze` accepts a new `skipValidation` option that runs only the state-mutating setup (identity / alias / definition registration + `normalizeInlineResources`) and elides every diagnostic-producing pass. The kernel stamps `<entry-dir>/.telo/manifests/.validated.json` with a content signature of the full LoadedGraph (manifest bytes + `@telorun/kernel` + `@telorun/analyzer` versions) after each successful validation; the next load with the same signature skips the per-resource validation walk (≈25 ms warm on hello-world).
  - **#4 — kernel**: persistent AJV validator cache. `SchemaValidator` writes compiled validators as standalone CJS modules under `<entry-dir>/.telo/manifests/__validators/<schema-hash>.cjs` and reloads them through a `createRequire` anchored at the kernel package so embedded `require("ajv/...")` / `require("ajv-formats/...")` calls keep resolving. Drops total `ajv.compile` calls during a warm hello-world from 9 to 1 (the remaining one is now lazy — only paid when a `Telo.Definition` document is actually validated). Also removes the unused `validateRuntimeResource` validator (10–15 ms of dead module-init compile time).

- 39aef08: `Telo.Application` accepts `variables:` / `secrets:` with per-field `env:` mapping; values resolve at `kernel.load()` into the root `variables.X` / `secrets.X` CEL scope before any controller or import initialises. `type:` supports `string | integer | number | boolean | object | array` — object and array values are JSON-decoded from a single env var. Coercion / schema / missing-required failures aggregate into one `ERR_MANIFEST_VALIDATION_FAILED` at load.

  `Telo.Library` variables / secrets remain pure JSON Schema property maps. An `env:` key on a Library entry is now rejected at load time with a `LIBRARY_ENV_KEY_REJECTED` diagnostic that explains importers must supply the value.

  The Telo editor's Deployment tab now renders the Application's declared environment contract above the free-form env vars list, so authors see exactly which env vars the manifest binds. The tab still drives the existing Run feature's env wiring — no manifest mutation.

  `Config.Env` is deprecated in favour of the new Application-level shape. The kind continues to work; the controller logs a deprecation notice at init and the docs page is marked deprecated. Migrating consumers is recommended but not forced.

  Diagnostics that target a missing child property now squiggle just the parent key identifier instead of the whole value block. `buildPositionIndex` additionally records map keys under the `@key:<path>` namespace, and the IDE range resolver prefers that key range when the leaf path isn't indexed.

- 849f57a: Add `provide:` template target to `Telo.Definition` and an optional typed `provide()` member to `Telo.Provider`.

  Manifest authors can now declare a `Telo.Provider` in pure YAML without a TypeScript controller:

  ```yaml
  kind: Telo.Definition
  metadata: { name: TokenProvider }
  capability: Telo.Provider
  extends: Auth.SessionProvider
  resources:
    - kind: Http.Request
      metadata: { name: "${{ self.name }}-read" }
      inputs: { url: "https://vault/v1/secret/${{ self.vaultPath }}" }
  provide:
    kind: Http.Request
    name: "${{ self.name }}-read"
  result:
    sessionId: "${{ result.body.data.session_id }}"
  ```

  The synthesized `provide()` spawns the dispatch target as an ephemeral, calls its `invoke()` with the top-level `inputs:` map (CEL-expanded against `{ self, variables, secrets, resources.* }`), optionally reshapes the result via the top-level `result:` map (CEL-expanded against `{ self, result }` where `result` is typed from the target's `outputType`), and tears the ephemeral down. No caching: each call re-runs the target.

  `Telo.Provider`'s `ProviderInstance` gains an optional `provide?(): Promise<T>` member, where `T` is JSON-schema-typed via the abstract's `outputType` when the definition `extends` one. Existing handle-shaped Providers (Sql.Connection, Http.Client, etc.) continue to work unchanged — they don't implement `provide()` and remain outside the typed value-flow contract.

  Analyzer coherence validators reject:

  - `PROVIDE_ON_NON_PROVIDER` — `provide:` on a non-`Telo.Provider` definition.
  - `PROVIDE_DISPATCHER_CONFLICT` — `provide:` co-existing with `invoke:` or `run:`.
  - `PROVIDE_TARGET_UNKNOWN` — `provide.name` not matching any `resources:` entry.
  - `PROVIDE_TARGET_NOT_INVOCABLE` — `provide:` target resolving to a non-`Telo.Invocable` kind.
  - `PROVIDER_MISSING_IMPLEMENTATION` — `Telo.Provider` definition lacking both `controllers:` and `provide:`.

  Top-level `result:` is a general post-call mapping: it works as a sibling of either `provide:` or `invoke:`. The kernel applies it after the inner invoke returns; the analyzer types `result` inside CEL from the dispatch target's `outputType` (looked up via `provide.kind` first, falling back to `invoke.kind`) and validates the produced mapping against the abstract's `outputType` when the definition `extends` one. `x-telo-context-from-ref-kind` now accepts either a single path or an array of fallback paths.

- be79957: Move `@telorun/sdk` to `peerDependencies` across the kernel, analyzer, templating, and every module.

  The SDK carries the `Stream` class registered with `@marcbachmann/cel-js` for stream-typed CEL values. cel-js identifies object types by constructor identity, so a second copy of `@telorun/sdk` in the install tree silently breaks streaming-typed evaluations with `Unsupported type: Stream`. The contract was previously enforced with three layered mechanisms (a generated `dist/generated/runtime-deps.json` driving install-root `dependencies`, `overrides` + `pnpm.overrides` blocks, and a `globalThis`-keyed singleton in `stream.ts`); the build artifact silently degraded when the kernel was run without a build step, defeating the layering.

  The new shape:

  - Every package that imports `@telorun/sdk` declares it as a `peerDependency`. Consumers (the kernel's install root, the CLI, apps) provide a single copy and `peerDependencies` cause npm/pnpm to resolve every transitive import to it.
  - The kernel's `NpmControllerLoader` no longer reads `runtime-deps.json`; the realm-collapse name list is a hardcoded constant (`REALM_COLLAPSE_NAMES = ["@telorun/sdk"]`) in `npm-loader.ts`. The install-root `package.json` it writes drops the `overrides` and `pnpm.overrides` blocks — peer-dep resolution makes them redundant.
  - `scripts/generate-runtime-deps.mjs` and the generated artifact are removed; `scripts/prepack-bake-overrides.mjs` no longer chains the runtime-deps regeneration.
  - The `globalThis` singleton in `sdk/nodejs/src/stream.ts` is **kept** as a safety net for environments that still end up with mismatched SDK copies (e.g. a controller install from a tarball that predates this change).

  Consumers installing `@telorun/kernel` or any module directly must now ensure `@telorun/sdk` is present in their dependency tree. The kernel already lists it via the install root for any manifest it boots, so kernel-driven usage is unaffected.

### Patch Changes

- Updated dependencies [c0129c0]

  - @telorun/analyzer@0.12.0

- 0331069: Fix loading manifests from `http(s)://` URLs as the entry point.

  The npm controller loader previously required the entry URL to be a local path or `file://` URL so the per-kernel install root could be anchored at `<entry-dir>/.telo/npm/`. HTTP-sourced manifests were rejected with `ControllerEnvMissingError`, so `pnpm run telo https://…/manifest.yaml` failed before any controller could be installed.

  The loader now picks an install root based on the entry URL scheme:

  - `file://` URL or bare filesystem path → unchanged (`<entry-dir>/.telo/npm/`)
  - `http://` / `https://` URL → user-level cache keyed by `sha256(entryUrl)` at `$TELO_NPM_CACHE_DIR` (override) or `$XDG_CACHE_HOME/telo/remote` or `~/.cache/telo/remote`. Repeat runs of the same URL hit the same cache; distinct URLs get isolated trees so two unrelated remote apps don't share `node_modules`.

  Single-realm install semantics are preserved: each kernel process still uses exactly one install root that pins `@telorun/sdk` (and every other realm-collapse name) to the kernel's own resolution via a `file:` dep, so class identity (`Stream`, etc.) is the same across the kernel/controller boundary regardless of where the install root physically lives.

- Updated dependencies [0331069]

  - @telorun/analyzer@0.12.0

- Updated dependencies [77c1c86]
- Updated dependencies [7889023]

  - @telorun/analyzer@0.12.0
  - @telorun/templating@0.3.0

- Updated dependencies [f3e5fbc]
- Updated dependencies [f3e5fbc]

  - @telorun/analyzer@0.12.0

- Updated dependencies [39aef08]

  - @telorun/analyzer@0.12.0

- Updated dependencies [849f57a]
- Updated dependencies [e411584]
- Updated dependencies [e411584]
- Updated dependencies [be79957]
  - @telorun/sdk@0.12.0
  - @telorun/analyzer@0.12.0

## 0.12.0

### Minor Changes

- 0f80fc5: `Bench.Suite.scenarios[*]` and `Http.Server.notFoundHandler` follow the canonical sibling shape: `invoke:` describes the dispatch target only; `inputs:` carries the call-time arguments as a sibling. The previously-accepted nested `invoke.inputs` form is gone — the benchmark runtime now reads `scenario.inputs` and the http-server runtime now reads `notFoundHandler.inputs`. Five benchmark manifests, one example, and `apps/registry/telo.yaml` migrated to the sibling form.

  Statically validate CEL expressions inside `Telo.Definition` template bodies. The analyzer now registers `self` (typed from the definition's `schema:`) and `inputs` (typed from `inputType:`, falling back to the `extends:`-declared abstract's `inputType:`) as available variables in `resources:` / `invoke:` / `run:` / `provide:` / top-level `inputs:` / top-level `result:` fields, catching typos at load time instead of first invocation.

  Aligns Telo.Definition's template-body shape with how Run.Sequence steps factor dispatch from data: `invoke:` / `provide:` / `run:` describe the dispatch target only; `inputs:` (values passed to the target) and `result:` (provide-only post-call mapping) live as top-level siblings on the definition. The previous nested `invoke.inputs` shape is gone — the kernel template controller now reads `definition.inputs`, and `modules/sql-repository/Read` migrates to the sibling form.

  Inside top-level `result:`, the `result` CEL variable is typed from the dispatch target's `outputType:`. The produced top-level `result` value is also AJV-checked against the abstract this definition `extends` (`outputType`); top-level `inputs` is AJV-checked against the dispatch target's `inputType` when declared. Mismatches surface as a new `TEMPLATE_TARGET_MISMATCH` diagnostic.

  Adds two reusable context-annotation forms used by the `Telo.Definition` builtin schema and available to any module that needs the same capabilities:

  - `x-telo-context-from-root: "<path>"` — root-anchored navigation (replace semantics), used to type variables sourced from a top-level field regardless of where the CEL appears.
  - `x-telo-context-from-ref-kind: "<refPath>#<field>"` — reads a kind name from `manifestRoot.<refPath>`, resolves it via the definition registry, and returns that kind's `<field>` schema.

  Schema-extracted contexts are now sorted by scope specificity (longest first) so the first-match-wins resolver picks the most-specific context. No existing module relied on the previous ordering (no overlapping scopes), so this change is observably backward-compatible.

### Patch Changes

- 67a9b31: Skip `npm install` for controller packages that are already present in `.telo/npm/node_modules/<pkg>` with the requested version. The previous fast path in `NpmControllerLoader.installPackage` compared the requested install spec (`@scope/pkg@0.3.4`) against the install root's `dependencies[<pkg>]` entry, but npm rewrites registry specs on `--save` (e.g. to `^0.3.4`), so the comparison never matched. Because a fresh `NpmControllerLoader` is constructed per `Telo.Definition.init`, every definition fell through to a no-op-but-~200ms `npm install --save <spec>` on every rerun, and each one emitted a `(npm-install, …ms)` line for its controller. The new path reads the installed package's own `package.json` `version` field and returns `"cache"` when it matches the PURL version — the CLI progress renderer already silences cache hits, so a warm rerun emits zero install lines, and a cold install emits one line per npm package rather than one per Telo resource sharing it.
- Updated dependencies [0f80fc5]
  - @telorun/analyzer@0.11.0

## 0.11.1

### Patch Changes

- 58362c4: Enrich CEL "No such key" errors with the failing access location and the actual shape at that point. When a `${{ … }}` expression like `steps.call.result.result.content[0].type` throws `No such key: content`, the kernel now appends a hint such as `at steps.call.result.result: cannot read 'content' — value is an empty object {}` (or `available keys: …` / `value is null` / `value is an array of length N`, etc.), so developers can immediately see which segment of the chain produced an unexpected shape instead of having to bisect the path by hand.
- Updated dependencies [58362c4]
  - @telorun/sdk@0.11.1
  - @telorun/analyzer@0.10.1

## 0.11.0

### Minor Changes

- f61b36a: `telo install` now also persists every imported manifest's YAML to `<entry-dir>/.telo/manifests/` (registry refs under `<namespace>/<name>/<version>/telo.yaml`, HTTP imports under `__http/<host>/<pathname>`). `telo run` registers a new `LocalManifestCacheSource` ahead of the registry / HTTP sources, so production images that ran `telo install` at build time boot with zero registry network I/O — fixing the self-bootstrap loop in the registry image and unblocking air-gapped deploys. Cache misses fall through to the network source transparently; dev runs without a prior install are unchanged. New CLI flag `telo install --registry-url <url>` mirrors `telo run` for consistency.

  The reader and writer share a single URL→path function so direct-URL imports of a registry-served manifest (`source: https://registry.telo.run/...`) hit the same cache file as the corresponding `source: namespace/name@version` ref. HTTP URLs with a query string or fragment are disambiguated with a 12-char content hash on the filename so two different manifests never collide. All cache paths are validated to stay under the cache root, guarding against `..` segments in module refs.

  - `@telorun/kernel`: adds `LocalManifestCacheSource`, `writeManifestCache`, `cachePathForCanonical`, and `resolveEntryDir` exports.
  - `@telorun/cli`: `telo install` writes the manifest cache; `telo run` registers the cache source; new `--registry-url` flag on `telo install`.

### Patch Changes

- Updated dependencies [65647e0]
  - @telorun/analyzer@0.10.0

## 0.10.0

### Minor Changes

- f1c35bc: Split `Kernel.start()` into `boot()` / `runTargets()` / `teardown()`, add public `Kernel.invoke()`, rename `Kernel.shutdown()` → `Kernel.forceIdle()`.

  Embedders that want "boot once, invoke many" (e.g. an AWS Lambda managed-runtime adapter, IDE previews, programmatic tests) can now drive each lifecycle phase explicitly without owning the wait loop. `start()` stays as a convenience method with no observable behaviour change — its `try` widens to cover `boot()` and `runTargets()` so init-time failures still drive teardown and still emit `Kernel.Stopping` / `Kernel.Stopped`, matching the pre-split contract that the CLI and test runner rely on.

  **New methods**:

  - `boot(): Promise<void>` — initialize resources, emit `Kernel.Initialized`. Does not run targets, does not wait.
  - `runTargets(): Promise<void>` — emit `Kernel.Starting`, run `targets:` from the manifest, emit `Kernel.Started`. Throws `ERR_KERNEL_STATE_INVALID` if called before `boot()` or after `teardown()`, or a second time.
  - `teardown(): Promise<void>` — emit `Kernel.Stopping`, tear down every initialized resource, emit `Kernel.Stopped`. Idempotent on the second call (no-op, no re-emit). Tolerates partial state — a `boot()` that threw mid-init still cleans up.
  - `invoke<TInputs, TOutput>(ref, inputs): Promise<TOutput>` — invoke a `Telo.Invocable` resource by `<Kind>.<Name>` (dot-form string) or `{ kind, name }`. Throws `ERR_KERNEL_STATE_INVALID` before `boot()` or after `teardown()`.

  **Breaking**:

  - `Kernel.shutdown(): void` is renamed to `Kernel.forceIdle(): void`. Same semantics (force-resolve a pending `waitForIdle()` regardless of active holds; used by SIGINT/SIGTERM handlers). The name disambiguates from the new `teardown()`. The only known external caller is the CLI's signal handler, updated in this changeset.
  - New `ERR_KERNEL_STATE_INVALID` runtime error code on `RuntimeErrorCode`.

  No migration needed for callers that only use `start()` — its semantics are unchanged.

- 47f7d83: Single-realm controller install: every controller in a kernel process now resolves through one `<entry-manifest-dir>/.telo/npm/` tree, with the kernel's own `@telorun/sdk` wired in as a `file:` dep. The realpath collapse this produces fixes class-identity bugs across the kernel/controller boundary — most visibly cel-js's `registerType("Stream", Stream)` matching `Stream` instances created on either side of the realm split.

  - `@telorun/kernel`: `Kernel.load(url)` records the entry URL; `getEntryUrl()` is exposed via `ResourceContext`. `NpmControllerLoader` rewrites every load — registry tag or `local_path` — as an `npm install <spec>` into the per-manifest install root. A filesystem lock at `<root>/.lock` (atomic `fs.open(path, 'wx')`, PID + start-time inside) makes the install cross-process safe; a hash of the materialized `package.json` short-circuits repeat installs. The legacy `~/.cache/telo/npm/` global cache is no longer consulted (existing trees are safe to delete by hand). `TELO_PKG_MANAGER` overrides the default `npm` invocation.
  - `@telorun/cli`: `telo install` passes the manifest's entry URL through to the kernel-side loader so the install root lands next to the manifest. `TELO_CACHE_DIR` is no longer consumed.
  - `@telorun/sdk`: `ResourceContext` gains a `getEntryUrl()` method.
  - `@telorun/assert`: `package.json` `exports` map now declares the Bun/Node conditional split (`bun → src/*.ts`, `import → dist/*.js`). The previous bare-`./src/*.ts` entries only worked because the old controller loader silently rewrote `src→dist`; that rewriter is gone.

### Patch Changes

- 5c49834: Loader returns the canonical load result; editor stops re-parsing.

  The analyzer's `Loader` now produces a single `LoadedFile` / `LoadedModule` / `LoadedGraph` that carries text, parsed `yaml.Document` ASTs, manifests, position metadata, and canonical identity together. Hosts consume the same parse — the editor no longer runs a parallel YAML pipeline, the VS Code extension and CLI no longer read positions from non-enumerable manifest metadata, and the kernel uses the same primitive for static analysis and runtime entry loads.

  **Breaking changes** in `@telorun/analyzer`. The deprecated methods are removed in this release rather than kept as shims:

  - `Loader.loadModule(url, opts)` now returns `LoadedModule` (was `ResourceManifest[]`).
  - `Loader.loadModuleGraph` removed — use `loadGraph` + `flattenForAnalyzer`.
  - `Loader.loadManifests` removed — use `loadGraph` + `flattenForAnalyzer`.
  - `Loader.loadModuleForFile` legacy shape removed; the replacement is `loadGraphForFile(url) → { graph, ownerUrl } | null`.
  - `attachPositionIndex` (the non-enumerable-metadata helper) removed; positions live on `LoadedFile.positions` and consumers look them up via `findPositions(graph, …)` from `@telorun/ide-support`.
  - `LoadedGraph.importEdges` is now `Map<string, Map<string, ImportEdge>>` carrying `{targetSource, targetModuleName, targetNamespace}` rather than a bare target URL — `flattenForAnalyzer` reads library identity off the edge directly instead of re-deriving from manifest metadata.

  **New surface**:

  - `parseLoadedFile(source, requestedUrl, text, opts?)` — pure, I/O-free parse primitive shared between the editor's source-view debounce and the loader's `read()` post-processing.
  - `Loader.loadFile(url, opts?)`, `Loader.loadGraph(entry, opts?)`, `Loader.loadGraphForFile(fileUrl)` — new methods returning the canonical types.
  - `flattenForAnalyzer(graph)` and `flattenLoadedModule(mod)` — produce the flat `ResourceManifest[]` `analyze()` consumes (graph-wide vs. single-module).
  - `@telorun/ide-support`: `findPositions(graph, diagnosticData)` returns `{file, positionIndex?, sourceLine?}` and replaces every host's hand-rolled "look up the file owning this diagnostic + its positions" loops.

  **Internal effects**:

  - `@telorun/cli`: migrated `check`, `install`, and `publish` to the new API; `formatAnalysisDiagnostics` takes a `LoadedGraph`.
  - `@telorun/kernel`: the kernel's facade methods (`loadModule`, `loadManifests`) preserve their `ResourceManifest[]` API so module controllers don't need to migrate; internally they project from the new types via `flattenForAnalyzer` / `flattenLoadedModule`.
  - The editor's `ModuleDocument` collapses to `{filePath, loaded: LoadedFile, dirty: boolean}`; the previous parallel `parseModuleDocument` pipeline (`text` / `docs` / `loadedJson` / `parseError` snapshots, in-memory adapter, chained adapter, populate/collect-partial passes, `mergeSubGraph`) is gone. Source-view edits and form edits both flow through `parseLoadedFile`; saves re-parse the just-written text to refresh the load-time snapshot.

- Updated dependencies [07c881a]
- Updated dependencies [5c49834]
- Updated dependencies [50ae578]
- Updated dependencies [f1c35bc]
- Updated dependencies [47f7d83]
  - @telorun/analyzer@0.9.0
  - @telorun/sdk@0.10.0

## 0.9.2

### Patch Changes

- Updated dependencies [30bcfef]
  - @telorun/analyzer@0.8.1

## 0.9.1

### Patch Changes

- 543b91f: Surface duplicate inline resource registrations as `ERR_DUPLICATE_RESOURCE` instead of silently skipping the second registration. `resolveChildren` previously suppressed the throw from `registerManifest` when the target name was already taken, which hid real bugs — most notably inline resources inside sibling `Run.Sequence` steps colliding on auto-generated names, where only the first sequence's invocations actually ran while the rest were silently aliased onto it.

  Three changes ship together:

  - `@telorun/kernel`: removed the `!hasManifest(name)` guard in `resolveChildren`. Duplicate registrations now throw at boot.
  - `@telorun/run`: inline-step auto-names now include the parent sequence's name and follow the project's PascalCase resource-naming convention — e.g. `SequenceHealthLivenessSteps1Assert` rather than `__sequence_steps_1__assert`. Sibling sequences with identical step names no longer collide.
  - `@telorun/kernel`: the unnamed-resource fallback was renamed from `__unnamed_<hex>` to `Unnamed<hex>` for the same convention.

## 0.9.0

### Minor Changes

- 88e5cb4: Introduce per-property templating engines via YAML tags. New `@telorun/templating` package owns the shared CEL core (compile, chain validator, walker, environment) and a pluggable engine registry. Two built-in engines ship: `!cel` (single CEL expression — no `${{ }}` wrapping) and `!literal` (opaque text — no interpolation, no analysis). Untagged `${{ }}` strings continue to compile as CEL exactly as before. The kernel, analyzer, telo editor, and VS Code extension now share one source of truth for engine registration and YAML tag parsing.

### Patch Changes

- Updated dependencies [88e5cb4]
- Updated dependencies [88e5cb4]
  - @telorun/analyzer@0.8.0

## 0.8.0

### Minor Changes

- 019c62a: Two additions to the shared CEL `Environment` used by the kernel runtime,
  the loader, and the static analyzer:

  **`json(value)` stdlib function.** Companion to the existing `sha256(string)`
  handler. Accepts any `dyn` value (primitives, lists, maps, nested structures
  sourced from step results) and returns a single-line JSON string. cel-js
  parses `int` / `uint` literals as BigInt; the handler coerces them with
  `Number(v)` unconditionally — values inside JS's safe range (±2^53)
  round-trip cleanly, larger values lose precision. Telo manifests never carry

  > 2^53 integer values in practice, so the simpler always-coerce contract
  > beats a value-dependent string fallback. Top-level `undefined` / function /
  > symbol values (which `JSON.stringify` would otherwise return as `undefined`,
  > violating the `json(dyn): string` signature) are coerced to `"null"`.

  The first consumer is the registry MCP server, whose tool result blocks
  need to package structured handler output into a single MCP `text` content
  slot — e.g. `text: "${{ json(steps.search.result) }}"`. The function is
  generally useful anywhere CEL needs to emit structured payloads as strings
  (logging, hashing, transmission, debug output).

  **`enableOptionalTypes: true` on the cel-js Environment.** Activates CEL's
  optional-types syntax in every site that goes through the shared environment
  (precompiled `${{ }}` template blocks). Available in any manifest from now
  on:

  - `value.?field` — optional field access; returns an `optional<T>` if the
    intermediate is missing instead of throwing.
  - `list[?index]` — optional indexing; same semantics for arrays.
  - `optional.orValue(default)` — unwrap with a fallback.
  - `optional.hasValue()` / `optional.value()` — explicit checks.

  This is a parser-level addition; the only existing-manifest hazard is using
  `optional` as a variable name (now reserved). The first consumer is the
  registry's `PublishHandler`, which uses
  `steps.parseManifest.result.docs[?0].?metadata.?description.orValue(null)`
  to safely extract the manifest's description across array indexing — a
  chain `has()` cannot express because cel-js's `has()` macro rejects array
  indexing in the path.

### Patch Changes

- c792025: Remove `@telorun/yaml-cel-templating` package and the `$let`/`$if`/`$for`/`$eval`/`$include` YAML directives. The package was unused — no manifest in the repo referenced any directive and no kernel code imported it. Static analyzability of manifests is a core architectural goal, and structural directives that produce resources at runtime are at odds with it. Plain `${{ }}` CEL interpolation continues to work as before.
- Updated dependencies [019c62a]
  - @telorun/analyzer@0.7.0

## 0.7.2

### Patch Changes

- Updated dependencies [40ae3ea]
- Updated dependencies [0335074]
  - @telorun/analyzer@0.6.1

## 0.7.1

### Patch Changes

- 024debe: Declare `engines.node: ">=24"` on `@telorun/cli` and `@telorun/kernel`. Makes the supported Node version explicit (and fixes the npm Node-version badge in the README, which previously rendered "not specified").

## 0.7.0

### Minor Changes

- b62e535: Streaming-Invocable convention, format-codec packages, and `Http.Api` `content:` map rewrite.

  **Breaking** (`@telorun/http-server`, `@telorun/ai`):

  - `Http.Api.routes[].returns[]` and `routes[].catches[]` (and the equivalent `Http.Server.notFoundHandler` lists) drop top-level `body` / `schema` in favour of a per-MIME `content:` map. Buffer-mode entries use `content[<mime>].body` / `content[<mime>].schema`; stream-mode entries use `content[<mime>].encoder` (ref to any `Codec.Encoder`). The map key is the canonical `Content-Type` — declaring `Content-Type` in `headers:` is rejected at load time. Multi-key `content:` maps are negotiated against the request's `Accept` header (RFC 9110 §12.5.1). Mismatch → `406 Not Acceptable`.
  - `mode: stream` is forbidden in `catches:` (catches fire pre-stream; no upstream iterable to feed an encoder).
  - Migration: every existing `returns: [..., body: ..., schema: ..., headers: { Content-Type: ... }]` rewrites mechanically to `returns: [..., content: { <mime>: { body, schema } }]`. In-tree manifests (`apps/registry`, `examples/*`, `tests/*`, `benchmarks/*`) migrated.
  - `Ai.TextStream`: `format` field removed; controller no longer encodes the wire — it returns `{ output: Stream<StreamPart> }`. Pair with a format-codec encoder (`Ndjson.Encoder`, `Sse.Encoder`, `PlainText.Encoder`) for HTTP responses or other byte transports. `text-stream-drain-controller.ts` removed (replaced by inline source → encoder → decoder steps).
  - `StreamPart.error` shape changed from native `Error` to `{ message, code?, data? }` so generic encoders can JSON-serialize error frames without bespoke translation.

  **New** (`@telorun/codec`, `@telorun/plain-text-codec`, `@telorun/ndjson-codec`, `@telorun/sse-codec`, `@telorun/octet-codec`):

  - `@telorun/codec` ships the `Encoder` and `Decoder` abstracts (no controllers — pure contracts).
  - Format-codec packages each carry one or both directions: `PlainText.Encoder/.Decoder` (UTF-8 collect + emit), `Ndjson.Encoder` (one JSON record per line), `Sse.Encoder` (Server-Sent Events frames), `Octet.Encoder/.Decoder` (raw bytes pass-through and collect).
  - All encoders implement `invoke({input}): Promise<{output: Stream<Uint8Array>}>` per the streaming-Invocable convention.

  **New** (`@telorun/sdk`):

  - `Stream<T>` class wrapping `AsyncIterable<T>`. Producers wrap their iterables in `new Stream(...)` so the value's constructor is recognized by CEL's runtime type-checker (which rejects unrecognized constructors like `AsyncGenerator` and Node `Readable`). The analyzer registers `Stream` as a CEL object type.

  **Annotation** (`@telorun/kernel`, `@telorun/analyzer`):

  - `x-telo-stream: true` schema annotation on input/output properties marks them as carrying a `Stream<T>`. CEL passes the value through by reference; analyzer's chain validator rejects `.field` / `[index]` access past a stream-marked property. Convention: streaming Invocables put the stream on `input` (inputs) and `output` (result).
  - `Self.<Abstract>` magic alias auto-registered for every Telo.Library/Application — lets concrete kinds in the same library use `extends: Self.<Abstract>` without a self-import that would loop the loader.
  - Analyzer's `buildReferenceFieldMap`, `resolveFieldValues`, `extractInlinesAtPath`, and `injectAtPath` (Phase 5) now recurse into `additionalProperties` via a `{}` path-segment marker. Required for refs nested inside open-keyed maps like `content[<mime>].encoder`.
  - `isInlineResource` widened: bare-kind refs (`{kind: X}` with no `name` and no extra config) are now treated as inline-singleton definitions and Phase 2 extracts them as fresh stateless resources. Previously `{kind: X}` raised `INVALID_REFERENCE` (treated as a malformed named ref). This matches the runtime-side `resolveChildren` semantics already documented for `Run.Throw`-style stateless inlines, and lets `encoder: {kind: Ndjson.Encoder}` work without boilerplate. Manifests that had `{kind: X}` with the (broken) intent of resolving to an existing named resource will now silently extract a fresh resource — extremely unlikely in practice (those refs were already failing analysis), but worth flagging for downstream consumers.

  **Behaviour changes worth flagging** (`@telorun/http-server`):

  - **Single-key `content:` maps now do `Accept` negotiation.** A route declaring only `content: { application/json: ... }` returns `406 Not Acceptable` for `Accept: image/png` — RFC 9110 §15.5.7 compliant. Pre-PR, the legacy top-level `body:` shape ignored `Accept` entirely. To preserve "always send" behaviour, declare `*/*` as an explicit key.
  - **Accept matching ignores media-type parameters** beyond the first `;`. `Accept: text/plain; charset=ascii` matches `content: { 'text/plain; charset=utf-8': ... }`. Q-values are still parsed for ranking; only the matching predicate ignores params. Authors needing parameter-level preference must declare distinct keys per parameter combo.
  - **Load-time validators reject misconfigured `content:` shapes.** `validateContentEntryShape` rejects `body+encoder` together (mutually exclusive), missing `encoder` under `mode: stream`, `body` under `mode: stream`, and `encoder` under `mode: buffer`. Previously some of these slipped through to runtime where they manifested as 500-on-negotiation.
  - **Mid-stream `pipeline()` failures emit `Http.Api.streamFailed` events.** Once `reply.hijack()` runs, mid-stream errors (encoder throws, broken pipe) bypass `catches:` by design (response is committed). They now emit a structured event with `path`, `method`, `status`, `mime`, and the error so operators can observe failures that would otherwise be silent.

  **Other** (`@telorun/http-client`, `@telorun/javascript`):

  - `HttpClient.Request` `mode: stream` returns `{ output: Stream<Uint8Array> }` instead of a bare `Readable` — fits the streaming-Invocable convention, pairs with `Octet.Encoder` for HTTP pass-through.
  - `JS.Script` injects `Stream` into every script's scope (via the second function argument, destructured at the top of the wrapper). User code can `new Stream(asyncGen)` directly.

  **Tests**:

  - New Layer 1 hermetic streaming-contract test (`modules/ai/tests/text-stream-streaming-contract.yaml`) — three sub-targets, byte-exact NDJSON / SSE / PlainText.
  - New Layer 2 live OpenAI streaming smoke (`modules/ai-openai/tests/openai-live-text-stream.yaml`) — env-gated; exercises `Ai.TextStream → Ndjson.Encoder → PlainText.Decoder` against the real provider.
  - New http-server integration test (`modules/http-server/tests/text-stream-via-http.yaml`) — exercises three single-format routes plus a four-format negotiated route with five Accept variants.

### Patch Changes

- 6d4280e: Fix segfault when multiple kernels concurrently load the same `pkg:cargo` controller crate. The napi controller loader's process-wide module cache only protected sequential callers — two parallel `kernel.start()` calls (e.g. tests running in parallel) could both miss the cache, both run `cargo build`, and both `fs.copyFile` over the same `<libname>.node` while one had already mmapped it, racing napi finalize callbacks and crashing Node with SIGSEGV. Concurrent loads for the same crate now share a single in-flight build promise; late arrivals await it and read the populated module cache when it resolves.
- Updated dependencies [b62e535]
  - @telorun/sdk@0.7.0
  - @telorun/analyzer@0.6.0

## 0.6.1

### Patch Changes

- 0c4d023: Surface controller-download progress as kernel events and render them in the CLI.

  `ControllerLoading` / `ControllerLoaded` / `ControllerLoadFailed` /
  `ControllerLoadSkipped` are now emitted from `ControllerLoader` itself, one
  cycle per attempted PURL candidate so env-missing fallback chains are visible.
  Payloads carry the single attempted `purl` instead of the full candidate
  array, plus `source` (`local` | `node_modules` | `cache` | `npm-install` |
  `cargo-build`) and `durationMs` on `Loaded` so consumers can distinguish real
  work from cache hits. `pkg:cargo` resolutions through `local_path` (the only
  cargo mode currently wired up) report `source: "local"` — cargo's incremental
  cache makes every run after the first effectively a no-op build, the same
  mental model as the npm `local_path` branch. `cargo-build` is reserved for a
  future distribution mode (fetch from a registry + compile). `Skipped` is
  emitted for recoverable env-missing fallbacks (e.g. `pkg:cargo` with no
  `rustc` on PATH) so consumers can close out per-attempt UI state without
  conflating it with a hard failure.

  The CLI renders a `⬇ <purl>` line at `Loading` and rewrites it in place to
  `✓ <purl> (<source>, <ms>)` (or `✗ …`) at `Loaded` / `Failed`. By default the
  renderer activates only when stdout is a TTY, so CI logs and the dockerised
  `telorun/telo` service stay silent. `--verbose` forces rendering on regardless
  of TTY (so captured/piped logs get the lines too).

  By default, resolutions reporting `source: cache` or `local` have their line
  erased once `Loaded` arrives — they're sub-millisecond and don't represent
  work worth surfacing. `--verbose` bypasses this filter and prints every
  resolution, including cache/local, which is useful for debugging which branch
  the loader took. Other sources (`node_modules`, `npm-install`, `cargo-build`)
  always render their `✓` line.

  The cargo / napi loader now also accepts an optional PURL fragment. When
  present, `pkg:cargo/foo?local_path=...#bar` projects to `module.bar` after
  loading the dylib (each sub-export must itself have `create` or `register`);
  without a fragment the whole module is the controller, as before. This
  mirrors the npm `#entry` semantics for crates that want one source file per
  controller. The raw module is cached per crate, so two PURLs differing only
  by fragment share one cargo build.

## 0.6.0

### Minor Changes

- dccd3a6: Kernel quick-wins cleanup plus per-module import isolation.

  **Per-module import isolation.** `Telo.Import` aliases now register on the declaring module's own `ModuleContext` instead of all collapsing into the root context's alias table. Sibling modules that declare the same alias name no longer overwrite each other; runtime kind dispatch resolves through the resource's owning module and walks up the parent chain so children still inherit root-level built-ins like `Telo`. This was a latent isolation bug — visible as wrong-target alias resolution whenever two modules used the same alias name.

  **SDK breaking changes.**

  - `ModuleContext.importAliases: Map<string, string>` is removed from the public interface; replaced with `hasImport(alias: string): boolean`. Callers that need to test alias presence should use `hasImport`; the underlying map is now `private` on the kernel implementation.
  - `ResourceContext.getResources(kind)` and `ResourceContext.teardownResource(kind, name)` are removed. They were always stubs that threw `"not implemented"`.
  - `ControllerContext.once(event, handler)` and `ControllerContext.off(event, handler)` are removed. Same reason — stubs that threw on call.
  - `ResourceContext.registerModuleImport(alias, target, kinds)` is unchanged in shape but now writes to the caller's own `ctx.moduleContext` rather than going through the kernel's discarded `_declaringModule` indirection.

  **Kernel internals.**

  - `kernel.getModuleContext`, `kernel.resolveModuleAlias`, `kernel.registerModuleImport` and `kernel.registerImportAlias(alias, target, kinds)` deleted. Runtime alias storage lives on `ModuleContext` itself.
  - `kernel._createInstance` resolves kinds via the resource's enclosing `ModuleContext` (walking parents) instead of always going through the root.
  - `EvaluationContext` no longer swallows `instance.snapshot()` errors with `.catch(() => ({}))` — failures now propagate into the existing init-loop diagnostics. Previously a provider whose snapshot threw silently produced an empty `${{ resources.X.* }}` namespace downstream.
  - Spurious `console.log("Registering resource:", kind, name)` in `ManifestRegistry.register()` removed.

  **Removed packages.** `@telorun/tracing` is deleted. The module's controllers depended exclusively on the now-removed `getResources`/`off` stubs, was wired into no tests, and had no external consumers in the workspace.

  **Assert.ModuleContext controller** was the only user of the removed `(ctx as any).resolveModuleAlias(...)` shim; it now calls `ctx.moduleContext.hasImport(alias)`.

- 2e0ad31: In-memory kernel bootstrap and `Adapter` → `Source` rename.

  **Breaking changes:**

  - `Kernel.loadFromConfig(path)` → `Kernel.load(url)`. The new method dispatches the URL through the registered `ManifestSource` chain unchanged — no implicit `file://` cwd-wrapping. The `loadDirectory` deprecation shim is removed.
  - `KernelOptions.sources: ManifestSource[]` is now required. Callers must pass an explicit list, e.g. `new Kernel({ sources: [new LocalFileSource()] })`. The previous hardcoded `LocalFileAdapter` registration in the `Kernel` constructor is gone.
  - `ManifestAdapter` interface renamed to `ManifestSource`. Per-scheme classes renamed: `LocalFileAdapter` → `LocalFileSource`, `HttpAdapter` → `HttpSource`, `RegistryAdapter` → `RegistrySource`. Files and directories renamed in turn (`manifest-adapters/` → `manifest-sources/`, `analyzer/.../adapters/` → `.../sources/`).
  - `LoaderInitOptions` field renames: `extraAdapters` → `extraSources`, `includeHttpAdapter` → `includeHttpSource`, `includeRegistryAdapter` → `includeRegistrySource`.
  - The dead-stub `kernel/nodejs/src/manifest-adapters/manifest-adapter.ts` (an unused parallel interface that drifted from the live one in `@telorun/analyzer`) is deleted.

  **New:**

  - `MemorySource`: an in-memory `ManifestSource` for embedders and tests. Available as a top-level export from `@telorun/kernel` and as a subpath export at `@telorun/kernel/memory-source`. Bare module names register under `<name>/telo.yaml` (mirroring disk's "module is a directory containing telo.yaml" convention) so relative imports (`./sub`, `../sibling`) work transparently with POSIX path resolution. `set(name, content)` accepts either YAML text or an array of parsed manifest objects (serialized via `yaml.stringify`).

  **Internal:**

  - `Loader.moduleCache` is now per-instance rather than `private static readonly`. Multiple in-process kernels (the headline use case for `MemorySource` — test runners, IDE previews) no longer share a process-wide cache.

### Patch Changes

- Updated dependencies [dccd3a6]
- Updated dependencies [2e0ad31]
  - @telorun/sdk@0.6.0
  - @telorun/analyzer@0.5.0

## 0.5.0

### Minor Changes

- f76dd0f: kernel/analyzer: library-declared Telo.Abstract + first-class `extends` + in-place invoke wrap.

  - Kernel: new runtime meta-controller for `kind: Telo.Abstract` so libraries can declare abstract contracts that importers resolve at runtime (not just in static analysis). Fixes the latent "No controller registered for kind 'Telo.Abstract'" failure when importing modules like `std/workflow` that declare an abstract.
  - Kernel: `_createInstance` now overrides `invoke` in-place on the controller's returned instance instead of wrapping it in a new object. The previous `{ ...instance, invoke }` shape (and a later prototype-preserving variant) split object identity: `init()` ran on the wrapper while the wrapper's `invoke` delegated back to the original instance, so any state `init` set on `this` was invisible at invocation time. Mutating in place keeps all lifecycle methods on the same object and incidentally preserves the prototype chain for class-based controllers.
  - Analyzer: `Telo.Definition` gains an `extends: "<Alias>.<Abstract>"` field (alias-form, resolved against the declaring file's `Telo.Import` declarations — same pattern as kind prefixes). This pins the target's module version through the import source. `DefinitionRegistry.extendedBy` is populated from both `extends` and `capability` (union-merged), so third-party modules using the legacy `capability: <UserAbstract>` overload keep working. A `CAPABILITY_SHADOWS_EXTENDS` warning prompts migration.
  - Analyzer: new `validateExtends` pass emits `EXTENDS_MALFORMED` / `EXTENDS_UNKNOWN_TARGET` / `EXTENDS_NON_ABSTRACT` / `CAPABILITY_SHADOWS_EXTENDS` diagnostics. The pass skips defs forwarded from imported libraries — those are validated in their own analysis context, where the source library's aliases are in scope.
  - Analyzer: Phase 1 registration loop now also registers `kind: Telo.Abstract` docs (previously only `Telo.Definition`), so cross-package `x-telo-ref` references to library-declared abstracts actually resolve.
  - Analyzer + kernel: the `Telo.Abstract` schema is now open (`additionalProperties: true`) — abstracts carry `schema` plus any forward-compatible fields (e.g. `inputType` / `outputType` from the typed-abstracts plan). `controllers` and `throws` remain forbidden on abstracts.
  - Loader: imported libraries' `Telo.Import` docs are now forwarded alongside their `Telo.Definition` / `Telo.Abstract` docs. Alias resolution remains the analyzer's responsibility — the loader just exposes the imports.
  - Analyzer: alias resolution is now per-scope. The consumer's aliases live in the main resolver; each imported library gets its own `AliasResolver` built from the `Telo.Import` docs forwarded under its `metadata.module`. Forwarded defs' `extends` and `capability` are normalized in their declaring library's scope, so `extendedBy` stays keyed by canonical kind even when a consumer imports the same dependency under a different alias name (or omits a transitive dependency it doesn't directly use).
  - SDK: `ResourceDefinition` type gains `extends?: string`.
  - Assert: `Assert.Manifest` supports `expect.warnings` alongside `expect.errors`.
  - Migration: `modules/workflow-temporal/telo.yaml` moves from `capability: Workflow.Backend` to canonical `capability: Telo.Provider, extends: Workflow.Backend`, and gains a self-referential `Telo.Import` (`name: Workflow, source: ../workflow`) so the alias on `extends` resolves against the library's own imports. No behavioural change for existing consumers.

- fc4a562: Polyglot controller support — Rust controllers via N-API. See `modules/starlark/plans/polyglot-rust-poc.md` for the full design.

  **SDK additions (additive, non-breaking):**

  - `ControllerPolicy` type — resolved selection policy: an ordered list of PURL-type prefixes optionally containing a single wildcard sentinel `"*"`.
  - `ResourceContext.getControllerPolicy()` and `ModuleContext.getControllerPolicy()` / `setControllerPolicy()` — produced by `Telo.Import`, consumed by `Telo.Definition.init`.

  **Kernel:**

  - `controller-loader.ts` is now a scheme dispatcher that picks a per-PURL sub-loader: `controller-loaders/npm-loader.ts` (existing logic, extracted) and `controller-loaders/napi-loader.ts` (new). The dispatcher applies the resolved policy: candidates are filtered/ordered by PURL-type prefix and the wildcard tail, and env-missing failures (`ControllerEnvMissingError`) advance to the next candidate while user-code failures (`ERR_CONTROLLER_BUILD_FAILED`, `ERR_CONTROLLER_INVALID`) fail hard.
  - `NapiControllerLoader` (dev mode only): probes `rustc --version`, runs `cargo build --release --features napi` in `local_path`, locates the dylib via `cargo metadata`, copies to `<libname>.node`, loads via `createRequire`. Distribution mode (per-platform npm packages) is out of scope and reports env-missing.
  - `runtime-registry.ts` — new module: label-to-PURL mapping (`nodejs ↔ pkg:npm`, `rust ↔ pkg:cargo`), kernel-native label, and `normalizeRuntime(value)` that resolves the user-facing `runtime:` field (string or array) into a `ControllerPolicy`. Reserved tokens: `auto` (kernel-native + wildcard), `native` (kernel-native only), `any` (wildcard).
  - `Telo.Import` schema gains a `runtime` field (string or array of strings); `Telo.Import` controller normalizes and stamps the resolved policy on the spawned child `ModuleContext` only when `runtime:` is explicit.
  - `Telo.Definition.init` reads the policy via `ctx.getControllerPolicy()` and forwards it to `ControllerLoader.load`.
  - `ControllerRegistry` is now keyed by `(kind, runtimeFingerprint)`. Lookup falls through three tiers: exact fingerprint, then `"default"` (built-ins), then any registered entry for the kind (root-context resources that reference an imported kind). Two `Telo.Import`s of the same library with divergent runtime selections each get their own cached controller instance.

  **Analyzer:**

  - `Telo.Definition` for `Import` in `analyzer/nodejs/src/builtins.ts` accepts the `runtime` property so static analysis doesn't reject manifests using the new field.

  **Tests:**

  - `kernel/nodejs/tests/napi-echo/` — Rust crate fixture exercising the napi-rs build + `.node` load path.
  - `kernel/nodejs/tests/__fixtures__/napi-test/telo.yaml` — Telo.Library wrapper around napi-echo.
  - `kernel/nodejs/tests/napi-echo-loads.yaml` — proves the loader dispatches `pkg:cargo` correctly with default `auto` resolution.
  - `kernel/nodejs/tests/napi-echo-runtime-rust.yaml` — proves explicit `runtime: rust` selects the cargo PURL.

  Repo gains a workspace-level `Cargo.toml` listing all telorun Rust crates as members; the existing Tauri crate is unaffected.

  No user-facing change for manifests that don't use `runtime:` or `pkg:cargo` — the existing npm load path is preserved exactly.

### Patch Changes

- fc4a562: Internal cleanup ahead of polyglot controller support (see `modules/starlark/plans/polyglot-rust-poc.md`):

  - `ControllerRegistry`: deleted the never-fired `registerControllerLoader` cache (gated on `baseDir = null`) and its only consumer (`registerControllerLoader`/`isModuleClass`). The live load path runs through `Telo.Definition.init` calling `ControllerLoader.load(...)`; the parallel registry-internal cache was dead.
  - `getController(kind)` now throws `ERR_CONTROLLER_NOT_LOADED` on miss instead of returning a `{ schema: { additionalProperties: false } }` stub. With the `Telo.Definition.init` path live, the stub was unreachable for any kind that has `controllers:` declared, but it silently masked bugs whenever a definition's init had not completed. Callers that want soft semantics use `getControllerOrUndefined(kind)`.
  - `kernel.start()`'s register-hook loop now iterates `getControllerKinds()` (kinds with controllers actually loaded) instead of `getKinds()` (all definitions), aligning with the throw-on-miss contract.
  - `ControllerLoader.load()` gains an optional `policy?: ControllerPolicy` third parameter as a typed seam. No producers or consumers wired yet — every call site continues to omit it. PR 1 (NapiControllerLoader) wires both ends.

  No user-facing behavior change for manifests that load successfully today.

- 80c3c03: Two follow-up fixes uncovered while building `@telorun/ai-openai` against the alias-form `extends` pattern from PR #37:

  - **Kernel:** `Telo.Import` controller now resolves relative `source` paths against the manifest's own stamped `metadata.source` instead of the parent module context's source. When a Telo.Library imports another library via a relative path, that path is written relative to the declaring library's file — not relative to whatever root manifest happens to load the chain. Without this fix, nested transitive imports would resolve against the wrong base directory at runtime (the analyzer was already correct).
  - **Analyzer:** `loadManifests` now forwards `Telo.Import` docs from imported libraries into the analysis manifest set, and re-stamps `resolvedModuleName` / `resolvedNamespace` on Telo.Import docs that re-encounter an already-loaded import URL through a different chain. Required so alias-form `extends` declarations inside imported libraries (e.g. `ai-openai/telo.yaml`'s `extends: Ai.Model`) resolve through the library's own `Telo.Import name: Ai`, even when the consumer doesn't import `Ai` directly.

  No behavioural change for existing modules — both fixes only affect cases that were already broken at runtime or that previously emitted spurious `EXTENDS_MALFORMED` diagnostics.

- Updated dependencies [80c3c03]
- Updated dependencies [f76dd0f]
- Updated dependencies [fc4a562]
  - @telorun/analyzer@0.4.0
  - @telorun/sdk@0.5.0

## 0.4.1

### Patch Changes

- Updated dependencies [e35e2ee]
- Updated dependencies [c97da42]
  - @telorun/analyzer@0.3.0

## 0.4.0

### Patch Changes

- 6a61dbf: Add `telo install <path>` — pre-downloads every controller declared by a manifest and its transitive `Telo.Import`s into the on-disk cache. At runtime the kernel finds each controller already cached and skips the boot-time `npm install`, removing the startup delay and the network dependency from production containers.

  Reuses the existing `ControllerLoader`, so resolution semantics (local_path, node_modules, npm fallback, entry resolution) are identical to runtime loading. Jobs run in parallel via `Promise.allSettled`; failures are reported per controller and the command exits non-zero if any failed.

  `ControllerLoader` is now exported from `@telorun/kernel`.

  **Cache location**: defaults to `~/.cache/telo/` (XDG-style, shared across projects for a user). Override via `TELO_CACHE_DIR` — set it per-project to bundle the cache alongside the manifest. The registry image now uses `TELO_CACHE_DIR=/srv/.telo-cache` so `telo install` at build time and `telo run` at boot both read/write the same project-local cache, and a single `COPY --from=build /srv /srv` carries the full bundle into the production stage.

## 0.3.3

### Patch Changes

- f75a730: Telo editor now renders schema string fields as a Monaco code editor when the field carries `x-telo-widget: "code"`, with syntax highlighting resolved from the field's `contentMediaType` via Monaco's own language registry. No built-in language table lives in the editor — modules declare their own format entirely through schema annotations, so new languages land without editor changes.

  - New recognized schema annotation `x-telo-widget` — registered in the kernel's AJV vocabulary. Accepts `"code"` today; orthogonal to `contentMediaType`, which carries the MIME.
  - `Javascript.Script.code` now declares `x-telo-widget: "code"` + `contentMediaType: "application/javascript"` and renders in Monaco with JS highlighting.
  - Composes unchanged with `x-telo-eval`: the CEL toggle wraps whichever inner widget the schema selects — typed-value mode shows the code editor, CEL mode shows the existing expression input.

- f75a730: Fix `createTypeValidator` crashing with `schema is invalid: data/properties/kind must be object,boolean` when a controller receives an inline type. The analyzer normalizes inline `{kind, schema: {...}}` values into `{kind, name}` refs before Phase 5 injection; the type validator now resolves those refs via the schema registry instead of compiling the ref object as a JSON Schema literal.

## 0.3.2

### Patch Changes

- 3c4ac58: Resource initialization errors now carry the resource `kind`, an underlying error `code`, and a structured `details` block extracted from the original error — AWS SDK service exceptions expose HTTP status / request ID / fault, pg database errors expose severity / detail / hint / SQLSTATE / routine, Node system errors expose syscall / address / port, and the full `cause` chain is walked. The CLI renders runtime diagnostics distinctly from static-analysis diagnostics: no redundant file path, `kind` and `name` shown as the heading, details indented below.
- Updated dependencies [3c4ac58]
  - @telorun/sdk@0.3.2
  - @telorun/analyzer@0.2.1

## 0.3.0

### Minor Changes

- 353d7e5: feat: invocable errors — structured error channel end-to-end

  Invocables and runnables now have a first-class structured-error channel for domain failures (`InvokeError`), distinct from operational failures (plain `Error` / `RuntimeError`). Route handlers branch on named codes via `catches:`; sequences catch with `error.code` / `error.message` / `error.data` / `error.step` context.

  **SDK** (`@telorun/sdk`)

  - New `InvokeError` class + `isInvokeError` guard. Symbol-based discrimination (`Symbol.for("telo.InvokeError")`) is dual-realm-safe across pnpm hoist splits, registry modules, and future sandbox isolation.
  - `ResourceDefinition.throws`: declared-throw contract (`codes` map, `inherit: true`, `passthrough: true`).
  - `ResourceContext` / `EvaluationContext` gain `invokeResolved(kind, name, instance, inputs)` for callers that already hold a resolved instance.

  **Kernel** (`@telorun/kernel`)

  - Single emission point for invoke-level events: `Invoked` / `InvokeRejected` / `InvokeFailed` / `InvokeRejected.Undeclared`. All call paths (direct invoke, sequence scope path, HTTP route handler) route through the same wrapper.
  - `Telo.Definition.throws:` schema with per-capability restrictions (rule 8: only on Invocable / Runnable).
  - `resolveChildren` now auto-registers bare-kind inline refs when a resource name is supplied without an explicit name on the ref — lets stateless invocables like `Run.Throw` be used inline via `invoke: {kind: Run.Throw}`.

  **Analyzer** (`@telorun/analyzer`)

  - New dataflow resolver (`resolve-throws-union.ts`) for `inherit: true` / `passthrough: true` declarations. Walks `x-telo-step-context` arrays generically, applies `try`/`catch` subtraction, detects cycles, memoises per manifest.
  - New coverage validator (`validate-throws-coverage.ts`) — rules 1/2/4/7 for `catches:` lists. Coverage-proving CEL parser recognises `error.code == 'X'`, disjunctions, and `error.code in [...]`. Typed `error.data.<field>` access against per-code `data:` schemas, with intersection narrowing for disjunctive `when:` clauses.
  - New error codes: `UNDECLARED_THROW_CODE`, `UNCOVERED_THROW_CODE`, `UNBOUNDED_UNION_NEEDS_CATCHALL`, `CATCHALL_NOT_LAST`, `INHERIT_WITHOUT_STEP_CONTEXT`.

  **Run module** (`@telorun/run`)

  - `Run.Sequence` declares `throws: { inherit: true }`. Its effective union is resolved from step invocables at analysis time.
  - New `Run.Throw` invocable: takes `{code, message, data?}` and throws `InvokeError`. Declared with `throws: { passthrough: true }`; the analyzer resolves constant / `error.code`-inside-catch forms at each call site.
  - Sequence `try`/`catch` `error` context gains `data?: unknown` and now branches on `isInvokeError`.

  **HTTP server module** (`@telorun/http-server`) — **breaking**

  - Route-level `response:` is replaced by two channel lists: `returns:` (how to render handler results) and `catches:` (how to render `InvokeError` throws). Applies to both `Http.Api` routes and `Http.Server.notFoundHandler`.
  - Plain `Error` / `RuntimeError` throws skip `catches:` and fall through to Fastify's default 5xx renderer — operational vs. domain failures are now distinct on the wire.
  - `catches:` entries reject `mode: stream` at schema validation (structured errors always render as JSON).
  - Unmatched `returns:` dispatch now throws (surfaces via Fastify's error handler) instead of rendering a silent 500.
  - Every `response:` occurrence across the repo (apps, benchmarks, examples, tests) migrated to `returns:` — no manifest carries the old shape.

  See `sdk/nodejs/plans/invocable-errors.md` for the full design and rollout phasing.

- 31d721e: feat: bearer-token auth for the Telo module registry publish endpoint

  The registry's `PUT /{namespace}/{name}/{version}` now requires an `Authorization: Bearer <token>` header. Reads stay anonymous. Tokens are provisioned declaratively at boot via `TELO_PUBLISH_TOKEN` and stored as SHA-256 hashes in a `tokens` table joined to `users` and `namespaces`.

  **Analyzer** (`@telorun/analyzer`) — **breaking for direct API consumers**

  - `StaticAnalyzer` and `Loader` now accept an optional `{ celHandlers }` in their constructors. Analyzer-only callers (VS Code extension, Docusaurus preview, CLI `check`/`publish`) can omit it and get throwing stubs. Runtime callers (kernel) must supply real handlers.
  - The module-level `celEnvironment` singleton is removed — `precompile.ts` now takes the `Environment` as a parameter.
  - New CEL stdlib function: `sha256(string): string`. Always registered with the correct signature so `env.check()` type-checks; behaviour depends on the supplied handler.
  - The throws-union resolver recognises the new `throw:` step shape (see Run module) and resolves its code at the call site using the same rules as passthrough invocables (literal / `${{ 'LIT' }}` / `${{ error.code }}` in catch).
  - CEL type-check failures now surface as diagnostics. Previously the analyzer only reported schema/type mismatches on valid expressions; `env.check(...)` returning `{ valid: false }` (wrong method, wrong operand types, wrong overload — e.g. `s.slice(7)` on a dyn) was silently dropped. Now surfaces as `SCHEMA_VIOLATION` with a `CEL type error:` message.

  **Kernel** (`@telorun/kernel`)

  - Constructs `StaticAnalyzer` and `Loader` with a `node:crypto`-backed `sha256` handler, so CEL templates invoking `sha256()` evaluate at runtime.

  **Run module** (`@telorun/run`) — **breaking**

  - `Run.Sequence` gains a first-class `throw:` step variant: `- name: X; throw: { code, message?, data? }` — throws `InvokeError` directly from inside the sequence. Works inside `catch:` blocks via `code: "${{ error.code }}"` for re-raise. A malformed `throw.code` (non-string or empty after expansion) is itself reported as `InvokeError("INVALID_THROW_STEP", …)` rather than a plain Error, so the failure stays in the structured-error channel and a surrounding `catches:` can map it.
  - The `Run.Throw` invocable is removed. Existing `invoke: { kind: Run.Throw }` call sites must migrate to `throw:` steps. The separate kind was redundant with the new step form, and the `throw:` step expresses the intent more directly inside sequences.
  - **Event-stream change:** `throw:` steps do **not** emit a scoped `<Kind>.<name>.InvokeRejected` event the way `Run.Throw` did. The error is thrown from inside the sequence's own `invoke()`, so the enclosing kind's event is what fires (e.g. `Run.Sequence.<handlerName>.InvokeRejected` — or nothing, when an enclosing `try` absorbs the throw). Downstream observers that filtered on `Run.Throw.*.InvokeRejected` must switch filters.

  **CLI** (`@telorun/cli`)

  - `telo publish` reads `TELO_REGISTRY_TOKEN` and sends it as `Authorization: Bearer <token>`. Without the env var, publishes to auth-gated registries fail with 401.

  See `apps/registry/plans/registry-auth.md` for the full plan.

### Patch Changes

- Updated dependencies [353d7e5]
- Updated dependencies [31d721e]
  - @telorun/sdk@0.3.0
  - @telorun/analyzer@0.2.0

## 0.2.9

### Patch Changes

- Automated release.
- Updated dependencies
  - @telorun/analyzer@0.1.4

## 0.2.8

### Patch Changes

- Automated release.
- Updated dependencies
  - @telorun/analyzer@0.1.3
  - @telorun/sdk@0.2.8
  - @telorun/yaml-cel-templating@1.0.4

## 0.2.7

### Patch Changes

- Automated release.
- Updated dependencies
  - @telorun/analyzer@0.1.2
  - @telorun/sdk@0.2.7

## 0.2.6

### Patch Changes

- Automated release.
- Updated dependencies
  - @telorun/analyzer@0.1.1
  - @telorun/sdk@0.2.6
  - @telorun/yaml-cel-templating@1.0.3

## 0.2.5

### Patch Changes

- Automated release.
- Updated dependencies
  - @telorun/sdk@0.2.5

## 0.2.4

### Patch Changes

- Automated release.
- Updated dependencies
  - @telorun/sdk@0.2.4
  - @telorun/yaml-cel-templating@1.0.2

## 0.2.3

### Patch Changes

- Automated release.
- Updated dependencies
  - @telorun/sdk@0.2.3

## 0.2.2

### Patch Changes

- Automated release.
- Updated dependencies
  - @telorun/sdk@0.2.2
  - @telorun/yaml-cel-templating@1.0.1
