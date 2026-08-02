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
  Sse: oci://ghcr.io/telorun/sse-codec@0.7.0
  Http: oci://ghcr.io/telorun/http-server@0.19.1
  Stream: oci://ghcr.io/telorun/stream@0.5.0
ports:
  http: { env: PORT, default: 3000 }
targets: [ !ref Server ]
---
kind: Stream.Of
metadata: { name: Events }
items: [ { type: tick, at: 1 }, { type: tick, at: 2 } ]
---
kind: Sse.Encoder
metadata: { name: Out }
---
kind: Http.Api
metadata: { name: Api }
routes:
  - request: { path: /events, method: GET }
    handler: !ref Events
    returns:
      - status: 200
        mode: stream            # pipe the handler's stream through an encoder
        content:
          text/event-stream:
            encoder: !ref Out
---
kind: Http.Server
metadata: { name: Server }
port: !cel "ports.http"
mounts:
  - path: /
    mount: !ref Api
```
