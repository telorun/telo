# Codec

The `Encoder` and `Decoder` abstracts — `Invocable` contracts that every concrete stream codec implements. Format-specific codec modules (`plain-text-codec`, `ndjson-codec`, `octet-codec`, `sse-codec`) extend these so downstream consumers can write transport-neutral pipelines.

## Why use this

- **Transport-neutral** — write once against `Codec.Encoder` / `Codec.Decoder`; swap the backing format at the import boundary without touching consumer manifests.
- **Stream-first** — both abstracts operate on `AsyncIterable<Uint8Array>` (encoder output) and `AsyncIterable<T>` (decoder output), so memory stays bounded for large payloads.
- **Composes with `Run.Sequence`** — codec invocations slot into pipelines like any other step.

## Kinds (abstracts)

| Kind | Purpose |
| --- | --- |
| `Codec.Encoder` | Abstract: encode an async iterable of records into a byte stream. |
| `Codec.Decoder` | Abstract: decode a byte stream into an async iterable of records (or a single value). |

These are abstracts, not runnable resources — concrete codec modules implement them.

## Example

A consumer reads `Codec.Encoder` polymorphically:

```yaml
kind: Telo.Application
metadata: { name: codec-stream, version: 1.0.0 }
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
# Any kind extending Codec.Encoder fits the route's `encoder:` slot — swapping
# the wire format is swapping this one resource.
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
        mode: stream
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
