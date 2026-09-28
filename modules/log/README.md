# Log

Write a structured log record from a manifest. `Log.Emit` emits exactly one record per call — a startup warning naming what an application exposes, an audit line, a milestone in a pipeline — through the application's own logging pipeline.

## Why use this

- **One record, the runtime's own pipeline** — the record carries the emitting resource and its import scope, the active trace and span ids when it runs inside a traced call, and goes through the scope's threshold, redaction and every sink in `logging.sinks`, exactly like the runtime's own records.
- **Typed attributes** — attributes are structured values (strings, booleans, numbers, null, and lists or maps of those), not text interpolated into the message.
- **Checked statically** — the level and every input key are part of the input contract, so `telo check` refuses `level: loud` or a misspelled key.

## Kinds

| Kind | Purpose |
| --- | --- |
| `Log.Emit` | Emit one log record with a level, a message and attributes. Takes no configuration. |

The module exports a ready-made instance, `Log.emit`, so a consumer references it instead of declaring one.

## Example

```yaml
kind: Telo.Application
metadata: { name: Api, version: 1.0.0 }
imports:
  Log: oci://ghcr.io/telorun/log@<version>
secrets:
  apiToken: { env: API_TOKEN, type: string, default: "" }
targets:
  # Say out loud, once at boot, that the API is open.
  - name: warnOpen
    when: !cel "secrets.apiToken == ''"
    invoke: !ref Log.emit
    inputs:
      level: warn
      message: API_TOKEN is not set; every route is reachable without a token
      attributes: { port: 8080 }
```

## Reference

- [Emitting a record](docs/emit.md) — the input contract, what the record carries, and how thresholds and sinks apply.
