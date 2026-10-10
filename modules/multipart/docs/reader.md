---
description: "Multipart.Reader: read a multipart payload incrementally — a stream of parts, each a stream of bytes"
sidebar_label: Multipart.Reader
---

# Multipart.Reader

> Examples below assume this module is imported with an `imports:` entry under alias `Multipart`. Kind references follow that alias — substitute your own if you import it under a different name.

Reads a received multipart payload **incrementally**: `parts` is a stream, and each part's `content` is its own stream of bytes.

## Reader or Decoder?

[`Multipart.Decoder`](./decoder.md) collects every part whole and hands back a list. That is the right default — parts become ordinary values you can assert on and pass around — and it is bounded by its limits: 8 MiB a part and 16 MiB in all, by default.

Reach for `Reader` when that bound is the problem: a file upload is exactly the case where holding a part whole is wrong, and raising the cap only moves the allocation. Memory here is bounded by one upstream chunk regardless of how large a part is.

## Inputs and output

| Input | Description |
| --- | --- |
| `input` | The received payload, as a byte stream. |
| `contentType` | The media type the sender used, carrying the boundary. |
| `maxPartBytes` | Largest content one part may hold, in bytes; its headers and framing are not counted. Omitted: no limit. Counted whether the part is read or skipped. |
| `maxParts` | Most parts the payload may hold. Default `1000`. |
| `maxTotalBytes` | Most bytes read from `input`, counting everything — framing, headers and content. Omitted: no limit. |

Each limit is an integer of at least 1; a literal below that is `CONTRACT_INPUTS_MISMATCH`. The two byte limits have no default because nothing is held: a part is streamed, so its size costs no memory here. Set them when the destination is what must be protected — and note that over HTTP the server's `maxBodyBytes` (1 MiB by default) bounds the whole request before any of these do.

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

## Failures

The same two codes as the decoder, both declared, so a route's `catches:` names them and `telo check` reports a route that covers neither (`UNCOVERED_THROW_CODE`):

| Code | `error.data` | Raised when |
| --- | --- | --- |
| `ERR_MULTIPART_MALFORMED` | `{ reason }` | The payload is not well-formed multipart. |
| `ERR_MULTIPART_LIMIT_EXCEEDED` | `{ limit, max, part?, name? }` | The payload crossed one of the limits. |

`reason` is one of:

| `reason` | Meaning |
| --- | --- |
| `boundary-missing` | `contentType` is empty or carries no `boundary=` parameter. |
| `truncated` | The payload ends before its closing boundary. |
| `header-malformed` | A part's header block holds a line that is not `name: value` — as when a part has no blank line before its content. |
| `header-too-large` | A part's header block passes 64 KiB with no blank line. |

`limit` is the name of the input that was exceeded (`maxPartBytes`, `maxParts` or `maxTotalBytes`) and `max` its value. `part` is the zero-based position of the part concerned (absent for `maxTotalBytes`), and `name` its form field name when `maxPartBytes` was exceeded by a part that declared one. The data is typed, so `error.data.limt` in a catch is `CEL_UNKNOWN_FIELD`.

```yaml
catches:
  - when: !cel "error.code == 'ERR_MULTIPART_MALFORMED'"
    status: 400
    content:
      application/json:
        body: { error: malformed_upload, reason: !cel "error.data.reason" }
  - when: !cel "error.code == 'ERR_MULTIPART_LIMIT_EXCEEDED'"
    status: 413
    content:
      application/json:
        body: { error: upload_too_large, limit: !cel "error.data.limit", max: !cel "error.data.max" }
```

### When they are raised

Only a missing boundary rejects the call, and it releases the input first, although nothing of it was read. Everything else is found **as the streams are drained**, so it surfaces wherever they are read — the step collecting a part's `content`, or the iteration asking for the next part. The first failure ends the read:

- the pull in progress fails with the coded error;
- the `parts` stream fails with the same error on its next pull, and delivers no further part;
- the source is released.

The `parts` stream answers for the input from the moment the call returns: a consumer that gives `parts` up without pulling a single part releases the input all the same.

A route whose handler drains the parts renders the failure through its `catches:` like any other throw. A route that has already started a streamed response when the failure arrives cannot: its status was sent.

A failure of the source itself — the request was cancelled, the connection dropped — is not reworded: it is rethrown as it was raised.
