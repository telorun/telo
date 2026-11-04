---
description: "Multipart.ReadPart: stream one named part out of a multipart upload — earlier parts discarded, the rest never read"
sidebar_label: Multipart.ReadPart
---

# Multipart.ReadPart

> Examples below assume this module is imported with an `imports:` entry under alias `Multipart`. Kind references follow that alias — substitute your own if you import it under a different name.

Reads **one named part** out of a received multipart payload and returns it as soon as its
headers have been read, with its content as a byte stream. The kind for a form that sends a
single file: nothing is iterated, nothing is held, and nothing after the file is read.

```yaml
- name: part
  invoke: { kind: Multipart.ReadPart }
  inputs:
    input: !cel "inputs.body"
    contentType: !cel "inputs.contentType"
    name: file
- name: stored
  invoke: !ref store
  # An optional entry: `declaredType` is passed only when the part carried one.
  inputs: !cel "{'content': steps.part.result.content, ?'declaredType': steps.part.result.?contentType}"
```

## Inputs and output

| Input | Description |
| --- | --- |
| `input` | The received payload, as a byte stream. |
| `contentType` | The media type the sender used, carrying the boundary. |
| `name` | The form field name of the part to read. **Required.** |
| `maxPartBytes`, `maxParts`, `maxTotalBytes` | As on [`Multipart.Reader`](./reader.md). A part skipped on the way counts toward them. |

The output is the part itself, a `Multipart.Part`: `content` (a byte stream), `headers`
(lowercase keys), and `contentType`, `name` and `filename` where the part carried them.
`contentType` is the header exactly as sent.

## Reading

- The **first** part whose Content-Disposition name equals `name` is returned; the parts
  before it are discarded as the read passes them.
- The parts **after** it are never read.
- `content` answers for the whole input: reading it to its end, stopping early, or
  releasing it without reading it all end the read and release the input.
- `content` pulls the payload only as its own consumer pulls, so a slow destination slows
  the upload rather than filling memory.

A part is optional by catching its code: there is no switch for it.

## Failures

| Code | When | Raised by |
| --- | --- | --- |
| `ERR_MULTIPART_MALFORMED` | The payload is not well-formed multipart. `error.data.reason` as on the reader. A content type with no `boundary=` releases the input first. | The call, when met before the part; the read of `content`, when met inside it. |
| `ERR_MULTIPART_LIMIT_EXCEEDED` | A limit was crossed. `error.data` as on the reader. | Likewise. |
| `ERR_MULTIPART_PART_MISSING` | The payload reached its closing boundary with no part named `name`. `error.data` is `{ name }`. | The call. |

Every refusal releases the input.

## Over HTTP

The upload route declares its body as a byte stream and passes it with the request's
content type; see `tests/read-part-over-http.yaml`. The server's `maxBodyBytes` (1 MiB by
default) bounds the whole request before any of the limits here do.
