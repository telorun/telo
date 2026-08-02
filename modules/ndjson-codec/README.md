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
  Ndjson: oci://ghcr.io/telorun/ndjson-codec@0.6.0
  Http: oci://ghcr.io/telorun/http-server@0.19.1
  Stream: oci://ghcr.io/telorun/stream@0.5.0
ports:
  http: { env: PORT, default: 3000 }
targets: [ !ref Server ]
---
kind: Stream.Of
metadata: { name: Events }
items: [ { id: 1 }, { id: 2 } ]
---
kind: Ndjson.Encoder
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
          application/x-ndjson:
            encoder: !ref Out
---
kind: Http.Server
metadata: { name: Server }
port: !cel "ports.http"
mounts:
  - path: /
    mount: !ref Api
```
