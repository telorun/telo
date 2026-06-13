# `--inspect` endpoint + detached, on-demand debug UI

Split the `--debug` monolith into a headless inspection endpoint and an
on-demand UI, and drop `@telorun/debug-ui` from the CLI's production
dependencies so the published CLI stays small.

## Outcome

- `--debug` → JSONL file sink only (`.telo.debug.jsonl`). No network, no UI, no
  `@telorun/debug-ui` dependency.
- `--inspect[=[host:]port]` → live inspection endpoint (SSE + wire + blobs +
  `/json/version`), default `127.0.0.1:9230`, loopback-default with a warning on
  non-loopback binds.
- The UI is a client, fetched on demand and **served same-origin** from the
  inspect server. The CLI ships no UI bytes; the bundle is cached under the
  `.telo` cache root after first fetch.

## Flag model

| Flag | Effect |
|------|--------|
| `--debug` | JSONL sink only. |
| `--inspect[=[host:]port]` | Start the endpoint. Implies the event tap. Prints endpoint URL. Loopback default; warn on public bind. |
| `--no-open` | With `--inspect` in a TTY, suppress auto fetch+serve+open of the UI. |

`--debug` and `--inspect` compose (file sink + live endpoint together). The event
tap (`kernel.on("*")`) is shared; today's `DebugSession` already centralizes it.

## UI delivery (Option B — cached, single-file)

- `debug-ui` emits a **single self-contained `index.html`** (inlined JS/CSS via
  `vite-plugin-singlefile`) as a second build output, alongside the existing
  `app-dist/` and the `./components` library export (editor keeps importing that
  unchanged). It **ships in the package `files`** so npm hosts it. One file ⇒ no
  tar/unzip, no runtime archive deps.
- **npm is the host, jsDelivr is the transport.** `npm publish` of `debug-ui` is
  the publish step — no separate hosting. The CLI fetches the single file from
  `https://cdn.jsdelivr.net/npm/@telorun/debug-ui@<version>/app-single/index.html`
  (immutable versioned URL, one `fetch()`). The CLI downloads it **server-side and
  serves it same-origin** — jsDelivr only ever talks to the CLI process, so the
  same-origin/no-secret-leak posture holds.
- **Version mapping is automatic.** `@telorun/debug-ui` stays a CLI `devDependency`
  at `workspace:*`; `pnpm publish` rewrites it to the exact version in the shipped
  `cli/package.json`. At runtime the CLI reads its own `package.json` →
  `devDependencies["@telorun/debug-ui"]` → uses that version in the jsDelivr URL.
  Always in sync with what the CLI was built against; no constant to bump.
- `resolveUiBundle(cacheRoot)` resolves the UI through a chain, first hit wins, so
  local dev never touches the network:
  1. `TELO_DEBUG_UI_PATH` env override → serve that file (arbitrary build escape hatch).
  2. Workspace devDep resolve (`require.resolve("@telorun/debug-ui")`) → present in
     the monorepo, absent in a production install → serve its built single file.
  3. Cache `<cacheRoot>/debug-ui/<version>/index.html` (version from own package.json).
  4. Fetch the jsDelivr URL → write to cache → serve.
  5. None resolved → headless fallback (endpoint works, UI absent).
- The monorepo dev loop stops at step 2 (offline, current code); an end user hits
  3/4. Same prerequisite as today: `debug-ui` must be built first
  (`pnpm --filter @telorun/debug-ui build`, or `vite build --watch`).
- The UI is always served same-origin by the inspect server, so `App.tsx`'s
  existing `/events` resolution is sufficient — no endpoint configuration needed.
  (A `?endpoint=` param for remote/hosted use is a trivial later add if wanted.)

## Work breakdown

1. **debug-ui build** — add the single-file output (`vite-plugin-singlefile` or a
   second config) to `app-single/index.html`; keep `app-dist/` and `./components`.
   Add `app-single/**` to the package `files` so npm hosts it.
2. **CLI deps** — move `@telorun/debug-ui` from `dependencies` to
   `devDependencies` in `cli/nodejs/package.json` (production installs strip it;
   the monorepo still resolves it for local UI testing). Editor retains its own dep.
3. **`ui-fetch.ts`** (CLI) — `resolveUiBundle(cacheRoot)`: the resolution chain
   above (`TELO_DEBUG_UI_PATH` → devDep resolve → cache → jsDelivr fetch-on-miss →
   null). Reads the pinned UI version from the CLI's own `package.json`. Returns the
   file path or null on failure-without-cache. jsDelivr base overridable via env.
4. **`DebugServer`** — replace `resolveAppDist()` (which resolves the npm package)
   with serving the resolved single file; add `/json/version` (protocol/wire
   version, kernel id, blob base) for client handshake.
5. **CLI flags** — add `--inspect[=[host:]port]` parsing (host:port split, default
   `127.0.0.1:9230`), redefine `--debug` as JSONL-only, add `--no-open`; update
   `knownBooleanFlags`/`knownValuedFlags` and `RunArgv`. Refactor `startDebugSession`
   into an endpoint session (inspect) + file sink (debug) that compose.
6. **Security** — loopback default; warn loudly on non-loopback bind.
7. **Docs + changesets** — `@telorun/cli` and `@telorun/debug-ui` changesets;
   update CLI/debug docs for the new flags and the on-demand UI.
