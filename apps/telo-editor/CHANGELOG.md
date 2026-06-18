# telo-editor

## 0.8.6

### Patch Changes

- Updated dependencies [a8c99ab]
  - @telorun/sdk@0.32.0
  - @telorun/debug-wire@0.2.0
  - @telorun/debug-ui@0.4.0
  - @telorun/analyzer@0.24.1
  - @telorun/templating@0.10.0

## 0.8.5

### Patch Changes

- Updated dependencies [b41012f]
- Updated dependencies [b41012f]
  - @telorun/debug-ui@0.3.0
  - @telorun/sdk@0.31.0
  - @telorun/analyzer@0.24.1
  - @telorun/templating@0.10.0

## 0.8.4

### Patch Changes

- Updated dependencies [b1dd65c]
- Updated dependencies [0c16f41]
  - @telorun/debug-ui@0.2.1
  - @telorun/templating@0.10.0
  - @telorun/analyzer@0.24.1
  - @telorun/ide-support@0.4.27

## 0.8.3

### Patch Changes

- Updated dependencies [aaa760d]
- Updated dependencies [aaa760d]
  - @telorun/analyzer@0.24.0
  - @telorun/templating@0.9.0
  - @telorun/ide-support@0.4.26

## 0.8.2

### Patch Changes

- Updated dependencies [d59e847]
- Updated dependencies [d59e847]
- Updated dependencies [d59e847]
  - @telorun/analyzer@0.23.2
  - @telorun/debug-wire@0.1.0
  - @telorun/debug-ui@0.2.0
  - @telorun/ide-support@0.4.25

## 0.8.1

### Patch Changes

- Updated dependencies [5973024]
  - @telorun/analyzer@0.23.1
  - @telorun/ide-support@0.4.24

## 0.8.0

### Minor Changes

- e6e8d88: Unify the docker and kubernetes runners behind a `/v1/capabilities` discovery
  endpoint. Runners advertise their own editable config schema; the editor
  collapses the docker-api and k8s adapters into a single capability-driven
  http-runner adapter with managed add/edit/remove/switch runners, and preflights
  required variables/secrets before a run.

### Patch Changes

- Updated dependencies [1ddd803]
  - @telorun/sdk@0.26.0
  - @telorun/analyzer@0.23.0
  - @telorun/templating@0.8.0

## 0.7.8

### Patch Changes

- Updated dependencies [c89e79b]
- Updated dependencies [4794671]
  - @telorun/analyzer@0.23.0
  - @telorun/ide-support@0.4.23

## 0.7.7

### Patch Changes

- Updated dependencies [ee8926f]
  - @telorun/templating@0.8.0
  - @telorun/analyzer@0.22.0
  - @telorun/ide-support@0.4.22

## 0.7.6

### Patch Changes

- Updated dependencies [8586b39]
- Updated dependencies [2292a84]
  - @telorun/analyzer@0.21.0
  - @telorun/sdk@0.23.0
  - @telorun/templating@0.7.0
  - @telorun/ide-support@0.4.21

## 0.7.5

### Patch Changes

- Updated dependencies [06cfcbf]
- Updated dependencies [06cfcbf]
- Updated dependencies [06cfcbf]
  - @telorun/analyzer@0.20.0
  - @telorun/templating@0.6.0
  - @telorun/ide-support@0.4.20

## 0.7.4

### Patch Changes

- Updated dependencies [64debb5]
  - @telorun/templating@0.5.0
  - @telorun/sdk@0.21.0
  - @telorun/analyzer@0.19.1
  - @telorun/ide-support@0.4.19

## 0.7.3

### Patch Changes

- Updated dependencies [81ebf47]
- Updated dependencies [ea57e10]
- Updated dependencies [81ebf47]
  - @telorun/analyzer@0.19.0
  - @telorun/ide-support@0.4.18

## 0.7.2

### Patch Changes

- Updated dependencies [5331205]
  - @telorun/sdk@0.19.0
  - @telorun/analyzer@0.18.0
  - @telorun/templating@0.4.1

## 0.7.1

### Patch Changes

- Updated dependencies [d2294de]
  - @telorun/analyzer@0.18.0
  - @telorun/sdk@0.18.0
  - @telorun/ide-support@0.4.17
  - @telorun/templating@0.4.1

## 0.7.0

### Minor Changes

- 125aeec: Add "Open in Telo Editor" support: launching the editor with a `?open=<url>` query parameter fetches a manifest over HTTP (e.g. a GitHub raw URL) and copies it into an in-browser virtual workspace under `/workspace/apps/<slug>/telo.yaml` for local editing. Relative (same-origin) imports cascade — their files are fetched and persisted verbatim, mirroring their layout relative to the root (without escaping the workspace) — while registry imports continue to resolve via the configured registry adapters. Before anything is written, a confirmation dialog previews the application/library name, description, declared imports, and the exact list of files to be created (flagging overwrites). A toast confirms the import. `loadWorkspace` now also resolves local imports that point at non-`telo.yaml` files copied in by a cascade.
- 3dc20d0: Add a Kubernetes runner. Extract backend-neutral `@telorun/runner-core` from docker-runner (shared `/v1` contract, routes, registry, SSE, ring buffers) behind a `RunnerBackend` seam; docker-runner becomes a thin backend over it with no behaviour change. Add `@telorun/k8s-runner`, a `KubernetesBackend` that runs Telo apps as sandboxed Pods (attach-based PTY, hard-ceiling limit clamping, tokenized bundle delivery, per-session ingress, orphan reaping) plus a Helm chart (RBAC, quota, NetworkPolicy) and a CI image job. Add a k8s editor `RunAdapter` via a shared `createHttpRunnerAdapter` factory. Rename the docker image `telorun/telo-runner` → `telorun/docker-runner`.
- e9c73ed: Add a raw file explorer and unified open-editors tabs. The left sidebar now shows the full workspace file tree (create/rename/delete/drag-move, with selection driving where new files land and top-level folders expanded by default), backed by a new `rename` workspace-adapter primitive across the Tauri, File System Access, and localStorage backends. The center pane is now a VSCode-style tab strip: module tabs host the structured views while non-telo files open in a Monaco editor (binary files show a placeholder). Open tabs, the active tab, and expanded folders persist across reloads, and structural file ops re-scan the workspace so the Applications/Libraries view stays in sync. Imports, Definitions, Resources, and Kinds moved from the sidebar/Inventory into dedicated module-view tabs (Imports keeps add/remove and the version-upgrade dropdown); the Inventory view and the redundant file-path/module-path labels were removed.

## 0.6.0

### Minor Changes

- 10868cd: Add "Open in Telo Editor" support: launching the editor with a `?open=<url>` query parameter fetches a single manifest over HTTP (e.g. a GitHub raw URL), copies it into an in-browser virtual workspace under `/workspace/apps/<slug>/telo.yaml`, and opens it for local editing. If a module with the same slug already exists, the user is prompted to confirm an overwrite via an alert dialog. A toast confirms a successful load.

### Patch Changes

- 69a0a8d: Align the telo-editor's static-analysis projection with the CLI's import boundary. Extract `flattenForAnalyzer`'s local/foreign forwarding rule into a shared `selectModuleManifestsForAnalysis` helper so the editor and the CLI cannot drift, and have the editor apply it per closure: the closure root stays fully local while imported modules forward only their definitions/abstracts/imports plus `exports.resources` instances (flagged `forwardedExport`). The editor now also anchors a closure at every workspace-local module (not just Applications), so a library imported by an app is validated in its own scope instead of the consumer's. Fixes cross-module `!ref Alias.export` (e.g. a flat `targets` invoke step) reporting spurious `SCHEMA_VIOLATION` / `UNDEFINED_KIND` in the editor while passing `telo check`.
- Updated dependencies [69a0a8d]
  - @telorun/analyzer@0.17.0
  - @telorun/ide-support@0.4.16

## 0.5.4

### Patch Changes

- Updated dependencies [0505e9b]
  - @telorun/ide-support@0.4.15

## 0.5.3

### Patch Changes

- Updated dependencies [c1432a6]
  - @telorun/analyzer@0.16.1
  - @telorun/ide-support@0.4.14

## 0.5.2

### Patch Changes

- Updated dependencies [0cd36a1]
  - @telorun/analyzer@0.16.0
  - @telorun/sdk@0.17.0
  - @telorun/ide-support@0.4.13
  - @telorun/templating@0.4.1

## 0.5.1

### Patch Changes

- Updated dependencies [55b4ec5]
- Updated dependencies [adc248b]
  - @telorun/analyzer@0.15.0
  - @telorun/sdk@0.16.0
  - @telorun/templating@0.4.1
  - @telorun/ide-support@0.4.12

## 0.5.0

### Minor Changes

- d187abd: Add the module overview graph as the `Telo.Application` topology canvas. Opening
  an Application now lands on a node-and-edge graph of its resources: nodes are
  partitioned by capability (Application / Service / Invocable / Runnable / Mount),
  ref relationships render as labelled edges, and ambient Provider / Type sources
  render as a collapsible side strip with "uses" chips on the resources that
  reference them. Layout is deterministic via `@dagrejs/dagre`; rendering via
  `@xyflow/react`.

  The module root is exposed through a synthesized kind + resource adapter, so
  selection, lookup, and the PickCanvas topology dispatch route it through the same
  path as every other resource. Opening a module default-selects its overview
  graph; the detail panel shows a read-only root summary (targets / variables /
  secrets). The graph replaces the sidebar's resource list — the sidebar's
  resources section is removed and the create-resource action moves onto the canvas
  as a panel button.

  `Telo.Library` modules get the exact same overview canvas (shared adapter,
  topology dispatch, renderer, and model). A Library has no `targets`, so it gets
  no target edges, no drag-to-wire, and no Targets section in the detail body;
  everything else — resource nodes, Provider/Type strip, ref edges, create
  button — is identical.

  Edges and chips are derived from the analyzer's `buildOverviewGraph` /
  `visitManifest`, so no resource kind is hardcoded in the editor. Refs nested
  inside step bodies (e.g. `Run.Sequence` `steps[].invoke`) are surfaced via the
  visitor's `discoverNestedRefs` value-tree scan, so resources used only from
  inside a sequence no longer render detached.

  Sequence-like nodes render their internal topology: a node whose kind schema
  declares an `x-telo-topology-role: steps` field shows its steps as sub-rows, each
  with its own source handle. Discovery recurses through branch / case / loop
  bodies and flattens them into a depth-indented row list, so the invokes inside a
  `while/do` loop appear individually instead of collapsed onto the loop. Each edge
  anchors to the deepest step its ref `fromPath` falls under — so a multi-step
  `Run.Sequence` shows one edge per `steps[].invoke` instead of bundling onto the
  node's outer handle. Step discovery is annotation-driven (shared with the
  Sequence canvas's variant helpers), so no kind name is hardcoded. A post-layout
  pass aligns each node's vertical center with the handle it is wired from — a step
  row for a per-step invoke edge, otherwise the source node — sweeping ranks
  left-to-right so a downstream ref target follows its already-aligned source
  (dagre has no per-handle ordering). Edges run roughly horizontal instead of
  crossing.

  The overview canvas's pan/zoom is remembered per module: the viewport is keyed by
  module filePath in editor state and restored when navigating back to an app/lib
  (fitting only on first view), instead of being shared across all modules.

  The selected node is highlighted on the overview canvas, and pressing Delete /
  Backspace on a selected non-root node removes that resource (new
  `removeResourceViaAst` AST op). The module root is never deletable, and the key
  handler is ignored while a text input is focused.

  Targets are editable directly on the graph: dragging an edge from the
  Application node to a Runnable / Service adds a target, deleting a target edge
  removes one. Endpoint validity is enforced against the kernel rule (targets must
  be `Telo.Runnable` or `Telo.Service`). Targets are read and written as `!ref
<name>` sentinels — the canonical reference form; the graph normalizes the
  sentinel shape when matching edges. Writes go through a new manifest-root
  `setApplicationTargets` AST op — distinct from the resource AST path because the
  Application root lives on the document root, not in `manifest.resources`.

### Patch Changes

- a6a1b96: feat(editor): edit variables/secrets on the app/library node detail panel

  Selecting the application/library node now renders an editable variables/secrets
  form (reusing the schema form) instead of a read-only summary. The form branches
  on the module kind: Application entries are host env bindings (`env` + `type`),
  while Library entries are plain JSON-Schema declarations (no `env`). Each entry's
  fields render inline in a horizontal row via a `flat` prop on the schema-form
  components (an editor layout choice, not a schema annotation), so `type`/`env`
  are visible without expanding a per-entry accordion.

  The module root is written through the generic `setResourceFields` (resolved via
  an owner-doc fallback), retiring the bespoke `setApplicationTargets`;
  `diffFields` now treats tagged `!ref`/`!cel` sentinels as opaque leaves so
  reference arrays like `targets` round-trip without losing their tags.

- Updated dependencies [ae0bf77]
- Updated dependencies [222b3d6]
  - @telorun/sdk@1.0.0
  - @telorun/analyzer@1.0.0
  - @telorun/templating@1.0.0
  - @telorun/ide-support@0.4.11

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
