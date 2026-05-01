# @telorun/starlark

## 0.2.2

### Patch Changes

- Updated dependencies [b62e535]
  - @telorun/sdk@0.7.0

## 0.2.1

### Patch Changes

- Updated dependencies [dccd3a6]
- Updated dependencies [2e0ad31]
  - @telorun/sdk@0.6.0

## 0.2.0

### Minor Changes

- fc4a562: Add a native Rust controller for `std/starlark`, opt-in via `runtime: rust` on a `Telo.Import`. Implementation lives at `modules/starlark/rust/` and is loaded by the kernel's `NapiControllerLoader` (delivered in the prior PR). The existing `nodejs` controller stays the kernel-native default — no change for manifests that don't set `runtime:`.

  The Rust controller is currently a PoC scaffold using the new `telorun-sdk` Rust crate (in-tree, not yet published to crates.io): `#[controller]` is the only macro the author touches, and the controller crate is a textbook Rust project with no `use napi` or `#[napi]` in its source. Replacing the scaffold's invoke body with a real `starlark-rust` evaluation is the natural next step — the SDK and macro shape are final.

  Schema and orchestration layers are untouched; this is purely a new implementation behind an existing definition.

### Patch Changes

- Updated dependencies [f76dd0f]
- Updated dependencies [fc4a562]
  - @telorun/sdk@0.5.0

## 0.1.11

### Patch Changes

- Updated dependencies [3c4ac58]
  - @telorun/sdk@0.3.2

## 0.1.10

### Patch Changes

- Updated dependencies [353d7e5]
  - @telorun/sdk@0.3.0

## 0.1.9

### Patch Changes

- Updated dependencies
  - @telorun/sdk@0.2.8

## 0.1.8

### Patch Changes

- Updated dependencies
  - @telorun/sdk@0.2.7

## 0.1.5

### Patch Changes

- Updated dependencies
  - @telorun/sdk@0.2.6

## 0.1.4

### Patch Changes

- Updated dependencies
  - @telorun/sdk@0.2.5

## 0.1.3

### Patch Changes

- Automated release.
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
