# Tracing

**Wardning**: this module is planned to be implemented, it is not available yet. The README is a placeholder for the intended design and API.

Kernel event export to observability backends. A `Tracing.Provider` subscribes to the kernel's event bus and forwards selected events to one or more exporters. The module ships with `Tracing.FileExporter`; additional exporters (OTLP, stdout, etc.) can be authored as separate modules that expose `Telo.Provider` resources implementing the exporter contract.

---

## Tracing.Provider

The provider is the fan-out hub — it listens for events matching `events`, filters them by `minLevel`, buffers them, and dispatches each to every exporter in `exporters`.

```yaml
kind: Tracing.Provider
metadata:
  name: Observability
exporters:
  - TraceFile
events:
  - "Kernel.*"
  - "Http.Server.RequestCompleted"
filters:
  minLevel: info
buffer:
  maxSize: 2000
  retryAttempts: 3
  retryDelay: 500
```

- `exporters` lists exporter resource names (not `x-telo-ref` references — plain strings). Each must resolve to a `Telo.Provider` implementing the exporter contract.
- `events` accepts exact event names or glob-style prefixes ending in `*`. `["*"]` (the default) captures everything.
- `filters.minLevel` (`debug` | `info` | `error`) drops events below the threshold.
- `buffer` governs the retry policy when an exporter rejects a batch — events are held in-memory up to `maxSize`, then dropped oldest-first.

---

## Tracing.FileExporter

Writes events to a local file. Most useful for development, CI log capture, and debugging production incidents when you need a local record.

```yaml
kind: Tracing.FileExporter
metadata:
  name: TraceFile
path: ./telo-events.ndjson
format: ndjson # json | ndjson | text
mode: append # append | overwrite
pretty: false
```

Formats:

- `ndjson` — one JSON object per line. The default, and the right choice for anything you plan to ingest (`jq`, log shippers).
- `json` — a single JSON array appended on each event (or pretty-printed when `pretty: true`). Use for human reading only; not streaming-friendly.
- `text` — human-readable one-liners.

`mode: overwrite` truncates the file when the exporter initializes — useful for repeatable test runs.

---

## Full example

```yaml
kind: Tracing.FileExporter
metadata:
  name: TraceFile
path: ./traces.ndjson
format: ndjson
mode: overwrite
---
kind: Tracing.Provider
metadata:
  name: Observability
exporters:
  - TraceFile
events:
  - "Kernel.*"
  - "Run.Sequence.*"
filters:
  minLevel: info
```

Run your Application with this provider in place and every kernel/sequence event above `info` lands in `traces.ndjson`.

---

## Notes

- Subscription is live for the life of the provider resource. If you tear down an exporter mid-run, its pending buffer is flushed synchronously on `teardown`.
- Event names follow the kernel's naming scheme (e.g. `Kernel.Started`, `Kernel.ResourceInitialized`). See [kernel/docs/telemetry-and-observability.md](../../kernel/docs/telemetry-and-observability.md) for the emitter catalogue.
- For OpenTelemetry-compatible backends (OTLP, Jaeger, Honeycomb), use or write a dedicated exporter — the file exporter is not a substitute.
