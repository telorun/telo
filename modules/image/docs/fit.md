---
description: "Image.Fit: scale an image down to fit a box and re-encode it"
sidebar_label: Image.Fit
---

# Image.Fit

> Examples below assume this module is imported with an `imports:` entry under alias `Image`. Kind references follow that alias — substitute your own if you import it under a different name.

Scales an image down so that it fits within a maximum width and height, and
re-encodes it. The step between an upload and whatever needs a bounded picture —
a thumbnail, an avatar, an image part sent to a model.

- **Aspect ratio is kept.** The image is scaled by one factor, the smaller of
  what the two sides allow: 4000×3000 into 512×512 is 512×384.
- **Never enlarged.** An image already inside the box keeps its size: 100×100
  into 512×512 is 100×100.
- **Always re-encoded.** The output is drawn and encoded afresh, even when the
  size does not change, so nothing of the input but its pixels survives — no
  EXIF block, no location, no embedded comment.
- **Limits before decoding.** `maxBytes` is judged against the input's length
  and `maxPixels` against the size its header declares, so a small file that
  claims to be 30000×30000 is refused without a decoder ever seeing it.

Accepts PNG, JPEG, WebP and GIF.

---

## Example

```yaml
kind: Image.Fit
metadata: { name: thumbnail }
format: jpeg
quality: 85
maxBytes: 10485760
```

```yaml
- name: thumb
  inputs:
    image: !cel "steps.upload.result.bytes"
    maxWidth: 512
    maxHeight: 512
  invoke: !ref thumbnail
- name: stored
  inputs:
    key: !interpolate "thumbnails/${{ uuidv4() }}"
    content: !cel "steps.thumb.result.image"
    contentType: !cel "steps.thumb.result.mediaType"
  invoke: !ref saveThumbnail
```

---

## Configuration

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `format` | `png` \| `jpeg` \| `webp` | no (default `png`) | Output image format. A per-invocation `format` takes precedence. |
| `quality` | integer, 1–100 | no (default `80`) | Encoder quality for the lossy formats; ignored for `png`. A per-invocation `quality` takes precedence. |
| `maxBytes` | integer ≥ 1 | no (default `26214400`, 25 MiB) | The longest input accepted, in bytes. |
| `maxPixels` | integer ≥ 1 | no (default `40000000`) | The most pixels (width × height) an input's header may declare. |

The two limits are literals: they are not evaluated as expressions.

## Invocation inputs

| Input | Type | Required | Description |
|-------|------|----------|-------------|
| `image` | bytes (`Telo.Bytes`) | yes | The image to fit — PNG, JPEG, WebP or GIF. |
| `maxWidth` | integer, 1–16384 | yes | The widest the result may be, in pixels. |
| `maxHeight` | integer, 1–16384 | yes | The tallest the result may be, in pixels. |
| `format` | `png` \| `jpeg` \| `webp` | no | Output image format. Takes precedence over the resource-level `format`. |
| `quality` | integer, 1–100 | no | Encoder quality for the lossy formats. Takes precedence over the resource-level `quality`. |

A literal outside its range is refused by `telo check`
(`CONTRACT_INPUTS_MISMATCH`, or `SCHEMA_VIOLATION` for a configuration field); a
computed one when the call is made (`ERR_INPUT_INVALID`).

## Output

| Field | Type | Description |
|-------|------|-------------|
| `image` | bytes (`Telo.Bytes`) | The fitted image, in the chosen format. |
| `width` | integer | Width of the result in pixels. |
| `height` | integer | Height of the result in pixels. |
| `mediaType` | string | `image/png`, `image/jpeg` or `image/webp`. |

## Orientation and frames

The result is the image turned upright by its EXIF orientation, wherever the
file carries one — a JPEG's EXIF block, a WebP's `EXIF` chunk, a PNG's `eXIf`
chunk — and the box is measured against the upright size: a 4000×3000 file
marked "rotate a quarter turn" is a 3000×4000 picture. The result does not
depend on whether the decoder honours the tag: the orientation is applied once,
here.

A GIF carries no EXIF and is taken as stored. An animated GIF yields its first
frame; the animation is not preserved.

Transparent pixels are kept by `png` and `webp` output. `jpeg` has no
transparency, and encodes them as the module's other kinds do.

## Limits

Both are checked before decoding, in this order:

1. **`maxBytes`** — the input is longer than the limit. Its header is not read.
2. **`maxPixels`** — the header declares a width × height above the limit. For
   a GIF the size is the larger of the declared screen and its first frame.

A decoded image occupies about four bytes per pixel whatever its file size, so
`maxPixels` is what bounds memory: the default of 40,000,000 allows roughly
160 MB for one image. Lower it for a service that only ever handles thumbnails
or avatars.

Decoding and encoding run off the event loop. The resize does not: one call holds the loop for a time proportional to the input's pixel count, which `maxPixels` bounds. A server resizing under load lowers `maxPixels` to the largest image it means to accept.

## Errors

| Code | When | `error.data` |
|------|------|--------------|
| `ERR_IMAGE_TOO_LARGE` | The input is over `maxBytes`, or its header declares more than `maxPixels`. Nothing was decoded. | `{ limit, max }` — `limit` is `maxBytes` or `maxPixels`, `max` that limit's value. |
| `ERR_UNSUPPORTED_IMAGE` | The bytes are not a readable PNG, JPEG, WebP or GIF: another format's signature (a PDF, a BMP, an AVIF), a truncated or malformed header, a GIF whose first frame is cut short, or a corrupt or truncated body the decoder rejects. A signature or header failure is raised before decoding. | — |
| `ERR_INPUT_INVALID` | An argument does not satisfy the input contract — `image` is not bytes, or a box side, `quality` or `format` is out of range. Raised before the controller runs. | — |

```yaml
catches:
  - when: !cel "error.code == 'ERR_IMAGE_TOO_LARGE'"
    status: 413
    content:
      application/json:
        body: { error: !cel "error.message" }
  - when: !cel "error.code == 'ERR_UNSUPPORTED_IMAGE'"
    status: 415
    content:
      application/json:
        body: { error: !cel "error.message" }
```
