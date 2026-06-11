# K8s runner: session progress reporting + import-keyed builds

## Goal

Two related refinements to how the k8s runner runs a session and reports it to the
telo editor:

1. **Explicit progress + spinner.** Today a session sits on `starting` with no
   signal through the docker build and the pod/kernel bootstrap, then either
   flips to `running` or throws. Surface what's happening (build, provision,
   boot) as a live feed with a spinner while the session is coming up.

2. **Rebuild only when deps change.** Today the per-app image is content-tagged
   on the whole bundle ([`image-build.ts:33-47`](../src/k8s/image-build.ts)), so
   any manifest/CEL edit triggers a fresh on-cluster Kaniko build. The image's
   *expensive* content — resolved module manifests + installed npm controllers —
   depends only on the **dependency closure** (the `imports:` set **plus** any
   controllers declared by inline `Telo.Definition` docs), not on resource bodies
   or CEL. Key the image on that closure and deliver the body to the pod at
   runtime, so body-only edits skip the build.

## Outcome

- Editing a resource body / CEL with unchanged imports **and** controllers →
  **no build**; the pod reuses the existing image and validates the new body
  in-memory at boot.
- Editing `imports:` → image rebuilds (Kaniko), as today.
- The editor shows a step feed + spinner covering build (incl. "cached — no
  build"), pod provisioning, and kernel boot, instead of a dead `starting` pause.
- `readOnlyRootFilesystem: true` and all current pod hardening are unchanged.

---

## Part 1 — Reporting contract: `progress` events + spinner

The status enum stays coarse; granularity rides an **additive** event so the
docker backend, SSE replay, and editor stay backward-compatible.

### Contract (`packages/runner-core/src/contract.ts`)

Add to `RunEvent`:

```ts
| { type: "progress"; phase: "build" | "provision" | "boot"; message: string; done?: boolean }
```

`RunStatus` is untouched. The server SSE channel already forwards
`event: ${event.type}` verbatim ([channel.ts:139,151](../../../packages/runner-core/src/sse/channel.ts#L139)),
so no server-side change is needed. **But the editor SSE client silently drops
unknown types**: [sse-client.ts:79-82](../../../apps/telo-editor/src/run/adapters/http-runner/sse-client.ts#L79-L82)
registers `addEventListener` per type and [sse-client.ts:109-112](../../../apps/telo-editor/src/run/adapters/http-runner/sse-client.ts#L109-L112)
gates on a hardcoded `isRunEvent` allow-list of `stdout|stderr|status`. Both must
gain `progress`, or the frame never reaches `context.tsx`. Mirror the type in the
editor's `run/types`.

### k8s backend emission (`apps/k8s-runner/src/k8s/backend.ts`)

Thread an `onProgress(phase, message, done?)` callback alongside `onStatus`
(plumbed from the session route the same way `onStatus` is). Emit:

- **build** — around `ensureSessionImage()`: `cache hit → "Using cached image"`;
  otherwise `queued → building → pushing → done (Ns)`. (Milestones only this
  pass; streaming Kaniko pod logs is a deliberate follow-up — see Non-goals.)
- **provision** — from the pod watch (`handlePhase`): read the session
  container's `state.waiting.reason` (`ContainerCreating`, `ImagePull*`,
  scheduling) and emit a message per transition until pod phase `Running`.
- **boot** — once pod phase `Running`: `"booting"` until the kernel signals ready
  (Part 1a). The in-memory validation pass (Part 3) happens here, on the pod's
  start path.

### Part 1a — Stream early so progress is live; flip `running` on pod `Running`

`backend.start()` now spans the image build + pod bring-up. The session route
therefore returns `201` + `streamUrl` **before** running `start()` in the
background, so the client connects and sees build/provision progress live instead
of blocking on "Starting run…" until the workload is up. A start failure (the
build, the pod) surfaces as a terminal `failed` status on the stream (the registry
schedules eviction on a terminal status), not an HTTP error.

The session flips to `running` when the Pod reaches `Running` — deterministic and
independent of the session image's `telo` version. A kernel-readiness signal was
considered (touch a file → readinessProbe → Pod `Ready` condition) to keep the
spinner through post-`Running` validation and avoid a rare `running → failed`
flicker, but it couples the flip to the in-image CLI: a base image whose `telo`
predates the signal would never flip and the session would hang in `starting`.
Not worth the coupling — the slow part (build/provision) is already covered by the
live stream; the brief post-`Running` validation runs while already `running`.

### Editor (`apps/telo-editor/src/run/`)

- `sse-client.ts`: add `progress` to `isRunEvent` and register
  `addEventListener("progress", …)` / `removeEventListener` (Part 1 above).
- `context.tsx`: handle `progress` events — keep a small `progress` list (or
  latest message) on the run record; ignore once status is terminal/`running`.
- `RunView` / `RunStatusChip`: render a `lucide-react` `Loader2` spinner while
  status is non-terminal and not yet `running`, with the latest progress message
  beside it. Spinner stops at `running`/terminal. No inline SVGs.

---

## Part 2 — Import-keyed image + runtime body delivery

### Image tag keyed on the dependency closure (`apps/k8s-runner/src/k8s/image-build.ts`)

`computeImageTag` hashes the **dependency closure** instead of every bundle file.
The closure is *not* just `imports:` — `telo install` installs `controllers:` from
**every** `Telo.Definition` in the flattened manifest set, including inline
Definitions in the entry Application body ([install.ts:32-56](../../../cli/nodejs/src/commands/install.ts#L32-L56)).
Keying on imports alone would reuse an image whose `/telo-cache/npm` lacks a
body-added controller → with `--no-cache-write` + no-network, `telo run` fails.

So the tag inputs are: `baseImage` + `teloRegistryUrl` + sorted `imports:` sources
+ sorted controller locators (`controllers` PURLs and any `local_path` + its
referenced source bytes) from all body `Telo.Definition` docs. CEL / resource-body
edits still hit the cache; adding or changing an import **or** a controller busts
it.

**Where / when it's computed — in the runner, no archive unpack.** The key runs
exactly where `computeImageTag` runs today — inside `ensureSessionImage`, from the
**in-memory** `bundle.files` strings the `/v1/sessions` request already carries
([contract.ts:31-34](../../../packages/runner-core/src/contract.ts#L31-L34)). The
tarball staging (`stageBuildContext`) happens **only on a cache miss**, after the
key has decided a build is needed — never on a cache hit. So computing the key
costs one shallow YAML parse of a few small docs: no network, no graph resolution
(exact import versions pin the closure), no unpack.

- **Not the editor.** Image tagging is Kaniko/registry-specific and
  runner-internal; the docker backend doesn't tag the same way. `StartSessionRequest`
  is backend-neutral, so the editor sends the same bundle to both — it must not
  learn a backend's tag format.
- **Not hand-rolled.** Extract via a shared static helper
  `extractDependencyKey(bundle) → { importSources, controllerLocators }` in
  `runner-core` (or a shared loader util), reusing telo's notion of where imports
  and controllers live (imports desugaring, multi-doc files, partial `include`s
  that can't hold Definitions) **without** a graph load — so the runner stays in
  sync with the loader rather than drifting.

### Build: relocate the baked cache with `TELO_CACHE_DIR`

`telo install` runs **exactly as today** (same command) — full `.telo` baked:
manifests, npm, warm validators + stamp. The only Dockerfile change
([`buildDockerfile`](../src/k8s/image-build.ts)) is pointing the cache root at a
fixed path via the reintroduced `TELO_CACHE_DIR` (Part 2a), so the deps don't
land next to the baked body and aren't shadowed by the runtime body mount:

```dockerfile
FROM <baseImage>
WORKDIR /app
COPY . /app
ARG TELO_REGISTRY_URL
ENV TELO_REGISTRY_URL=$TELO_REGISTRY_URL
ENV TELO_CACHE_DIR=/telo-cache
RUN telo install /app/<entry>
```

Deps bake at `/telo-cache/{manifests,npm}`; the body at `/app` is disposable —
whatever first built the image for that imports-set. The real body arrives at boot.

### Runtime body delivery (`pod-spec.ts`, `bundle-store.ts`, `backend.ts`)

- Stage the session bundle behind a tokenized URL (reuse the build-context
  mechanism in `bundle-store.ts`; add `stageSessionBundle`).
- Add an init container to the session pod (reusing `config.initImage`, wget+tar)
  that fetches the bundle into a writable `/app` emptyDir.
- Set `TELO_CACHE_DIR=/telo-cache` (the baked, read-only deps) and run
  `telo run /app/<entry> --no-cache-write` (Part 3), `workingDir` stays `/work`.
  No symlink, no dir rename — the body sits at `/app`, telo reads deps from
  `/telo-cache`.
- Repoint `HOME` / `npm_config_cache` at a **separate** writable emptyDir: today
  both ride on `/telo-cache` ([`pod-spec.ts:50-52`](../src/k8s/pod-spec.ts)), which
  now holds read-only baked deps.

telo reuses any baked validator whose schema is unchanged and re-derives the rest
in-memory; `--no-cache-write` guarantees nothing is written to the read-only
`/telo-cache`.

### Part 2a — Reintroduce `TELO_CACHE_DIR`, resolved once and threaded

The `.telo` root is currently re-derived from the entry dir in several places —
`resolveEntryDir` for the validator cache ([kernel.ts:329-334](../../../kernel/nodejs/src/kernel.ts#L329-L334))
and the analysis stamp, `LocalManifestCacheSource`, and `computeInstallRoot`
([npm-loader.ts:698-707](../../../kernel/nodejs/src/controller-loaders/npm-loader.ts#L698-L707)) —
and [pod-spec.ts:50](../src/k8s/pod-spec.ts) still exports a `TELO_CACHE_DIR` that
**nothing reads**. Reintroduce it, but **resolve it once and pass the value down**;
no consumer reads the env or calls `resolveEntryDir` independently.

- Add `resolveCacheRoot(entryUrl)` → the `.telo` root: `process.env.TELO_CACHE_DIR`
  if set, else `<entryDir>/.telo` (null for memory/http entries that skip the disk
  cache).
- Resolve it **at the outermost load entry only** and thread it as a plain value:
  - `Kernel.load(url, { …, cacheDir? })` — if `cacheDir` is passed the kernel reads
    no env; otherwise it resolves once and stores `this._cacheRoot`.
  - Pass that single value to every consumer, replacing each site's own
    `resolveEntryDir`/env read: schema validator
    (`setCacheDir(join(root, "manifests/__validators"))`), analysis stamp
    (`join(root, "manifests")`), and the controller loader's npm install root
    (`join(root, "npm")`).
  - The CLI (`run`/`install`) resolves once via the same helper and passes it as
    `cacheDir` to both `kernel.load` and `LocalManifestCacheSource` /
    `writeManifestCache`, so the env is read exactly once per invocation.
- `TELO_NPM_CACHE_DIR` / `XDG_CACHE_HOME` (the *remote download* cache for http
  entries) are a different layer and unaffected.

---

## Part 3 — `--no-cache-write` (read-only cache)

A kernel `LoadOption` (`writeCache: false`) exposed as `telo run --no-cache-write`.
Semantics: **read the cache normally, never persist new derived entries.** The
import tier (manifests + npm) and any matching baked validators/stamp are served
from disk; anything uncached is compiled/validated in-memory; validation errors
surface normally (nothing swallowed). Not `--no-cache` — the cache is fully used,
only writes are suppressed.

Two write sites to gate (reads stay):

- **Validator disk cache** (`kernel/nodejs/src/schema-validator.ts`): keep
  `cacheDir` set so `compileAjvOrLoadCached` still *reads* `<hash>.cjs`; gate the
  *write* block on a new `cacheWritable` flag (e.g. `setCacheDir(dir, { write })`).
- **Analysis stamp** (`kernel/nodejs/src/manifest-sources/analysis-stamp.ts`,
  wired in `kernel.ts`): still read + compare the baked stamp (mismatch → revalidate),
  but skip writing the new stamp when `writeCache` is false.

CLI wiring in `cli/nodejs/src/commands/run.ts`: parse `--no-cache-write` →
`writeCache: false` in the `kernel.load` options.

---

## Phases shown to the user (end to end)

```
build      ⠋ Using cached image            (or: Building image… → Pushing… → done 38s)
provision  ⠙ Scheduling → Pulling image → Creating container
boot       ⠸ Booting
running    ● Running
```

---

## Files touched

- `packages/runner-core/src/contract.ts` — `RunEvent.progress`
- `packages/runner-core/src/routes/sessions.ts` — plumb `onProgress`
- `packages/runner-core/src/` — shared static `extractDependencyKey(bundle)` helper
- `apps/k8s-runner/src/k8s/backend.ts` — emit build/provision/boot progress; gate `running` flip on the readiness marker
- `apps/k8s-runner/src/k8s/image-build.ts` — dependency-closure tag (imports + body controllers), `ENV TELO_CACHE_DIR` in Dockerfile
- `apps/k8s-runner/src/k8s/pod-spec.ts` — body-delivery init container, `TELO_CACHE_DIR=/telo-cache`, repoint HOME/npm scratch, run flag
- `apps/k8s-runner/src/bundle-store.ts` — `stageSessionBundle`
- `kernel/nodejs/src/manifest-sources/local-manifest-cache-source.ts` — `resolveCacheRoot` helper; accept cache root
- `kernel/nodejs/src/kernel.ts` — resolve cache root once, thread to validator/stamp/npm; `cacheDir` + `writeCache` load options
- `kernel/nodejs/src/controller-loaders/npm-loader.ts` — take threaded install root instead of recomputing
- `kernel/nodejs/src/schema-validator.ts` — read-only cache mode (`writeCache`)
- `kernel/nodejs/src/manifest-sources/analysis-stamp.ts` — gate stamp write on `writeCache`
- `cli/nodejs/src/commands/{run,install}.ts` — resolve cache root once, pass `cacheDir`; `run` adds `--no-cache-write` and emits the readiness marker after `kernel.load` resolves
- `apps/telo-editor/src/run/adapters/http-runner/sse-client.ts` — allow + listen for `progress`
- `apps/telo-editor/src/run/types.ts` — `progress` variant
- `apps/telo-editor/src/run/context.tsx` — handle `progress`
- `apps/telo-editor/src/run/ui/{RunView,RunStatusChip}.tsx` — spinner + message

## Non-goals (follow-ups)

- Streaming raw Kaniko build logs into the feed (milestones only here).
- Persisting the boot-time warm cache across pods (content-addressed shared
  volume keyed by body-hash) to skip in-memory revalidation on repeat runs.

## Risks / checks

- **Dependency-closure hash completeness.** Must capture everything `telo install`
  installs — imports **and** body-declared `controllers`/`local_path`. Exact import
  versions pin the transitive manifest/controller closure (no graph load needed);
  confirm nothing else body-dependent reaches `/telo-cache` (partials can't hold
  Definitions or imports). `extractDependencyKey` must track the loader's discovery
  rules, not a parallel reimplementation that can drift.
- **Readiness marker.** Must be unambiguous on the merged PTY stream and never
  collide with app output (env-gated sentinel). Confirm `kernel.load` resolution is
  the right emit point for both one-shot Runnables and Services, and that a pod
  dying pre-marker reports `failed`/`exited` (not a `running` flicker).
- **Single cache-root resolution.** Verify `TELO_CACHE_DIR` is read exactly once
  per invocation and threaded — no lingering `resolveEntryDir`/env read in the
  validator, stamp, npm-loader, or CLI sites. Memory/http entries must still skip
  the disk cache (null root).
- **Read-only deps + npm resolution.** Verify Node resolves controllers from a
  `TELO_CACHE_DIR` that lives outside the entry dir, and that `--no-cache-write`
  guarantees zero writes under the read-only `/telo-cache` (extend the
  `analyze-only-warm` test: chmod the cache dir read-only and assert a clean
  `telo run`).
- **Boot latency.** Each fresh pod pays the in-memory validation walk for changed
  schemas — the visible `boot` phase. Confirm it's acceptable for large manifests.

## Versioning & docs

- Changesets for every touched `@telorun/*` package (`runner-core`, `kernel`,
  `cli`, editor app if published).
- `--no-cache-write` documented in the CLI `run` docs; the k8s runner's
  build/runtime model and progress contract documented under
  `apps/k8s-runner/docs/` (wire new pages into `pages/docusaurus.config.ts` +
  `pages/sidebars.ts`).
