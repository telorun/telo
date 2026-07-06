# SSE Codec

Server-Sent Events codec — event-record stream ↔ byte iterables. The encoder produces one SSE frame per item (`[id: <id>\n]event: <type>\ndata: <json>\n\n`).

## Why use this

- **Drop-in for `text/event-stream`** — register `Sse.Encoder` on an `Http.Server` to expose any async iterable as an SSE stream.
- **Typed event records** — items carry `{ event, data }`, so producers stay schema-checked.
- **Implements the `Codec.Encoder` abstract** — consumers that depend on `Codec.Encoder` get SSE for free at the import boundary.

## Kinds

| Kind | Purpose |
| --- | --- |
| `Sse.Encoder` | Encode an async iterable of event records into SSE frames. |

## Record shape

Each item is an object: an optional `type` becomes the SSE `event:` (default
`message`), an optional `id` (string/number) becomes the SSE `id:` line — the
`Last-Event-ID` reconnection cursor — and the remaining fields become the
JSON-encoded `data:` payload. A bare string frames as a `message` event whose
data is the JSON-encoded string.

Because a typeless object frames as a `message` event with an `id:` line, a
`{ id, data }` replay-journal envelope (from `RecordStream.JournalSource`) can be
piped straight to the encoder for a **resumable** stream — the client checkpoints
`id` and reconnects with `?lastEventId=` (or the native `Last-Event-ID` header).

## Example

```yaml
kind: Telo.Application
metadata: { name: sse-stream, version: 1.0.0 }
imports:
  Sse: std/sse-codec@latest
---
kind: Http.Server
metadata: { name: Stream }
encoders:
  text/event-stream: { kind: Sse.Encoder, name: Out }
```
