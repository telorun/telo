# @telorun/test

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
