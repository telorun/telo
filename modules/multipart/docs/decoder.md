---
description: "Multipart.Decoder: split a received multipart payload back into its parts"
sidebar_label: Multipart.Decoder
---

# Multipart.Decoder

> Examples below assume this module is imported with an `imports:` entry under alias `Multipart`. Kind references follow that alias — substitute your own if you import it under a different name.

Splits a received multipart payload back into its parts — the inbound half, for a server accepting an upload.

## Inputs

| Input | Description |
| --- | --- |
| `input` | The received payload, as a byte stream. |
| `contentType` | The media type the sender used, carrying the boundary. Take it from the request's `Content-Type` header. |
| `maxPartBytes` | Largest content one part may hold, in bytes; its headers and framing are not counted. Default `8388608` (8 MiB). |
| `maxParts` | Most parts the payload may hold. Default `1000`. |
| `maxTotalBytes` | Most bytes read from `input`, counting everything — framing, headers and content. Default `16777216` (16 MiB). |

Each limit is an integer of at least 1; a literal below that is `CONTRACT_INPUTS_MISMATCH`.

## Output

`parts` is a list, in the order the parts appeared:

| Field | Description |
| --- | --- |
| `content` | The part's payload, as raw bytes. |
| `contentType` | Its declared media type, when it carried one. |
| `name` | The form field name from its `Content-Disposition`. |
| `filename` | The file name, when present. |
| `headers` | Every header it carried, with lowercase keys. |

`name` and `filename` are each present only when the part's `Content-Disposition` declared **that** parameter. A file part sent with a `filename` and no `name` comes back with no `name` at all — not with the file name standing in for it — so `has(part.name)` answers the question you asked. A part with no headers at all (a plain unnamed field carrying only `content`) decodes to empty `headers` rather than failing.

## The boundary comes from the header

Nothing inside a multipart body says where parts begin — the boundary is a parameter of the media type. So `contentType` is required, and one with no `boundary=` parameter is an **error** rather than a payload with zero parts. Those two outcomes are indistinguishable to a caller, and the silent one is a request that looks empty rather than malformed. A missing boundary releases the input before the call is rejected, although nothing of it was read.

```yaml
- name: Decode
  inputs:
    input: !cel "request.body"
    contentType: !cel "request.headers['content-type']"
  invoke:
    kind: Multipart.Decoder
```

## Why parts are buffered

Parts come back as a list of byte values rather than a stream of streams. The underlying source is single-pass, so a caller holding part 2 while reading part 3 would read nothing — a stream-of-streams makes out-of-order consumption a use-after-free with no error. Buffering makes the parts ordinary values, and the three limits are what keep it bounded: `maxPartBytes` caps one part, `maxParts` how many there are, and `maxTotalBytes` the payload as a whole, since a thousand small parts are as unbounded as one large one.

A limit stops the read as soon as the bytes read show it is crossed — the payload is never collected first, and reading stops within one chunk of `maxTotalBytes`.

## Failures

Two codes, both declared, so a route's `catches:` names them and `telo check` reports a route that covers neither (`UNCOVERED_THROW_CODE`):

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

A failure of the source itself — the request was cancelled, the connection dropped — is not reworded: it is rethrown as it was raised.

## Receiving over HTTP

`Http.Server` accepts a multipart body out of the box, as **raw bytes** — no `contentTypeParsers` entry needed. Raw rather than text because decoding a multipart body as a string corrupts every binary part, and the parts are the point.

Declare the route's body as a byte stream and hand it straight to the decoder:

```yaml
- request:
    path: /upload
    method: POST
    schema:
      body:
        x-telo-type: { name: Telo.Stream, of: Telo.Bytes }
  inputs:
    input: !cel "request.body"
    contentType: !cel "request.headers['content-type']"
  handler: !ref Decoder
```

A `contentTypeParsers` entry naming an exact multipart type still works and takes precedence for that type — Fastify consults its exact-string parsers before its pattern ones. It only overrides the type it names, so declaring one for `multipart/form-data` leaves `multipart/related` and `multipart/mixed` on the default.

### Two limits, one upload

The server holds every request body to its own `maxBodyBytes` — 1 MiB by default, multipart included — before the decoder's limits are consulted. An upload route over 1 MiB raises both, the route's limit and the decoder's:

```yaml
- request:
    path: /upload
    method: POST
    schema:
      body:
        x-telo-type: { name: Telo.Stream, of: Telo.Bytes }
  maxBodyBytes: 52428800
  inputs:
    input: !cel "request.body"
    contentType: !cel "request.headers['content-type']"
    maxPartBytes: 41943040
    maxTotalBytes: 52428800
  handler: !ref Decoder
```

A body over the route's `maxBodyBytes` is answered 413 by the server itself, and no `catches:` entry sees it; a payload over the decoder's limits is `ERR_MULTIPART_LIMIT_EXCEEDED`, which the route maps. See `tests/over-http-limits.yaml`.
