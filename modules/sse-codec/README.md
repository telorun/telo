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
| `Sse.Decoder` | Parse a byte stream of SSE frames back into one record per frame, emitted as each arrives. |

`Sse.Decoder` streams rather than collecting: the whole point of the format is
that a frame is usable the moment it lands, and buffering to the end would make
every consumer wait for the response to finish. `data` is handed over as **text**
and never parsed — the format says nothing about what a payload is, and a stream
carrying JSON frames routinely ends with a sentinel that is not JSON
(`data: [DONE]`), so parsing here would fail on the one frame announcing the
stream is over.

Comments and keep-alives dispatch nothing, multi-line payloads are joined with
newlines, and an `id` persists across frames as a stream cursor. A trailing frame
that never got its blank line **is** dispatched, departing from the EventSource
rule that discards it: that rule serves a reconnecting browser stream where the
partial event arrives again, and a one-shot HTTP response has no second delivery.

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

If the upstream iterable throws mid-stream, the encoder emits a terminal
`event: error` frame and ends. That tells the client, but by then the stream is
already with the transport, so the failure never reaches the caller and the
response still completes `200` — the encoder therefore also logs it at `error`,
which is the only server-side report of a stream that died halfway.

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
