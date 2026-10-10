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

The payload is written for a reader that is not Telo, so a CEL value JSON has no
form for is written in its plain encoding: a timestamp as RFC 3339 text in UTC, a
duration as seconds (`"5400s"`), bytes as base64url, a `uint` as its digits.

Because a typeless object frames as a `message` event with an `id:` line, a
`{ id, data }` replay-journal envelope (from `RecordStream.JournalSource`) can be
piped straight to the encoder for a **resumable** stream — the client checkpoints
`id` and reconnects with `?lastEventId=` (or the native `Last-Event-ID` header).

If the upstream iterable throws mid-stream, the encoder emits a terminal
`event: error` frame and ends. That tells the client, but by then the stream is
already with the transport, so the failure never reaches the caller and the
response still completes `200` — the encoder therefore also logs it at `error`,
which is the only server-side report of a stream that died halfway.

## Writing frames from another module's controller

A transport that writes its own event stream — rather than encoding a
handler's — formats frames with the same functions the encoder uses. The module
declares them as a code entry, `@telorun/sse-codec`, which a module importing
this one resolves from its controller:

```ts
import { sseComment, sseFrame } from "@telorun/sse-codec";

response.write(sseFrame({ type: "hello", bundle }, "My.Mount 'admin'"));
response.write(sseComment("keepalive", "My.Mount 'admin'"));
```

| Function | Returns |
| --- | --- |
| `sseFrame(item, owner)` | one frame for a record or a string, exactly as the encoder frames it |
| `sseComment(text, owner)` | a comment line — what keeps an idle connection open, and dispatches nothing in a reader |

`owner` names the writer in a refusal (`ERR_INVALID_INPUT`): an item that is
neither an object nor a string, a `type` or `id` holding a line break, a
comment holding one.

## Reading frames from another module's controller

A controller that receives an event stream — a provider reading a streamed HTTP
response — parses it with the reader `Sse.Decoder` runs, from the same code
entry:

```ts
import { readSseRecords } from "@telorun/sse-codec";

for await (const record of readSseRecords(body, "My.Client 'feed'", { maxFrameBytes: 1 << 20 })) {
  handle(record.event, record.data);
}
```

| Function | Returns |
| --- | --- |
| `readSseRecords(input, owner, bounds?)` | an async generator of `{ event, data, id?, retry? }`, one per dispatched frame, by the decoder's rules |

`input` is an async iterable of byte chunks (or text). Each record is yielded as
its frame completes, and a consumer that stops early returns `input`, so a
transport behind it is told nobody is reading. A failure of `input` itself passes
through unchanged.

Two bounds keep a broken or hostile peer from turning a stream into memory:

- **A line** — more than 1 MiB arriving with no line terminator is refused. Always
  applied, and the only bound `Sse.Decoder` applies.
- **A frame** — `bounds.maxFrameBytes`, when given, is the most payload one frame
  may accumulate across its `data:` lines before the blank line that ends it,
  each line counted with the newline that joins it. Without it a frame is
  unbounded.

Both refusals, and a chunk that is neither bytes nor text, are `ERR_INVALID_INPUT`
naming `owner`. A reader with a failure vocabulary of its own re-raises them
under its own code.

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
