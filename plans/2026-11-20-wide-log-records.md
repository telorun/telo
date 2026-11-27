---
status: draft
priority: medium
depends-on: []
packages: [kernel, sdk, modules/http-server, modules/queue, modules/broadcast, modules/scheduler, modules/mcp-server, modules/desktop, modules/log, docs, apps/authoring-agent]
refinement: not-ready
---

# One wide log record per unit of work, by default

## Problem

Every `ctx.log` call becomes its own record on every sink. A single HTTP request writes `http.server.request.started`, whatever the handlers and imported libraries log, and `http.server.request` at the end — several lines, interleaved with every other request in flight. With tracing off (the default) nothing on those lines says which request they belong to, so they cannot even be grouped after the fact. The question an operator actually asks — "show me the failed checkouts for this user, with the payment provider's error" — needs one record per request holding everything that request learned, with the user on it.

Inbound transports handle units of work (`Http.Server` a request, the queue `Worker` and the broadcast `Subscription` a message, `scheduler` a tick, `mcp-server` stdio a message, `desktop` an action), but the logging pipeline knows nothing of them.

## Constraints

- we are talking about logs here, not traces
- on by default means current behaviour is swapped to wide events and can be opted out to current logs

## Surface

**Added**

- `records` — a field on `Telo.LogSink`, inherited by every sink kind: `wide` (default) or `lines` (today's one record per logging call, unchanged). The host-attached debug-wire sink always receives lines.
- `telo.unit` — the `event_name` of a wide record.
- `telo.unit.id` — attribute of a wide record: 16 lowercase hex characters, the span id's format, from a salted per-process counter.
- `telo.unit.start_time`, `telo.unit.duration_ms` — when the unit started (RFC 3339) and how long it took.
- `telo.unit.outcome` — how the unit settled, on the final part only: `ok`, `rejected`, `failed`, `cancelled` or `parked`, the set `Span.Settle` uses.
- `telo.unit.event_name` — on the final part, the `eventName` of the transport's completion record when one was admitted (`http.server.request`).
- `telo.unit.record_count`, `telo.unit.error_count` — how many records folded into the part, and how many carried an error; the same on every sink.
- `telo.unit.records` — the part's folded records that pass the sink's level, in order, always present, each a map in the record model's field names (`timestamp`, `severity_number`, `severity_text`, `message`, `event_name`, `resource`, `module`, `scope`, `span_id`, `attributes`, `error`, `dropped_attributes_count`) whatever the encoding, absent members left out.
- `telo.unit.part`, `telo.unit.partial` — the part number (from 1), and `true` on every part but the last of a split unit.
- `ctx.openUnit(base, { ref, label, attributes })` — opens a unit on a context and returns `{ context, settle(outcome, { attributes?, record? }) }`; `record` is `{ severity, message, eventName?, error? }`, the transport's completion record.
- `ctx.setUnitAttributes(context, attributes)` — merges attributes into the unit the context carries, last write wins per key; does nothing with no unit.
- `context` — an option on the SDK's logging calls, beside `eventName`, naming the invocation context a record belongs to.
- `unit` — a member of the invocation context (SDK and wire): the unit's opaque identity, inherited by every derived context.
- `Unit.Open` (request `instance`, `base`, `ref`, `label`, `attributes`; response `unit`, `context`), `Unit.Settle` (request `instance`, `unit`, `outcome`, `attributes`, `record`; empty response), `Unit.SetAttributes` (request `instance`, `context`, `attributes`) — controller-protocol messages within `telo-10`.
- `Log.SetUnitAttributes` and its ready-made instance `setUnitAttributes` — in the `log` module: input `attributes` (typed as `Log.Emit`'s), output `{}`.

**Changed**

- Default log output — every sink without `records: lines`, the zero-config console included, writes one `telo.unit` record per unit of work instead of one record per logging call.
- `Log.Write` — gains optional `context` (the kernel stamps the record's span and unit from it) and `eventName`.
- `ctx.rootContext()`, `ctx.runDetached` — also shed `unit`, as they shed `zones`.
- `pretty` encoding — a wide record prints as a headline line with each entry as an indented sub-line.
- `sampling` — what reaches `lines` sinks is sampled per record as today; wide sinks follow one decision per unit.
- `buffer` — on a wide sink a record occupies one slot per record it carries, capped at `buffer`; its `buffer_full` and `sampled` drops count records.
- `Http.Server`, the queue `Worker`, the broadcast `Subscription`, `scheduler`, `mcp-server` (stdio), `desktop` — each opens one unit per request, message, delivery, tick or action, and hands its per-unit completion record (`http.server.request`, "Tick failed", "Action failed", the worker's and subscription's) to the settle instead of logging it.

**Removed**

None.

## Solution

**Units.** A unit of work is opened by `ctx.openUnit` and ended by its `settle`; it is a logging concept and changes nothing about spans. The unit's identity rides the invocation context beside `zones`, so it follows every dispatch the unit drives and is shed by the two clearings that already shed zones — `ctx.rootContext()` and `ctx.runDetached`. A unit opened on a context that already carries one replaces it in the context it returns. A transport that also traces opens its span on `ctx.rootContext()` as today and then the unit on the span's context, so with tracing on the wide record carries that span's ids. With no wide sink attached, `ctx.openUnit` returns the base context unchanged and its settle writes only its `record`, as an ordinary record — a `lines`-only application carries no unit anywhere. Every inbound transport opens exactly one unit per unit of work; a transport that does not (a third-party one not yet adopting units, the Rust kernel's) keeps writing ordinary records. Over the controller protocol these are `Unit.Open`, `Unit.Settle` and `Unit.SetAttributes`.

**Which unit a record belongs to.** A record logged with a `context` belongs to that context's unit. A record logged without one belongs to the dispatch it is logged in: in process that is the ambient invocation context, so every stdlib controller's `ctx.log` call inside a request folds into the request's unit with no change to the controller; over the protocol a `Log.Write` with no `context` is an ordinary record, so a controller in another process passes the context it was dispatched with — which also attributes its concurrent records to the right span.

**The settle carries the transport's completion record.** A transport's per-unit outcome record — `Http.Server`'s `http.server.request`, the scheduler's "Tick failed" — is no longer logged; it is the settle's `record`. That record is stamped and judged exactly as the opening instance's own log call is today: its scope's threshold, then redaction; the per-mount `logging.level` stays the transport's own gate, below which it passes no `record`. A `lines` sink writes the admitted record as an ordinary record carrying the settle's attributes — so with the settle's attributes equal to today's set, `lines` output is today's. A wide sink takes the record's `error` as the headline's and its `eventName` as `telo.unit.event_name`; the headline's `message` stays the unit's label. A settle with no record, or one the scope suppressed, adds no severity, error or event name; its outcome and attributes still merge. Records a transport writes during the unit (`http.server.request.started`) stay ordinary records, logged with the unit's `context` from hooks outside the ambient one. A wide sink writes exactly the records a `lines` sink at the same level writes, grouped.

**The unit's own attributes.** A wide record's flat attributes are the opening attributes, then every `setUnitAttributes` call in order, then the settle's, plus the `telo.unit.*` bookkeeping. Each call passes the caller's redaction; with no unit (detached work, no wide sink, a unit already written) it does nothing. A folded record's attributes and error stay in its own entry and are never hoisted, so an outbound call's `server.address` or failure never reads as the inbound request's. The attribute limits apply to each record when it is logged and to the unit's own attributes; entries are not limited again, and the `telo.unit.*` keys do not count toward the attribute-count limit. `dropped_attributes_count` keeps meaning truncation.

**Folding.** Records pass their scope's threshold and redaction as today. Records naming no open unit go to every sink as ordinary records. Otherwise the kernel folds each record once into its unit's current part; fold state is allocated at the first record. A part closes at 100 records, after 30 s with something in it (one shared sweep over open parts, oldest first), at a `fatal` record, when the fold budget is exceeded, at the settle, or at a controlled exit. The fold budget is 16 MiB per kernel across all open parts, a record sized after the attribute limits as the UTF-8 length of every key and string, the length of bytes, and 8 per other scalar; exceeding it closes the oldest open parts first. The limits are fixed, so every wide sink sees the same parts. Every part carries the unit's own attributes known when it is written; the settle's attributes, outcome and event name only the final one. A part's severity is the highest of its folded entries and, on the final part, an admitted settle record. A hard kill loses open parts, documented beside the residual cases of buffered sinks; the synchronous flush path closes them like a controlled exit.

**Visibility.** Each wide sink filters a part's entries to its own `level`. A part that is not the last is written to a sink when one of its entries passes that sink's level; the final part is written when the unit's highest severity — over every folded entry and an admitted settle record — passes it. A sink that saw a unit begin therefore always sees its outcome, and a failing unit whose only record is its settle's still writes one record. `telo.unit.record_count` and `telo.unit.error_count` count the part as folded; `telo.unit.records` holds what passes the sink. In an asynchronous sink's buffer a wide record occupies one slot per record it carries — its entries plus itself — capped at `buffer`, so a part larger than the buffer is still accepted when the buffer is empty (`drop_new`) or evicts the rest (`drop_old`); its drops count those records.

**Sampling.** The per-record sampling stage stays exactly as today for what reaches `lines` sinks and for ordinary records. Wide sinks follow one decision per unit, taken when its first part closes, keyed by that part's severity and the unit's label, using the effective `sampling` of the opener's scope — the root's unless the opener's import sets its own. Later parts follow it, except that a part at error severity or above is always written unless `sampleErrors` is set; folded records are never sampled one by one. On a wide sink, `sampled` counts the records of each part the decision withheld that the visibility rule would have written there.

**Encodings.** In `json` a wide record is an ordinary record with the top-level keys and their order unchanged; the `telo.unit.records` entries sit inside `attributes`, keep the record model's field names and follow the sorted-keys rule. In `otlp` they are an `arrayValue` of `kvlistValue`s. In `pretty` the headline shows the unit's own attributes plus `telo.unit.outcome` and `telo.unit.duration_ms` (and `telo.unit.id` / `telo.unit.part` only when the unit was split), its error beneath it; each entry follows as a sub-line indented two spaces in the ordinary layout, its error beneath it.

**Edge cases.** `Telo.LogTraceSink` writes its span records on a context carrying no unit, so they are never folded. A library's records fold into the application's unit after its own scope gated and redacted them, and its entry carries its `scope`. A child application (`App.Instance`, `ctx.runtime.run`) is a kernel of its own and folds its own units into its own sinks; the id counter and salt are per process, so two kernels never mint one id.

**Static analysis.** `records` is validated as an enum (`SCHEMA_VIOLATION` for any other value); there is no new runtime refusal, so no analyzer twin. Whether a transport opens units is controller behaviour the analyzer cannot see, and no check keyed on module or kind names is added.

**Releases.** A manifest writing `records:` gets its floor from `telo release floor`. The seven modules whose controllers call `ctx.openUnit` or `ctx.setUnitAttributes` (`http-server`, `queue`, `broadcast`, `scheduler`, `mcp-server`, `desktop`, `log`) each add a `restrictions:` entry requiring the telo release that ships them, which no floor measurement sees. Every fragment is `Added`, the breaking default described in its body.

**Documentation.** `kernel/specs/logging.md` gains a "Units of work and wide records" section — the unit, which unit a record belongs to, the settle and its record, the unit's attributes, folding, visibility, the limits and the fold budget, conformance vectors with a golden wide record — plus the `telo.unit.*` names in its reserved table, `records` in its common sink fields, the buffer weight and record-counted drops in its buffering section, the per-unit decision in its sampling section, wide-record clauses in each encoding and a record's `context`; its examples use invented module names. `kernel/specs/controller-protocol.md` lists `unit`, `Unit.Open`, `Unit.Settle`, `Unit.SetAttributes` and `Log.Write`'s `context` / `eventName` as additive within `telo-10`, the outcome set declared once and shared by `Span.Settle` and `Unit.Settle`, with the message data and vector rows the spec check reads; `kernel/specs/tracing.md` is unchanged. `docs/guides/logging.md` shows the terminal output and the console opt-out; the controller-authoring guide states that an inbound transport opens one unit per unit of work and that a controller in another process passes its context to `Log.Write`; `modules/http-server/docs/log-events.md` and each touched transport's docs say what the transport settles with, where its per-unit event appears on a wide record (`telo.unit.event_name`), and that quieting a mount or an import still silences healthy requests; `modules/log` documents `Log.SetUnitAttributes`. A benefits-ledger entry under Telo itself ("one log record per request or message, by default, with tracing off, carrying the fields you add"), the authoring agent's primer and release fragments for every touched unit ship in the same change. The Rust kernel reads no `logging:` and hosts no inbound transport, and the Rust SDK has no `openUnit`; the logging spec records both as polyglot debt.

## Example

A shop API whose checkout calls a payment provider and logs a warning when the charge is declined, and a sync that fails. The console shows only what needs attention; a file keeps everything.

```yaml
kind: Telo.Application
metadata: { name: Shop }
requires: { telo: ">=unreleased" }
imports:
  Http: ../../modules/http-server
  HttpClient: ../../modules/http-client
  Log: ../../modules/log
  Scheduler: ../../modules/scheduler
ports: { http: { env: PORT, protocol: tcp, default: 8080 } }
logging:
  level: debug
  sinks:
    - { kind: Telo.ConsoleSink, level: warn }
    - { kind: Telo.FileSink, destination: ./shop.jsonl }
targets:
  - !ref server
  - !ref supplierSync
  - { name: openDocs, invoke: { kind: Telo.OpenUrl }, inputs: { url: !interpolate "http://localhost:${{ ports.http }}/docs/" } }
---
kind: Http.Server
metadata: { name: server }
listen: { port: !cel "ports.http" }
openapi: { info: { title: Shop, version: 1.0.0 } }
mounts:
  - path: /
    mount: !ref shopApi
  - { path: /docs, mount: { kind: Http.Reference } }
---
kind: Http.Api
metadata: { name: shopApi }
routes:
  - request:
      path: /checkout
      method: POST
      schema:
        body: { type: object, properties: { userId: { type: string } }, required: [userId] }
    handler:
      kind: Telo.Sequence
      inputType: { kind: Telo.JsonSchema, schema: { type: object, properties: { userId: { type: string } }, required: [userId] } }
      steps:
        - name: identify
          invoke: !ref Log.setUnitAttributes
          inputs: { attributes: { user.id: !cel "inputs.userId" } }
        - name: charge
          invoke:
            kind: HttpClient.Request
            client: { kind: HttpClient.Client, baseUrl: "https://api.stripe.com" }
          inputs: { url: /v1/charges, method: POST, body: { customer: !cel "inputs.userId" } }
        - name: report
          if: !cel "steps.charge.result.status == 402"
          then:
            - name: declined
              invoke: !ref Log.emit
              inputs: { level: warn, message: payment declined, attributes: { payment.provider: stripe } }
    inputs: { userId: !cel "request.body.userId" }
    returns:
      - { status: 402, content: { application/json: { body: { error: payment declined } } } }
---
kind: Scheduler.Interval
metadata: { name: supplierSync }
every: 30s
invoke:
  kind: Telo.Sequence
  steps:
    - throw: { code: ERR_SYNC_FAILED, message: the supplier feed answered 503 }
```

**Before** — the console at `warn` shows the checkout's warning cut off from its request and its user, and the failed sync as a bare error line:

```
12:34:56.761 WARN  Log.Emit.emit  payment declined  payment.provider=stripe
12:35:26.004 ERROR Scheduler.Interval.supplierSync  Tick failed
  ERR_SYNC_FAILED: the supplier feed answered 503
```

**After** — one record per unit: the request's own attributes and its user on the headline, its warning beneath; the failed tick once, with its error:

```
12:34:56.789 WARN  Http.Server.server  POST /checkout  http.request.method=POST http.response.status_code=402 http.route=/checkout http.server.request.duration=0.041 httpserver.request_id=1 telo.unit.duration_ms=41 telo.unit.event_name=http.server.request telo.unit.outcome=ok user.id=user_456
  12:34:56.761 WARN  Log.Emit.emit  payment declined  payment.provider=stripe
12:35:26.004 ERROR Scheduler.Interval.supplierSync  supplierSync  telo.unit.duration_ms=3 telo.unit.outcome=failed
  ERR_SYNC_FAILED: the supplier feed answered 503
```

The same checkout in `./shop.jsonl` (`json`, at `debug`, one line, wrapped here). Its entries are the received record, the outbound call and the warning — the outbound call's `server.address` and status stay in its entry; the completion record is the headline:

```json
{"time":"2026-11-27T12:34:56.789104000Z","level":"WARN","severity":13,"msg":"POST /checkout",
 "resource":{"kind":"Http.Server","name":"server","id":"Http.Server.server"},"module":"http-server",
 "attributes":{"http.request.method":"POST","http.response.status_code":402,"http.route":"/checkout",
  "http.server.request.duration":0.041,"httpserver.request_id":"1",
  "telo.unit.duration_ms":41,"telo.unit.error_count":0,"telo.unit.event_name":"http.server.request",
  "telo.unit.id":"3f9a1c0e5b7d2a64","telo.unit.outcome":"ok","telo.unit.part":1,"telo.unit.record_count":3,
  "telo.unit.records":[
   {"attributes":{"http.request.method":"POST","http.route":"/checkout","httpserver.request_id":"1","url.path":"/checkout"},
    "event_name":"http.server.request.started","message":"Request received","module":"http-server",
    "resource":{"id":"Http.Server.server","kind":"Http.Server","name":"server"},
    "severity_number":5,"severity_text":"DEBUG","timestamp":"2026-11-27T12:34:56.748311000Z"},
   {"attributes":{"http.client.request.duration":0.009,"http.request.method":"POST","http.response.status_code":402,
     "server.address":"api.stripe.com","url.path":"/v1/charges","url.scheme":"https"},
    "message":"Request completed","module":"http-client",
    "resource":{"id":"HttpClient.Request.shopApi.routes.0.handler.steps.1.invoke","kind":"HttpClient.Request","name":"shopApi.routes.0.handler.steps.1.invoke"},
    "severity_number":5,"severity_text":"DEBUG","timestamp":"2026-11-27T12:34:56.759020000Z"},
   {"attributes":{"payment.provider":"stripe"},
    "message":"payment declined","module":"log",
    "resource":{"id":"Log.Emit.emit","kind":"Log.Emit","name":"emit"},
    "severity_number":13,"severity_text":"WARN","timestamp":"2026-11-27T12:34:56.761902000Z"}],
  "telo.unit.start_time":"2026-11-27T12:34:56.748Z","user.id":"user_456"},
 "event_name":"telo.unit"}
```

The same record as an OTLP log record, to a sink at `warn` (one entry passes):

```json
{"timeUnixNano":"1795782896789104000","severityNumber":13,"severityText":"WARN",
 "body":{"stringValue":"POST /checkout"},"eventName":"telo.unit",
 "attributes":[
  {"key":"http.request.method","value":{"stringValue":"POST"}},
  {"key":"http.response.status_code","value":{"intValue":"402"}},
  {"key":"http.route","value":{"stringValue":"/checkout"}},
  {"key":"http.server.request.duration","value":{"doubleValue":0.041}},
  {"key":"httpserver.request_id","value":{"stringValue":"1"}},
  {"key":"telo.unit.duration_ms","value":{"intValue":"41"}},
  {"key":"telo.unit.error_count","value":{"intValue":"0"}},
  {"key":"telo.unit.event_name","value":{"stringValue":"http.server.request"}},
  {"key":"telo.unit.id","value":{"stringValue":"3f9a1c0e5b7d2a64"}},
  {"key":"telo.unit.outcome","value":{"stringValue":"ok"}},
  {"key":"telo.unit.part","value":{"intValue":"1"}},
  {"key":"telo.unit.record_count","value":{"intValue":"3"}},
  {"key":"telo.unit.records","value":{"arrayValue":{"values":[
   {"kvlistValue":{"values":[
    {"key":"attributes","value":{"kvlistValue":{"values":[{"key":"payment.provider","value":{"stringValue":"stripe"}}]}}},
    {"key":"message","value":{"stringValue":"payment declined"}},
    {"key":"module","value":{"stringValue":"log"}},
    {"key":"resource","value":{"kvlistValue":{"values":[
     {"key":"id","value":{"stringValue":"Log.Emit.emit"}},
     {"key":"kind","value":{"stringValue":"Log.Emit"}},
     {"key":"name","value":{"stringValue":"emit"}}]}}},
    {"key":"severity_number","value":{"intValue":"13"}},
    {"key":"severity_text","value":{"stringValue":"WARN"}},
    {"key":"timestamp","value":{"stringValue":"2026-11-27T12:34:56.761902000Z"}}]}}]}}},
  {"key":"telo.unit.start_time","value":{"stringValue":"2026-11-27T12:34:56.748Z"}},
  {"key":"user.id","value":{"stringValue":"user_456"}}]}
```

A request still open after 30 s is written in parts sharing one id; every part carries the request's attributes, only the last its outcome:

```
12:35:26.750 INFO  Http.Server.server  GET /export  http.request.method=GET http.route=/export telo.unit.id=b81f2c90d4e7a315 telo.unit.part=1
  12:34:56.750 INFO  Log.Emit.emit  export started  export.rows=120000
12:35:41.102 INFO  Http.Server.server  GET /export  http.request.method=GET http.response.status_code=200 http.route=/export http.server.request.duration=44.352 httpserver.request_id=7 telo.unit.duration_ms=44352 telo.unit.event_name=http.server.request telo.unit.id=b81f2c90d4e7a315 telo.unit.outcome=ok telo.unit.part=2
  12:35:41.090 INFO  Log.Emit.emit  export finished  export.bytes=48211902
```

Opting the console out keeps today's lines there — the "Request completed" record exactly as now — while the file stays wide and samples healthy units whole; the quietened mount still writes nothing for a healthy request:

```yaml
kind: Telo.Application
metadata: { name: Status }
requires: { telo: ">=unreleased" }
imports: { Http: ../../modules/http-server }
ports: { http: { env: PORT, protocol: tcp, default: 8080 } }
logging:
  level: debug
  sampling: { first: 10, thereafter: 100, tick: 1s }
  sinks:
    - { kind: Telo.ConsoleSink, level: warn, records: lines }
    - { kind: Telo.FileSink, destination: ./status.jsonl }
targets:
  - !ref server
  - { name: openDocs, invoke: { kind: Telo.OpenUrl }, inputs: { url: !interpolate "http://localhost:${{ ports.http }}/docs/" } }
---
kind: Http.Server
metadata: { name: server }
listen: { port: !cel "ports.http" }
openapi: { info: { title: Status, version: 1.0.0 } }
mounts:
  - { path: /, mount: !ref statusApi, logging: { level: warn } }
  - { path: /docs, mount: { kind: Http.Reference } }
---
kind: Http.Api
metadata: { name: statusApi }
routes:
  - request: { path: /health, method: GET }
    handler: { kind: Telo.Value, value: { ok: true } }
    returns:
      - { status: 200, content: { application/json: { body: { ok: true } } } }
```

A misspelt value is refused before the app runs:

```yaml
kind: Telo.Application
metadata: { name: Status }
logging:
  sinks:
    - { kind: Telo.ConsoleSink, records: wid }
```

```
$ telo check ./telo.yaml
telo.yaml:5:43  error  SCHEMA_VIOLATION  /logging/sinks/0/records must be equal to one of the allowed values: wide, lines
```

A transport controller opens a unit per request and hands its completion record to the settle; a handler's controller adds a field:

```ts
const unit = ctx.openUnit(spanContext, {
  ref: this.ref,
  label: `${request.method} ${route}`,
  attributes: { "http.request.method": request.method, "http.route": route },
});
ctx.log.debug("Request received", { "url.path": request.url }, { eventName: "http.server.request.started", context: unit.context });
await handleRequest(request, unit.context);
unit.settle("ok", {
  attributes: { "http.response.status_code": 402, "http.server.request.duration": 0.041 },
  record: { severity: SEVERITY.info, message: "Request completed", eventName: "http.server.request" },
});

ctx.setUnitAttributes(invokeContext, { "tenant.id": tenant });
```

The same over the controller protocol, from an out-of-process transport (`Acme.Listener`):

```json
{"type":"Unit.Open","instance":"listener-1","ref":{"kind":"Acme.Listener","name":"inbox"},"label":"message orders.created","attributes":{"messaging.destination.name":"orders.created"},"base":{"cancellation":{"source":"c-12"}}}
{"unit":"9c04e1d7a2b35f80","context":{"cancellation":{"source":"c-12"},"unit":"9c04e1d7a2b35f80"}}
{"type":"Log.Write","instance":"listener-1","severity":5,"message":"Message received","eventName":"acme.listener.message.received","context":{"cancellation":{"source":"c-12"},"unit":"9c04e1d7a2b35f80"}}
{"type":"Unit.SetAttributes","instance":"listener-1","context":{"cancellation":{"source":"c-12"},"unit":"9c04e1d7a2b35f80"},"attributes":{"order.id":"ord_881"}}
{"type":"Unit.Settle","instance":"listener-1","unit":"9c04e1d7a2b35f80","outcome":"failed","attributes":{"messaging.operation.name":"process"},"record":{"severity":17,"message":"Message failed","eventName":"acme.listener.message","error":{"type":"ERR_ORDER_REJECTED","message":"order total is negative"}}}
{}
```

With no wide sink attached, the `Unit.Open` response carries the base context unchanged (no `unit` member), and the settle writes its `record` as an ordinary record.

## Verify

- With tracing off, the shop's checkout writes exactly the console, file and OTLP records shown above; the file's record holds three entries and the console's one, both with `telo.unit.record_count: 3`, and neither carries `server.address` among its top-level attributes.
- At the default `info` with the default console, a 200 prints exactly one line; a failing tick prints one `error` `telo.unit` record and its error once; a succeeding tick prints nothing.
- A mount with `logging.level: warn` writes nothing for a 200 on a wide console and on a wide file at `debug` (unless the handler logs); a 500 there writes one `error` `telo.unit` record. An import at `level: warn` writes no `telo.unit` for a request whose handlers log nothing, and a unit whose settle record the scope suppressed carries no `telo.unit.event_name`.
- Wide records carrying `telo.unit.event_name: http.server.request` correspond one-to-one with the `http.server.request` records a `lines` sink writes for the same traffic.
- A handler error prints once, under its entry; an untruncated wide record carries no `dropped_attributes_count`; an attribute nested ten levels deep survives inside its entry as it does on a line.
- A request logging 250 records yields three parts with the same `telo.unit.part` numbers on the file and on a `warn` console; the `warn` console receives the part holding its only warning and the final part with `telo.unit.outcome`; part 2 of a split request carries `http.route` and `http.request.method`; a `fatal` record closes its part at once.
- With `records: lines`, console output for the same requests is byte-identical to a pre-change build's, timestamps aside, and with only `lines` sinks a handler's context carries no `unit`.
- With `sampling: { first: 1, thereafter: 0 }` at the root, the second `ok` request to one route writes nothing on a wide file and counts its records as `sampled` there, while a failing request to that route is written with its full `telo.unit.record_count`; the same config under `records: lines` yields today's output and drop counts; `sampling:` on the `Http` import alone thins that server's units.
- 10,000 concurrent requests each logging large attributes keep the fold under 16 MiB and each yields complete parts sharing one `telo.unit.id`; a file sink with `buffer: 8192` holding 100-entry parts holds 81 of them; a sink with `buffer: 50` writes a 100-entry part whenever its buffer is empty; a dropped 3-entry part counts 4 under `buffer_full`.
- Ctrl-C during a slow request yields a wide record on the file at `debug` — `telo.unit.outcome: cancelled` when the transport settled, else a partial part.
- With tracing on, the spans exported for the scheduler, mcp-server and desktop fixtures are identical before and after; a request's wide record carries its span's ids.
- Through a controller over a carrier, two concurrent requests each get their own records in their own unit when it passes `context`, and a `Log.Write` without `context` is an ordinary record; `generation.json` still reads 10.
- A detached task's records are written as ordinary records and its `setUnitAttributes` call leaves no trace and raises no error; with `Telo.LogTraceSink` attached, a request yields one `telo.unit` record plus its separate `telo.span` records.
- A TTY console prints a three-record unit as one headline and three indented sub-lines, with no `telo.unit.records=` text; the golden wide record encodes byte-identically in `json` across runtimes.
- `--debug` changes nothing on the console; `telo check` refuses `records: wid`.

## Decisions

- **A unit is its own call, `ctx.openUnit`, not the inbound span.** Tying it to `inbound` would change what `inbound` and `Span.Open` mean and add root spans for `scheduler`, `mcp-server` and `desktop` when tracing is on — a tracing change for a logging feature; a flag on `openSpan` meaning "unit, no span" would be a mode switch. `ctx.rootContext()` was rejected as the unit: it has no end to write at and is also a plain fallback context.
- **Carried on the invocation context, beside `zones`.** A parallel ambient store would need its own clearing at every site; the context's existing clearings end a unit correctly with no unit-specific code.
- **Only transports open units.** A fallback unit at the kernel's dispatch point would split one request into several units (verifiers, policy, handler, catches) and silently regroup them once its transport adopts units.
- **A record names its context; no logger hangs off the unit.** A logger bound to one holder would be a second spelling for one of several holders of a context; passing the context into the log call is what `slog` and the OTel Logs API do.
- **`records` is per sink, not a `logging:` key.** Grouping is a property of the destination, like `encoding`; the root `level` is the scope's creation threshold cascading through imports, not a sink default, and a unit spans imports. Opting the zero-config console out is one `sinks:` entry.
- **The transport's completion record is the settle's record** — canonical log lines. Logging it and settling separately would write the same facts twice and leave the settle outside the scope and per-mount gating that quiet `/health` today; naming a summary event to exclude from the fold would keep both writes. A severity derived from the outcome would make every coded 4xx a warning.
- **The wide record keeps the completion record's event name as `telo.unit.event_name`, not as its own `event_name`.** Consumers key on `http.server.request` across transport implementations, so it must survive; making it the wide record's `event_name` would give one event name two shapes and two severity rules. Its `message` is non-normative prose and is not kept.
- **One outcome set for spans and units.** A transport decides one outcome and hands it to both settles; a second vocabulary would need a mapping.
- **Only the unit's own attributes and error are flat; authors add theirs explicitly.** A semantic-convention key or an error describes the operation of the record carrying it; hoisting would put an outbound call's `server.address` or failure on the inbound request, and protecting only the unit's own keys would still let an unowned inner key read as the request's. `setUnitAttributes` is how OTel's `SetAttributes` and Honeycomb's `AddField` put a business field on the request.
- **Collisions are not counted.** `dropped_attributes_count` stays truncation only, which backends alert on.
- **`lines` is today's output exactly**, with no unit attribute — the opt-out the constraints define.
- **Fold once per unit, filter per sink.** Per-sink folds would give two sinks different part boundaries and counts and grow state with every sink; judging visibility on a whole unit would buffer an unbounded stream.
- **Each sink judges by its own `level`; errors are not also written as lines.** Two shapes for one error would duplicate it in every backend; `fatal` and controlled exits cover the dying-process case.
- **Fixed limits, and one budget across units.** Configurable limits would be keys meaningful only under `wide`, making `records` a discriminator, and would let runtimes split at different points. A per-part byte cap would still let memory grow with concurrency. No split on the attribute-count limit: a unit's own map is small, and truncation covers the rest.
- **A wide record weighs the records it carries in a sink's buffer, capped at the buffer.** One slot per wide record would let the default buffer hold about a hundred times today's memory during a backend outage; without the cap a small buffer could never accept a large part.
- **Every part repeats the unit's own attributes.** Many log backends cannot join parts on `telo.unit.id`.
- **`telo.unit.records` is always present, in the record model's field names.** A shape that varies with the count breaks every consumer's schema.
- **Sampling: one decision per unit for wide sinks, from the opener's scope; per record for `lines`.** A per-sink stage would change `lines` output; sampling inside the fold leaves holes and a `telo.unit.record_count` that lies; root-only configuration would stop an import's `sampling:` from thinning the units it opens.
- **No protocol generation bump.** `telo-10` is spoken by no carrier yet, so it grows additively, as its spec says of such a generation.
