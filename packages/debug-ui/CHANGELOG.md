# @telorun/debug-ui

## 0.6.0

### Minor Changes

- 897c0b9: Surface session port reachability on the endpoint badge instead of the log stream.

  After a session goes running, the runner (`watchReachability` in
  `@telorun/runner-core`, used by the k8s and docker backends) probes each declared
  tcp port and emits a structured `reachability` `RunEvent` per port — `checking`,
  then `reachable`, or `unreachable` after a 30s timeout (flipping back to
  `reachable` if it recovers). The editor renders this on each endpoint link in the
  debug panel: a spinner while checking, a green icon when reachable, a red icon
  when unreachable — turning the loopback-bind / wrong-port failure (previously an
  opaque downstream 502, or a late log line) into live status on the URL itself.

  The badge reflects reachability from the runner to the workload (pod network for
  k8s, published port / container for docker) — a proxy for the common loopback-bind
  failure, not end-to-end health of the public link, and a startup signal rather
  than continuous monitoring (a port that comes up then dies keeps its green icon).

## 0.5.0

### Minor Changes

- a125804: Make the debug UI usable on a phone-width viewport.

  The layout previously assumed a desktop width — a single non-wrapping header row and the Graph view's fixed 220px trace-list + 340px detail rails left almost no room for the canvas under ~640px. A `@media (max-width: 640px)` block now:

  - wraps the header tabs/controls and the events filter bar, with larger tap targets;
  - stacks the Graph view vertically — the invocation list becomes a horizontal scroll strip above the canvas, and the node-detail panel becomes a bottom sheet overlaying the canvas instead of a 340px side column;
  - lets the drill-down panels go near-full-width with a tight cascade.

  The drill-down cascade offset moved from an inline `left` to a `--tdbg-depth` CSS variable so the media query can retune it; desktop layout is unchanged.

  Also fixes pan/zoom on touch: xyflow ships no `touch-action`, so the browser claimed one-finger drags and the graph never panned on a touch device. The flow container is now `touch-action: none`, handing pan/pinch to xyflow.

- a125804: Give resources spawned by a templated kind a hierarchical identity, so the debug graph nests them under their parent and stops collapsing collisions.

  A `Telo.Definition` with a `resources:` block (e.g. `std/crud`'s `Crud.Resource`) expands into child resources whose `kind` + `name` are identical across every instance of the kind — two `Crud.Resource`s both spawn `SqlRepo.Read.reader`. The debug stream keyed nodes by name, so those children collided and only one appeared, with no link back to the owning resource.

  - **Kernel / SDK**: every resource now carries a full hierarchical `id` (`<owner.id>/<kind>.<name>`, or `<kind>.<name>` at the top level). A template controller stamps the owning resource onto the child context it registers its `resources:` into (`EvaluationContext.owner`), so the children's `Created` / `Initialized` / `Teardown` and dispatch events carry that `owner` and a unique `id`; dependency edges are id-qualified too. `ResourceContext.ownerPrefix` exposes the composing prefix so the identity stays unique when templates nest. The dependency-edge collector also skips `schema` for the system kinds whose `schema:` is definitionally a JSON-Schema contract (`Telo.Definition` / `Telo.Abstract` / `Telo.Type`): a `{kind, name}`-shaped value in a schema `examples` block is documentation data, not a `!ref`, and previously surfaced as a phantom dependency edge (e.g. every `Telo.Definition` wiring itself to a resource named in its example). Other kinds' `schema` fields are still walked, so a genuine `schema: !ref X` resolves.
  - **Resolved properties**: each `Created` event now also carries `properties` — the resource's config "after templating", with compile-time `${{ }}` / `!cel` reduced to concrete values, resolved `!ref`s (and injected live instances) shown as `{kind,name}`, deferred runtime expressions as their `${{ source }}` text, and known secret values scrubbed to `[secret]`. The node detail panel renders it as a **Properties** section above Inputs/Outputs.
  - **Wire** (`@telorun/debug-wire`): lifecycle and dispatch payloads gain `id` on the resource `ref` and an optional `owner` pointer (`WireOwner`, `WireResourceRef`, `LifecyclePayload`); `Created` adds `properties`. Additive — a legacy producer that omits `id` falls back to name-keyed identity.
  - **Debug UI**: the Graph view keys nodes by `id` and renders a templated resource as one node with an "n internal" badge. Clicking it opens a drill-down panel showing that resource plus the children it spawned (`subtreeGraph`), wired into a tree — the children connected by their own dependency edges, and the parent linked by a dashed ownership edge only to children not already reached through a sibling (so a handler reached via the Http.Api isn't also tied directly to the parent). Drilling into a child pushes another panel onto a cascading stack (recursive to any depth); panels beneath peek out on the left and click to pop back, so the main canvas never reflows. The node-detail aside now scrolls as one unit — previously its flex body collapsed each inputs/outputs payload into a tiny nested scrollbar.

### Patch Changes

- Updated dependencies [a125804]
  - @telorun/debug-wire@0.3.0

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
