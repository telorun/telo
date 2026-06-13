# @telorun/cli

## 0.27.0

### Minor Changes

- 9ef48a6: Add a live debug-event inspection UI. `telo run --inspect` starts a
  localhost-only inspection endpoint and prints its URL — a single page that
  watches the kernel event stream in real time (SSE), with text/kind/suffix
  filtering, expandable payloads, pause, and replay of events that fired before
  the page was opened. (`--debug` independently writes the `.telo.debug.jsonl`
  event log; the two compose. See the `--inspect` flag set for delivery details.)

  New `@telorun/debug-ui` package: the browser-safe, runtime-agnostic consumer
  surface — the debug wire-format types + JSON Schema, filter logic, an SSE client,
  and React components (incl. the standalone app served by the inspection server).
  It has no Node-only dependency so it also runs in the editor webview.

  Binary payloads (images and any other file kind) are not inlined: the producer
  offloads each `Uint8Array`/`Buffer` to an in-memory, content-addressed LRU blob
  store and emits a small `{ "$blob": "blobs/<id>", "mediaType", "byteLength" }`
  pointer in its place (the key it sits under is preserved). The `DebugServer`
  serves the bytes at `GET /blobs/:id`; the UI renders `image/*` inline and other
  types as download links. Content addressing dedupes repeated buffers (e.g. a
  redraw loop).

  The producer (serializer + `DebugServer` + blob store) stays Node-side in the
  CLI; the cross-runtime contract is the wire format
  (`@telorun/debug-ui/wire-schema.json`), so a future Rust/Go kernel can serve the
  same UI by conforming to it. The inspection server binds `127.0.0.1` and is
  `unref`'d, so a one-shot `--inspect` run still exits normally.

- 9ef48a6: Ship the debug UI on demand instead of bundling it in the CLI, and give the
  inspection endpoint its own composable flag set.

  - `telo run --inspect[=[host:]port]` starts the live inspection endpoint
    (default `127.0.0.1:9230`; non-loopback binds print a security warning) and
    serves the UI same-origin, with a `/json/version` discovery handshake.
    `--no-open` suppresses auto-opening the browser. `--debug` is a separate,
    composable flag that writes only the `.telo.debug.jsonl` event log (no network,
    no UI).
  - The CLI does not bundle `@telorun/debug-ui` (it's a `devDependency`). The UI is
    fetched on demand from npm via jsDelivr and cached under the `.telo` cache
    root; in the monorepo it resolves from the workspace, so local builds are
    testable offline. `TELO_DEBUG_UI_PATH` overrides the bundle path; `TELO_DEBUG_UI_URL`
    overrides the CDN base.
  - `@telorun/debug-ui` builds a self-contained single-file bundle
    (`app-single/index.html`) alongside `app-dist/`.

### Patch Changes

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

- 9ef48a6: Fix `telo run --watch --inspect` dropping the debug UI on every reload. The
  inspection server is now created once per session and the rebuilt kernel
  re-attaches to it each cycle, so the browser's SSE connection (and replay buffer
  - JSONL) survive reloads instead of the UI showing the process as terminated.
- Updated dependencies [9ef48a6]
- Updated dependencies [9ef48a6]
  - @telorun/kernel@0.27.0

## 0.26.1

### Patch Changes

- Updated dependencies [5973024]
- Updated dependencies [a592710]
  - @telorun/analyzer@0.23.1
  - @telorun/kernel@0.26.1
  - @telorun/ide-support@0.4.24

## 0.26.0

### Minor Changes

- 1ddd803: Add a single, threaded cache-root resolution and a read-only cache mode for ephemeral runs.

  - **`TELO_CACHE_DIR` reinstated** as the override for the `.telo` cache root, resolved once per load via the new `resolveCacheRoot(entryUrl)` and threaded to the manifest cache, compiled validators, analysis stamp, and npm install root — no consumer re-derives it or reads the env independently. `Kernel.load` gains a `cacheDir` option so a CLI caller resolves it once and the kernel reads no env.
  - **`telo run --no-cache-write`** (kernel `writeCache: false`) keeps the cache read-only: baked validators/manifests are still loaded, anything uncached validates in-memory, and nothing is persisted — so a read-only, ephemeral session rootfs validates without touching (or failing to write) the cache. Validation errors still surface normally.
  - **SDK**: `ResourceContext` gains `getInstallRoot()`, the threaded npm install root, so controllers honour a relocated cache root.

### Patch Changes

- Updated dependencies [1ddd803]
  - @telorun/kernel@0.26.0
  - @telorun/sdk@0.26.0
  - @telorun/analyzer@0.23.0
  - @telorun/templating@0.8.0

## 0.25.0

### Patch Changes

- 206cf98: fix(cli): restore `telo run --watch`

  Watch mode was inert — its file watching and reload were stubbed out against
  two kernel methods (`getSourceFiles`, `reloadSource`) that no longer exist.
  Reimplement it as a full-restart loop: load → derive the graph's local files
  (entry, `include:` partials, imported libraries) → start (held alive so
  one-shot apps don't exit) → reload on any change by cancelling and tearing the
  kernel down, then rebuilding. Load/boot failures are reported as diagnostics
  and watch keeps running so the next edit retries. The watcher set is persistent
  across reloads (one long-lived `fs.watch` per file) rather than torn down and
  recreated each cycle — under bun, re-`fs.watch`-ing a just-closed path never
  fires again, which limited reloads to exactly one.

- Updated dependencies [c89e79b]
- Updated dependencies [c89e79b]
- Updated dependencies [1098ad0]
- Updated dependencies [4794671]
  - @telorun/kernel@0.25.0
  - @telorun/analyzer@0.23.0
  - @telorun/ide-support@0.4.23

## 0.24.2

### Patch Changes

- 004a848: Warm analysis caches at `telo install` time so a prebuilt image boots without re-deriving them.

  `kernel.load` now accepts an `analyzeOnly` option that runs the static-analysis pre-flight and persists its caches (the `.validated.json` analysis stamp and the compiled `__validators/` schema cache) but stops before module instantiation, target wiring, and application-env resolution. It also pre-compiles the application-env residual validators (`variables`/`secrets`/`ports`), which the runtime would otherwise recompile on every boot. `telo install` invokes this offline `kernel.load` to bake the caches onto a writable filesystem, so the runtime `load()` on a read-only session rootfs hits the stamp and skips the validation walk instead of failing to persist the caches (EROFS/ENOENT) on every boot.

- Updated dependencies [004a848]
  - @telorun/kernel@0.24.2

## 0.24.1

### Patch Changes

- Updated dependencies [9a305e6]
  - @telorun/kernel@0.24.1

## 0.24.0

### Patch Changes

- Updated dependencies [ee8926f]
- Updated dependencies [ee8926f]
  - @telorun/kernel@0.24.0
  - @telorun/templating@0.8.0
  - @telorun/analyzer@0.22.0
  - @telorun/ide-support@0.4.22

## 0.23.0

### Patch Changes

- Updated dependencies [8586b39]
- Updated dependencies [2292a84]
  - @telorun/kernel@0.23.0
  - @telorun/analyzer@0.21.0
  - @telorun/sdk@0.23.0
  - @telorun/templating@0.7.0
  - @telorun/ide-support@0.4.21

## 0.22.0

### Minor Changes

- 06cfcbf: Add `telo cel functions` (list the CEL standard library — `--json` for tooling) and `telo cel eval "<expr>" [--context <json>]` (evaluate a CEL expression with the real Node handlers). Backed by a single-source CEL catalog: `@telorun/templating` now exports `celFunctionCatalog()` / `CEL_FUNCTIONS`, and `buildCelEnvironment` registers from it so the documented surface can't drift from what's registered. `@telorun/kernel` exports `nodeCelHandlers` (the Node `crypto`/`Buffer` implementations) so the CLI's eval matches a real run.

### Patch Changes

- Updated dependencies [06cfcbf]
- Updated dependencies [06cfcbf]
- Updated dependencies [06cfcbf]
  - @telorun/kernel@0.22.0
  - @telorun/analyzer@0.20.0
  - @telorun/templating@0.6.0
  - @telorun/ide-support@0.4.20

## 0.21.0

### Patch Changes

- Updated dependencies [64debb5]
  - @telorun/templating@0.5.0
  - @telorun/sdk@0.21.0
  - @telorun/analyzer@0.19.1
  - @telorun/kernel@0.21.0
  - @telorun/ide-support@0.4.19

## 0.20.1

### Patch Changes

- Updated dependencies [81ebf47]
- Updated dependencies [ea57e10]
- Updated dependencies [81ebf47]
  - @telorun/analyzer@0.19.0
  - @telorun/kernel@0.20.1
  - @telorun/ide-support@0.4.18

## 0.20.0

### Patch Changes

- Updated dependencies [2864c4d]
  - @telorun/kernel@0.20.0

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

- Updated dependencies [5331205]
  - @telorun/sdk@0.19.0
  - @telorun/kernel@0.19.0
  - @telorun/analyzer@0.18.0
  - @telorun/templating@0.4.1

## 0.18.0

### Patch Changes

- Updated dependencies [d2294de]
  - @telorun/analyzer@0.18.0
  - @telorun/sdk@0.18.0
  - @telorun/kernel@0.18.0
  - @telorun/ide-support@0.4.17
  - @telorun/templating@0.4.1

## 0.17.3

### Patch Changes

- Updated dependencies [69a0a8d]
  - @telorun/analyzer@0.17.0
  - @telorun/kernel@0.17.3
  - @telorun/ide-support@0.4.16

## 0.17.2

### Patch Changes

- 0505e9b: cli + ide-support: operate on the inline `imports:` map instead of standalone `Telo.Import` documents

  `telo upgrade` and `telo publish` now read and rewrite import sources from the
  `imports:` map on the `Telo.Application` / `Telo.Library` doc, covering both the
  scalar shorthand (`Alias: <src>`) and the object form (`Alias: { source: <src>, … }`).
  Standalone `Telo.Import` document handling is dropped from both commands. `upgrade`
  keeps its byte-level splice (quote style, comments, and folded block scalars are
  preserved); `publish` canonicalizes relative `imports:` sources to
  `<namespace>/<name>@<version>` and now loads the pre-flight analysis graph with
  `desugarImports` so inline imports resolve during static validation. `telo install`
  likewise loads its graph with `desugarImports`, so transitive inline imports are
  discovered, cached, and analyzed.

  ide-support source autocomplete fires on `imports:` entries (scalar value or the
  `source:` under the object form), gated on the enclosing path so unrelated `source:`
  fields never trigger it. `Telo.Import` is removed from the no-registry kind
  completion fallback.

- Updated dependencies [0505e9b]
  - @telorun/ide-support@0.4.15

## 0.17.1

### Patch Changes

- Updated dependencies [c1432a6]
  - @telorun/analyzer@0.16.1
  - @telorun/kernel@0.17.1
  - @telorun/ide-support@0.4.14

## 0.17.0

### Patch Changes

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

- Updated dependencies [0cd36a1]
  - @telorun/analyzer@0.16.0
  - @telorun/kernel@0.17.0
  - @telorun/sdk@0.17.0
  - @telorun/ide-support@0.4.13
  - @telorun/templating@0.4.1

## 0.16.1

### Patch Changes

- Updated dependencies [acb8996]
  - @telorun/kernel@0.16.1

## 0.16.0

### Patch Changes

- Updated dependencies [55b4ec5]
- Updated dependencies [adc248b]
  - @telorun/analyzer@0.15.0
  - @telorun/kernel@0.16.0
  - @telorun/sdk@0.16.0
  - @telorun/templating@0.4.1
  - @telorun/ide-support@0.4.12

## 0.15.0

### Patch Changes

- Updated dependencies [ae0bf77]
- Updated dependencies [222b3d6]
  - @telorun/sdk@0.13.0
  - @telorun/kernel@0.15.0
  - @telorun/analyzer@0.14.0
  - @telorun/templating@0.4.0
  - @telorun/ide-support@0.4.11

## 0.14.0

### Patch Changes

- Updated dependencies [bfe4967]
- Updated dependencies [1c37ee1]
  - @telorun/kernel@0.14.0
  - @telorun/analyzer@0.13.0
  - @telorun/templating@0.3.1
  - @telorun/ide-support@0.4.10

## 0.13.2

### Patch Changes

- Updated dependencies [6ce1a52]
- Updated dependencies [6ce1a52]
  - @telorun/analyzer@0.12.1
  - @telorun/kernel@0.13.2
  - @telorun/ide-support@0.4.9

## 0.13.1

### Patch Changes

- 4c1a50b: Refresh in-tree documentation version pins to the current registry latest.

## 0.13.0

### Minor Changes

- f3e5fbc: Make warm `telo run` ~3× faster by populating the local manifest cache automatically and deduplicating loader reads.

  - **analyzer**: `Loader.loadFile` now keys a fast path on the request URL, skipping the source `read()` round-trip when the same URL is loaded twice in one kernel lifetime. When the cache has the file in the other compile mode it reparses from cached text instead of re-reading. Previously every duplicate request re-ran the underlying `read()` — a `fetch` for `RegistrySource`, a disk read for `LocalFileSource`.
  - **kernel**: `Kernel.load()` retains the full `LoadedGraph` and exposes it via `kernel.getLoadedGraph()` so the CLI can hand it to `writeManifestCache` without re-walking the graph.
  - **cli**: `telo run` now writes through to `<entry-dir>/.telo/manifests/` after a successful first load, reusing the same `writeManifestCache` path `telo install` already uses. Subsequent runs hit the local cache and skip the registry round-trip — without requiring an explicit `telo install`. Cache writes are best-effort: read-only filesystems (e.g. baked Docker images) log a warning and continue.

- 768f5d7: Add `telo upgrade <paths..>` — scans the given manifest files for `Telo.Import` declarations whose `source` is a registry ref (`<namespace>/<name>@<version>`), queries the registry for the latest published version, and rewrites the source in place when a newer version is available.

  The command uses the same registry-URL fallback as `install` / `run` (`--registry-url` flag > `TELO_REGISTRY_URL` > `https://registry.telo.run`). Pre-release versions are excluded by default; pass `--include-prerelease` to consider them. `--dry-run` reports the proposed upgrades without touching the file.

  Non-registry sources (relative paths, HTTP URLs) and unparseable versions are skipped with a notice rather than treated as errors.

### Patch Changes

- Updated dependencies [c0129c0]

  - @telorun/analyzer@0.12.0
  - @telorun/kernel@0.13.0
  - @telorun/ide-support@0.4.8

- Updated dependencies [0331069]
- Updated dependencies [0331069]

  - @telorun/analyzer@0.12.0
  - @telorun/kernel@0.13.0
  - @telorun/ide-support@0.4.7

- Updated dependencies [77c1c86]
- Updated dependencies [7889023]

  - @telorun/analyzer@0.12.0
  - @telorun/templating@0.3.0
  - @telorun/kernel@0.13.0
  - @telorun/ide-support@0.4.6

- Updated dependencies [f3e5fbc]
- Updated dependencies [f3e5fbc]

  - @telorun/analyzer@0.12.0
  - @telorun/kernel@0.13.0
  - @telorun/ide-support@0.4.5

- 3e3f134: Migrate Docker image publishing to a per-runtime-repo scheme with variant + multi-arch tagging.

  **Kernel image** moves from `telorun/telo` to `telorun/node`, reserving the namespace for future polyglot kernels (`telorun/rust`, `telorun/go`). The previous monolithic image is split into four variants per release:

  - `telorun/node:<v>` / `telorun/node:<v>-slim` — lean variants, no Rust toolchain.
  - `telorun/node:<v>-rust-<rust-version>` / `telorun/node:<v>-rust-<rust-version>-slim` — opt-in Rust toolchain layered on top.

  Rolling tags (`latest`, `<major>`, `<major>.<minor>`) compose with the variant suffixes. Release tags are immutable; pin to exact versions for reproducible builds. Release images are multi-arch (`linux/amd64` + `linux/arm64`). Dev tags (`sha-<short>-*`) appear on every main-branch push, slim variants only.

  **Lambda base images** newly published as `telorun/lambda-node-managed:<lambda-version>` (managed nodejs runtime) and `telorun/lambda-node-custom:<lambda-version>` (custom `provided.al2023` runtime). Both pre-install `@telorun/lambda` and its workspace deps at `${LAMBDA_TASK_ROOT}`; user images derive from them and add only their manifest + install root. The `-node-` segment in the repo name reserves the namespace for future `telorun/lambda-rust-*` images.

  **CI**: docker publishing now runs from `.github/workflows/publish-docker.yml`, called by `publish.yml` after `changesets/action` actually publishes packages. Per-image gating reads `outputs.publishedPackages` so kernel images rebuild only when `@telorun/cli` bumps and lambda images only when `@telorun/lambda` bumps.

- Updated dependencies [39aef08]

  - @telorun/kernel@0.13.0
  - @telorun/analyzer@0.12.0
  - @telorun/ide-support@0.4.4

- Updated dependencies [849f57a]
- Updated dependencies [e411584]
- Updated dependencies [e411584]
- Updated dependencies [be79957]
  - @telorun/kernel@0.13.0
  - @telorun/sdk@0.12.0
  - @telorun/analyzer@0.12.0
  - @telorun/ide-support@0.4.3
  - @telorun/templating@0.3.0

## 0.12.0

### Patch Changes

- Updated dependencies [67a9b31]
- Updated dependencies [0f80fc5]
  - @telorun/kernel@0.12.0
  - @telorun/analyzer@0.11.0
  - @telorun/ide-support@0.4.2

## 0.11.1

### Patch Changes

- Updated dependencies [58362c4]
- Updated dependencies [58362c4]
  - @telorun/kernel@0.11.1
  - @telorun/sdk@0.11.1
  - @telorun/analyzer@0.10.1
  - @telorun/templating@0.2.3
  - @telorun/ide-support@0.4.1

## 0.11.0

### Minor Changes

- f61b36a: `telo install` now also persists every imported manifest's YAML to `<entry-dir>/.telo/manifests/` (registry refs under `<namespace>/<name>/<version>/telo.yaml`, HTTP imports under `__http/<host>/<pathname>`). `telo run` registers a new `LocalManifestCacheSource` ahead of the registry / HTTP sources, so production images that ran `telo install` at build time boot with zero registry network I/O — fixing the self-bootstrap loop in the registry image and unblocking air-gapped deploys. Cache misses fall through to the network source transparently; dev runs without a prior install are unchanged. New CLI flag `telo install --registry-url <url>` mirrors `telo run` for consistency.

  The reader and writer share a single URL→path function so direct-URL imports of a registry-served manifest (`source: https://registry.telo.run/...`) hit the same cache file as the corresponding `source: namespace/name@version` ref. HTTP URLs with a query string or fragment are disambiguated with a 12-char content hash on the filename so two different manifests never collide. All cache paths are validated to stay under the cache root, guarding against `..` segments in module refs.

  - `@telorun/kernel`: adds `LocalManifestCacheSource`, `writeManifestCache`, `cachePathForCanonical`, and `resolveEntryDir` exports.
  - `@telorun/cli`: `telo install` writes the manifest cache; `telo run` registers the cache source; new `--registry-url` flag on `telo install`.

### Patch Changes

- Updated dependencies [d9df589]
- Updated dependencies [f61b36a]
- Updated dependencies [65647e0]
  - @telorun/ide-support@0.4.0
  - @telorun/kernel@0.11.0
  - @telorun/analyzer@0.10.0

## 0.10.0

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

- Updated dependencies [07c881a]
- Updated dependencies [5c49834]
- Updated dependencies [50ae578]
- Updated dependencies [f1c35bc]
- Updated dependencies [47f7d83]
  - @telorun/analyzer@0.9.0
  - @telorun/ide-support@0.3.0
  - @telorun/kernel@0.10.0
  - @telorun/sdk@0.10.0
  - @telorun/templating@0.2.2

## 0.9.2

### Patch Changes

- Updated dependencies [30bcfef]
  - @telorun/analyzer@0.8.1
  - @telorun/templating@0.2.1
  - @telorun/kernel@0.9.2

## 0.9.1

### Patch Changes

- Updated dependencies [543b91f]
  - @telorun/kernel@0.9.1

## 0.9.0

### Minor Changes

- 88e5cb4: Introduce per-property templating engines via YAML tags. New `@telorun/templating` package owns the shared CEL core (compile, chain validator, walker, environment) and a pluggable engine registry. Two built-in engines ship: `!cel` (single CEL expression — no `${{ }}` wrapping) and `!literal` (opaque text — no interpolation, no analysis). Untagged `${{ }}` strings continue to compile as CEL exactly as before. The kernel, analyzer, telo editor, and VS Code extension now share one source of truth for engine registration and YAML tag parsing.

### Patch Changes

- Updated dependencies [88e5cb4]
- Updated dependencies [88e5cb4]
  - @telorun/analyzer@0.8.0
  - @telorun/templating@0.2.0
  - @telorun/kernel@0.9.0

## 0.8.0

### Patch Changes

- Updated dependencies [019c62a]
- Updated dependencies [c792025]
  - @telorun/kernel@0.8.0
  - @telorun/analyzer@0.7.0

## 0.7.3

### Patch Changes

- 84e9edf: `telo publish` now canonicalizes relative `Telo.Import.source` paths (e.g. `../ai`) into absolute registry references of the form `<namespace>/<name>@<version>` before pushing the manifest. Relative paths are only meaningful on the publisher's filesystem; once a manifest reached the registry, the leading `..` collapsed the version segment of the registry URL (so e.g. a sibling import at `…/<package>/<version>/` + `../<sibling>` resolved to `…/<package>/<sibling>`, dropping the version), and any consumer that imported a published library which itself used relative imports got a 500 from the registry. Sibling-module metadata (`namespace` / `name` / `version`) is read from the local target's `telo.yaml` at publish time.

## 0.7.2

### Patch Changes

- Updated dependencies [40ae3ea]
- Updated dependencies [0335074]
  - @telorun/analyzer@0.6.1
  - @telorun/kernel@0.7.2

## 0.7.1

### Patch Changes

- 024debe: Declare `engines.node: ">=24"` on `@telorun/cli` and `@telorun/kernel`. Makes the supported Node version explicit (and fixes the npm Node-version badge in the README, which previously rendered "not specified").
- Updated dependencies [024debe]
  - @telorun/kernel@0.7.1

## 0.7.0

### Patch Changes

- Updated dependencies [6d4280e]
- Updated dependencies [b62e535]
  - @telorun/kernel@0.7.0
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

- Updated dependencies [0c4d023]
  - @telorun/kernel@0.6.1

## 0.6.0

### Minor Changes

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
  - @telorun/kernel@0.6.0
  - @telorun/analyzer@0.5.0

## 0.5.0

### Patch Changes

- Updated dependencies [fc4a562]
- Updated dependencies [80c3c03]
- Updated dependencies [f76dd0f]
- Updated dependencies [fc4a562]
  - @telorun/kernel@0.5.0
  - @telorun/analyzer@0.4.0
  - @telorun/sdk@0.5.0

## 0.4.1

### Patch Changes

- 2900b1c: `telo publish` now retries transient registry push failures with exponential backoff (up to 4 attempts). Retries on network errors (DNS, reset, `fetch failed`) and on `408`, `425`, `429`, and `5xx` responses so flaky CI pushes no longer fail the whole workflow.
- Updated dependencies [e35e2ee]
- Updated dependencies [c97da42]
  - @telorun/analyzer@0.3.0
  - @telorun/kernel@0.4.1

## 0.4.0

### Minor Changes

- 6a61dbf: Add `telo install <path>` — pre-downloads every controller declared by a manifest and its transitive `Telo.Import`s into the on-disk cache. At runtime the kernel finds each controller already cached and skips the boot-time `npm install`, removing the startup delay and the network dependency from production containers.

  Reuses the existing `ControllerLoader`, so resolution semantics (local_path, node_modules, npm fallback, entry resolution) are identical to runtime loading. Jobs run in parallel via `Promise.allSettled`; failures are reported per controller and the command exits non-zero if any failed.

  `ControllerLoader` is now exported from `@telorun/kernel`.

  **Cache location**: defaults to `~/.cache/telo/` (XDG-style, shared across projects for a user). Override via `TELO_CACHE_DIR` — set it per-project to bundle the cache alongside the manifest. The registry image now uses `TELO_CACHE_DIR=/srv/.telo-cache` so `telo install` at build time and `telo run` at boot both read/write the same project-local cache, and a single `COPY --from=build /srv /srv` carries the full bundle into the production stage.

### Patch Changes

- Updated dependencies [6a61dbf]
  - @telorun/kernel@0.4.0

## 0.3.3

### Patch Changes

- Updated dependencies [f75a730]
- Updated dependencies [f75a730]
  - @telorun/kernel@0.3.3

## 0.3.2

### Patch Changes

- 3c4ac58: Resource initialization errors now carry the resource `kind`, an underlying error `code`, and a structured `details` block extracted from the original error — AWS SDK service exceptions expose HTTP status / request ID / fault, pg database errors expose severity / detail / hint / SQLSTATE / routine, Node system errors expose syscall / address / port, and the full `cause` chain is walked. The CLI renders runtime diagnostics distinctly from static-analysis diagnostics: no redundant file path, `kind` and `name` shown as the heading, details indented below.
- Updated dependencies [3c4ac58]
  - @telorun/sdk@0.3.2
  - @telorun/kernel@0.3.2
  - @telorun/analyzer@0.2.1

## 0.3.1

### Patch Changes

- 2d866be: Add `--skip-controllers` flag to `telo publish`. When set, skips the controller build/publish/PURL-rewrite loop and only runs static analysis and pushes the manifest to the Telo registry. Used by the Changesets-driven CI release flow, where controller packages are already published by `changeset publish`.

## 0.3.0

### Minor Changes

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
  - @telorun/kernel@0.3.0
  - @telorun/analyzer@0.2.0

## 0.2.9

### Patch Changes

- Automated release.
- Updated dependencies
  - @telorun/analyzer@0.1.4
  - @telorun/kernel@0.2.9

## 0.2.8

### Patch Changes

- Automated release.
- Updated dependencies
  - @telorun/analyzer@0.1.3
  - @telorun/kernel@0.2.8

## 0.2.7

### Patch Changes

- Automated release.
- Updated dependencies
  - @telorun/analyzer@0.1.2
  - @telorun/kernel@0.2.7

## 0.2.6

### Patch Changes

- Automated release.
- Updated dependencies
  - @telorun/analyzer@0.1.1
  - @telorun/kernel@0.2.6

## 0.2.5

### Patch Changes

- Automated release.
- Updated dependencies
  - @telorun/kernel@0.2.5

## 0.2.4

### Patch Changes

- Automated release.
- Updated dependencies
  - @telorun/kernel@0.2.4

## 0.2.3

### Patch Changes

- Automated release.
- Updated dependencies
  - @telorun/runtime@0.2.3

## 0.2.2

### Patch Changes

- Automated release.
- Updated dependencies
  - @telorun/runtime@0.2.2
