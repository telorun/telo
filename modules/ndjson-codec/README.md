# NDJSON Codec

NDJSON codec — JSON-record stream ↔ byte iterables. The encoder produces one JSON-encoded record per line (`JSON.stringify(item) + "\n"`).

## Why use this

- **Streaming-native** — emits records as they arrive; no buffering of the full batch.
- **Newline-delimited** — line-based framing is trivial for downstream parsers and `tail -f` debugging.
- **Implements the `Codec.Encoder` abstract** — drops into any consumer that takes a `Codec.Encoder` (HTTP responses, file writers, etc.).

## Kinds

| Kind | Purpose |
| --- | --- |
| `Ndjson.Encoder` | Encode an async iterable of JSON records into NDJSON bytes. |

## Example

```yaml
kind: Telo.Application
metadata: { name: ndjson-stream, version: 1.0.0 }
imports:
  Ndjson: std/ndjson-codec@latest
---
kind: Http.Server
metadata: { name: Stream }
encoders:
  application/x-ndjson: { kind: Ndjson.Encoder, name: Out }
```
