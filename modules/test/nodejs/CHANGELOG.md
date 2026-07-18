# @telorun/test

## 0.4.45

### Patch Changes

- Updated dependencies [ec524cd]
  - @telorun/kernel@0.47.0

## 0.4.44

### Patch Changes

- Updated dependencies [bd4f3ac]
  - @telorun/kernel@0.46.0

## 0.4.43

### Patch Changes

- Updated dependencies [d88a397]
- Updated dependencies [d88a397]
  - @telorun/kernel@0.45.0

## 0.4.42

### Patch Changes

- @telorun/kernel@0.44.1

## 0.4.41

### Patch Changes

- Updated dependencies [8c24da2]
  - @telorun/kernel@0.44.0

## 0.4.40

### Patch Changes

- Updated dependencies [9a92bf1]
  - @telorun/kernel@0.43.0

## 0.4.39

### Patch Changes

- Updated dependencies [b7d378a]
- Updated dependencies [2ff9027]
  - @telorun/kernel@0.42.0

## 0.4.38

### Patch Changes

- Updated dependencies [721a241]
  - @telorun/kernel@0.41.0

## 0.4.37

### Patch Changes

- Updated dependencies [36af5f5]
  - @telorun/kernel@0.40.2

## 0.4.36

### Patch Changes

- @telorun/kernel@0.40.1

## 0.4.35

### Patch Changes

- 4e5d861: Guard `process.env` against controllers bypassing declared bindings. Once the
  kernel boots it replaces the global `process.env` with a guardrail Proxy whose
  denied set is **derived from the manifest**: exactly the host env-var names the
  root Application binds via `variables` / `secrets` / `ports` (their `env:` keys).
  Such a key reads back `undefined` (and `'FOO' in process.env` / enumeration see
  nothing) even when the variable is set, and the first read of each logs a
  warning. Controllers must read those through `ctx.env` (the sanctioned snapshot
  the kernel threads in) or, preferably, the declared `variables` / `secrets`.

  Every **other** key passes through transparently (real value, no warning) — the
  kernel carries no allowlist of vendor env conventions. A bundled SDK reading its
  own configuration (`NODE_ENV`, `AWS_PROFILE` / `AWS_*` / `SMITHY_*`, `~/.aws`
  path lookups, `BUN_*`, the AWS Lambda execution-environment context, …) is
  undeclared, so it is untouched. The guarantee is narrow and honest: a controller
  cannot bypass a _declared_ binding by reading its raw env var. This is a
  guardrail, not an isolation boundary — in-process controllers can still reach the
  OS environment by other means; the `process.env` property is left non-writable so
  a casual `process.env = {…}` cannot drop it.

  The denied set is process-global and additive: several `Kernel` instances can
  boot in one process (the test suite runs child kernels in-process), and each
  unions its declared keys into the shared set even after the Proxy is installed.

  The kernel's own `TELO_*` / cache reads and its subprocess spawns (`npm`,
  `cargo`/`rustc`) use the real environment captured before the lock — shared on
  `globalThis` so a second in-process `@telorun/kernel` copy (the test suite loads
  its own to spawn child kernels) recovers it even when loaded after the lock,
  rather than capturing the Proxy and handing child spawns an env missing the
  denied keys. `analyzeOnly` loads never boot, so `telo check` / the editor / the
  analyzer are unaffected.

  The stdlib controllers that read host env use `ctx.env`: `config`
  (`Config.EnvironmentVariableStore`), `lambda` (Lambda mode detection),
  `mcp-client` (the spawned stdio child's environment), and `test` (the env the
  suite forwards to each spawned test kernel). These keep their existing behaviour
  and remain compatible with older kernels.

- Updated dependencies [4e5d861]
- Updated dependencies [4e5d861]
  - @telorun/kernel@0.40.0

## 0.4.34

### Patch Changes

- Updated dependencies [ef511d9]
  - @telorun/kernel@0.39.1

## 0.4.33

### Patch Changes

- d84a585: Unify glob matching across the monorepo onto a single dependency-free engine in a new `@telorun/glob` package. It exports `selectByPatterns` (plus `HARD_IGNORE` / `DEFAULT_IGNORE` / `GLOB_PRUNE_DIRS`) as the one matcher used everywhere a `.gitignore`-style pattern set is resolved: `files:` bundling (`telo publish` + the editor run bundle), `include:` expansion (kernel `LocalFileSource` + the editor adapters), and test discovery (`@telorun/test`).

  This removes four divergent implementations — the kernel's `minimatch`, the editor's hand-rolled glob→regex, the test runner's own `globToRegex`, and an `ignore`-based pass — in favor of a small matcher implementing a documented **Telo glob** subset of gitignore. The subset and its exact behavior are pinned by a language-neutral conformance suite (`packages/glob/conformance/glob.json` + `README.md`) so any runtime (Node today; Rust / Go later) can reimplement it identically rather than chasing one library's quirks. The kernel drops `minimatch` and the CLI drops its direct `ignore` dependency; the matcher lives in its own package rather than the static analyzer, so consumers depend on it directly instead of reaching into `@telorun/analyzer` for a non-analysis primitive.

  The deny set is split into a non-overridable **hard** tier (`node_modules`/`.git`/`.telo`) and a soft, opt-out-able tier (`.telobundle.*`). `applyDefaultIgnore: false` (used by `include:` resolution to reach co-located partials) now only skips the soft tier — a broad `**` `include:` can no longer recurse into the manifest cache, and resolves identically in the kernel and the editor.

- Updated dependencies [ebca26a]
- Updated dependencies [d84a585]
  - @telorun/kernel@0.39.0
  - @telorun/glob@0.2.0

## 0.4.32

### Patch Changes

- Updated dependencies [a125804]
  - @telorun/kernel@0.38.0

## 0.4.31

### Patch Changes

- Updated dependencies [5ea5ff3]
- Updated dependencies [5ea5ff3]
  - @telorun/kernel@0.37.0

## 0.4.30

### Patch Changes

- Updated dependencies [dded615]
  - @telorun/kernel@0.36.0

## 0.4.29

### Patch Changes

- @telorun/kernel@0.35.0

## 0.4.28

### Patch Changes

- @telorun/kernel@0.34.0

## 0.4.27

### Patch Changes

- Updated dependencies [95f168e]
- Updated dependencies [95f168e]
  - @telorun/kernel@0.33.0

## 0.4.26

### Patch Changes

- Updated dependencies [a8c99ab]
  - @telorun/kernel@0.32.0

## 0.4.25

### Patch Changes

- Updated dependencies [b41012f]
  - @telorun/kernel@0.31.0

## 0.4.24

### Patch Changes

- Updated dependencies [912044a]
  - @telorun/kernel@0.30.2

## 0.4.23

### Patch Changes

- @telorun/kernel@0.30.1

## 0.4.22

### Patch Changes

- Updated dependencies [cce2caa]
  - @telorun/kernel@0.30.0

## 0.4.21

### Patch Changes

- Updated dependencies [b4e6ac8]
  - @telorun/kernel@0.29.0

## 0.4.20

### Patch Changes

- Updated dependencies [d59e847]
  - @telorun/kernel@0.28.0

## 0.4.19

### Patch Changes

- Updated dependencies [9ef48a6]
- Updated dependencies [9ef48a6]
  - @telorun/kernel@0.27.0

## 0.4.18

### Patch Changes

- Updated dependencies [5973024]
- Updated dependencies [a592710]
  - @telorun/kernel@0.26.1

## 0.4.17

### Patch Changes

- Updated dependencies [1ddd803]
  - @telorun/kernel@0.26.0

## 0.4.16

### Patch Changes

- Updated dependencies [c89e79b]
- Updated dependencies [c89e79b]
- Updated dependencies [1098ad0]
- Updated dependencies [4794671]
  - @telorun/kernel@0.25.0

## 0.4.15

### Patch Changes

- Updated dependencies [004a848]
  - @telorun/kernel@0.24.2

## 0.4.14

### Patch Changes

- Updated dependencies [9a305e6]
  - @telorun/kernel@0.24.1

## 0.4.13

### Patch Changes

- Updated dependencies [ee8926f]
- Updated dependencies [ee8926f]
  - @telorun/kernel@0.24.0

## 0.4.12

### Patch Changes

- Updated dependencies [8586b39]
- Updated dependencies [2292a84]
  - @telorun/kernel@0.23.0

## 0.4.11

### Patch Changes

- Updated dependencies [06cfcbf]
- Updated dependencies [06cfcbf]
- Updated dependencies [06cfcbf]
  - @telorun/kernel@0.22.0

## 0.4.10

### Patch Changes

- @telorun/kernel@0.21.0

## 0.4.9

### Patch Changes

- @telorun/kernel@0.20.1

## 0.4.8

### Patch Changes

- Updated dependencies [2864c4d]
  - @telorun/kernel@0.20.0

## 0.4.7

### Patch Changes

- Updated dependencies [5331205]
  - @telorun/kernel@0.19.0

## 0.4.6

### Patch Changes

- @telorun/kernel@0.18.0

## 0.4.5

### Patch Changes

- @telorun/kernel@0.17.3

## 0.4.4

### Patch Changes

- @telorun/kernel@0.17.1

## 0.4.3

### Patch Changes

- Updated dependencies [0cd36a1]
  - @telorun/kernel@0.17.0

## 0.4.2

### Patch Changes

- Updated dependencies [acb8996]
  - @telorun/kernel@0.16.1

## 0.4.1

### Patch Changes

- adc248b: Loosen the `@telorun/sdk` peer dependency range from an exact pin to `*`.

  The sdk is a host-provided peer (the kernel supplies the single shared instance, so `Stream` and other sdk class identities stay intact for CEL's runtime type-checker). Pinning it via `workspace:*` published as an exact version, which made every sdk release fall out of range and forced a spurious major bump of all peer-dependents. Declaring the peer range as `*` (with a `workspace:*` devDependency to preserve local linking) keeps the single-instance guarantee while preventing the false major-bump cascade.

- Updated dependencies [55b4ec5]
- Updated dependencies [adc248b]
  - @telorun/kernel@0.16.0

## 0.4.0

### Patch Changes

- Updated dependencies [ae0bf77]
  - @telorun/sdk@0.13.0
  - @telorun/kernel@0.15.0

## 0.1.2

### Patch Changes

- Updated dependencies [bfe4967]
  - @telorun/kernel@0.14.0

## 0.1.1

### Patch Changes

- @telorun/kernel@0.13.2

## 0.1.0

### Patch Changes

- @telorun/kernel@0.13.0

- Updated dependencies [0331069]

  - @telorun/kernel@0.13.0

- Updated dependencies [7889023]

  - @telorun/kernel@0.13.0

- Updated dependencies [f3e5fbc]
- Updated dependencies [f3e5fbc]

  - @telorun/kernel@0.13.0

- Updated dependencies [39aef08]

  - @telorun/kernel@0.13.0

- be79957: Move `@telorun/sdk` to `peerDependencies` across the kernel, analyzer, templating, and every module.

  The SDK carries the `Stream` class registered with `@marcbachmann/cel-js` for stream-typed CEL values. cel-js identifies object types by constructor identity, so a second copy of `@telorun/sdk` in the install tree silently breaks streaming-typed evaluations with `Unsupported type: Stream`. The contract was previously enforced with three layered mechanisms (a generated `dist/generated/runtime-deps.json` driving install-root `dependencies`, `overrides` + `pnpm.overrides` blocks, and a `globalThis`-keyed singleton in `stream.ts`); the build artifact silently degraded when the kernel was run without a build step, defeating the layering.

  The new shape:

  - Every package that imports `@telorun/sdk` declares it as a `peerDependency`. Consumers (the kernel's install root, the CLI, apps) provide a single copy and `peerDependencies` cause npm/pnpm to resolve every transitive import to it.
  - The kernel's `NpmControllerLoader` no longer reads `runtime-deps.json`; the realm-collapse name list is a hardcoded constant (`REALM_COLLAPSE_NAMES = ["@telorun/sdk"]`) in `npm-loader.ts`. The install-root `package.json` it writes drops the `overrides` and `pnpm.overrides` blocks — peer-dep resolution makes them redundant.
  - `scripts/generate-runtime-deps.mjs` and the generated artifact are removed; `scripts/prepack-bake-overrides.mjs` no longer chains the runtime-deps regeneration.
  - The `globalThis` singleton in `sdk/nodejs/src/stream.ts` is **kept** as a safety net for environments that still end up with mismatched SDK copies (e.g. a controller install from a tarball that predates this change).

  Consumers installing `@telorun/kernel` or any module directly must now ensure `@telorun/sdk` is present in their dependency tree. The kernel already lists it via the install root for any manifest it boots, so kernel-driven usage is unaffected.

- Updated dependencies [849f57a]
- Updated dependencies [be79957]
  - @telorun/kernel@0.13.0
  - @telorun/sdk@0.12.0

## 0.3.10

### Patch Changes

- Updated dependencies [67a9b31]
- Updated dependencies [0f80fc5]
  - @telorun/kernel@0.12.0

## 0.3.9

### Patch Changes

- Updated dependencies [58362c4]
- Updated dependencies [58362c4]
  - @telorun/kernel@0.11.1
  - @telorun/sdk@0.11.1

## 0.3.8

### Patch Changes

- Updated dependencies [f61b36a]
  - @telorun/kernel@0.11.0

## 0.3.7

### Patch Changes

- Updated dependencies [5c49834]
- Updated dependencies [f1c35bc]
- Updated dependencies [47f7d83]
  - @telorun/kernel@0.10.0
  - @telorun/sdk@0.10.0

## 0.3.6

### Patch Changes

- @telorun/kernel@0.9.2

## 0.3.5

### Patch Changes

- Updated dependencies [543b91f]
  - @telorun/kernel@0.9.1

## 0.3.4

### Patch Changes

- Updated dependencies [88e5cb4]
  - @telorun/kernel@0.9.0

## 0.3.3

### Patch Changes

- Updated dependencies [019c62a]
- Updated dependencies [c792025]
  - @telorun/kernel@0.8.0

## 0.3.2

### Patch Changes

- @telorun/kernel@0.7.2

## 0.3.1

### Patch Changes

- Updated dependencies [024debe]
  - @telorun/kernel@0.7.1

## 0.3.0

### Minor Changes

- 6d4280e: `Test.Suite` now runs tests in parallel. Each test still runs in its own isolated `Kernel`; the suite drives a worker pool that pulls from the discovered queue. New optional `concurrency` field on the `Test.Suite` schema (integer, minimum `1`) controls the pool size; defaults to `3` (small enough that Node's single JS thread isn't the bottleneck, large enough to overlap I/O across a few tests). Set to `1` to restore the previous strictly-sequential behaviour. Per-test PASS/FAIL is printed as each test finishes, so result order is no longer guaranteed when `concurrency > 1`.

### Patch Changes

- Updated dependencies [6d4280e]
- Updated dependencies [b62e535]
  - @telorun/kernel@0.7.0
  - @telorun/sdk@0.7.0

## 0.2.1

### Patch Changes

- Updated dependencies [0c4d023]
  - @telorun/kernel@0.6.1

## 0.2.0

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

## 0.1.9

### Patch Changes

- fc4a562: `Test.Suite.discoverTests` now hard-skips any path containing a `node_modules/` segment and dedupes results by realpath. Without this, pnpm's symlinked workspace packages caused the same test yaml to be discovered through multiple paths (e.g. once via `kernel/nodejs/tests/foo.yaml` and again through every `**/node_modules/@telorun/kernel/tests/foo.yaml` symlink), inflating "FAIL" counts with non-existent duplicates.

  Hard-skipping `node_modules` is unconditional rather than a default-exclude entry, because vendored test files in dependency packages should never run as workspace tests regardless of the user's `exclude` config.

- Updated dependencies [fc4a562]
- Updated dependencies [80c3c03]
- Updated dependencies [f76dd0f]
- Updated dependencies [fc4a562]
  - @telorun/kernel@0.5.0
  - @telorun/sdk@0.5.0

## 0.1.8

### Patch Changes

- @telorun/kernel@0.4.1

## 0.1.7

### Patch Changes

- Updated dependencies [6a61dbf]
  - @telorun/kernel@0.4.0

## 0.1.6

### Patch Changes

- Updated dependencies [f75a730]
- Updated dependencies [f75a730]
  - @telorun/kernel@0.3.3

## 0.1.5

### Patch Changes

- Updated dependencies [3c4ac58]
  - @telorun/sdk@0.3.2
  - @telorun/kernel@0.3.2

## 0.1.4

### Patch Changes

- Updated dependencies [353d7e5]
- Updated dependencies [31d721e]
  - @telorun/sdk@0.3.0
  - @telorun/kernel@0.3.0

## 0.1.3

### Patch Changes

- Updated dependencies
  - @telorun/kernel@0.2.9

## 0.1.2

### Patch Changes

- Updated dependencies
  - @telorun/kernel@0.2.8
  - @telorun/sdk@0.2.8

## 0.1.1

### Patch Changes

- Updated dependencies
  - @telorun/kernel@0.2.7
  - @telorun/sdk@0.2.7
