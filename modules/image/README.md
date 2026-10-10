# Image

Fit an image into a box, and draw labelled rectangles onto one. Two jobs that
meet in a vision pipeline: bound a picture before it is stored or sent to a
model, and visualise what the model proposed — render a document or frame, let
it propose bounding boxes, draw them, let it look again.

## Why use this

- **Visualization, not mutation** — shapes are drawn as given and clipped at
  the image edges; a box that hangs off the canvas renders partially, because
  showing a wrong proposal is the point of a review loop.
- **One coordinate space with the pdf module** — pixels, top-left origin,
  matching what `Pdf.Rasterizer` reports and `Pdf.FormFields` consumes, so
  boxes flow between rendering, preview, and field placement untranslated.
- **Bounded before decoding** — `Image.Fit` judges a file's length and the
  pixel size its header declares before any decoder runs, so a small upload
  claiming to be 30000×30000 is refused, not decoded. What it returns is
  always re-encoded: turned upright by its EXIF orientation, and carrying no
  metadata. A corrupt or truncated image is `ERR_UNSUPPORTED_IMAGE`.
- **Bytes in, bytes out** — every image slot is declared as bytes
  (`Telo.Bytes`: PNG, JPEG, or WebP in — and GIF for `Image.Fit`; PNG, JPEG or
  WebP out, chosen via `format`), composing with `S3.Get`/`S3.Put`, `Octet.Decoder`, and HTTP
  bodies without touching the filesystem. An `image` argument comes from a
  byte-producing resource, an `!include-bytes` embed, or base64url text;
  anything else is refused before the controller runs — `telo check` reports
  an expression of another type, and a value only known at run fails the call
  with `ERR_INPUT_INVALID`. Each output reports its `mediaType`.

## Kinds

| Kind | Purpose |
| --- | --- |
| `Image.Blank` | Produce a solid-color canvas as image bytes (png/jpeg/webp) — pipeline seed or hermetic test fixture. |
| `Image.Overlay` | Draw labelled rectangles onto an image; returns annotated bytes (png/jpeg/webp) plus dimensions. |
| [`Image.Fit`](docs/fit.md) | Scale an image down to fit a maximum width and height, never enlarging, and re-encode it (png/jpeg/webp); refuses an oversized file or pixel count before decoding. |

## Example

```yaml
kind: Telo.Application
metadata: { name: box-preview, version: 1.0.0 }
imports:
  Image: oci://ghcr.io/telorun/image@0.4.0
  Run: oci://ghcr.io/telorun/run@0.13.0
targets: [ !ref MarkFields ]
---
kind: Image.Overlay
metadata: { name: DrawBoxes }
stroke: { color: "#FF3B30", width: 3 }
label: { color: "#FFFFFF", placement: top-left }
---
# Draw the model's proposed fields onto a rendered page.
kind: Run.Sequence
metadata: { name: MarkFields }
inputs:
  page: {}                      # the rendered image's bytes
  fields: {}                    # the boxes the model proposed
steps:
  - name: marked
    inputs:
      image: !cel "inputs.page"
      shapes: !cel |
        inputs.fields.map(f, {
          "x": f.x, "y": f.y, "width": f.width, "height": f.height,
          "label": f.name + " (" + f.type + ")"
        })
    invoke: !ref DrawBoxes
```
