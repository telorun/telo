---
description: "Multipart.Reader: read a multipart payload incrementally — a stream of parts, each a stream of bytes"
sidebar_label: Multipart.Reader
---

# Multipart.Reader

> Examples below assume this module is imported with an `imports:` entry under alias `Multipart`. Kind references follow that alias — substitute your own if you import it under a different name.

Reads a received multipart payload **incrementally**: `parts` is a stream, and each part's `content` is its own stream of bytes.

## Reader or Decoder?

[`Multipart.Decoder`](./decoder.md) collects every part whole and hands back a list. That is the right default — parts become ordinary values you can assert on and pass around — and it is bounded by `maxPartBytes`, 8 MiB by default.

Reach for `Reader` when that bound is the problem: a file upload is exactly the case where holding a part whole is wrong, and raising the cap only moves the allocation. Memory here is bounded by one upstream chunk regardless of how large a part is.

## Inputs and output

| Input | Description |
| --- | --- |
| `input` | The received payload, as a byte stream. |
| `contentType` | The media type the sender used, carrying the boundary. |

`parts` is a stream of `{content, headers, contentType?, name?, filename?}`, where `content` is itself a byte stream.

## Skipping a part is safe

The usual objection to this shape is that the source is single-pass: a consumer that moves to part 3 without draining part 2 would read nothing, silently, because the cursor is still mid-part.

**Advancing discards the remainder.** Moving to the next part consumes whatever is left of the current one and throws it away — reading nothing into memory. So a consumer that inspects headers and skips bodies is correct by construction, and what would otherwise be an ordering contract it could violate without noticing is simply not violable.

That holds for a **partial** read too, not only for skipping a part whole. Stopping halfway through a body closes the stream you were handed, which is not the same as finishing it; the reader drains its own source rather than the stream it gave you, so "never started" and "stopped early" end in the same place.

```yaml
kind: Run.Iteration
metadata: { name: OverParts }
inputType:
  kind: Telo.JsonSchema
  schema:
    type: object
    properties:
      parts:
        x-telo-type:
          name: Telo.Stream
          of:
            type: object
            properties:
              name: { type: string }
              content:
                x-telo-type: { name: Telo.Stream, of: Telo.Bytes }
collection: !cel "inputs.parts"
concurrency: 1          # parts arrive in order; do not process them concurrently
steps:
  - name: Store
    if: !cel "item.name == 'file'"
    then:
      - name: Write
        inputs:
          path: !cel "'/uploads/' + item.filename"
          content: !cel "item.content"
        invoke: !ref SaveFile
```

Declaring the `of` argument on the iteration's `inputType` is what keeps `item.name` and `item.content` typed inside the body.

`concurrency: 1` is not decoration: parts share one cursor, so processing several at once has no meaning here.
