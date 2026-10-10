# Media Type

`media-type` — what a value really is, read from its leading bytes. A client
says an upload is `image/png`; `MediaType.Detector` looks at the bytes, answers
with the media type they support, and says whether the label was contradicted.
It reports and never refuses: what to do with a mislabelled or unwanted file is
the caller's decision.

## Why use this

- **The label is checked against the content.** A PNG sent as `image/jpeg`, or
  random bytes sent as `image/png`, comes back `mislabelled: true`.
- **One closed set.** PNG, JPEG, GIF, WebP, PDF, ZIP and the three Office Open
  XML document types — a data file, not code, so the set is the same wherever
  the module runs.
- **Streams stay streams.** At most 4,096 leading bytes are read; `output`
  hands on every input byte unchanged, so an upload is sniffed on its way to
  storage without being held whole.
- **No failure of its own.** Unknown content is an answer
  (`application/octet-stream`, or the declared type when nothing contradicts
  it), not an error, and the kind declares no error codes. A declared type that
  is not a media type at all is read as no claim, so a raw header value can be
  passed straight in.

## Kinds

| Name | What it is |
| --- | --- |
| [`MediaType.Detector`](docs/detector.md) | `{ input, declared? }` → `{ mediaType, mislabelled, output }`. No configuration. |

## Example

An upload route that accepts only PNG and JPEG images and stores what it was
actually sent. The refusal is two checks, in this order: `mislabelled`, then the
route's own accept list against `mediaType`.

```yaml
kind: Run.Sequence
metadata: { name: storeAvatar }
inputType:
  kind: Telo.JsonSchema
  schema:
    type: object
    required: [content, contentType]
    properties:
      content:
        x-telo-type: { name: Telo.Stream, of: Telo.Bytes }
      contentType: { type: string }
steps:
  - name: sniffed
    inputs:
      input: !cel "inputs.content"
      declared: !cel "inputs.contentType"
    invoke:
      kind: MediaType.Detector
  - name: refuseMislabelled
    if: !cel "steps.sniffed.result.mislabelled"
    then:
      - name: mislabelled
        throw:
          code: UPLOAD_MISLABELLED
          message: !interpolate "The file is not the ${{ inputs.contentType }} it was sent as."
  - name: refuseUnwanted
    if: !cel "!(steps.sniffed.result.mediaType in ['image/png', 'image/jpeg'])"
    then:
      - name: unwanted
        throw:
          code: UPLOAD_TYPE_NOT_ACCEPTED
          message: !interpolate "${{ steps.sniffed.result.mediaType }} files are not accepted."
  - name: stored
    inputs:
      key: !interpolate "avatars/${{ uuidv4() }}"
      content: !cel "steps.sniffed.result.output"
      contentType: !cel "steps.sniffed.result.mediaType"
    invoke: !ref saveAvatar
```

`saveAvatar` is whatever keeps the bytes — a `Blob.Put`, an `Fs.FileWrite`.
Hand it `output`, not the original stream: the detector has already read the
start of that one.

## Reference

- [Detector](docs/detector.md) — inputs, outputs, the recognised set and the
  rule.
