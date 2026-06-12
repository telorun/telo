# Image

Draw labelled rectangles onto an image. The visualization half of
vision-grounding loops: render a document or frame, let a model propose
bounding boxes, draw them, let it look again.

## Why use this

- **Visualization, not mutation** — shapes are drawn as given and clipped at
  the image edges; a box that hangs off the canvas renders partially, because
  showing a wrong proposal is the point of a review loop.
- **One coordinate space with the pdf module** — pixels, top-left origin,
  matching what `Pdf.Rasterizer` reports and `Pdf.FormFields` consumes, so
  boxes flow between rendering, preview, and field placement untranslated.
- **Bytes in, bytes out** — buffered `Uint8Array` payloads (PNG, JPEG, or
  WebP in; the same set out, chosen via `format`), composing with
  `S3.Get`/`S3.Put`, `Octet.Decoder`, and HTTP bodies without touching the
  filesystem. Each output reports its `mediaType`.

## Kinds

| Kind | Purpose |
| --- | --- |
| `Image.Blank` | Produce a solid-color canvas as image bytes (png/jpeg/webp) — pipeline seed or hermetic test fixture. |
| `Image.Overlay` | Draw labelled rectangles onto an image; returns annotated bytes (png/jpeg/webp) plus dimensions. |

## Example

```yaml
kind: Telo.Application
metadata: { name: box-preview, version: 1.0.0 }
imports:
  Image: std/image@latest
---
kind: Image.Overlay
metadata: { name: DrawBoxes }
stroke: { color: "#FF3B30", width: 3 }
label: { color: "#FFFFFF", placement: top-left }
---
# Draw the model's proposed fields onto the rendered page.
- name: marked
  inputs:
    image: "${{ steps.page.result.image }}"
    shapes: |-
      ${{ inputs.fields.map(f, {
        "x": f.x, "y": f.y, "width": f.width, "height": f.height,
        "label": f.name + " (" + f.type + ")"
      }) }}
  invoke: !ref DrawBoxes
```
