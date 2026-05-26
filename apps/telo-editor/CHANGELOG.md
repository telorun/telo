# telo-editor

## 0.3.3

### Patch Changes

- Updated dependencies [0331069]
  - @telorun/analyzer@1.4.0
  - @telorun/ide-support@0.4.7

## 0.3.2

### Patch Changes

- Updated dependencies [77c1c86]
- Updated dependencies [7889023]
  - @telorun/analyzer@1.3.0
  - @telorun/templating@1.1.0
  - @telorun/ide-support@0.4.6

## 0.3.1

### Patch Changes

- Updated dependencies [f3e5fbc]
- Updated dependencies [f3e5fbc]
  - @telorun/analyzer@1.2.0
  - @telorun/ide-support@0.4.5

## 0.3.0

### Minor Changes

- 39aef08: `Telo.Application` accepts `variables:` / `secrets:` with per-field `env:` mapping; values resolve at `kernel.load()` into the root `variables.X` / `secrets.X` CEL scope before any controller or import initialises. `type:` supports `string | integer | number | boolean | object | array` — object and array values are JSON-decoded from a single env var. Coercion / schema / missing-required failures aggregate into one `ERR_MANIFEST_VALIDATION_FAILED` at load.

  `Telo.Library` variables / secrets remain pure JSON Schema property maps. An `env:` key on a Library entry is now rejected at load time with a `LIBRARY_ENV_KEY_REJECTED` diagnostic that explains importers must supply the value.

  The Telo editor's Deployment tab now renders the Application's declared environment contract above the free-form env vars list, so authors see exactly which env vars the manifest binds. The tab still drives the existing Run feature's env wiring — no manifest mutation.

  `Config.Env` is deprecated in favour of the new Application-level shape. The kind continues to work; the controller logs a deprecation notice at init and the docs page is marked deprecated. Migrating consumers is recommended but not forced.

  Diagnostics that target a missing child property now squiggle just the parent key identifier instead of the whole value block. `buildPositionIndex` additionally records map keys under the `@key:<path>` namespace, and the IDE range resolver prefers that key range when the leaf path isn't indexed.

### Patch Changes

- Updated dependencies [39aef08]
  - @telorun/analyzer@1.1.0
  - @telorun/ide-support@0.4.4

## 0.2.12

### Patch Changes

- Updated dependencies [849f57a]
- Updated dependencies [e411584]
- Updated dependencies [e411584]
- Updated dependencies [be79957]
  - @telorun/sdk@1.0.0
  - @telorun/analyzer@1.0.0
  - @telorun/ide-support@0.4.3
  - @telorun/templating@1.0.0

## 0.2.11

### Patch Changes

- Updated dependencies [0f80fc5]
  - @telorun/analyzer@0.11.0
  - @telorun/ide-support@0.4.2

## 0.2.10

### Patch Changes

- Updated dependencies [58362c4]
  - @telorun/sdk@0.11.1
  - @telorun/analyzer@0.10.1
  - @telorun/templating@0.2.3
  - @telorun/ide-support@0.4.1

## 0.2.9

### Patch Changes

- Updated dependencies [d9df589]
- Updated dependencies [65647e0]
  - @telorun/ide-support@0.4.0
  - @telorun/analyzer@0.10.0

## 0.2.8

### Patch Changes

- Updated dependencies [07c881a]
- Updated dependencies [5c49834]
- Updated dependencies [50ae578]
- Updated dependencies [f1c35bc]
- Updated dependencies [47f7d83]
  - @telorun/analyzer@0.9.0
  - @telorun/ide-support@0.3.0
  - @telorun/sdk@0.10.0
  - @telorun/templating@0.2.2

## 0.2.7

### Patch Changes

- Updated dependencies [30bcfef]
  - @telorun/analyzer@0.8.1
  - @telorun/templating@0.2.1
  - @telorun/ide-support@0.2.7

## 0.2.6

### Patch Changes

- Updated dependencies [88e5cb4]
- Updated dependencies [88e5cb4]
  - @telorun/analyzer@0.8.0
  - @telorun/templating@0.2.0
  - @telorun/ide-support@0.2.6

## 0.2.5

### Patch Changes

- Updated dependencies [019c62a]
  - @telorun/analyzer@0.7.0
  - @telorun/ide-support@0.2.5

## 0.2.4

### Patch Changes

- Updated dependencies [40ae3ea]
- Updated dependencies [0335074]
  - @telorun/analyzer@0.6.1
  - @telorun/ide-support@0.2.4

## 0.2.3

### Patch Changes

- Updated dependencies [b62e535]
  - @telorun/sdk@0.7.0
  - @telorun/analyzer@0.6.0
  - @telorun/ide-support@0.2.3

## 0.2.2

### Patch Changes

- Updated dependencies [dccd3a6]
- Updated dependencies [2e0ad31]
  - @telorun/sdk@0.6.0
  - @telorun/analyzer@0.5.0
  - @telorun/ide-support@0.2.2

## 0.2.1

### Patch Changes

- Updated dependencies [80c3c03]
- Updated dependencies [f76dd0f]
- Updated dependencies [fc4a562]
  - @telorun/analyzer@0.4.0
  - @telorun/sdk@0.5.0
  - @telorun/ide-support@0.2.1

## 0.2.0

### Minor Changes

- 2900b1c: Added port exposure to the Run feature. The Deployment view has an "Exposed ports" editor next to "Environment variables"; both the in-process Tauri Docker adapter and the remote `@telorun/docker-runner` HTTP service publish the configured ports (`-p port:port/protocol` / Docker API `PortBindings`) when a session starts. The Run view header shows one clickable `host:port` chip per exposed port; the host is resolved from `DOCKER_HOST` (Tauri adapter) or from the runner's base URL (HTTP adapter). `RunStatus.running` now carries an optional `endpoints` array describing where the container is reachable.
- 9391cba: Added per-module undo/redo for source edits. Every persisted edit (from the form views, topology canvas, or Monaco source view) is recorded as a snapshot on a per-module history stack, keyed by the module's owner file path. The top bar has Undo / Redo icon buttons that walk the active module's stack; consecutive edits to the same file within 1s are coalesced into a single entry, each module caps at 20 entries, and the stack is persisted to `localStorage` scoped by workspace root so history survives across sessions. Monaco's built-in in-buffer undo is untouched and runs orthogonally.

### Patch Changes

- Updated dependencies [e35e2ee]
- Updated dependencies [c97da42]
- Updated dependencies [c97da42]
  - @telorun/analyzer@0.3.0
  - @telorun/ide-support@0.2.0

## 0.1.6

### Patch Changes

- Updated dependencies [3c4ac58]
  - @telorun/sdk@0.3.2
  - @telorun/analyzer@0.2.1

## 0.1.5

### Patch Changes

- Updated dependencies [353d7e5]
- Updated dependencies [31d721e]
  - @telorun/sdk@0.3.0
  - @telorun/analyzer@0.2.0

## 0.1.4

### Patch Changes

- Updated dependencies
  - @telorun/analyzer@0.1.4

## 0.1.3

### Patch Changes

- Updated dependencies
  - @telorun/analyzer@0.1.3
  - @telorun/sdk@0.2.8

## 0.1.2

### Patch Changes

- Updated dependencies
  - @telorun/analyzer@0.1.2
  - @telorun/sdk@0.2.7

## 0.1.1

### Patch Changes

- Updated dependencies
  - @telorun/analyzer@0.1.1
  - @telorun/sdk@0.2.6
