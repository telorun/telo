---
status: draft
priority: medium
depends-on: []
packages: [kernel, sdk, modules/http-server, modules/queue, modules/broadcast, modules/scheduler, modules/mcp-server, modules/desktop, docs, apps/authoring-agent]
refinement: not-started
---

# One wide log record per unit of work, by default

## Problem

Every `ctx.log` call becomes its own record on every sink. A single HTTP request writes `http.server.request.started`, whatever the handlers and imported libraries log, and `http.server.request` at the end — several lines, interleaved with every other request in flight. With tracing off (the default) nothing on those lines says which request they belong to, so they cannot even be grouped after the fact. The question an operator actually asks — "show me the failed checkouts for this user, with the payment provider's error" — needs one record per request holding everything that request learned.

Inbound transports already mark a unit of work for tracing (`Http.Server`, the queue `Worker` and the broadcast `Subscription` open one span per request or message), but with tracing off that span is a no-op, and `scheduler` ticks, `mcp-server` stdio messages and `desktop` actions open none at all.

## Constraints

- we are talking about logs here, not traces
- on by default means current behaviour is swapped to wide events and can be opted out to current logs

## Surface

**Added**

- `records` — a field on `Telo.LogSink`, inherited by every sink kind: `wide` (default) or `lines` (today's one record per logging call). The host-attached debug-wire sink always receives lines.
- `telo.unit` — the `event_name` of a wide record.
- `telo.unit.id` — attribute on every record emitted inside a unit, in both modes and with tracing off: 16 lowercase hex characters from a salted counter of its own.
- `telo.unit.start_time`, `telo.unit.duration_ms`, `telo.unit.outcome` — when the unit started (RFC 3339), how long it took, how it settled.
- `telo.unit.record_count`, `telo.unit.error_count` — how many records folded in, and how many carried an error.
- `telo.unit.records` — the folded records in order, each `{ time, severity, message, event_name, resource, scope, error.type }` with absent members left out.
- `telo.unit.part`, `telo.unit.partial` — the part number (from 1) of a unit split by the limits, and `true` on every part but the last.
- `log` on the value `ctx.openSpan` returns — a logger bound to the unit, for transport hooks that run outside the ambient context.
- `unit` on the invocation context — the unit's identity, carried by `deriveContext`, absent from `ctx.rootContext()` and from `ctx.runDetached` tasks.

**Changed**

- Default log output — every sink without `records: lines`, the zero-config console included, writes one `telo.unit` record per unit of work instead of one record per logging call.
- `inbound` on `ctx.openSpan` — now means "this span starts an inbound unit of work"; the W3C carrier `traceparent` / `tracestate` become optional inside it. With tracing off the call returns a context carrying the unit instead of the base unchanged.
- `Span.Open` (controller protocol) — the same change on the wire, under the protocol's generation rule.
- `scheduler`, `mcp-server` (stdio), `desktop` — each tick, message and action now opens an inbound span, so it is a unit (and appears as a span when tracing is on).

**Removed**

None.

## Solution

**Units.** A unit of work is an inbound span: `ctx.openSpan` called with `inbound` opens one whether tracing is on or off, and its `settle` ends it. The unit's identity rides the invocation context beside `zones`, so it follows every dispatch the unit drives and is shed by the two clearings that already shed zones — `ctx.rootContext()` and `ctx.runDetached`. A span opened inside a unit without `inbound` (an agent's model call) stays in it; an `inbound` span opened under a context that already carries a unit joins it. The kernel's logging pipeline holds each unit's fold state keyed by that identity and drops it when the unit is written. Every inbound transport opens exactly one inbound span per unit: `Http.Server` per request, the queue `Worker` per message, the broadcast `Subscription` per delivery, `scheduler` per tick, `mcp-server` stdio per message, `desktop` per action. Transports keep emitting their own per-unit records (`http.server.request.started`, `http.server.request`) — now on the unit's logger — and never learn how a sink is configured.

**Folding.** Threshold, redaction and sampling still run per record, before anything is folded, so a suppressed record still costs nothing. At fan-out a `wide` sink folds the unit's records that pass its own `level`; a `lines` sink gets each record as today, carrying `telo.unit.id`. When the unit settles, each wide sink receives one record: `message` the span's label (else the resource name), `event_name: telo.unit`, `resource` / `module` / `scope` those of the transport resource, trace and span ids only when tracing is on, severity the highest among the folded records, and one flat attribute map built from the opening attributes, then every folded record's attributes in order, then the settle attributes (status, outcome, `error.type`) — last write wins, each overwrite counted in `dropped_attributes_count`. `error` is the last error at the highest severity. A unit with no record at a sink's level writes nothing to that sink, so an import at `level: warn` still silences access noise.

**Limits.** A unit's current part is written as a partial record when it holds 100 folded records, when the next record would take the merged map past the 128-attribute limit, or after 30 s with something in it. The limits are fixed and decided on what the gate admitted, so every wide sink splits at the same points. A `fatal` record closes the current part at once. At a controlled exit, every open unit is written as a partial record before the sinks' final flush (the synchronous flush path does the same); a hard kill loses open units, documented beside the residual cases of buffered sinks.

**Edge cases.** Detached work carries no unit and logs plain records. A record whose context names a unit already written is written as an ordinary record keeping `telo.unit.id`. `Telo.LogTraceSink` writes its span records on a context carrying no unit, so they are never folded. A library's records fold into the application's unit after its own scope gated and redacted them, and its entry in `telo.unit.records` carries its `scope`. Sampling decides per record; a wide record is never sampled.

**Static analysis.** `records` is validated as an enum (`SCHEMA_VIOLATION` for any other value); there is no new runtime refusal, so no analyzer twin. Whether a transport opens units is controller behaviour the analyzer cannot see, and no check keyed on module or kind names is added. A manifest writing `records:` gets its floor from `telo release floor`.

**Documentation and bookkeeping.** `kernel/specs/logging.md` gains a "Units of work and wide records" section (the record, merge order, limits, conformance vectors with a golden wide record), the `telo.unit.*` names in its reserved table, `records` in §12.1's common fields, the fold in §10.1's pipeline and the exit behaviour in §10.5. `kernel/specs/tracing.md` §4 and §6.2 and `kernel/specs/controller-protocol.md`'s `Span.Open` section say what `inbound` now means. `docs/guides/logging.md`, each touched transport's module docs, a benefits-ledger entry under Telo itself ("one log record per request or message, by default, with tracing off"), the authoring agent's primer, and release fragments for every touched unit ship in the same change. The Rust kernel reads no `logging:` and hosts no inbound transport; the logging spec records it as polyglot debt (units, folding, the limits and `telo.unit.*` exactly, and `Span.Open` answering with a unit when tracing is off).

## Verify

- With tracing off, a request that logs three records writes one `telo.unit` record on the console carrying `http.response.status_code`, `telo.unit.outcome`, `telo.unit.record_count: 3` and three entries in `telo.unit.records`; a scheduler tick does the same.
- With `records: lines`, the same request writes today's lines, each carrying one shared `telo.unit.id`; two concurrent requests split cleanly by it, and two processes never mint the same id.
- Console at `warn` and a file at `debug`, both wide: a 200 reaches only the file, a 500 reaches both, and the console's record holds no debug content.
- A two-minute SSE stream yields a part every 30 s sharing one `telo.unit.id`, only the last carrying `telo.unit.outcome`; a loop logging 250 records yields three parts.
- Ctrl-C during a slow request yields a wide record (`cancelled` or partial), never nothing.
- An agent's model call inside a boot run opens no unit; a detached task's records carry no `telo.unit.id`; with `Telo.LogTraceSink` attached, a request yields one `telo.unit` record plus its separate `telo.span` records.
- `--debug` changes nothing on the console; `telo check` refuses `records: wid`.

## Decisions

- **The unit is the inbound span, not a new API.** A separate `ctx.openUnit` beside `openSpan` is two calls for one concept that can disagree; `ctx.rootContext()` has no end to write at and is also a plain fallback context. Tying it to `inbound` (rather than to any span with no parent) keeps an agent's nested span from becoming a unit.
- **Carried on the invocation context, beside `zones`.** A parallel ambient store would need its own clearing at every site; the context's existing clearings end a unit correctly with no unit-specific code, and only an identity crosses the controller protocol.
- **`records` is per sink, not a `logging:` key.** Grouping is a property of the destination, like `level` and `encoding`: a terminal, Studio and an OTLP backend want different things, and a unit spans imports, so an import-level cascade would have no meaning.
- **Every record inside a unit carries `telo.unit.id`.** Concurrent lines are otherwise ungroupable with tracing off; an attribute rather than a record field, since the encodings forbid extra top-level keys.
- **Flat, last-write-wins attributes.** Wide records are queried by semantic-convention keys, so per-emitter namespaces would break the point of them; first-wins would let early records beat the settle status. Nothing is lost silently — overwrites are counted and each record's identity survives in `telo.unit.records`.
- **Transport records stay ordinary records.** Subsuming `http.server.request` into the settle would make a transport depend on each sink's mode, which differs per sink.
- **Each sink judges by its own `level`; errors are not also written as lines.** Two shapes for one error would duplicate it in every backend; `fatal` and controlled exits cover the dying-process case.
- **Fixed limits.** Configurable ones would be keys meaningful only under `wide`, making `records` a discriminator, and would let runtimes split at different points.
- **`scheduler`, `mcp-server` stdio and `desktop` open inbound spans.** They handle units of work but open none today, which also contradicts the tracing spec's one-span-per-unit rule; the feature closes that gap rather than leaving their records as lines.

## Example after the change

An application keeping per-line output on the console while shipping wide records to a file:

```yaml
kind: Telo.Application
metadata: { name: Shop }
logging:
  sinks:
    - { kind: Telo.ConsoleSink, records: lines }
    - { kind: Telo.FileSink, destination: /var/log/shop.jsonl }
```

One request in the file, as JSON (abridged):

```json
{ "severity_text": "ERROR", "event_name": "telo.unit", "message": "POST /api/checkout",
  "resource": { "kind": "Http.Server", "name": "server" },
  "attributes": { "telo.unit.id": "3f9a1c0e5b7d2a64", "http.request.method": "POST",
    "http.route": "/api/checkout", "user.id": "user_456", "payment.provider": "stripe",
    "http.response.status_code": 500, "error.type": "ERR_PAYMENT_DECLINED",
    "telo.unit.outcome": "rejected", "telo.unit.duration_ms": 1247,
    "telo.unit.record_count": 4, "telo.unit.error_count": 1, "telo.unit.records": ["…"] } }
```
