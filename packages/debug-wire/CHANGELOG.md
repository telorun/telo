# @telorun/debug-wire

## 0.4.0

### Minor Changes

- c1fef72: Implement the structured logging specification (`kernel/specs/logging.md`).

  Records carry an OTel severity number, a message, structured attributes, the
  emitting resource's identity, its import-alias scope, and the active dispatch
  span's trace and span ids — all attached automatically. Controllers emit through
  the new ambient `ctx.log`.

  Logging is configured by a `logging:` block on the root `Telo.Application`:
  `level`, `attributes`, `redact`, `sampling`, and a `sinks:` list of ref-or-inline
  entries. `Telo.ConsoleSink` and `Telo.FileSink` are kernel built-ins resolvable
  without an import; omitting `sinks:` yields exactly one console sink, so the
  zero-config case stays "pretty on a terminal, JSON when piped". An `imports:`
  entry may carry its own `logging:` block to raise verbosity for that dependency's
  subtree; config cascades and may be narrowed at each hop. There is no
  `TELO_LOG_*` variable and no logging CLI flag — a level derived from the host
  environment goes through a `variables:` entry read with `!cel`.

  New `Telo.Sink` capability and `Telo.LogSink` abstract, so the sink set is open
  to the ecosystem: a third party ships a sink by publishing a module whose kind
  extends `Telo.LogSink`. The new `std/otlp` module does exactly that.

  Behaviour changes:

  - The CLI now honours `NO_COLOR` and implements the spec's full color-precedence
    order. `FORCE_COLOR=0` disables color rather than enabling it.
  - `TracePayload.spanId` / `parentSpanId` on the debug wire are now 16-character
    lowercase hex strings rather than numeric counters, matching the ids log
    records carry. The internal counter is unchanged; hex is rendered only at the
    encoding boundary and is salted per process so two services in one distributed
    trace cannot mint the same id.
  - `Http.Server`'s `logger:` field now means "enable request logging" rather than
    being a raw Fastify passthrough. Fastify's Pino instance is replaced with a
    Telo-backed adapter, so request records inherit the root `logging:` block's
    level, encoding, redaction, and sinks.
  - The kernel no longer writes diagnostics to `process.stderr` or `console.*`;
    everything routes through the logger. The ad-hoc `TELO_BUNDLE_DEBUG` env var is
    replaced by ordinary trace-level records.
  - `on_full: block` and invalid redaction paths are now caught by `telo check`
    (static analysis), not only at boot — `on_full: block` is unimplementable on a
    single-threaded runtime and a bad redaction path would otherwise silently fail
    to redact. Both remain enforced at runtime as a backstop.

  Two pre-existing bugs fixed along the way:

  - A CEL expression feeding **any** enum-constrained field produced a spurious
    `SCHEMA_VIOLATION`, because the placeholder substituted for the expression
    satisfied `type` but violated `enum`. Fixed in both the analyzer and the
    kernel.
  - `teardownResources` aborted the whole cascade on the first throwing resource,
    with no aggregation and no reporting. Failures are now collected into
    `ERR_TEARDOWN_FAILED` so one bad teardown cannot skip the rest — including the
    log sinks, which are pinned to tear down last.
  - The inline `imports:` desugaring silently dropped unknown entry fields, so a
    per-import `logging:` block never reached the import controller.

## 0.3.0

### Minor Changes

- a125804: Give resources spawned by a templated kind a hierarchical identity, so the debug graph nests them under their parent and stops collapsing collisions.

  A `Telo.Definition` with a `resources:` block (e.g. `std/crud`'s `Crud.Resource`) expands into child resources whose `kind` + `name` are identical across every instance of the kind — two `Crud.Resource`s both spawn `SqlRepo.Read.reader`. The debug stream keyed nodes by name, so those children collided and only one appeared, with no link back to the owning resource.

  - **Kernel / SDK**: every resource now carries a full hierarchical `id` (`<owner.id>/<kind>.<name>`, or `<kind>.<name>` at the top level). A template controller stamps the owning resource onto the child context it registers its `resources:` into (`EvaluationContext.owner`), so the children's `Created` / `Initialized` / `Teardown` and dispatch events carry that `owner` and a unique `id`; dependency edges are id-qualified too. `ResourceContext.ownerPrefix` exposes the composing prefix so the identity stays unique when templates nest. The dependency-edge collector also skips `schema` for the system kinds whose `schema:` is definitionally a JSON-Schema contract (`Telo.Definition` / `Telo.Abstract` / `Telo.Type`): a `{kind, name}`-shaped value in a schema `examples` block is documentation data, not a `!ref`, and previously surfaced as a phantom dependency edge (e.g. every `Telo.Definition` wiring itself to a resource named in its example). Other kinds' `schema` fields are still walked, so a genuine `schema: !ref X` resolves.
  - **Resolved properties**: each `Created` event now also carries `properties` — the resource's config "after templating", with compile-time `${{ }}` / `!cel` reduced to concrete values, resolved `!ref`s (and injected live instances) shown as `{kind,name}`, deferred runtime expressions as their `${{ source }}` text, and known secret values scrubbed to `[secret]`. The node detail panel renders it as a **Properties** section above Inputs/Outputs.
  - **Wire** (`@telorun/debug-wire`): lifecycle and dispatch payloads gain `id` on the resource `ref` and an optional `owner` pointer (`WireOwner`, `WireResourceRef`, `LifecyclePayload`); `Created` adds `properties`. Additive — a legacy producer that omits `id` falls back to name-keyed identity.
  - **Debug UI**: the Graph view keys nodes by `id` and renders a templated resource as one node with an "n internal" badge. Clicking it opens a drill-down panel showing that resource plus the children it spawned (`subtreeGraph`), wired into a tree — the children connected by their own dependency edges, and the parent linked by a dashed ownership edge only to children not already reached through a sibling (so a handler reached via the Http.Api isn't also tied directly to the parent). Drilling into a child pushes another panel onto a cascading stack (recursive to any depth); panels beneath peek out on the left and click to pop back, so the main canvas never reflows. The node-detail aside now scrolls as one unit — previously its flex body collapsed each inputs/outputs payload into a tiny nested scrollbar.

## 0.2.0

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

## 0.1.0

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
