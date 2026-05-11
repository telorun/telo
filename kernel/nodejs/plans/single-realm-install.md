# Single-Realm Module Installation

## Problem

Controllers loaded from a foreign `node_modules` tree (e.g. host-mounted workspace inside the Docker image) imported a different copy of `@telorun/sdk` than the kernel itself. Class-identity-sensitive integrations broke — cel-js's `registerType("Stream", Stream)` didn't recognize `Stream` instances created by the foreign-realm controller, throwing `Unsupported type: Stream`.

Reproducer: `docker run -v $PWD:/srv -w /srv telorun/telo:nodejs ./examples/chat-console.yaml`.

## Architecture

**Today:** One install tree per kernel process, rooted at the entry manifest's directory. All controllers — registry, `file:`, and `local_path` — resolve through the same hoisted `node_modules`. The kernel's own `@telorun/sdk` is wired into the install via a `file:` dep pointing at the kernel's resolved package location (`createRequire(import.meta.url)` from kernel boot). npm/pnpm materialize `file:` deps as **symlinks**; Node's ESM resolver follows symlinks to the real path. The kernel and every controller therefore resolve `@telorun/sdk` to the *same realpath*, giving `Stream` (and any other class-identity-sensitive type) a single constructor across the process.

`overrides` + `pnpm.overrides` on the install root pin `@telorun/sdk` to that same `file:` resolution, so any nested controller asking for the SDK transitively lands on the same path.

### Realm-collapse scope

Only `@telorun/sdk` is `file:`-aliased today. The list lives in [`scripts/generate-runtime-deps.mjs`](../../../scripts/generate-runtime-deps.mjs) and ships with the kernel as `dist/generated/runtime-deps.json`. Other kernel-runtime libs (yaml, ajv, cel-js, …) are duplicated harmlessly when controllers pull them in transitively — none of them carry class-identity guarantees today. Add a name to the list when a new shared runtime symbol's `instanceof` or constructor identity matters across module boundaries; `@telorun/analyzer` is deliberately excluded because it has `workspace:*` deps the package manager can't resolve through a `file:` link in dev mode.

### Trade-offs

- **Per-manifest dedup, not per-PURL dedup.** Each manifest dir has its own `.telo/npm/`. On-disk overhead is mitigated by npm/pnpm's content-addressed store (the actual files are deduped at the store level even when manifest trees aren't), but resolve time and metadata overhead per first run is a real regression.
- **Cross-process contention is now global per manifest dir.** Two Telo processes against the same manifest (CLI + IDE, watch + run, parallel CI shards) would race on `npm install` into the same root and corrupt the tree. Mitigation is a **filesystem lock** on `<root>/.lock` (atomic `fs.open(path, 'wx')` with PID + start-time inside; stale-holder detection via `process.kill(pid, 0)`). Concurrent processes serialize naturally; the lock protocol is "acquire → check if desired state already present → install if not → release." Re-checking after acquiring the lock — by hashing the install-root `package.json` and inspecting `node_modules/<pkg>` — means peers wake up to find the work already done.
- **`local_path` semantics shift.** The qualifier is *preserved* — `pkg:npm/foo?local_path=./bar` continues to mean "use this local source for the controller package." What changes is that the loader installs it via `npm install file:<path>` into `.telo/npm/` rather than importing from `<path>` directly. Loses zero-second hot-reload of host edits; gains realm consistency. The same model applies to `pkg:cargo` when its `.telo/cargo/` slice lands.
- **Modules must ship a built `dist/` and declare a Bun/Node-conditional `exports` map.** With `npm install file:`, the package's `exports`/`main` is consulted directly. Modules that previously shipped only `src/*.ts` and relied on the loader's `src→dist` rewriter must produce a `dist/` and route Node imports through it. The Bun condition continues to point at `src/` so workspace dev still has zero-build hot-reload via Bun's TS support.
- **The runtime install root moves** from `~/.cache/telo/...` to `<entry-manifest-dir>/.telo/npm/`. Per-manifest scope, inspectable, gitignorable, no global cache contamination. The image's `/opt/telo` stays read-only. The legacy `~/.cache/telo/npm/` is no longer consulted; users may delete it by hand.
- **Runtime dependency on `npm` (or `pnpm`) in `PATH`.** First-run install shells out to the package manager. Default is `npm` (always present with Node); `TELO_PKG_MANAGER` overrides. The probe at first install fails with a clear remediation message rather than crashing inside `execFile`.

### `.telo/` is the shared per-manifest workspace

`<entry-manifest-dir>/.telo/` is the namespace for everything Telo materializes next to a manifest. Each runtime owns one subdirectory; this slice fills in `npm/`. Other loaders can land theirs without revisiting the convention.

```text
<entry-manifest-dir>/.telo/
  npm/                  # this slice — pkg:npm controllers + their deps
    package.json        # holds the kernel-side @telorun/sdk as file: dep + overrides
    .telo-state.json    # hash of the materialized package.json so re-runs short-circuit
    .lock               # cross-process install lock (atomic fs.open, PID + ts inside)
    node_modules/
  cargo/                # future home for pkg:cargo controllers
  golang/               # future home for pkg:golang controllers
  debug/events.jsonl    # replaces today's ./.telo-debug/events.jsonl
  snapshots/            # --snapshot-on-exit output
```

Contract between loaders: each gets one subdir under `.telo/` named after its runtime (PURL-type), and manages its own internal layout. No cross-runtime coupling. Cleanup of `debug/` and `snapshots/` is a follow-up; the directory convention lands here so later moves are mechanical.

## Implementation map

- [`kernel/nodejs/src/controller-loaders/npm-loader.ts`](../src/controller-loaders/npm-loader.ts) — single-root install, fs-lock, file:-alias for `@telorun/sdk`, override pinning.
- [`kernel/nodejs/src/controller-loader.ts`](../src/controller-loader.ts) — `ControllerLoaderOptions.entryUrl` plumbed through to npm-loader.
- [`kernel/nodejs/src/kernel.ts`](../src/kernel.ts) — `Kernel.load(url)` records the entry URL; `getEntryUrl()` exposed via `ResourceContext`.
- [`kernel/nodejs/src/resource-context.ts`](../src/resource-context.ts) and [`sdk/nodejs/src/resource-context.ts`](../../../sdk/nodejs/src/resource-context.ts) — new `getEntryUrl()` method.
- [`kernel/nodejs/src/controllers/resource-definition/resource-definition-controller.ts`](../src/controllers/resource-definition/resource-definition-controller.ts) — passes entry URL to `ControllerLoader`.
- [`cli/nodejs/src/commands/install.ts`](../../../cli/nodejs/src/commands/install.ts) — passes entry URL when running `telo install`.
- [`scripts/generate-runtime-deps.mjs`](../../../scripts/generate-runtime-deps.mjs) — emits `dist/generated/runtime-deps.json` (the realm-collapse name list).
- [`scripts/prepack-bake-overrides.mjs`](../../../scripts/prepack-bake-overrides.mjs) — published-tarball `overrides`/`pnpm.overrides` belt-and-braces; chains into the runtime-deps regeneration.
- [`kernel/nodejs/package.json`](../package.json), [`cli/nodejs/package.json`](../../../cli/nodejs/package.json) — `build` invokes the runtime-deps generator; `prepack` invokes the override-baker.
- [`modules/assert/nodejs/package.json`](../../../modules/assert/nodejs/package.json) — exports map gains the Bun/Node conditional split (was a pre-existing bug masked by the old loader's `src→dist` rewrite).

## Testing

- **Realm identity, not version equality.** [`kernel/nodejs/tests/npm-loader-realm-identity.test.ts`](../tests/npm-loader-realm-identity.test.ts) loads a controller into a temp install root, then asserts the install-root SDK realpath equals the kernel-side SDK realpath. Path-based equality is the test signal; constructor identity is implied once the realpaths match because Node's ESM resolver caches by realpath. (npm's `file:` install behaviour — symlink vs. copy — varies across versions; the test does not assume one or the other, only that whichever the package manager picked was applied consistently.)
- **End-to-end**: `examples/chat-console.yaml` under `docker run -v ...` streams a response (the original failing scenario).
- **Override-baker**: [`kernel/nodejs/tests/prepack-bake-overrides.test.ts`](../tests/prepack-bake-overrides.test.ts) verifies the script rejects `workspace:` leftovers, writes both `overrides` and `pnpm.overrides`, and chains the runtime-deps regeneration.
- **Workspace dev (`pnpm run telo`)**: existing `pnpm run test:node` passes against the materialized `.telo/npm/` next to each test fixture.

## Out of Scope

- `peerDependencies` migration of module packages — not required; consumer-side `overrides` is sufficient.
- `apps/docker-runner` bundling refactor — picks up the fix automatically.
- Pre-warming `.telo/npm/` at install time — possible perf follow-up; correctness doesn't depend on it.
