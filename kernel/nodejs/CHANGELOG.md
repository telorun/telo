# @telorun/kernel

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
