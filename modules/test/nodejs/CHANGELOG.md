# @telorun/test

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
