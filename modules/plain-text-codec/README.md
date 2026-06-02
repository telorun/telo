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
  PlainText: std/plain-text-codec@latest
---
kind: Http.Server
metadata: { name: Stream }
encoders:
  text/plain: { kind: PlainText.Encoder, name: Out }
```
