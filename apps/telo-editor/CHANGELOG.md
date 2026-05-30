# telo-editor

## 0.4.0

### Minor Changes

- a41e69a: Rework run handling to support one session per application with per-application
  run history. Starting a second run no longer crashes the editor with a blank
  screen (`RunIo.open() may be called only once`): a per-run terminal buffer now
  owns the single transport open and replays its transcript into the view, so runs
  stay re-viewable across remounts. The Run button gains a chevron dropdown listing
  the active application's recent runs; selecting one opens its output.

### Patch Changes

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

- 4815295: Isolate each application's static analysis so apps in a workspace no longer
  interfere with one another. Previously the whole workspace was analyzed against
  a single shared registry keyed by module name, so when two apps imported the
  same library at different versions, one version's definitions overwrote the
  other's — producing spurious diagnostics and wrong completions for the losing
  app. Analysis now runs per-application closure with an isolated registry, and
  the source-view completion provider selects the registry of the active module.
  Diagnostics are also now routed to each resource's own source file via the
  analyzer's stamped `filePath`, so two modules that legitimately share a
  `{kind, name}` (resource names are module-scoped) no longer misattribute one
  module's diagnostics to the other.
- 1c37ee1: Add `visitManifest` — one shared manifest visitor that emits the annotation
  sites (`RefSite`, `ScopeBoundary`, `SchemaFromSite`, `CelSite`, plus resource
  enter/exit bookends) the analyzer's passes previously each rediscovered with
  duplicated scaffolding. `validate-references`, `dependency-graph`, and the CEL
  context walk now consume it; behaviour is unchanged (full analyzer + integration
  suites pass).

  Path-driven sites (ref / scope / schema-from) come from the per-kind field map;
  CEL sites are found by scanning the value tree, with the field map supplying the
  matched `x-telo-context`. Scope is per-resource: `ScopeBoundary` carries both the
  source-enclosure prefixes (for ref candidate scoping) and the enclosed-resource
  name set (for dropping boot edges to scoped targets), so no cross-resource
  ordering or global state is needed.

  Exposes `AnalysisRegistry.visitManifest` as the public host seam, and adds the
  editor `buildOverviewGraph` adapter that projects `RefSite` events into
  capability-classified edges (Service/Invocable/Runnable/Mount) and "uses" chips
  (Provider/Type).

- Updated dependencies [bfe4967]
- Updated dependencies [1c37ee1]
  - @telorun/analyzer@0.13.0
  - @telorun/templating@0.3.1
  - @telorun/ide-support@0.4.10

## 0.3.5

### Patch Changes

- Updated dependencies [6ce1a52]
- Updated dependencies [6ce1a52]
  - @telorun/analyzer@0.12.1
  - @telorun/ide-support@0.4.9

## 0.3.4

### Patch Changes

- Updated dependencies [c0129c0]
  - @telorun/analyzer@1.5.0
  - @telorun/ide-support@0.4.8

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
