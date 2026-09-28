# `Otlp.TraceSink`

> Examples assume the alias `Otlp` for this module.

Exports the application's finished trace spans to an OpenTelemetry collector's
traces endpoint as OTLP/JSON. It extends the kernel's `Telo.TraceSink`, so it is
listed in the root Application's `tracing.sinks` — inline or by `!ref` — and
attaching it is what turns tracing on (normative: `kernel/specs/tracing.md`).
Only a listed sink is attached: one declared on its own and not listed exports
nothing. To attach it only under a condition, write the entry as
`{ sink, when }`, as below.

```yaml
kind: Telo.Application
metadata:
  name: my-app
imports:
  Otlp: oci://ghcr.io/telorun/otlp@<version>
variables:
  otlpEndpoint:
    env: OTLP_ENDPOINT
    type: string
    default: ""
secrets:
  collectorToken:
    env: OTLP_TOKEN
    type: string
    default: ""
tracing:
  sinks:
    - sink:
        kind: Otlp.TraceSink
        endpoint: !interpolate "${{ variables.otlpEndpoint }}/v1/traces"
        headers:
          authorization: !cel "'Bearer ' + secrets.collectorToken"
        resourceAttributes:
          service.name: my-app
          service.version: !cel "module.version"
      when: !cel "variables.otlpEndpoint != ''"
```

## Fields

| Field | Required | Meaning |
|---|---|---|
| `endpoint` | yes | The collector's OTLP/JSON traces endpoint (typically `…/v1/traces`). |
| `headers` | no | Extra request headers, typically credentials — read them from `secrets:`. |
| `resourceAttributes` | no | OTel resource attributes on every batch. `service.name` falls back to `unknown_service:<executable>`. |
| `timeout` | no | Per-request timeout (default `10s`). |
| `buffer` | no | Spans held before the drop policy applies (default `8192`). |
| `on_full` | no | `drop_new` (default) or `drop_old`. `block` is refused at load. |
| `flush_interval` | no | Max time a span sits buffered (default `1s`). |

## What is exported

One `ExportTraceServiceRequest` per flush, one span per finished span:

- `traceId`, `spanId`, `parentSpanId` as hex, `startTimeUnixNano` /
  `endTimeUnixNano` as decimal strings, `kind` `1` (internal);
- the span's attributes as an OTLP attribute list, plus `telo.span.outcome`
  (`ok`, `rejected`, `failed`, `cancelled`, `parked`);
- `status`: `1` (OK) for `ok`, `2` (ERROR) for `rejected` and `failed` with the
  span's `error.type` as the message, `0` (UNSET) for `cancelled` and `parked`,
  which neither succeeded nor failed.

A span never carries the dispatch's inputs or outputs — only what a contract
marks with `x-telo-span-attribute` or a controller declares.

## Delivery

Spans are buffered and POSTed in batches on `flush_interval`, and whatever is
still buffered is exported when the application shuts down. Delivery is a
network round-trip, so nothing here is synchronously flushable: spans held only
in this sink may be lost if the process dies at once. A failed export counts the
whole batch as dropped in the runtime's drop accounting and logs a warning
naming the endpoint and the reason.
