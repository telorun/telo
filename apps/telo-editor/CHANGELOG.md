# telo-editor

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
