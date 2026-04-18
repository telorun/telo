# Run Adapters

## Goal

Implement the Run action so clicking Run on an Application starts the manifest under an adapter-chosen runtime (Docker via Tauri in v1), streams stdout/stderr back into the editor with ANSI color, and lets the user stop it. The adapter layer is designed so additional runtimes (remote service API, Kubernetes, etc.) can be added later as pure extensions — no changes to the editor's Run wiring.

## Non-goals

- Remote service-API adapter. Out of scope here; the interface must accommodate it later.
- Kernel-events tab (structured `ResourceInitialized` / `ResourceFailed` stream into a dedicated view). Out of scope, but the `RunEvent` shape must leave room for it.
- Multi-session UX. One active run per editor instance in v1.
- Stdin. Log view is read-only.
- Multi-environment deployment UX. The data shape supports multiple environments per Application (see *Deployment environments*) but v1 ships only a single auto-created `local` environment. Add/rename/delete, per-environment adapter override, and secret handling land in a follow-up.

---

## Principles

1. **One root directory, one future package.** Everything Run-related lives under `src/run/` so the layer can be lifted into `@telorun/run-adapter` when the VS Code extension or another host needs it. Nothing outside `src/run/` depends on adapter internals.
2. **Adapters declare their own availability and config shape.** The UI never hardcodes "check if docker is installed" or "the docker adapter has an image field." Each adapter owns three things: a JSON Schema describing its config, a sync `validateConfig` for cross-field rules, and an async `isAvailable(config)` probe. The Run affordance and Settings picker key off a three-state report: `ready`, `needs-setup` (config missing/invalid), or `unavailable` (environment issue). These two states are UX-distinct: setup-needed points the user at the form; unavailable points them at their environment.
3. **Forms are schema-driven, with an escape hatch.** Adapter config forms render by passing `configSchema` through the existing [resource-schema-form/](apps/telo-editor/src/components/resource-schema-form/) renderer — the same JSON-Schema pipeline the editor uses everywhere else. Adapters that need bespoke UI (a file picker, a "Test connection" button) can export a `customForm` component that overrides the renderer.
4. **Discriminated unions as extension points.** `RunEvent` and `RunStatus` are closed unions today but open-for-extension: adding `{ type: "kernel"; … }` later does not break existing consumers — the log view ignores unknown variants.
5. **Bundle, don't mount semantics.** The adapter receives an already-resolved bundle of manifest files (entry Application + transitive local Libraries). How to transport the bundle (bind-mount, tarball upload, kube ConfigMap) is the adapter's concern.

---

## Directory structure

```
apps/telo-editor/
  src/run/
    types.ts                 # RunAdapter, RunRequest, RunBundle, RunSession, RunEvent, RunStatus, AvailabilityReport
    bundle.ts                # async buildRunBundle(workspace, entryPath, readFile) → RunBundle
    registry.ts              # adapter registry (register, list, get, default)
    context.tsx              # RunProvider + useRun() hook
    adapters/
      tauri-docker/
        adapter.ts           # implements RunAdapter via Tauri invoke + event listen
        config-schema.ts     # JSON Schema for adapter config (image name, etc.)
        protocol.ts          # payload shapes shared with Rust
        availability.ts      # probe: docker CLI present, daemon reachable
    ui/
      RunView.tsx            # full-canvas replacement while a run is active
      LogStream.tsx          # ANSI-colored, virtuoso-backed log list
      RunStatusChip.tsx      # status pill
      AdapterUnavailable.tsx # unreachable-env message + Recheck
      AdapterSetupRequired.tsx # config issues + "Open Settings" CTA
      AdapterConfigForm.tsx  # renders configSchema via resource-schema-form, or customForm override
    index.ts                 # barrel — only thing the rest of the editor imports

  # Deployment data + UI live outside src/run/ because they are editor-workspace
  # concerns (not adapter-layer) and are reused by any future run mechanism.
  src/components/views/deployment/
    DeploymentView.tsx
    EnvironmentSelector.tsx  # v1: read-only "Local" label; future: dropdown
    EnvVarsEditor.tsx        # key/value table

  src-tauri/src/
    lib.rs                   # register run_start, run_stop, run_probe_docker commands
    run/
      mod.rs
      bundle.rs              # write RunBundle to a tempfile::TempDir
      docker.rs              # spawn docker, stream stdio, handle stop, DOCKER_HOST passthrough
      session.rs             # in-process map: sessionId → child handle; window-close cleanup
      availability.rs        # docker version probe
```

Rule: **nothing outside `src/run/`** imports from `src/run/adapters/` or `src/run/ui/`. Only `src/run/index.ts` is a valid import target for the rest of the editor.

---

## Public interface (`src/run/types.ts`)

```ts
import type { JSONSchema7 } from "json-schema";

export interface RunAdapter<Config = unknown> {
  id: string;                        // stable id, e.g. "tauri-docker"
  displayName: string;               // "Local (Docker via Tauri)"
  description: string;               // short line shown in Settings picker

  // Config surface — everything the adapter needs the user to fill in.
  configSchema: JSONSchema7;         // rendered by SettingsModal via resource-schema-form
  defaultConfig: Config;             // seeded when user first selects the adapter

  // Optional cross-field / custom validation beyond what the schema expresses.
  // Return [] when config is valid. Runs sync on every settings edit.
  validateConfig(config: Config): ConfigIssue[];

  // Optional escape hatch for adapters that need bespoke form UI.
  // When set, SettingsModal renders this instead of the schema-driven form.
  customForm?: React.ComponentType<{
    value: Config;
    issues: ConfigIssue[];
    onChange: (next: Config) => void;
  }>;

  // Environment probe. Assumes validateConfig(config) returned []. Caller must
  // not invoke this when there are unresolved config issues — the adapter is
  // entitled to assume all required fields are present.
  isAvailable(config: Config): Promise<AvailabilityReport>;

  start(request: RunRequest, config: Config): Promise<RunSession>;
}

export type AvailabilityReport =
  | { status: "ready" }
  | { status: "needs-setup"; issues: ConfigIssue[] }             // config invalid despite caller's check (e.g. live probe found a bad field)
  | { status: "unavailable"; message: string; remediation?: string };

export interface ConfigIssue {
  path: string;                      // JSON pointer into config, e.g. "/apiUrl"
  message: string;                   // human-readable, shown inline under the field
}

export interface RunRequest {
  bundle: RunBundle;
  env?: Record<string, string>;
}

export interface RunBundle {
  entryRelativePath: string;                                   // POSIX-style, relative to bundle root
  files: Array<{ relativePath: string; contents: string }>;    // entry Application + every transitively-imported local Library (and their include: partials)
}

export interface RunSession {
  id: string;
  getStatus(): RunStatus;
  subscribe(listener: (event: RunEvent) => void): () => void;  // returns unsubscribe
  stop(): Promise<void>;
}

export type RunStatus =
  | { kind: "starting" }
  | { kind: "running" }
  | { kind: "exited"; code: number }
  | { kind: "failed"; message: string }
  | { kind: "stopped" };

export type RunEvent =
  | { type: "stdout"; chunk: string }      // raw bytes decoded UTF-8, ANSI preserved
  | { type: "stderr"; chunk: string }
  | { type: "status"; status: RunStatus };
  // Reserved: { type: "kernel"; event: KernelEvent } — added later, ignored by current UI.
```

### The three availability states

A boolean hides the reason; a two-state ready/unavailable conflates "user hasn't filled in a required field" with "Docker daemon is down." These deserve different UX:

- **`ready`** — Run button is enabled. Settings picker shows a green check.
- **`needs-setup`** — Run button shows "Setup required"; clicking opens Settings with the adapter's form focused and `issues` highlighted inline under the relevant fields. Settings picker shows an amber "Setup required" badge. Typical cause: blank URL, missing namespace, required secret not entered.
- **`unavailable`** — Run button shows "Unavailable"; clicking opens `RunPanel` with `AdapterUnavailable` (message + remediation + Recheck). Settings picker shows a grey warning with the same message. Typical cause: Docker daemon not running, network unreachable, cluster credentials expired.

Call sites:

1. **Settings form** calls `validateConfig(config)` on every keystroke (cheap, sync). Issues render inline under each field.
2. **Settings picker availability badge** calls `isAvailable(config)` on adapter selection and Recheck — only when `validateConfig` returned `[]`. If `validateConfig` has issues, the badge shows `needs-setup` without hitting the probe.
3. **Run button** calls `validateConfig` first, then `isAvailable(config)` immediately before starting — environment can change between Settings visit and click. The `needs-setup` case from `isAvailable` itself exists for runtime config discovery (e.g. a probe learns the configured endpoint is malformed) and is treated the same as a sync validation failure.

---

## Adapter registry (`src/run/registry.ts`)

- In-memory map `id → RunAdapter`. Seeded at editor startup with the Tauri-Docker adapter.
- `registry.list()` returns adapters in display order.
- `registry.get(id)` returns adapter or `undefined`.
- No auto-detection at startup — availability is probed on demand (Settings open, Run click, Recheck click). Startup stays fast; probes can hit `docker version` which takes hundreds of ms.

Adding a future adapter is a single call: `registry.register(new ServiceApiAdapter(config))`.

---

## Bundle resolution (`src/run/bundle.ts`)

Async function. The workspace graph (modules, imports, `include` paths) is in memory and read synchronously; **file contents are not**: [ParsedManifest](apps/telo-editor/src/model.ts#L31-L51) stores `include: string[]` (paths only), and `rawYaml` is populated only on parse failure. Partial files and even the main `telo.yaml` texts must be read via `WorkspaceAdapter.readFile`.

**Source of truth: on-disk raw text, always.** The bundle's `contents` strings come from `readFile`, never from re-serializing `ParsedManifest`. Re-serialization would lose comments, anchors, and formatting, and could subtly alter CEL string literals via YAML round-tripping — all of which the user sees in the editor and expects to run verbatim. The existing `rawYaml` field on `ParsedManifest` is deliberately **not** used as a shortcut (it is only populated on parse failure, so cannot substitute for a `readFile` in the success path) — reading every file from disk at bundle time keeps the policy uniform.

```ts
async function buildRunBundle(
  workspace: Workspace,
  entryFilePath: string,
  readFile: (absPath: string) => Promise<string>,   // injected — typically WorkspaceAdapter.readFile
): Promise<RunBundle>
```

Algorithm:

1. Resolve the entry Application manifest in `workspace.modules`. Reject if not `kind: "Application"`.
2. BFS over `Telo.Import` resources. For each import, classify via `ImportKind`:
   - `"local"` → resolve to a workspace module path; recurse into its imports.
   - `"registry"` / `"remote"` → ignore (the container / runtime resolves them).
3. For every visited local module, collect its `telo.yaml` path and every path listed in its `include: string[]`.
4. Read each collected path via `readFile` in parallel (`Promise.all`).
5. Compute the common ancestor directory across the set; use it as the bundle root.
6. Emit `{ relativePath, contents }` per file, with POSIX separators.

### Source of truth: disk vs. editor buffer

Open question worth calling out — currently resolved as **disk**: the bundle reflects what is on disk at the moment of Run, not unsaved edits in the editor buffer. If the user has pending changes in an open manifest, those changes will not run until saved. Rationale:

- Serializing `ParsedManifest` back to YAML would bypass the writer's formatting guarantees and could diverge from what the user sees.
- "Run what I see" semantics are ambiguous when only *some* modules are dirty.
- Save-before-run is the well-understood IDE convention.

Follow-up item (separate PR, not blocking the adapter plan): auto-save all dirty manifests on Run, with a Setting toggle to disable. Tracked separately so the Run-adapter scope stays contained.

Tests live at `src/run/__tests__/bundle.test.ts` with fixtures covering:
- Application with no imports.
- Application importing one local Library that imports another local Library.
- Application mixing local + registry imports (registry imports must be absent from the bundle).
- Circular local imports (should terminate; emit each file once).
- Partials reached via `include:` are present in the bundle with their on-disk contents (stubbed `readFile`).

---

## Deployment environments

Applications frequently reference `${{ env.FOO }}` in their CEL expressions. The CLI fills that from `process.env`; the editor has no ambient `process.env` to forward, and wouldn't want to — leaking unrelated host env vars into a container is a privacy footgun. Instead, each Application gets an editor-managed **deployment configuration**: a named set of environments, each defining the `env` passed to its run.

### v1 scope

- Each Application has exactly one auto-created environment with `id: "local"`, `name: "Local"`, `env: {}`.
- New Applications seed this on first access; the user never has to create the environment before Run works.
- Env vars are edited in a new **Deployment** view (see below).
- The Run flow reads the active environment's `env`, passes it as `RunRequest.env`.

### Data shape

Lives on `EditorState` at runtime (so views and Run flow read/write through one source), but is **persisted in its own localStorage key** — not folded into the existing `saveState` projection (see *Persistence* below).

```ts
interface EditorState {
  // …existing fields…
  deploymentsByApp: Record<string, ApplicationDeployment>;   // keyed by Application filePath
}

interface ApplicationDeployment {
  activeEnvironmentId: string;                              // "local" in v1
  environments: Record<string, DeploymentEnvironment>;      // keyed by id
}

interface DeploymentEnvironment {
  id: string;                                               // stable, e.g. "local", "staging"
  name: string;                                             // user-facing label
  env: Record<string, string>;
  // Future (deferred): adapterIdOverride?, secretsRef?, description?
}
```

Keyed by Application `filePath` for v1. This means renaming or moving an Application silently orphans its deployment entry; acceptable for v1, but a follow-up should introduce a stable id on the manifest (e.g. generated UUID in `metadata`) and migrate the keying to it. Called out so it isn't mistaken for a latent bug.

### Persistence — separate localStorage key

The existing [storage.ts](apps/telo-editor/src/storage.ts) `saveState` / `loadPersistedState` round-trips a three-field `PersistedState` (`rootDir`, `activeModulePath`, `activeView`) explicitly projected at [storage.ts:20-24](apps/telo-editor/src/storage.ts#L20-L24), and the file comment scopes it to "lightweight cross-session state." `deploymentsByApp` doesn't fit that envelope — it's a per-workspace map of structured data that should evolve independently from UI-focus state.

Solution: a new storage module `src/storage-deployments.ts` with its own localStorage key `telo-editor-deployments-v1`:

```ts
// stored shape
interface PersistedDeployments {
  byWorkspace: Record<string, Record<string, ApplicationDeployment>>;
  //           ^workspace rootDir     ^Application filePath
}
```

Separating keys gives deployment storage its own migration story (future: secret-ref redirection, schema bumps) without dragging `PersistedState` along. It also keeps deployments for multiple workspaces resident — switching workspaces doesn't clobber the other's env vars. On workspace load, `EditorState.deploymentsByApp` is hydrated from `byWorkspace[rootDir] ?? {}`.

**Plaintext caveat.** localStorage is not encrypted. v1 accepts this: the expected use is test fixtures and non-production config, not secret material. OS-keychain integration is a follow-up if users need to store real secrets rather than development values — and would slot in cleanly as a field-level `secretsRef` on `DeploymentEnvironment`.

### Why EditorState and not the manifest

- Env values may contain secrets; they must not be committed with the manifest.
- Deployment configuration is editor-local workflow, not part of the Application's deployable artifact.
- Storing alongside the manifest (sibling `telo.deploy.yaml`) is a plausible future escalation for portability — deferred until a concrete need appears. Keeping it in editor storage today costs nothing and sidesteps the secrets-in-git question.

### UI: Deployment view

New view registered under [src/components/views/](apps/telo-editor/src/components/views/) alongside `inventory/`, `topology/`, `source/`:

```
src/components/views/deployment/
  DeploymentView.tsx
  EnvironmentSelector.tsx    # v1: shows "Local" read-only; future: dropdown + add/delete
  EnvVarsEditor.tsx          # key/value table with add-row / delete-row
```

- Registered by extending [ViewId](apps/telo-editor/src/model.ts#L104) with `"deployment"` and adding the same string to `VALID_VIEWS` in [storage.ts:7](apps/telo-editor/src/storage.ts#L7) so `activeView` rehydration accepts it.
- Shown as another tab in `ViewContainer` when the active module is an Application.
- Hidden when the active module is a Library (libraries don't run); if the rehydrated `activeView` is `"deployment"` and the active module is a Library, fall back to `"topology"` (same pattern `loadPersistedState` already uses for invalid values).
- v1 renders: the single "Local" environment name (read-only), then `EnvVarsEditor` — an editable key/value list bound to `deploymentsByApp[app].environments.local.env`.
- Future work (multi-environment) slots in by making `EnvironmentSelector` interactive; no changes to `RunRequest.env` or adapter interface.

### `RunView` is not a `ViewId`

`RunView` is deliberately **not** a member of the `ViewId` union. It is:

- Not user-selectable via the tab picker.
- Not persisted as `activeView` across restarts (reopening the editor should not land on an empty/stale run view).
- Shown purely as a function of `RunContext` state (an active or recently-terminated session the user hasn't dismissed).

`ViewContainer` renders `RunView` in place of the `activeView`-selected view when `RunContext.isRunViewOpen` is true, leaving the underlying `activeView` untouched so closing `RunView` restores the user's prior view unchanged.

### Future-proofing hooks

- The adapter interface stays flat (`RunRequest.env: Record<string, string>`) — environment selection is resolved editor-side before `adapter.start` is called, so adapters never see the concept.
- `ApplicationDeployment.activeEnvironmentId` today is always `"local"`; the field exists so multi-env UX is a pure extension.
- `DeploymentEnvironment` is open-for-extension (`adapterIdOverride`, `secretsRef`, etc.) without breaking v1 serialized state.

---

## Tauri-Docker adapter

### Config shape (`src/run/adapters/tauri-docker/config-schema.ts`)

```ts
export interface TauriDockerConfig {
  image: string;                     // default: "telorun/telo"
  pullPolicy: "missing" | "always" | "never";   // default: "missing"
  dockerHost?: string;                // optional; forwards to DOCKER_HOST env
}

export const tauriDockerSchema: JSONSchema7 = {
  type: "object",
  required: ["image", "pullPolicy"],
  properties: {
    image: { type: "string", minLength: 1, default: "telorun/telo",
             description: "Docker image implementing the telo CLI entrypoint." },
    pullPolicy: { type: "string", enum: ["missing", "always", "never"], default: "missing" },
    dockerHost: { type: "string",
                  description: "Override DOCKER_HOST (e.g. unix:///var/run/docker.sock). Leave blank to use the default." },
  },
};
```

`validateConfig` is trivial (JSON Schema `required` + `minLength` cover it); returns `[]` for most cases. A future adapter with cross-field rules ("API URL required when not using local socket") lives here.

### Frontend (`src/run/adapters/tauri-docker/adapter.ts`)

- `start(req, config)`:
  1. Generate `sessionId` (UUID).
  2. Register event listeners on `run:{sessionId}:stdout`, `run:{sessionId}:stderr`, `run:{sessionId}:status` via `@tauri-apps/api/event`.
  3. `invoke("run_start", { sessionId, bundle: req.bundle, env: req.env ?? {}, config })`.
  4. Return a `RunSession` whose `subscribe` fan-outs to registered listeners; `stop` calls `invoke("run_stop", { sessionId })` and awaits the final `status` event.
- `isAvailable(config)` → `invoke("run_probe_docker", { config })` which returns a typed `AvailabilityReport`.

### Availability probe (`src/run/adapters/tauri-docker/availability.ts` + Rust `availability.rs`)

Staged checks, the first failure wins:

1. Run `docker version --format '{{.Server.Version}}'` (with `DOCKER_HOST` from config, if set) with a 2 s timeout.
   - CLI missing → `{ status: "unavailable", message: "Docker CLI not found in PATH.", remediation: "Install Docker Desktop or the Docker Engine." }`
   - CLI present, daemon unreachable, `dockerHost` blank → `{ status: "unavailable", message: "Docker daemon not reachable.", remediation: "Start Docker Desktop or ensure the docker socket is accessible." }`
   - CLI present, daemon unreachable, `dockerHost` set → `{ status: "needs-setup", issues: [{ path: "/dockerHost", message: "Cannot connect to daemon at <value>." }] }` — a bad override is a config issue, not an environment issue.
2. If `pullPolicy !== "always"`, check `docker image inspect <image>`. Missing image:
   - `pullPolicy === "missing"` → `{ status: "ready" }` with a non-blocking note ("Image will be pulled on first run") surfaced by the UI. This is not a failure — `docker run` handles it — but the user deserves to know about the pending latency.
   - `pullPolicy === "never"` → `{ status: "unavailable", message: "Image <image> not present locally and pullPolicy is 'never'.", remediation: "Run docker pull <image> or change pullPolicy." }`.

On success → `{ status: "ready" }`.

### Rust side (`src-tauri/src/run/`)

- `session.rs`: `pub struct SessionRegistry(Mutex<HashMap<String, SessionHandle>>)`. `SessionHandle` owns the child process + a `tempfile::TempDir` so `run_stop` and process-exit cleanup have everything they need; `TempDir`'s `Drop` deletes the directory automatically. Also owns a window-close hook: on Tauri's `WindowEvent::CloseRequested`, iterate live sessions and run the same `docker kill` path as `run_stop` so editor shutdown doesn't orphan containers. `--rm` on `docker run` handles the graceful path; the close hook handles crashes and user-driven window closes.
- `bundle.rs`: creates a `tempfile::TempDir` (prefix `telo-run-`) per session and writes bundle files into it. POSIX separators in `relativePath` are converted to `PathBuf` components — no string concat.
- `docker.rs`:
  - Spawns `docker run --rm -i --name telo-run-<sessionId> -v <tempdir>:/srv -w /srv [-e K=V …] <image> ./<entryRelativePath>`. Mirrors the documented usage: `docker run -v .:/srv -w /srv telorun/telo ./some-app`. The image's entrypoint is `telo`, so the trailing argument is the manifest path only — no `telo` prefix.
  - If `config.dockerHost` is set, propagates it as the `DOCKER_HOST` env on the `docker run` command itself (not just the availability probe). The same override must drive both calls or an available daemon at a custom host wouldn't actually run the container.
  - Uses `tokio::process::Command` with piped stdout/stderr.
  - Two spawned tasks read from stdout/stderr, emit `Window::emit` events with UTF-8-decoded chunks (ANSI preserved, no stripping).
  - A third task awaits `child.wait()` and emits the terminal `status` event, then removes the session entry (`TempDir` drop deletes the tempdir).
- `run_stop`: looks up the session, runs `docker kill telo-run-<sessionId>` with `DOCKER_HOST` propagated (cross-platform reliable — direct signal to the child Docker CLI is racy on Windows). Waits for the exit task to emit `stopped`.
- Image name comes from a setting persisted in the frontend, passed through `run_start`. Default: `telorun/telo`. Override lets users pin a tag, point at a local build, or swap registries.
- New Rust deps: `tokio` (full feature for process + time), `tempfile`, `uuid`, `serde_json`. `tauri_plugin_shell` is not used — it is tuned for one-off commands, not long-lived streaming children.
- Capabilities: `run_start` / `run_stop` / `run_probe_docker` are app-level commands (not a Tauri plugin), so they are invocable as soon as they are registered in `tauri::generate_handler!` inside [lib.rs](apps/telo-editor/src-tauri/src/lib.rs). No additions to [capabilities/default.json](apps/telo-editor/src-tauri/capabilities/default.json) are expected — plugin-style `<ns>:allow-<cmd>` permissions apply to plugins, not to the app's own commands. **Verify during PR 2**: the current `lib.rs` registers no `#[tauri::command]`s, so there is no in-repo precedent, and Tauri's capability enforcement has evolved across minor versions. If an `invoke` is rejected at runtime, add an app-command permission entry at that point rather than debating the policy up front. If a decision is later made to extract these into a reusable plugin, a permissions manifest would be added at that point.

### Windows bind-mount note

Tauri's `std::env::temp_dir()` returns a Windows-native path; Docker Desktop needs the same path (paths like `C:\Users\...` work with Docker Desktop's bind-mount translation on recent versions; no `/c/Users/...` rewriting required). If this fails in practice, fall back to `dunce::canonicalize` + docker-context detection. Out of scope to build heuristics until someone reports a failure — but `isAvailable()` should report the Docker Desktop environment.

---

## UI

### `RunView` (formerly `RunPanel`)

Full-canvas view, **not** a dockable bottom panel. When a session is active (or Run was just clicked against an unavailable adapter), the main content area in [Editor.tsx](apps/telo-editor/src/components/Editor.tsx) renders `RunView` in place of the active view (topology / inventory / source / deployment). The [DetailPanel](apps/telo-editor/src/components/DetailPanel.tsx) is hidden while `RunView` is shown — the run deserves the full width. The sidebar stays. Closing `RunView` (X button, or a `view: "previous"` control) restores the previous active view.

Why canvas-replacement over bottom-dock:

- No new layout machinery — slots into the existing `ViewContainer` pattern as a synthetic view that takes precedence.
- Full-width logs match real log volume better than a 30vh strip.
- The Run state is temporal and foreground; hiding the canvas communicates "we're doing something different right now" more cleanly than a persistent bottom bar.
- DetailPanel being hidden avoids the awkward case of a user having a resource selected while they watch logs — nothing in `DetailPanel` is meaningful during a run.

Visibility rules:

- Not rendered until the user clicks Run for the first time in the session.
- Takes over the canvas on Run click.
- Stays shown after the run exits until the user closes it; re-clicking Run while closed reopens it with the existing session's log buffer intact.
- Closing clears the session from `RunContext` only after a terminal status (`exited` / `failed` / `stopped`); mid-run close keeps the session active and shows a toast "Run continues in background" (future), or is disabled (v1 — simpler).

Header: adapter name, `RunStatusChip`, Stop button (enabled in `starting` / `running`), Clear-logs button (enabled only in terminal states), Close button.
Body: `LogStream`. Empty state: "Waiting for output…" during `starting`.

### `LogStream`

- Interleaved stdout + stderr, in emission order.
- ANSI color via `ansi-to-react` (pure-DOM, small; no `xterm.js` weight — we don't need input, resize, or selection beyond browser-native).
- Virtualized via `react-virtuoso`. Hand-rolled windowing is rejected — partial-line buffering across virtualization boundaries is a foot-shooting gallery and virtuoso handles sticky-bottom scroll for us.
- Auto-scroll to bottom via virtuoso's `followOutput`. If the user scrolls up, stop auto-scrolling and show a "Jump to bottom" affordance.
- Chunks are split into lines on the fly; partial lines (no trailing `\n`) buffer until the next chunk.
- Capped at 10 000 rendered lines; older lines drop with a "(earlier output truncated)" marker at the top.

### `RunStatusChip`

Color + label per `RunStatus`. Uses existing design tokens.

### `AdapterUnavailable`

Rendered inside `RunView` (not in a modal) when the user clicks Run while the selected adapter reports unavailable. Shows `reason`, `remediation`, and a Recheck button that reruns `isAvailable()` and retries automatically on success.

### Run button indicator

The existing [TopBar Run button](apps/telo-editor/src/components/TopBar.tsx#L59) replaces its icon with a spinner while a session is `starting` or `running`. When the session reaches a terminal state and the user has closed `RunView`, a small coloured dot remains on the button (green for `exited: 0`, red for `failed` / non-zero exit / `stopped`) until the next Run click.

### Run button behaviour

Current stub in [Editor.tsx:220-223](apps/telo-editor/src/components/Editor.tsx#L220-L223) is replaced by:

1. Look up the selected adapter from settings via `registry.get(settings.activeRunAdapterId)`. If missing, open Settings with the picker focused.
2. Read the adapter's persisted config from `settings.runAdapterConfig[adapter.id]` (falling back to `adapter.defaultConfig`).
3. Run `adapter.validateConfig(config)`. If issues → open Settings with the adapter row expanded and `issues` rendered inline; return.
4. Call `adapter.isAvailable(config)` with a short loading indicator on the Run button.
   - `"needs-setup"` → open Settings as in step 3 with the returned `issues`.
   - `"unavailable"` → switch the main view to `RunView` with `AdapterUnavailable` showing the message, remediation, and a Recheck button.
   - `"ready"` → continue.
5. If a session is already active: confirm "Stop current run and start new?" before proceeding.
6. **Ensure on-disk state matches in-memory edits** — the bundle is read from disk, so any unflushed edits would otherwise run the previous revision. The editor's existing mutation paths (`persistModule`) write eagerly, so this step is a no-op in practice with one known gap: the Source view's Monaco debounce (~500ms) can hold an unsaved edit in local state. Running within that window runs the pre-edit bytes on disk. Accepted for v1; tracked as a follow-up (imperative "flush Source editor debounce" API, or switch Source to write-through).
7. Resolve the active deployment environment: `deploymentsByApp[activeManifest.filePath]?.environments[activeEnvironmentId]?.env ?? {}`. If no `ApplicationDeployment` exists yet, create the default `local` environment first.
8. Build the bundle via `await buildRunBundle(workspace, activeManifest.filePath, workspaceAdapter.readFile)`.
9. Call `adapter.start({ bundle, env }, config)`, push the session into `RunContext`, switch the main view to `RunView`.

The Run button tooltip reflects the last-known state per adapter (`ready` / `Setup required: <first issue>` / `<unavailable message>`) without requiring a click. State is cached in `RunContext` and invalidated on config changes or Recheck. While a session is `starting` or `running`, the Run button shows a spinner in place of its icon.

---

## Settings integration

- Extend [AppSettings](apps/telo-editor/src/model.ts#L10-L12) with `activeRunAdapterId: string` and `runAdapterConfig: Record<string, unknown>`. Persistence flows through the existing `saveSettings` / `loadSettings` path in [storage.ts](apps/telo-editor/src/storage.ts) — run-adapter choice is a user preference, not workspace-scoped state, so it belongs alongside `registryServers` rather than in `EditorState`. Update [DEFAULT_SETTINGS](apps/telo-editor/src/model.ts#L23) to seed the default adapter id. Per-adapter config is stored opaquely by id; the adapter's `configSchema` is the source of truth for its shape.
- [SettingsModal.tsx](apps/telo-editor/src/components/SettingsModal.tsx) gets a new "Run" section:
  - Radio list driven by `registry.list()`. Each row: `displayName`, `description`, and a status badge (green `Ready` / amber `Setup required` / grey `Unavailable`).
  - Selected row expands to show `AdapterConfigForm`, the adapter's form (schema-driven by default, `customForm` if the adapter overrides), and — below the form — the availability summary with a Recheck button.
  - New-install default: first registered adapter (`tauri-docker`), seeded with `adapter.defaultConfig`.
- `RunProvider` reads settings at mount and re-validates / re-probes on every settings change.

### `AdapterConfigForm` — the rendering layer

Lives in `src/run/ui/AdapterConfigForm.tsx`. Accepts `{ adapter, value, onChange }` and:

- If `adapter.customForm` is set → render it, passing `issues` from `validateConfig(value)`.
- Otherwise → render via the existing [resource-schema-form/](apps/telo-editor/src/components/resource-schema-form/) renderer, feeding `adapter.configSchema`.

`ResourceSchemaForm` does **not** currently accept per-field error props — [its props](apps/telo-editor/src/components/resource-schema-form/index.tsx#L6-L15) are `schema / values / onChange / onFieldBlur / onParseStateChange / resolvedResources / rootCelEval / onSelectResource`. Getting `ConfigIssue[]` to the user therefore has two paths:

**v1 (this plan): issue summary block above the form.** `AdapterConfigForm` renders an errors banner above the `ResourceSchemaForm` listing each issue as `<label>: <message>`. The label comes from a small helper that resolves a JSON pointer against the schema and prefers the field's `title` (or falls back to the last path segment) — so the user sees `Docker Host: Cannot connect…` rather than `/dockerHost: …`. Works for flat schemas like tauri-docker's. Ships with zero changes to the shared renderer.

`ResourceSchemaForm` is called with inert defaults for the props that don't apply to adapter config: `resolvedResources={[]}`, `rootCelEval={null}`, `onSelectResource={undefined}`. If the renderer later starts *requiring* CEL/resource context (rather than gracefully ignoring empty values), a thin "schema form without resource context" wrapper splits out at that point; premature for now.

**Follow-up PR (not part of this plan): `fieldErrors?: Record<string, string>` on `ResourceSchemaForm`.** Adds a prop threaded through `FieldControl` into each leaf/object/scalar field so errors render inline under the relevant control. Benefits resource editing broadly, not just adapter config — any validator (analyzer, CEL, adapter) can feed into it. Scoped as its own PR because it touches every field-kind renderer in `resource-schema-form/`; not a drive-by of the Run adapter work. When it lands, `AdapterConfigForm` switches to inline errors and the summary block becomes a no-op.

This keeps `SettingsModal` completely free of adapter-specific knowledge. Adding a new adapter means adding a schema and a probe; zero changes to SettingsModal.

### Why JSON Schema over a React component

- Telo already thinks in JSON Schema — resources, `x-telo-*` annotations, and the existing editor form renderer. Adapter config inherits that pipeline for free.
- Schema doubles as runtime validation without a second source of truth.
- Adapters stay serializable and describable — a future "export adapter config for a team" or "validate config in CI" need has a clean path.
- The `customForm` escape hatch handles cases that genuinely need bespoke UI (file pickers, "Test connection" buttons) without forcing schema gymnastics.

---

## Wiring plan (PR breakdown)

Each step leaves the codebase working.

### PR 1 — Types, bundle, registry, tests, boundary lint

- Add `src/run/types.ts`, `src/run/registry.ts`, `src/run/bundle.ts`, `src/run/index.ts`.
- Unit tests for `buildRunBundle` with the fixture cases above (stubbed `readFile`).
- Extend [eslint.config.mjs](apps/telo-editor/eslint.config.mjs) with the `no-restricted-imports` rule described in *Module-boundary enforcement*.
- Add `@types/json-schema` to devDependencies.
- No UI, no Tauri. Nothing is wired into `Editor.tsx` yet.

### PR 2 — Tauri-Docker Rust backend

- Add `src-tauri/src/run/` (session, bundle, docker, availability).
- Register `run_start`, `run_stop`, `run_probe_docker` commands.
- Wire the window-close hook that kills active sessions' containers on editor shutdown.
- Commands registered in `tauri::generate_handler!`; no capability changes expected (verify at runtime per the note in *Rust side*).
- Integration tested by hand against the real `telorun/telo` image with a one-resource hello manifest — confirms stdout streaming, stop, status emission, and DOCKER_HOST passthrough end-to-end.

### PR 3 — Deployment environments (state + view)

- Extend `EditorState` with `deploymentsByApp: Record<string, ApplicationDeployment>`.
- Add `src/storage-deployments.ts` with its own `telo-editor-deployments-v1` localStorage key and `PersistedDeployments` shape; hydrate `deploymentsByApp` from `byWorkspace[rootDir]` on workspace load and persist on every mutation. Do **not** extend `PersistedState` / `saveState` in `storage.ts`.
- Extend [ViewId](apps/telo-editor/src/model.ts#L104) with `"deployment"` and add the same string to `VALID_VIEWS` in [storage.ts:7](apps/telo-editor/src/storage.ts#L7); add a fallback to `"topology"` when the persisted view is `"deployment"` but the active module is a Library.
- Add helpers for "get-or-create-local-environment" that `RunContext` and the Deployment view both use.
- Add `src/components/views/deployment/DeploymentView.tsx` + `EnvironmentSelector` + `EnvVarsEditor`.
- Register the view in `ViewContainer`; hide the tab for Libraries.
- No Run wiring yet — the view edits state, nothing reads it.

### PR 4 — Tauri-Docker frontend adapter + RunContext + RunView

- Add `src/run/adapters/tauri-docker/`, `src/run/context.tsx`, `src/run/ui/`.
- Add `ansi-to-react` and `react-virtuoso` to dependencies.
- Register the adapter in `registry.ts` at editor startup.
- Replace the `handleRunModule` stub with the full sequence (save dirty → resolve deployment env → bundle → availability → start). Run button spinner wired via `RunContext`.
- Wire `RunView` into `ViewContainer` as a synthetic view that takes precedence while a session is active; hide `DetailPanel` in that mode.
- Run button works end-to-end against `telorun/telo`, with env vars from the deployment view flowing into the container.

### PR 5 — Settings integration

- Add adapter picker to `SettingsModal`.
- Add `AdapterConfigForm` component that renders `adapter.configSchema` via the existing `resource-schema-form/` renderer (or `customForm` if overridden), with the JSON-pointer→schema-title label helper for issue summaries.
- Persist `activeRunAdapterId` and `runAdapterConfig` in `AppSettings`.
- Wire `validateConfig` → summary-banner errors; `isAvailable` → status badge + Recheck.
- Tauri-docker config (image, pullPolicy, dockerHost) editable via Settings.

---

## New dependencies

Frontend ([apps/telo-editor/package.json](apps/telo-editor/package.json)):

- `@types/json-schema` (devDep, added in PR 1) — `JSONSchema7` type for `RunAdapter.configSchema`. No runtime dep; schemas are plain data.
- `ansi-to-react` (runtime, added in PR 4) — ANSI color parsing for `LogStream`. Small, pure React, no xterm dependency.
- `react-virtuoso` (runtime, added in PR 4) — list virtualization for `LogStream` under high log volume, with sticky-bottom `followOutput` built in.

Rust ([apps/telo-editor/src-tauri/Cargo.toml](apps/telo-editor/src-tauri/Cargo.toml)):

- `tokio` with the `process`, `io-util`, `rt-multi-thread`, `time`, `macros` features.
- `tempfile` — tempdir lifecycle.
- `uuid` with `v4` — session ids.
- `serde_json` is already pulled transitively by Tauri; pinned explicitly for clarity.

No new workspace packages.

---

## Module-boundary enforcement

The "nothing outside `src/run/` imports from `src/run/adapters/` or `src/run/ui/`; only `src/run/index.ts` is a valid external import target" rule is enforced by lint, not convention. The current [eslint.config.mjs](apps/telo-editor/eslint.config.mjs) only does `globalIgnores`, so PR 1 extends it:

```js
{
  files: ["src/**/*.{ts,tsx}"],
  ignores: ["src/run/**"],
  rules: {
    "no-restricted-imports": ["error", {
      patterns: [
        { group: ["**/run/adapters/**", "**/run/ui/**"],
          message: "Import from src/run (the barrel), not from src/run/adapters or src/run/ui." },
      ],
    }],
  },
}
```

`src/run/**` itself is excluded so internal cross-references inside `src/run/` are allowed. A matching check inside `src/run/` could block `ui/` from importing `adapters/` and vice versa, but that is over-specified for v1 — skip until a violation appears.

---

## Risks and prerequisites

1. **Registry-import resolution inside the container.** `pkg:npm:*` and URL imports must resolve from inside the running image. Matches existing CLI behaviour; the image's responsibility. If the image lacks network at runtime, users will see clear errors from the kernel on stderr — not our problem to mask.
2. **Docker availability UX.** `isAvailable()` must give actionable remediation strings, not generic errors. Listed messages above.
3. **Bind-mount quirks on Windows.** Unknown failure modes on older Docker Desktop; start simple, add conversion only when a user reports.
4. **Log volume.** Long-running services can emit MB of logs. `LogStream` virtualization + line cap handle this; measured via a test run that emits 100k lines.
5. **Secrets in logs.** `stdout` is shown verbatim. Not a regression vs. CLI; mention in docs.
6. **Process cleanup on editor crash.** Tempdir + container with `--rm` auto-clean; the `telo-run-<sessionId>` container name makes manual cleanup trivial (`docker ps -a --filter name=telo-run- -q | xargs docker rm -f`). On editor restart, a startup task can sweep leftover `telo-run-*` containers older than 1 hour. Out of v1 scope unless it proves a problem.

---

## What extending for a future adapter looks like

To confirm the design works for the remote service-API case without building it:

1. New files under `src/run/adapters/service-api/`: `adapter.ts`, `config-schema.ts`.
2. `configSchema` declares `{ url, apiKey, tlsInsecure? }` with `required: ["url", "apiKey"]`.
3. `validateConfig` returns `ConfigIssue`s when the URL is malformed beyond what `format: "uri"` catches (e.g. non-HTTPS in production mode).
4. `isAvailable(config)` does a `GET /health` with the API key.
   - Network failure → `{ status: "unavailable", message: "Service unreachable at <url>.", remediation: "Check VPN / service status." }`.
   - `401` → `{ status: "needs-setup", issues: [{ path: "/apiKey", message: "Token rejected." }] }`.
   - `200` → `{ status: "ready" }`.
5. `start()` tarballs the bundle, POSTs to `/runs`, opens a WebSocket stream, translates server events into `RunEvent`s.
6. `registry.register(new ServiceApiAdapter())` at startup.

Zero changes to `Editor.tsx`, `RunPanel`, `SettingsModal`, or the Run button. That is the test of the adapter boundary.
