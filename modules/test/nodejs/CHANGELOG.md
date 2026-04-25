# @telorun/test

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
