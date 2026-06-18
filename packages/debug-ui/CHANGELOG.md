# @telorun/debug-ui

## 0.4.0

### Minor Changes

- a8c99ab: Generic dispatch tracing: trace every capability dispatch (invoke and run) through one instrumented chokepoint and carry trace data in a structured event payload instead of the event name.

  - Dispatch events drop the kind from the name (`<name>.Invoked` / `.Run`, plus error/cancel variants). The payload now carries `{ spanId, parentSpanId, capability, phase, outcome, ref: { kind, name }, … }`; consumers read the payload and never parse the dotted name. Lifecycle events (`Kind.name.Created` / `.Initialized` / `.Teardown`) are unchanged.
  - `run()` is now span-instrumented like `invoke()`: it mints and propagates a trace id, so Runnables (e.g. a `Run.Sequence` boot target) appear in the trace and their nested invokes re-parent correctly instead of detaching as false roots. Long-lived Services emit a `<name>.Running` start span. Run failures emit `<name>.RunFailed` (rethrown, never swallowed).
  - Invoke/run emit a `<name>.Invoking` / `.Running` start span when tracing is on.
  - SDK: new `REF_IDENTITY` / `stampRefIdentity` / `getRefIdentity`. The kernel stamps a resolved `!ref`'s kind+name onto the injected instance so `executeInvokeStep` routes pre-injected live instances through the traced chokepoint instead of calling `.invoke()` directly and escaping instrumentation.
  - The boot `targets` run is wrapped in an application span (`<appName>.Run`, `ref.kind: "Telo.Application"`), so the application is the trace root with its targets nested beneath. Pre-resolved `!ref` boot targets now dispatch through a new `EvaluationContext.runResolved` (the `run()` analog of `invokeResolved`) instead of calling `instance.run()` directly, so they emit their own run spans nested under the app.
  - A `Telo.Service`'s long-lived `run()` no longer establishes the cancellation/trace ALS scope (its token is delivered via the explicit `run(invokeCtx)` argument instead). This stops the boot scope leaking onto async resources the service creates — e.g. an HTTP server's socket — so inbound work (each request) starts as its own root trace with no inherited boot cancellation token, instead of nesting under the bootstrap trace. Runnables keep the ALS scope so their steps still nest and inherit cancellation.
  - `EventBus.emit` short-circuits in O(1) when there are no subscribers, keeping the always-through-the-chokepoint dispatch effectively free when nobody is listening.
  - OpenTelemetry-ready trace model: every span carries a `traceId` (OTel-compatible 16-byte hex), minted at the root and inherited by descendants, so an exporter groups a trace without walking the parent chain. New generic `ctx.openSpan(base, { ref, label, attributes, inbound? })` primitive opens an inbound-boundary span (capability `"request"`) that roots its own trace; `inbound` allows continuing an upstream distributed trace later. The `TracePayload` gains `traceId`, `label`, and `attributes`.
  - `http-server`: each inbound request opens a request span attributed to the `Http.Api` and labelled with the route (`"POST /feedback"`, attributes `{ method, path }`); the handler invoke and its subtree nest under it, as a trace separate from the bootstrap.
  - Trace context capture: a trace's root span carries `payload.context` — a redacted snapshot of the CEL root scope available to the trace (`variables`, `resources` snapshots, `ports`, and `secrets` with values masked to `"[secret]"`; host `env` omitted). Lets a debug consumer see what data an execution could reference beyond its own inputs/outputs. The UI renders it as an "Available context" section on the root node.

### Patch Changes

- Updated dependencies [a8c99ab]
  - @telorun/debug-wire@0.2.0

## 0.3.0

### Minor Changes

- b41012f: debug-ui: new **Graph** view — now the first tab, beside Events/Logs.

  - A left rail lists every traced **invocation** (root calls); selecting one scopes the canvas to just the resources that took part in that call, wired by the real parent→child **call edges**, each node showing its inputs → outputs.
  - With nothing selected, the canvas shows the live **resource topology**: nodes appear gray on `Created`, brighten on `Initialized`, and pulse on each invocation (tinted by outcome), with dependency wiring from the `Created` payload. A "Hide unconnected" toggle (on by default) drops resources with no dependency wiring.

  Adds the pure, framework-agnostic folds `deriveGraph` (topology), `deriveInvocations` + `traceSubgraph` (call traces, from event `metadata.invocationId` / `parentInvocationId`), and the `EventGraph` component (built on `@xyflow/react` + dagre).

## 0.2.1

### Patch Changes

- b1dd65c: Endpoint links now label from the endpoint's absolute `url` (its authority) when present, so the displayed text matches the link actually opened. Previously a proxy/ingress endpoint showed a `host:port` label whose host wasn't the routable one (and, for ingress, a port that isn't the externally served one).

## 0.2.0

### Minor Changes

- d59e847: Debug stream now carries **logs as well as events**, and the editor embeds the
  debug UI.

  - New `@telorun/debug-wire` package: the language-neutral frame contract shared
    by the producer, the runner, the editor, and the debug UI. A stream now carries
    two discriminated frame kinds on one channel — `kind: "event"` (kernel events)
    and `kind: "log"` (one stdout/stderr line). Browser-safe; `wire-schema.json` is
    the source of truth a non-TypeScript producer conforms to. `@telorun/debug-ui`
    re-exports its types.
  - `@telorun/cli`: `--inspect` / `--debug` now tee the run's stdout/stderr into the
    stream as `log` frames (the terminal is untouched; the tee is restored on stop).
    The inspect server adds permissive CORS so an embedding webview can read it.
  - `@telorun/debug-ui`: the watcher is now a **Logs / Events** tab split over one
    frame stream (`DebugPanel` + `LogView`); `DebugWatcher` wraps it for the
    standalone app. `connectDebugStream` delivers `DebugFrame`s routed by `kind`.
    Components take a `theme` prop (`"light" | "dark" | "system"`, default
    `"system"` — follows `prefers-color-scheme` live); `DebugPanel` also takes a
    `logsSlot` (an embedding host can render its own interactive terminal in the
    Logs tab) and a `defaultTab`. When **no** `theme` is supplied the panel owns
    its mode and shows a system/light/dark toggle in its header; when a host
    passes `theme`, the host owns it and the toggle is hidden.

  The editor (private) embeds `DebugPanel` in the run view's Debug tab: remote
  HTTP/k8s runners relay frames over the existing `/v1/sessions/:id/events`
  transport (the security/ingress boundary), while the local runner reads the
  workload's loopback `--inspect` port directly — both surface identical `debug`
  run events. Blob payloads aren't resolvable in the editor embed yet (the
  workload's blob endpoint isn't reachable from the editor); events and logs work.

- d59e847: Debug UI now links to the running application's exposed ports.

  - `@telorun/debug-ui`: `DebugPanel` takes an `endpoints` prop and renders each as
    a link in its header (tcp → clickable `http://host:port`, udp → plain label).
    New `AppEndpoint` type + `endpointHref` / `endpointLabel` helpers (browser-safe,
    no runner/kernel dependency). The standalone `DebugWatcher` sources endpoints
    from the producer's `/json/version` handshake, filling a blank host from the
    page origin so the link points where the viewer reached the server (localhost
    locally, the bound host remotely).
  - `@telorun/kernel`: new `Kernel.getResolvedPorts()` — the root Application's
    resolved `ports:` (integer + declared protocol per name), available after
    `load()`. Empty when the root declares no ports.
  - `@telorun/cli`: the `--inspect` server advertises the app's resolved ports as
    `appEndpoints` in its `/json/version` handshake. The UI now opens once the
    ports are known (deferred from server start to first load), so the discovery
    handshake already carries the endpoints.

  The editor (private) renders the same links inside `DebugPanel` from its resolved
  run endpoints, replacing the separate chips in the run-view header.

### Patch Changes

- Updated dependencies [d59e847]
  - @telorun/debug-wire@0.1.0

## 0.1.0

### Minor Changes

- 9ef48a6: Add a live debug-event inspection UI. `telo run --inspect` starts a
  localhost-only inspection endpoint and prints its URL — a single page that
  watches the kernel event stream in real time (SSE), with text/kind/suffix
  filtering, expandable payloads, pause, and replay of events that fired before
  the page was opened. (`--debug` independently writes the `.telo.debug.jsonl`
  event log; the two compose. See the `--inspect` flag set for delivery details.)

  New `@telorun/debug-ui` package: the browser-safe, runtime-agnostic consumer
  surface — the debug wire-format types + JSON Schema, filter logic, an SSE client,
  and React components (incl. the standalone app served by the inspection server).
  It has no Node-only dependency so it also runs in the editor webview.

  Binary payloads (images and any other file kind) are not inlined: the producer
  offloads each `Uint8Array`/`Buffer` to an in-memory, content-addressed LRU blob
  store and emits a small `{ "$blob": "blobs/<id>", "mediaType", "byteLength" }`
  pointer in its place (the key it sits under is preserved). The `DebugServer`
  serves the bytes at `GET /blobs/:id`; the UI renders `image/*` inline and other
  types as download links. Content addressing dedupes repeated buffers (e.g. a
  redraw loop).

  The producer (serializer + `DebugServer` + blob store) stays Node-side in the
  CLI; the cross-runtime contract is the wire format
  (`@telorun/debug-ui/wire-schema.json`), so a future Rust/Go kernel can serve the
  same UI by conforming to it. The inspection server binds `127.0.0.1` and is
  `unref`'d, so a one-shot `--inspect` run still exits normally.

- 9ef48a6: Ship the debug UI on demand instead of bundling it in the CLI, and give the
  inspection endpoint its own composable flag set.

  - `telo run --inspect[=[host:]port]` starts the live inspection endpoint
    (default `127.0.0.1:9230`; non-loopback binds print a security warning) and
    serves the UI same-origin, with a `/json/version` discovery handshake.
    `--no-open` suppresses auto-opening the browser. `--debug` is a separate,
    composable flag that writes only the `.telo.debug.jsonl` event log (no network,
    no UI).
  - The CLI does not bundle `@telorun/debug-ui` (it's a `devDependency`). The UI is
    fetched on demand from npm via jsDelivr and cached under the `.telo` cache
    root; in the monorepo it resolves from the workspace, so local builds are
    testable offline. `TELO_DEBUG_UI_PATH` overrides the bundle path; `TELO_DEBUG_UI_URL`
    overrides the CDN base.
  - `@telorun/debug-ui` builds a self-contained single-file bundle
    (`app-single/index.html`) alongside `app-dist/`.
