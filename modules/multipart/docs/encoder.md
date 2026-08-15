---
description: "Multipart.Encoder: combine parts into one framed payload, with the media type to send it under"
sidebar_label: Multipart.Encoder
---

# Multipart.Encoder

> Examples below assume this module is imported with an `imports:` entry under alias `Multipart`. Kind references follow that alias — substitute your own if you import it under a different name.

Combines an ordered list of parts into a single payload with boundary framing, and returns it together with the media type to send it under.

## Inputs

| Input | Description |
| --- | --- |
| `parts` | The parts to combine, in order. At least one. |
| `subtype` | `form-data` (default), `related` or `mixed`. Same framing; only the media type differs. |
| `boundary` | A fixed boundary, overriding the generated one. For a reproducible payload — a signed request, a golden test. |

### A part

| Field | Description |
| --- | --- |
| `content` | A string (encoded UTF-8), raw `Telo.Bytes`, or a `Telo.Stream of Telo.Bytes`. |
| `contentType` | This part's media type. Omitted leaves the part unlabelled, which is what a plain form field wants. |
| `name` | Form field name → `Content-Disposition: form-data; name=...`. |
| `filename` | Original file name; its presence is what makes a server treat the part as an uploaded file. |
| `headers` | Extra headers, merged **over** the derived ones — an explicit header always wins. |

## Output

| Field | Description |
| --- | --- |
| `output` | The framed payload, as a byte stream. |
| `contentType` | The media type to send `output` under, **boundary included**. |
| `boundary` | The boundary used, for a caller that must build the header itself. |

## Why the content type comes back

The boundary is generated here and must appear in both the framing and the header. A caller writing `content-type: multipart/related` by hand cannot know it, and a server handed a header whose boundary does not match the body finds **no parts at all** — an upload that returns `200` having transferred nothing. Returning the pair together makes that unrepresentable:

```yaml
- name: Encode
  inputs:
    subtype: related
    parts:
      - contentType: application/json
        content: '{"name":"report.png"}'
      - contentType: image/png
        filename: report.png
        content: !cel "steps.Render.result.bytes"
  invoke:
    kind: Multipart.Encoder

- name: Upload
  inputs:
    url: https://example.com/upload
    method: POST
    headers:
      content-type: !cel "steps.Encode.result.contentType"
    body: !cel "steps.Encode.result.output"
  invoke: !ref Uploader
```

## Streaming

A part whose `content` is a byte stream is written through as it is consumed, so only one chunk is in memory at a time. `Http.Request` sends the resulting body chunked, so a multi-gigabyte part never lands in a buffer.

One consequence worth knowing: a **stream body is single-shot**, so a request carrying one cannot be retried (`ERR_HTTP_BODY_NOT_REPLAYABLE`). For an upload that must survive a retry, either keep the parts as bytes — the whole payload is then replayable — or use a resumable, chunked upload instead.

## Boundaries

The generated boundary is long and random enough that no realistic payload contains it. If you supply your own, it is **your** responsibility that no part contains it: a boundary occurring inside a part terminates it early, splitting one part into two with nothing to report the corruption. Parts already in memory are checked — text and bytes alike, since arbitrary bytes are the likelier carrier — while a streamed part cannot be, because checking would mean buffering it.
