---
slug: /build/tracing
description: "Tracing in Telo: turning span export on with trace sinks, reading spans as log records or shipping them to an OpenTelemetry collector, putting contract values on a span, and opening spans from a controller."
---

# Tracing

Every dispatch in a Telo application is a **span**: each `invoke` and `run`,
the application's boot run, and the spans controllers open for work that is not
a dispatch — an HTTP request, an agent's model call. Spans nest, so one request
is one trace you can read top to bottom.

Tracing is **off** until something wants the spans, and costs nothing while it
is. Declaring a trace sink is what turns it on.

## Turning it on

Add a `tracing:` block to the root Application and list its sinks — inline, or
by `!ref`, as in `logging.sinks`:

```yaml
kind: Telo.Application
metadata:
  name: my-app
tracing:
  sinks:
    - kind: Telo.LogTraceSink
```

`Telo.LogTraceSink` is built in. It writes each finished span as one log record
(event name `telo.span`) through the logging pipeline, so spans appear wherever
your logs already go — the console, a file, a collector — with no extra setup:

```
{"msg":"invoke writeFile","event_name":"telo.span","trace_id":"cd41…","span_id":"fb03…","attributes":{"telo.span.outcome":"ok","telo.span.duration_ms":4,"telo.span.parent_span_id":"fb03…","telo.resource.kind":"Run.Sequence","telo.resource.name":"writeFile"}}
```

The record carries the span's own trace and span ids, the same ones on every log
record emitted inside that span, so filtering on a trace id gives you both.
`level:` sets the record's severity (default `info`).

`tracing:` belongs to the root Application only. A library cannot turn tracing
on for the application that imports it — `telo check` refuses it.

Only the sinks the list names are attached. A trace sink declared somewhere else
— on its own at the top level, or inside an imported library — receives nothing,
and `telo check` warns `SINK_UNATTACHED` at it. To use a sink declared as its own
resource, list it: `- !ref collector`.

## Shipping spans to a collector

The `otlp` module's `OTLP.TraceSink` exports spans to an OpenTelemetry
collector over OTLP/JSON:

```yaml
imports:
  OTLP: oci://ghcr.io/telorun/otlp@<version>
variables:
  otlpEndpoint:
    env: OTLP_ENDPOINT
    type: string
    default: ""
tracing:
  sinks:
    - sink:
        kind: OTLP.TraceSink
        endpoint: !interpolate "${{ variables.otlpEndpoint }}/v1/traces"
        resourceAttributes:
          service.name: my-app
      when: !cel "variables.otlpEndpoint != ''"
    - sink:
        kind: Telo.LogTraceSink
      when: !cel "variables.otlpEndpoint == ''"
```

## Attaching a sink conditionally

An entry in `tracing.sinks` is a sink, or `{ sink, when }` — the sink (inline or
`!ref`) and a condition resolved once at startup, with `variables`, `secrets`
and `ports` in scope. `false` leaves the sink unattached — the example above
exports to the collector when an endpoint is configured and to the logs
otherwise. With every sink unattached, tracing stays off. `logging.sinks` takes
the same two entry forms.

## What a span carries

- its trace id, span id and parent span id;
- a name — `invoke <resource>`, `run <resource>`, or whatever a controller named
  the span it opened;
- start and end times;
- an outcome: `ok`, `rejected` (a coded error), `failed` (anything else),
  `cancelled` or `parked` (a durable run waiting);
- `error.type` when it was rejected or failed — the error's code, never its
  message;
- `telo.cancellation.reason` when it was cancelled;
- `telo.resource.kind` / `telo.resource.name` on a dispatch span;
- the attributes its contract or its controller declares.

A span **never** carries the dispatch's inputs, outputs or CEL scope. Payload
stays out of the trace backend.

## Putting a value on a span

To see a value of the call on its span — a conversation id, an exit code — mark
the property in the resource's contract with `x-telo-span-attribute`:

```yaml
kind: Run.Sequence
metadata:
  name: checkFile
inputType:
  kind: Telo.JsonSchema
  schema:
    type: object
    properties:
      path: { type: string }
outputType:
  kind: Telo.JsonSchema
  schema:
    type: object
    properties:
      exitCode:
        type: integer
        x-telo-span-attribute: telo.check.exit_code
```

An input property lands on every span of the call, an output property on a span
that ended `ok`. The mark goes on a scalar property the contract reaches through
`properties` — a `$defs` entry or a named shape a property references counts —
not on an array item, a map value or the whole contract, and never beside
`x-telo-sensitive: true`. `telo check` reports a misplaced mark
(`SPAN_ATTRIBUTE_MISPLACED`) and a malformed name (`SPAN_ATTRIBUTE_INVALID`);
names are dot-separated lowercase segments, `telo.check.exit_code`.

## Requests and upstream traces

An HTTP server opens one span per request — `GET /api/items`, named after the
matched route — before anything runs for it, and the request's mount guard,
body parser and handler all run beneath it. A request carrying a W3C
`traceparent` header joins the caller's trace, under the caller's span; an
invalid one is ignored and the request roots a trace of its own. See the
`http-server` module's tracing docs for the attributes and outcomes.

## Opening a span from a controller

A controller that does work worth seeing — a model call, a tool call — opens a
span with `ctx.openSpan(ctx, { ref, label, attributes })`, dispatches on the
span's `context`, and closes it with `settle(outcome, { attributes })`. A span
opened on a dispatch's context is that dispatch's child. A transport receiving
work from outside passes the W3C headers it received as
`inbound: { traceparent, tracestate }`, and the span continues that trace. While
tracing is off, `openSpan` hands back the context unchanged and `settle` does
nothing.

## Metrics

There is no separate metrics signal. A counter or a latency distribution is an
aggregation over spans — the count of `execute_tool` spans, the durations of
`chat` spans — computed by the backend receiving them.

## Reference

The normative contract is [`kernel/specs/tracing.md`](https://github.com/telorun/telo/blob/main/kernel/specs/tracing.md).
