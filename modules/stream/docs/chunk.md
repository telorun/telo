---
description: "Stream.Chunk: re-frame a byte stream into fixed-size pieces, each carrying its own offset"
sidebar_label: Stream.Chunk
---

# Stream.Chunk

> Examples below assume this module is imported with an `imports:` entry under alias `Stream`. Kind references follow that alias — substitute your own if you import it under a different name.

Re-frames a stream of bytes into consecutive pieces of a fixed size. The boundaries a byte stream arrives with are an artifact of the transport — a socket read, a file read-ahead — and are almost never the ones a consumer wants: a resumable upload needs the size the far end mandates, a framed protocol needs its frame size. So this both **coalesces** (buffering across a piece that is too small) and **splits** (cutting one that is too large). Only the final piece is short.

One piece is held in memory at a time, so chunking a source larger than memory is exactly what it is for.

## Fields

| Field | Description |
| --- | --- |
| `size` | Default bytes per piece, used when a call supplies none. Declare it here when the size is a property of the destination rather than of the call. |

## Inputs

| Input | Description |
| --- | --- |
| `input` | The byte stream to re-frame. |
| `size` | Bytes per piece, overriding the declared `size`. Supplied per call for a size the far end dictates — a resumable upload negotiates one. |

## Output

`output` is a stream of records:

| Field | Description |
| --- | --- |
| `bytes` | This piece's bytes. |
| `offset` | Byte offset of this piece from the start of the stream. |
| `length` | Number of bytes in this piece. |
| `index` | Zero-based position in the sequence. |
| `last` | True for the final piece, so a consumer can close its framing. |

`offset` and `last` travel **with the piece** rather than being derived downstream, which is what makes positional framing expressible in CEL at the point of use — an iteration body has nowhere to accumulate a running offset.

## Example — a resumable upload

Each piece becomes one request, with a `Content-Range` built from the record:

```yaml
- name: Chunks
  inputs:
    input: !cel "steps.Read.result.output"
    size: 786432          # 768 KiB — a multiple of 256 KiB, as Drive requires
  invoke:
    kind: Stream.Chunk

- name: Upload
  inputs:
    chunks: !cel "steps.Chunks.result.output"
    total: !cel "steps.Stat.result.size"
  invoke: !ref PutChunks
```

where `PutChunks` is a `Run.Iteration` over the chunk stream:

```yaml
kind: Run.Iteration
metadata: { name: PutChunks }
inputType:
  kind: Telo.JsonSchema
  schema:
    type: object
    required: [chunks, total]
    properties:
      chunks:
        x-telo-type:
          name: Telo.Stream
          of:
            type: object
            properties:
              bytes: { x-telo-type: Telo.Bytes }
              offset: { type: integer }
              length: { type: integer }
              last: { type: boolean }
      total: { type: integer }
collection: !cel "inputs.chunks"
concurrency: 1
steps:
  - name: Put
    inputs:
      url: !cel "inputs.uploadUrl"
      method: PUT
      headers:
        Content-Range: !cel "'bytes ' + string(item.offset) + '-' + string(item.offset + item.length - 1) + '/' + string(inputs.total)"
      body: !cel "item.bytes"
    invoke: !ref ChunkPut
```

Declaring the `of` argument is what keeps `item.offset` and `item.bytes` **type-checked** inside the body — without it the element is `dyn` and a typo goes unreported.

Each chunk is a `Telo.Bytes` value rather than a stream, so it is **replayable**: a chunk that fails on a retryable status is re-sent unchanged. A whole-file stream body is single-shot and cannot be, which is the practical reason to chunk a large upload rather than stream it in one request.

## Notes

- An **empty source yields nothing**. Emitting a final empty piece would make `last` arrive with no bytes, and a consumer sending it would issue a zero-length request.
- A **string element is decoded as UTF-8** rather than rejected — a text codec upstream is an ordinary pipeline. Any other value type is an error, never a silent coercion.
- Each emitted record **owns its bytes**; nothing aliases the internal carry buffer.
