# SSE Codec

Server-Sent Events codec — event-record stream ↔ byte iterables. The encoder produces one SSE frame per item (`event: <type>\ndata: <json>\n\n`).

## Why use this

- **Drop-in for `text/event-stream`** — register `Sse.Encoder` on an `Http.Server` to expose any async iterable as an SSE stream.
- **Typed event records** — items carry `{ event, data }`, so producers stay schema-checked.
- **Implements the `Codec.Encoder` abstract** — consumers that depend on `Codec.Encoder` get SSE for free at the import boundary.

## Kinds

| Kind | Purpose |
| --- | --- |
| `Sse.Encoder` | Encode an async iterable of event records into SSE frames. |

## Example

```yaml
kind: Telo.Import
metadata: { name: Sse }
source: std/sse-codec@latest
---
kind: Http.Server
metadata: { name: Stream }
encoders:
  text/event-stream: { kind: Sse.Encoder, name: Out }
```
