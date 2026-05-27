# @telorun/sdk

## 0.12.0

### Minor Changes

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

## 0.11.1

### Patch Changes

- 58362c4: Make `Stream` a `globalThis`-keyed singleton so its constructor identity survives multiple `@telorun/sdk` copies in a single process. cel-js identifies CEL object types by constructor identity, and the kernel + an npm-loaded controller (e.g. `S3.Get`) routinely resolve to different sdk installs (workspace vs `.telo/npm/<hash>/...`). Before this change, a `Stream` value produced by a controller threw `Unsupported type: Stream` at runtime whenever it flowed through a CEL expression like `${{ steps.fetch.result.output }}` — even though both copies declared the same `Stream` class — because the registered constructor on the kernel side wasn't the constructor that produced the value. The fix is contained in the sdk's `stream.ts`: the first copy to load registers its `Stream` class on `globalThis` under `Symbol.for("@telorun/sdk:Stream")`; later copies discard their local class declaration at export time and re-export the registered one. No build artifact, `file:` symlink, or kernel-side realm-collapse install is required for class identity to hold.

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
