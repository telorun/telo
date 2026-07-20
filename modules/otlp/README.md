# std/otlp

Export Telo's structured log records to an OpenTelemetry collector over
OTLP/JSON.

`Otlp.Sink` is a log sink: declare it as a resource, then point the root
Application's `logging.sinks` at it with a `!ref`. It ships as a module rather
than a kernel built-in because it is optional and needs wiring — an endpoint,
credentials, and a timeout — all of which the resource graph already models.

```yaml
kind: Telo.Application
metadata:
  name: my-app
imports:
  Otlp: std/otlp@0.1.0
secrets:
  collectorToken:
    env: OTLP_TOKEN
    type: string
logging:
  level: info
  sinks:
    - kind: Telo.ConsoleSink
    - !ref shipped
---
kind: Otlp.Sink
metadata:
  name: shipped
endpoint: https://collector.example.com/v1/logs
headers:
  authorization: !cel "'Bearer ' + secrets.collectorToken"
resourceAttributes:
  service.name: my-app
```

## Fields

| Field | Required | Meaning |
|---|---|---|
| `endpoint` | yes | Collector's OTLP/JSON logs endpoint. |
| `headers` | no | Extra request headers, typically credentials. |
| `resourceAttributes` | no | OTel resource attributes on every batch. |
| `timeout` | no | Per-request timeout (default `10s`). |
| `level` | no | Minimum severity, filtered at fan-out. |
| `buffer` | no | Records held before the drop policy applies (default `8192`). |
| `on_full` | no | `drop_new` (default) or `drop_old`. |
| `flush_interval` | no | Max time a record sits buffered (default `1s`). |

The encoding is fixed at OTLP/JSON and is not configurable: a collector accepts
exactly one wire format, so offering a choice would only produce payloads it
rejects.

## Durability

This sink is **not synchronously flushable** — delivery is a network round-trip,
which cannot complete without yielding. A `fatal` record's flush is *initiated*
but not awaited, so records held only here may be lost if the process dies
immediately after.

Use `Telo.FileSink` when you need audit-grade durability; ship to a collector for
aggregation, not as the sole record of a critical event.

`on_full: block` is rejected at load on Node.js, as it is for every sink: the
event loop cannot drain a buffer while the producer is suspended.

## Redaction

Put credentials in `secrets:`. Telo redacts secret values from its own records
automatically, so a token interpolated into `headers` never appears in a log
line about this sink.

See the [logging guide](https://telo.run/docs/guides/logging) for the full
configuration surface.
