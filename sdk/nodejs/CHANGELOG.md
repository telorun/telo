# @telorun/sdk

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

## 0.3.2

### Patch Changes

- 3c4ac58: Resource initialization errors now carry the resource `kind`, an underlying error `code`, and a structured `details` block extracted from the original error — AWS SDK service exceptions expose HTTP status / request ID / fault, pg database errors expose severity / detail / hint / SQLSTATE / routine, Node system errors expose syscall / address / port, and the full `cause` chain is walked. The CLI renders runtime diagnostics distinctly from static-analysis diagnostics: no redundant file path, `kind` and `name` shown as the heading, details indented below.

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

## 0.2.8

### Patch Changes

- Automated release.

## 0.2.7

### Patch Changes

- Automated release.

## 0.2.6

### Patch Changes

- Automated release.

## 0.2.5

### Patch Changes

- Automated release.

## 0.2.4

### Patch Changes

- Automated release.

## 0.2.3

### Patch Changes

- Automated release.

## 0.2.2

### Patch Changes

- Automated release.
