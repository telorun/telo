# Emitting a record

`Log.Emit` is an invocable with no configuration. Each call emits exactly one log record and returns `{}`. The module exports one instance, `Log.emit`; declare your own only if you want a record attributed to a resource name of your choosing.

## Input

| Field | Type | Meaning |
| --- | --- | --- |
| `level` | `trace` \| `debug` \| `info` \| `warn` \| `error` \| `fatal` | Severity. Required. |
| `message` | string | The record's headline. Required. |
| `attributes` | map | Optional structured data. Each value is a string, boolean, integer, number, `null`, or a list or map of those, at any depth. |

The contract is closed: an unknown key or a level outside the six names is `CONTRACT_INPUTS_MISMATCH` at `telo check`, and `ERR_INPUT_INVALID` for a value only known at run time.

## The record

The record is emitted through the emitting resource's logger, so it is indistinguishable in shape from the runtime's own records (see the logging guide, `docs/guides/logging.md`, and `kernel/specs/logging.md`):

- `resource` is the `Log.Emit` instance (`emit` for the exported one), and `scope` is the import alias path of the `Log` module — `Log` when the application imports it under that alias. That path is what an import's `logging: { level }` names, so raising it silences these records without touching anything else.
- `trace_id` / `span_id` are those of the call that invoked it, when it runs inside a traced dispatch.
- The scope's threshold applies: a record below it is dropped, which is not an error.
- Redaction applies to `attributes`: a value bound to `secrets:` is replaced automatically, and `logging.redact.paths` names further attribute paths. The message is free text and is not scrubbed — keep secrets out of it.
- Every sink the application lists in `logging.sinks` receives it.

`fatal` is a severity, not control flow: it flushes the sinks immediately and does not stop the application.
