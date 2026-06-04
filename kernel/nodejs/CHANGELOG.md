# @telorun/kernel

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
