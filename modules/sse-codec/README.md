# SSE Codec

Server-Sent Events codec — frame stream ↔ byte iterables. The encoder writes one SSE frame per `Frame` record (`[id: <id>\n][event: <event>\n][retry: <ms>\n]data: <json>\n\n`).

## Why use this

- **Drop-in for `text/event-stream`** — register `Sse.Encoder` on an `Http.Server` to expose any async iterable as an SSE stream.
- **Typed frames** — items are `Sse.Frame` records `{ data, event?, id?, retry? }`, and a `Stream.Map` declaring `elementType: !ref Sse.Frame` is checked against that shape before the app runs.
- **Implements the `Codec.Encoder` abstract** — consumers that depend on `Codec.Encoder` get SSE for free at the import boundary.

## Kinds

| Kind | Purpose |
| --- | --- |
| `Sse.Encoder` | Encode an async iterable of `Sse.Frame` records into SSE bytes. |
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

## Frames

Each item is an `Sse.Frame` (exported as a shape, written `!ref Sse.Frame`), a closed object:

| Member | Written as |
| --- | --- |
| `data` (required, any JSON value) | `data: <json>` — one line, the value's plain JSON encoding |
| `event` (string, no line break, not empty) | `event: <event>`; omitted, no line is written and a reader takes the event as `message` |
| `id` (string with no line break, or integer) | `id: <id>` — the cursor a client sends back as `Last-Event-ID` |
| `retry` (integer ≥ 0) | `retry: <ms>` — the reconnection delay a client should use |

The lines are written in the order `id`, `event`, `retry`, `data`, then a blank
line. A keep-alive is not a frame: it is transport timing, written with
`sseComment` by whatever owns the connection.

Records of another shape are made into frames upstream, with `Stream.Map`:

```yaml
- name: frames
  invoke:
    kind: Stream.Map
    elementType: !ref Sse.Frame
    value: { id: !cel "item.id", event: !cel "item.type", data: !cel "item" }
  inputs: { input: !cel "steps.source.result.output" }
```

`elementType` is what holds `value` to the frame shape when the manifest is
checked: a misspelt member is refused before the app runs.

The encoder's `input` is declared as a stream of `Frame`s, so a stream whose
producer declares its element (`x-telo-type: { name: Telo.Stream, of: … }` in its
`outputType`) is held to the frame shape when the manifest is checked, and one of
another shape is refused before the app runs. A stream that declares no element —
`Stream.Of`'s and `Stream.Map`'s output among them — is not judged statically, and
reaches the run-time refusal below.

The payload is written for a reader that is not Telo, so a CEL value JSON has no
form for is written in its plain encoding: a timestamp as RFC 3339 text in UTC, a
duration as seconds (`"5400s"`), bytes as base64url, a `uint` as its digits.

A `{ id, data }` replay-journal envelope (from `RecordStream.JournalSource`) is
already a frame, so it can be piped straight to the encoder for a **resumable**
stream — the client checkpoints `id` and reconnects with `?lastEventId=` (or the
native `Last-Event-ID` header).

### When the stream fails

A value that is not a frame — an unknown member, no `data`, a field holding a
line break, an `id` that is neither text nor an integer — is refused with
`ERR_INVALID_INPUT`, and ends the stream exactly as a failure of the upstream
iterable does: with a terminal frame

```
event: error
data: {"message":"…","code":"…"}
```

(`code` only when the failure carries one), and then the stream ends. That tells
the client, but by then the stream is already with the transport, so the failure
never reaches the caller and the response still completes `200` — the encoder
therefore also logs it at `error`, which is the only server-side report of a
stream that died halfway. To end a failing stream with a frame of your own
instead, put `Stream.Recover` before the encoder.

## Writing frames from another module's controller

A transport that writes its own event stream — rather than encoding a
handler's — formats frames with the same functions the encoder uses. The module
declares them as a code entry, `@telorun/sse-codec`, which a module importing
this one resolves from its controller:

```ts
import { sseComment, sseFrame } from "@telorun/sse-codec";

response.write(sseFrame({ event: "hello", data: { bundle } }, "My.Mount 'admin'"));
response.write(sseComment("keepalive", "My.Mount 'admin'"));
```

| Function | Returns |
| --- | --- |
| `sseFrame(frame, owner)` | the wire text of one `Frame`, exactly as the encoder writes it |
| `sseComment(text, owner)` | a comment line — what keeps an idle connection open, and dispatches nothing in a reader |

`owner` names the writer in a refusal (`ERR_INVALID_INPUT`): a value that is not
a frame, a field holding a line break, a comment holding one.

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
metadata: { name: SseStream, version: 1.0.0 }
imports:
  Sse: oci://ghcr.io/telorun/sse-codec@<version>
  Http: oci://ghcr.io/telorun/http-server@<version>
  Stream: oci://ghcr.io/telorun/stream@<version>
ports:
  http: { env: PORT, default: 3000 }
targets: [!ref server]
---
kind: Telo.Sequence
metadata: { name: events }
steps:
  - { name: ticks, invoke: { kind: Stream.Of, items: [{ at: 1 }, { at: 2 }] } }
  - name: frames
    invoke: { kind: Stream.Map, elementType: !ref Sse.Frame, value: { event: tick, data: !cel "item" } }
    inputs: { input: !cel "steps.ticks.result.output" }
outputs:
  output: !cel "steps.frames.result.output"
---
kind: Http.Api
metadata: { name: api }
routes:
  - request: { path: /events, method: GET }
    handler: !ref events
    returns:
      - status: 200
        mode: stream # pipe the handler's stream through an encoder
        content:
          text/event-stream: { encoder: { kind: Sse.Encoder } }
---
kind: Http.Server
metadata: { name: server }
listen: { port: !cel "ports.http" }
mounts:
  - { path: /, mount: !ref api }
```
