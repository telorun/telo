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
| `maxPartBytes` | Largest single part accepted, in bytes. Default 8 MiB. |

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

Nothing inside a multipart body says where parts begin — the boundary is a parameter of the media type. So `contentType` is required, and one with no `boundary=` parameter is an **error** rather than a payload with zero parts. Those two outcomes are indistinguishable to a caller, and the silent one is a request that looks empty rather than malformed.

```yaml
- name: Decode
  inputs:
    input: !cel "request.body"
    contentType: !cel "request.headers['content-type']"
  invoke:
    kind: Multipart.Decoder
```

## Why parts are buffered

Parts come back as a list of byte values rather than a stream of streams. The underlying source is single-pass, so a caller holding part 2 while reading part 3 would read nothing — a stream-of-streams makes out-of-order consumption a use-after-free with no error. Buffering makes the parts ordinary values, and `maxPartBytes` is what keeps it bounded: it caps a single part **and** the payload as a whole, since a thousand small parts is as unbounded as one large one.

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
