# MediaType.Detector

> Examples assume this module is imported under the alias `MediaType`.

Identifies content from its leading bytes and compares the answer with the
media type it was declared to have. An invocable with no configuration:

```yaml
kind: MediaType.Detector
metadata: { name: sniff }
```

## Inputs

| Input | Type | Required | Purpose |
| --- | --- | --- | --- |
| `input` | bytes, or a stream of bytes | yes | The content to identify. |
| `declared` | string | no | The media type the content was said to have — a `Content-Type` header, a multipart part's type. |

`declared` is compared lower-cased and with its parameters dropped:
`Text/Plain; charset=utf-8` is `text/plain`. It is whatever a client sent, so
it never fails the call: omitting it, passing `application/octet-stream` and
passing text that is not a media type at all (`png`, an empty string, `a/b/c`)
all mean the same thing — nothing was claimed, and the result is what the bytes
prove. Only a literal that is not text is refused, by `telo check`
(`CONTRACT_INPUTS_MISMATCH`).

## Outputs

| Output | Type | Meaning |
| --- | --- | --- |
| `mediaType` | media type | The resolved type, as lower-case `type/subtype` with no parameters. |
| `mislabelled` | boolean | The content contradicts `declared`. |
| `output` | stream of bytes | Every byte of `input`, unchanged and in order. |

`mediaType` is always written in the form a storage or response slot expects —
each side starts with a letter or digit, continues with letters, digits and
`!#$&^_.+-`, and is at most 127 characters long.

## The recognised set

The set is closed and is data: `media-types.json` at the module root. A type is
either proven by a signature in its own leading bytes, or built on a container
whose signature vouches for it.

| Media type | Proven by |
| --- | --- |
| `image/png` | the eight-byte PNG signature |
| `image/jpeg` | `FF D8 FF` |
| `image/gif` | `GIF87a` or `GIF89a` |
| `image/webp` | `RIFF` at byte 0 and `WEBP` at byte 8 |
| `application/pdf` | `%PDF-` |
| `application/zip` | `PK` followed by `03 04`, `05 06` or `07 08` |
| `application/vnd.openxmlformats-officedocument.wordprocessingml.document` (`.docx`) | its container, `application/zip` |
| `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` (`.xlsx`) | its container, `application/zip` |
| `application/vnd.openxmlformats-officedocument.presentationml.presentation` (`.pptx`) | its container, `application/zip` |

Every signature starts at the first byte: content with anything in front of it
proves nothing.

**A container-based type is vouched for only as far as its container.** A file
declared as a `.docx` whose bytes are a ZIP archive is reported as that `.docx`
type, not mislabelled — and so is any other ZIP archive declared the same way.
Nothing looks inside the archive. With no `declared`, such a file is
`application/zip`, because that is all the bytes prove.

## The rule

| `declared` | The bytes prove | `mediaType` | `mislabelled` |
| --- | --- | --- | --- |
| absent, `application/octet-stream`, or not a media type | a type P | P | `false` |
| absent, `application/octet-stream`, or not a media type | nothing | `application/octet-stream` | `false` |
| D | D, or the container D is built on | D | `false` |
| D | another type P | P | `true` |
| D, a type in the set | nothing | `application/octet-stream` | `true` |
| D, a type not in the set | nothing | D | `false` |

Read as examples:

- PNG bytes declared `image/jpeg` → `image/png`, mislabelled.
- A `.docx` declared with its Office Open XML type → that type, not mislabelled.
- Plain text declared `text/plain` → `text/plain`, not mislabelled. No signature
  exists for text, so the label is all there is and it is taken as given.
- Random bytes declared `image/png` → `application/octet-stream`, mislabelled: a
  PNG would have proven itself.
- PNG bytes with nothing declared → `image/png`.
- PNG bytes declared `png` → `image/png`, not mislabelled: an unreadable label
  is no label.

So `mislabelled: false` means "nothing in the bytes contradicts the label", not
"the label was verified": a type outside the set is never verified.

## Refusing

The detector never refuses, and declares no error codes. A caller that accepts
only some types checks two things, in this order:

1. `mislabelled` — refuse, whatever the type: the sender described the file
   wrongly.
2. `mediaType` against its own accept list — refuse a type it does not handle.

```yaml
- name: sniffed
  inputs:
    input: !cel "inputs.content"
    declared: !cel "inputs.contentType"
  invoke: !ref sniff
- name: refuseMislabelled
  if: !cel "steps.sniffed.result.mislabelled"
  then:
    - name: mislabelled
      throw: { code: UPLOAD_MISLABELLED, message: The file is not what it was sent as. }
- name: refuseUnwanted
  if: !cel "!(steps.sniffed.result.mediaType in ['image/png', 'image/jpeg', 'application/pdf'])"
  then:
    - name: unwanted
      throw: { code: UPLOAD_TYPE_NOT_ACCEPTED, message: That kind of file is not accepted. }
```

Checking the accept list alone is not enough when it holds a type outside the
set: `text/plain` is returned for any bytes declared `text/plain` that carry no
known signature.

## Reading and the output stream

- **At most 4,096 leading bytes are inspected, before the call returns.** Bytes
  held whole are not read at all beyond that window. A stream is pulled chunk
  by chunk until 4,096 bytes are held or it ends, so the call waits for that
  much of the source and no more.
- **`output` is the whole input.** It yields the chunks already pulled, as they
  arrived, then the rest of the source as it is consumed. Bytes held whole come
  back as one chunk.
- **Use `output` in place of `input`.** A stream handed in has been read from;
  what follows the detector reads `output`.
- **A source failure is raised as it arrived** — from the call when it happens
  inside the window, from `output` when it happens later.
- **Stopping early releases the source.** A consumer that stops reading
  `output`, or never starts, releases the stream that was handed in.
- **A stream must yield bytes.** A chunk that is anything else, or an `input`
  that is neither bytes nor a stream, fails with `ERR_INPUT_INVALID`.
