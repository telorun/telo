# Plain Text Codec

Plain-text codec — UTF-8 string ↔ byte iterables. The encoder accepts `{delta: string}` (the AI streaming shape), bare strings, or `Uint8Array`. The decoder concatenates every chunk into a single string.

## Why use this

- **AI-streaming friendly** — accepts the `{delta: string}` shape that `Ai.TextStream` emits, so AI output streams to HTTP responses without a glue step.
- **Symmetric** — implements both `Codec.Encoder` and `Codec.Decoder` for text request/response bodies.
- **UTF-8 by default** — no encoding negotiation required for common text payloads.

## Kinds

| Kind | Purpose |
| --- | --- |
| `PlainText.Encoder` | Encode strings (or `{delta}` records) into UTF-8 bytes. |
| `PlainText.Decoder` | Collect UTF-8 byte chunks into a single string. |

## Example

```yaml
kind: Telo.Application
metadata: { name: plain-text-stream, version: 1.0.0 }
imports:
  PlainText: std/plain-text-codec@0.6.0
  Http: std/http-server@0.19.1
  Stream: std/stream@0.5.0
ports:
  http: { env: PORT, default: 3000 }
targets: [ !ref Server ]
---
kind: Stream.Of
metadata: { name: Lines }
items: [ "hello ", "telo" ]
---
kind: PlainText.Encoder
metadata: { name: Out }
---
kind: Http.Api
metadata: { name: Api }
routes:
  - request: { path: /text, method: GET }
    handler: !ref Lines
    returns:
      - status: 200
        mode: stream            # pipe the handler's stream through an encoder
        content:
          text/plain:
            encoder: !ref Out
---
kind: Http.Server
metadata: { name: Server }
port: !cel "ports.http"
mounts:
  - path: /
    mount: !ref Api
```
