# @telorun/assert

## 0.7.35

### Patch Changes

- @telorun/analyzer@0.41.1

## 0.7.34

### Patch Changes

- Updated dependencies [0c1c8fd]
  - @telorun/analyzer@0.41.0

## 0.7.33

### Patch Changes

- Updated dependencies [6418e2a]
  - @telorun/analyzer@0.40.0

## 0.7.32

### Patch Changes

- Updated dependencies [c1fef72]
  - @telorun/analyzer@0.39.0

## 0.7.31

### Patch Changes

- 8af345f: The `Telo.Definition` schema is now the sole resource-config contract.

  A controller module's exports become the controller instance verbatim, so an
  `export const schema` silently won over the manifest's `schema:`. The analyzer
  never loads controllers, so those overrides were invisible to `telo check` and
  to the editor, could not be pre-compiled by the validator warm (recompiling on
  every boot, and failing to persist on a read-only image), and were free to drift
  from the manifest they shadowed.

  `ControllerInstance.schema` is removed, and the kernel now validates every
  resource against its definition's schema. All 35 controller-exported schemas are
  gone: 26 were `additionalProperties: true` catch-alls that merely _disabled_ the
  manifest's stricter validation, and 9 kept their TypeBox for `Static<typeof …>`
  typing but no longer export it.

  Two manifests had already drifted and are corrected:

  - `S3.Bucket` was missing `accessKeyId` / `secretAccessKey` entirely, though its
    controller required both. They are now declared (and required) in the manifest.
  - `Assert.ModuleContext` was missing `resources` / `variables` / `secrets`.

  Controller authors: declare config in `telo.yaml`, not in code. An
  `export const schema` is now inert.

- Updated dependencies [0368e6f]
- Updated dependencies [8af345f]
  - @telorun/analyzer@0.38.0

## 0.7.30

### Patch Changes

- Updated dependencies [ec524cd]
  - @telorun/analyzer@0.37.0

## 0.7.29

### Patch Changes

- Updated dependencies [bd4f3ac]
  - @telorun/analyzer@0.36.0

## 0.7.28

### Patch Changes

- Updated dependencies [56c810b]
- Updated dependencies [d88a397]
  - @telorun/analyzer@0.35.0

## 0.7.27

### Patch Changes

- Updated dependencies [cd3ec0b]
  - @telorun/analyzer@0.34.1

## 0.7.26

### Patch Changes

- Updated dependencies [8c24da2]
  - @telorun/analyzer@0.34.0

## 0.7.25

### Patch Changes

- Updated dependencies [3961e35]
- Updated dependencies [b5a325f]
- Updated dependencies [9a92bf1]
  - @telorun/analyzer@0.33.0

## 0.7.24

### Patch Changes

- Updated dependencies [2ff9027]
  - @telorun/analyzer@0.32.0

## 0.7.23

### Patch Changes

- Updated dependencies [36af5f5]
  - @telorun/analyzer@0.31.0

## 0.7.22

### Patch Changes

- Updated dependencies [5dd71ee]
  - @telorun/analyzer@0.30.1

## 0.7.21

### Patch Changes

- Updated dependencies [2d9323c]
- Updated dependencies [4e5d861]
  - @telorun/analyzer@0.30.0

## 0.7.20

### Patch Changes

- Updated dependencies [ebca26a]
  - @telorun/analyzer@0.29.0

## 0.7.19

### Patch Changes

- Updated dependencies [a9ac4ba]
  - @telorun/analyzer@0.28.1

## 0.7.18

### Patch Changes

- 5ea5ff3: Inject manifest sources into the `Loader` constructor instead of constructing built-ins inside it.

  `new Loader(...)` now takes `(sources: ManifestSource[], options?: { celHandlers? })` — the caller (composition root) decides which concrete sources exist and supplies them. The previous behaviour of self-constructing `HttpSource`/`RegistrySource` (gated by `includeHttpSource`/`includeRegistrySource` flags) and the `extraSources`/`registryUrl` init options are removed. A new exported `defaultSources(registryUrl?)` bundles the browser-safe built-ins (HTTP + registry) for the common case, so consumers compose them explicitly: `new Loader([localFileSource, ...defaultSources(registryUrl)])`.

  This removes a dependency-inversion violation: the `Loader` now depends only on the `ManifestSource` abstraction and no longer imports concrete source implementations.

- Updated dependencies [5ea5ff3]
- Updated dependencies [5ea5ff3]
  - @telorun/analyzer@0.28.0

## 0.7.17

### Patch Changes

- Updated dependencies [dded615]
  - @telorun/analyzer@0.27.0

## 0.7.16

### Patch Changes

- Updated dependencies [12f6d6f]
  - @telorun/analyzer@0.26.0

## 0.7.15

### Patch Changes

- Updated dependencies [d7fda97]
  - @telorun/analyzer@0.25.0

## 0.7.14

### Patch Changes

- @telorun/analyzer@0.24.1

## 0.7.13

### Patch Changes

- Updated dependencies [aaa760d]
  - @telorun/analyzer@0.24.0

## 0.7.12

### Patch Changes

- Updated dependencies [d59e847]
  - @telorun/analyzer@0.23.2

## 0.7.11

### Patch Changes

- Updated dependencies [5973024]
  - @telorun/analyzer@0.23.1

## 0.7.10

### Patch Changes

- Updated dependencies [c89e79b]
- Updated dependencies [4794671]
  - @telorun/analyzer@0.23.0

## 0.7.9

### Patch Changes

- Updated dependencies [ee8926f]
  - @telorun/analyzer@0.22.0

## 0.7.8

### Patch Changes

- Updated dependencies [8586b39]
- Updated dependencies [2292a84]
  - @telorun/analyzer@0.21.0

## 0.7.7

### Patch Changes

- Updated dependencies [06cfcbf]
  - @telorun/analyzer@0.20.0

## 0.7.6

### Patch Changes

- @telorun/analyzer@0.19.1

## 0.7.5

### Patch Changes

- Updated dependencies [81ebf47]
- Updated dependencies [ea57e10]
- Updated dependencies [81ebf47]
  - @telorun/analyzer@0.19.0

## 0.7.4

### Patch Changes

- Updated dependencies [d2294de]
  - @telorun/analyzer@0.18.0

## 0.7.3

### Patch Changes

- Updated dependencies [69a0a8d]
  - @telorun/analyzer@0.17.0

## 0.7.2

### Patch Changes

- Updated dependencies [c1432a6]
  - @telorun/analyzer@0.16.1

## 0.7.1

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

## 0.7.0

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

## 0.6.0

### Patch Changes

- Updated dependencies [ae0bf77]
- Updated dependencies [222b3d6]
  - @telorun/sdk@0.13.0
  - @telorun/analyzer@0.14.0

## 0.1.2

### Patch Changes

- Updated dependencies [bfe4967]
- Updated dependencies [1c37ee1]
  - @telorun/analyzer@0.13.0

## 0.1.1

### Patch Changes

- Updated dependencies [6ce1a52]
- Updated dependencies [6ce1a52]
  - @telorun/analyzer@0.12.1

## 0.1.0

### Patch Changes

- Updated dependencies [c0129c0]

  - @telorun/analyzer@0.12.0

- Updated dependencies [0331069]

  - @telorun/analyzer@0.12.0

- Updated dependencies [77c1c86]
- Updated dependencies [7889023]

  - @telorun/analyzer@0.12.0

- Updated dependencies [f3e5fbc]
- Updated dependencies [f3e5fbc]

  - @telorun/analyzer@0.12.0

- Updated dependencies [39aef08]

  - @telorun/analyzer@0.12.0

- be79957: Move `@telorun/sdk` to `peerDependencies` across the kernel, analyzer, templating, and every module.

  The SDK carries the `Stream` class registered with `@marcbachmann/cel-js` for stream-typed CEL values. cel-js identifies object types by constructor identity, so a second copy of `@telorun/sdk` in the install tree silently breaks streaming-typed evaluations with `Unsupported type: Stream`. The contract was previously enforced with three layered mechanisms (a generated `dist/generated/runtime-deps.json` driving install-root `dependencies`, `overrides` + `pnpm.overrides` blocks, and a `globalThis`-keyed singleton in `stream.ts`); the build artifact silently degraded when the kernel was run without a build step, defeating the layering.

  The new shape:

  - Every package that imports `@telorun/sdk` declares it as a `peerDependency`. Consumers (the kernel's install root, the CLI, apps) provide a single copy and `peerDependencies` cause npm/pnpm to resolve every transitive import to it.
  - The kernel's `NpmControllerLoader` no longer reads `runtime-deps.json`; the realm-collapse name list is a hardcoded constant (`REALM_COLLAPSE_NAMES = ["@telorun/sdk"]`) in `npm-loader.ts`. The install-root `package.json` it writes drops the `overrides` and `pnpm.overrides` blocks — peer-dep resolution makes them redundant.
  - `scripts/generate-runtime-deps.mjs` and the generated artifact are removed; `scripts/prepack-bake-overrides.mjs` no longer chains the runtime-deps regeneration.
  - The `globalThis` singleton in `sdk/nodejs/src/stream.ts` is **kept** as a safety net for environments that still end up with mismatched SDK copies (e.g. a controller install from a tarball that predates this change).

  Consumers installing `@telorun/kernel` or any module directly must now ensure `@telorun/sdk` is present in their dependency tree. The kernel already lists it via the install root for any manifest it boots, so kernel-driven usage is unaffected.

- Updated dependencies [849f57a]
- Updated dependencies [e411584]
- Updated dependencies [e411584]
- Updated dependencies [be79957]
  - @telorun/sdk@0.12.0
  - @telorun/analyzer@0.12.0

## 0.5.8

### Patch Changes

- Updated dependencies [0f80fc5]
  - @telorun/analyzer@0.11.0

## 0.5.7

### Patch Changes

- Updated dependencies [58362c4]
  - @telorun/sdk@0.11.1
  - @telorun/analyzer@0.10.1

## 0.5.6

### Patch Changes

- Updated dependencies [65647e0]
  - @telorun/analyzer@0.10.0

## 0.5.5

### Patch Changes

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
  - @telorun/sdk@0.10.0

## 0.5.4

### Patch Changes

- Updated dependencies [30bcfef]
  - @telorun/analyzer@0.8.1

## 0.5.3

### Patch Changes

- Updated dependencies [88e5cb4]
- Updated dependencies [88e5cb4]
  - @telorun/analyzer@0.8.0

## 0.5.2

### Patch Changes

- Updated dependencies [019c62a]
  - @telorun/analyzer@0.7.0

## 0.5.1

### Patch Changes

- Updated dependencies [40ae3ea]
- Updated dependencies [0335074]
  - @telorun/analyzer@0.6.1

## 0.5.0

### Minor Changes

- f74bfa2: Three new value-level assertion kinds — concise alternatives to `Assert.Schema { properties: { x: { const: ... } } }` for trivial value checks.

  - **`Assert.Equals`** — deep equality between `actual` and `expected` (primitives, plain objects, arrays). One-line replacement for the const-via-schema pattern.
  - **`Assert.Matches`** — JS regex match on a string `actual` (`pattern` source + optional `flags`). Replaces `pattern:` schema usage.
  - **`Assert.Contains`** — substring check when `actual` is a string, or deep-equality membership when `actual` is an array.

  All three are `Telo.Runnable`. Values come through step `inputs:` so CEL refs (`${{ steps.X.result.y }}`, `${{ error.code }}`) are evaluated by `Run.Sequence` automatically. Failure throws `InvokeError` with code `ERR_ASSERTION_FAILED`. `Assert.Schema` stays for actual structural validation.

## 0.3.1

### Patch Changes

- Updated dependencies [b62e535]
  - @telorun/sdk@0.7.0
  - @telorun/analyzer@0.6.0

## 0.3.0

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

- Updated dependencies [dccd3a6]
- Updated dependencies [2e0ad31]
  - @telorun/sdk@0.6.0
  - @telorun/analyzer@0.5.0

## 0.2.0

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

### Patch Changes

- Updated dependencies [80c3c03]
- Updated dependencies [f76dd0f]
- Updated dependencies [fc4a562]
  - @telorun/analyzer@0.4.0
  - @telorun/sdk@0.5.0

## 0.1.12

### Patch Changes

- Updated dependencies [e35e2ee]
- Updated dependencies [c97da42]
  - @telorun/analyzer@0.3.0

## 0.1.11

### Patch Changes

- Updated dependencies [3c4ac58]
  - @telorun/sdk@0.3.2
  - @telorun/analyzer@0.2.1

## 0.1.10

### Patch Changes

- Updated dependencies [353d7e5]
- Updated dependencies [31d721e]
  - @telorun/sdk@0.3.0
  - @telorun/analyzer@0.2.0

## 0.1.8

### Patch Changes

- Updated dependencies
  - @telorun/analyzer@0.1.4

## 0.1.7

### Patch Changes

- Updated dependencies
  - @telorun/analyzer@0.1.3
  - @telorun/sdk@0.2.8

## 0.1.6

### Patch Changes

- Updated dependencies
  - @telorun/analyzer@0.1.2
  - @telorun/sdk@0.2.7

## 0.1.5

### Patch Changes

- Automated release.
- Updated dependencies
  - @telorun/sdk@0.2.6

## 0.1.4

### Patch Changes

- Automated release.
- Updated dependencies
  - @telorun/sdk@0.2.5

## 0.1.3

### Patch Changes

- Updated dependencies
  - @telorun/sdk@0.2.4

## 0.1.2

### Patch Changes

- Updated dependencies
  - @telorun/sdk@0.2.3

## 0.1.1

### Patch Changes

- Automated release.
- Updated dependencies
  - @telorun/sdk@0.2.2
