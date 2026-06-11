# Unify the Docker & Kubernetes runner adapters via a runner-advertised capabilities document

## Goal

The telo editor hardcodes knowledge about specific runner backends: the
`docker-api` adapter knows about `image` / `pullPolicy` / `registryUrl`, and the
`k8s` adapter knows those fields are server-enforced. But both already speak the
identical `/v1` HTTP+SSE contract — the only real difference is which config
fields the user may edit.

Make **the runner the authority on its own config surface**. Each runner exposes
a `GET /v1/capabilities` discovery document carrying a JSON Schema for its
editable config. The editor collapses the two HTTP adapters into a single
generic **HTTP runner** adapter that renders whatever schema the runner
advertises — mirroring the rule that already governs the analyzer/editor:
*never hardcode knowledge about specific resource kinds* (here: runner
backends).

## Scope

- **In scope:** the two HTTP adapters — `docker-api` and `k8s`. They become one
  unified `http-runner` adapter.
- **Out of scope:** `tauri-docker` ("Local (docker)"). It drives Docker through
  Tauri `invoke()`, not the `/v1` HTTP contract, so it cannot serve a
  capabilities endpoint. It stays a separate adapter, untouched.

After this change the editor registers two **adapter types**: `tauri-docker`
(Tauri-only) and `http-runner` (replaces `docker-api` + `k8s`). On top of these
types the user manages a list of named **runner instances** they can add, edit,
remove, and switch between (see "Runner management").

## Adapters vs runners

The unification draws a clean line the current code lacks:

- **Adapter (type)** — a transport implementation registered in the registry.
  Two exist: `http-runner` (any `/v1` runner reachable by URL) and `tauri-docker`
  (local Docker via Tauri `invoke()`). Adapter types are code, not user data.
- **Runner (instance)** — a user-configured instance of an adapter type: a name,
  the adapter type it uses, and that adapter's config (e.g. an `http-runner`
  pointed at `https://runner.telo.run`). Runners are user data, persisted in
  settings. A user can have many `http-runner` instances (cloud, a local
  `:8061`, a remote k8s) and switch between them.

## The capabilities document

```
GET /v1/capabilities →
{
  displayName: string,            // e.g. "Docker runner" / "Kubernetes runner"
  description: string,
  config: { schema: JSONSchema7 },// editable config surface; each property
                                  // carries its own `default` (no separate
                                  // defaults object — JSON Schema owns defaults)
  features: { io: boolean, ports: boolean }
}
```

- **Defaults live in the schema.** Every property's `default` is the seed value;
  the editor builds the initial config by walking `schema.properties[*].default`.
  No second source of truth.
- **`baseUrl` is NOT in the advertised schema.** It is the one field the runner
  cannot describe (you need the URL to reach the runner). It stays a static,
  client-owned field with its env-var default. The editor merges: static
  `baseUrl` field + dynamically-fetched server schema.
- **What each runner advertises:**
  - docker-runner → `{ image, pullPolicy, registryUrl }`, all editable, with
    their defaults (`image: telorun/node:0-slim`, `pullPolicy: missing`).
  - k8s-runner → the same `image` / `pullPolicy` properties but marked
    `readOnly: true` (with their server-enforced defaults), so the form renders
    them disabled. `registryUrl` is omitted. The user edits only `baseUrl`.

## Wire `config` shape

The schema describes the **full** wire shape; server-enforced fields are
`readOnly`. The `SessionConfig` wire contract (`{ image, pullPolicy,
registryUrl? }`, with `image`/`pullPolicy` **required** in the probe + sessions
body schemas) is unchanged — the editor always sends a complete `SessionConfig`,
filling read-only fields from the schema's advertised `default`s. A runner that
locks a field (k8s `image`/`pullPolicy`) advertises it `readOnly: true` with the
enforced value as its `default`; the form shows it disabled and still sends it.
This keeps the probe/sessions body schemas as-is — no loosening of `required`.

## Changes by package

### `packages/runner-core`
- Add `contract.ts` types: `RunnerCapabilities`, `RunnerFeatures`.
- Add `routes/capabilities.ts`: `GET /v1/capabilities`. The route is generic —
  it returns a `RunnerCapabilities` value the concrete runner supplies (so the
  document is backend-authored, not core-authored).
- Wire it in `server.ts` (`app.register(capabilitiesRoute(...))`) and pass the
  capabilities value through `ServerDeps` (each runner provides its own).
- Export the new route + types from `index.ts`.
- The probe + sessions body schemas are unchanged (`image`/`pullPolicy` stay
  required) — the editor always sends a complete `SessionConfig`.

### `apps/docker-runner` & `apps/k8s-runner`
- Each supplies its `RunnerCapabilities` document to `buildServer`
  (`displayName`, `description`, `config.schema`, `features`).
- docker-runner advertises `{ image, pullPolicy, registryUrl }`, all editable,
  with defaults.
- k8s-runner advertises `image`/`pullPolicy` as `readOnly: true` with the
  server-enforced values as their `default`s (the values it currently hardcodes
  in the client-side `K8S_REQUEST_CONFIG`, which moves server-side as the
  advertised defaults).

### `apps/telo-editor`
- **Delete** `adapters/docker-api/` and `adapters/k8s/`.
- **Add** `adapters/http-runner/` as the unified adapter built on the existing
  `createHttpRunnerAdapter` factory, with `id: "http-runner"`, a static
  `baseUrl`-only bootstrap schema, and a `defaultConfig.baseUrl` of
  `https://runner.telo.run` (the hosted Telo Cloud runner), overridable via
  `VITE_TELO_RUNNER_URL` (see env note).
- **Dynamic schema.** `RunAdapter.configSchema` is consumed synchronously in
  three places (`AdapterConfigForm.tsx:25,30`, `RunSettingsSection.tsx`,
  `Editor.tsx`). Extend the adapter contract so the schema can be fetched per
  `baseUrl`: add `fetchCapabilities(config): Promise<RunnerCapabilities | null>`
  to `RunAdapter` (optional; only the http-runner implements it). The config
  form fetches capabilities when `baseUrl` becomes reachable, merges the static
  `baseUrl` field with `capabilities.config.schema`, and re-renders. The
  existing `Recheck` flow in `RunSettingsSection` is the natural trigger point.
- The adapter's `displayName` / `description` become dynamic: fall back to a
  generic "HTTP runner" until capabilities load, then show what the runner
  advertised.
- `buildRequestConfig` becomes a pass-through of the schema-driven values
  (minus `baseUrl`), instead of the per-backend hardcoded shapes.
- **`readOnly` support.** `ResourceSchemaForm` does not currently honor JSON
  Schema `readOnly` on data fields (only `cel-field-wrapper` uses `readOnly`, for
  an unrelated reason). Option 2 needs read-only fields rendered disabled, so add
  `readOnly` handling to the scalar field controls (`scalar-field.tsx` et al.) —
  disabled input, value still present in the emitted config.
- Update `setupAdapters()` in `run/index.ts` to register the `httpRunnerAdapter`
  type instead of `dockerApiAdapter` + `k8sAdapter` (the registry holds adapter
  *types*; runner *instances* live in settings — see "Runner management").
- Settings model + runner-manager UI + run-flow resolution + migration — see the
  dedicated "Runner management" section. Touches `model.ts`, `SettingsModal.tsx`,
  `RunSettingsSection.tsx`, and `Editor.tsx`'s run path.
- Rename the misnamed `makeDockerApiIo` (`adapters/http-runner/io-client.ts`) to
  a backend-neutral name (e.g. `makeHttpRunnerIo`) and update the call site in
  `factory.ts:163`.

### Graceful fallback (older runners)
A runner without `/v1/capabilities` (older version, or a non-conforming proxy)
must not break the editor. When the fetch 404s or fails, the form shows the
bare `baseUrl`-only schema — the user can still point at and start the runner;
they just don't get advertised editable fields. Surface the missing-capabilities
state, don't swallow it (a subtle "advanced fields unavailable" note).

## `VITE_TELO_*` env (already implemented — consolidate)

Both env vars exist today:
- `VITE_TELO_RUNNER_URL` → docker-api default (`http://localhost:8061`).
- `VITE_TELO_K8S_RUNNER_URL` → k8s default (`http://localhost:8062`).

The unified adapter has a single `baseUrl` default of `https://runner.telo.run`
(the hosted Telo Cloud runner), overridable via **`VITE_TELO_RUNNER_URL`** (keep
the primary name). `VITE_TELO_K8S_RUNNER_URL` becomes redundant and is retired.
No new env plumbing is required — the existing `import.meta.env` read pattern
moves into `adapters/http-runner/config-schema.ts`, with the localhost default
swapped for the cloud URL.

## Runner management (add / edit / remove / switch)

Today settings hold a single `activeRunAdapterId` plus one config per adapter id
(`model.ts:17-18`). Replace that one-per-type model with a managed list of runner
instances.

### Data model (`model.ts`)
```ts
export interface RunnerInstance {
  id: string;        // stable generated id (uuid)
  name: string;      // user-editable label, e.g. "Telo Cloud", "Local docker"
  adapterId: string; // which adapter type: "http-runner" | "tauri-docker"
  config: unknown;   // that adapter's opaque config (baseUrl, …)
  builtIn?: boolean; // seeded, non-removable (see below)
}

interface AppSettings {
  // replaces activeRunAdapterId + runAdapterConfig:
  runners: RunnerInstance[];
  activeRunnerId: string;
}
```
The adapter registry stays the registry of *types*; a runner resolves its adapter
via `registry.get(runner.adapterId)` and feeds `runner.config` to it. The
capabilities document supplies each runner's `displayName`/`description` for
display; `name` is the user's own label (defaults to the advertised `displayName`
on add). `activeRunnerId` is a single **global** selection — the one runner the
Run button uses across all manifests.

### Seeded / built-in runners
`DEFAULT_SETTINGS.runners` seeds:
- **Telo Cloud** — an `http-runner` at `https://runner.telo.run`. Removable.
- **Local (docker)** — the `tauri-docker` instance, present only under Tauri.
  Marked `builtIn` and non-duplicable (a local Docker singleton — you can't have
  two), but the user may keep or ignore it.

At least one runner must always exist and one must be active: removing the active
runner re-points `activeRunnerId` to another; the last runner can't be removed.

### UI (`RunSettingsSection` → runner manager)
Rework the section from "radio list of adapter types" into a runner list:
- Each row: name, advertised status badge (existing probe flow per runner),
  select-as-active radio, and **Edit** / **Remove** controls (Remove hidden for
  `builtIn` and for the last/active-only runner).
- **Add runner** button → a small form: name + `http-runner` config (`baseUrl`,
  then the dynamically-fetched capability fields). Adapter type is implicitly
  `http-runner` (the only user-addable type today); if a second addable type
  appears, this grows a type picker. `tauri-docker` is never user-added — it's
  the seeded local entry.
- **Edit** reuses the same form against an existing instance.
- New Radix dialog/popover for the add/edit form (UI primitives via `radix-ui`,
  icons from `lucide-react`, per repo rules).

### Run flow (`Editor.tsx:317`)
Resolve `settings.runners.find(r => r.id === settings.activeRunnerId)`, then its
adapter + `runner.config`, instead of `registry.get(activeRunAdapterId)` +
`runAdapterConfig[id]`. The not-registered / not-configured fallbacks stay.

## Persistence / migration

The settings shape changes (`runAdapterConfig` + `activeRunAdapterId` →
`runners[]` + `activeRunnerId`), so add a one-time migration:
- Build `runners[]` from existing `runAdapterConfig` entries — an old
  `docker-api` or `k8s` config becomes an `http-runner` instance (named after the
  old adapter) carrying its `baseUrl`; a `tauri-docker` config becomes the local
  built-in.
- Always ensure the seeded **Telo Cloud** + (under Tauri) **Local** runners exist.
- Map the old `activeRunAdapterId` onto the migrated instance's id.

A missing/legacy key falls back to the seeded defaults (mirrors the existing
"fall back to `defaultConfig`" safety), so a partial migration never leaves the
Run button without a runner.

## Testing
- `runner-core`: route test for `GET /v1/capabilities` returning the supplied
  document.
- docker-runner / k8s-runner: assert each serves its capabilities document, and
  that k8s advertises `image`/`pullPolicy` as `readOnly` with the enforced
  defaults.
- editor: the http-runner adapter renders `baseUrl` only before capabilities
  load, expands after, and falls back cleanly on a 404.
- editor runner management: add / edit / remove / switch runners; the active
  runner drives the Run button; can't remove the last/active-only runner;
  settings migration maps old `runAdapterConfig` + `activeRunAdapterId` onto
  `runners[]` + `activeRunnerId`.

## Docs & versioning
- Update `apps/k8s-runner/README.md`, docker-runner README, and any runner
  contract docs to describe `/v1/capabilities`.
- Changeset for the affected `@telorun/*` packages (`runner-core`,
  `telo-editor`, both runners).
