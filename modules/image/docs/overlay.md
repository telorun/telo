---
description: "Image.Overlay: draw labelled rectangles onto an image"
sidebar_label: Image.Overlay
---

# Image.Overlay

> Examples below assume this module is imported with an `imports:` entry under alias `Image`. Kind references follow that alias — substitute your own if you import it under a different name.

Draws labelled rectangles onto an image via a server-side canvas
(`@napi-rs/canvas`) and returns the annotated image in the requested format
(PNG by default). Coordinates are pixels, top-left origin — the same space
`Pdf.Rasterizer` reports.

Visualization, not mutation: shapes are drawn as given and **clipped at the
image edges** — a box that hangs off the canvas renders partially, because
showing a wrong proposal is the point of a review loop. Only non-finite
coordinates or non-positive sizes are rejected.

---

## Example

```yaml
kind: Image.Overlay
metadata: { name: DrawBoxes }
stroke: { color: "#FF3B30", width: 3 }
label: { color: "#FFFFFF", placement: top-left }
```

```yaml
- name: marked
  inputs:
    image: "${{ steps.page.result.image }}"
    shapes:
      - { x: 240, y: 64, width: 300, height: 40, label: "firstName (text)" }
      - { x: 240, y: 128, width: 40, height: 40, color: "#0066FF" }
  invoke: !ref DrawBoxes
```

---

## Configuration

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `stroke.color` | string | no (default `#FF3B30`) | CSS color of the rectangle outline; a shape's `color` overrides it. |
| `stroke.width` | number | no (default `3`) | Outline thickness in pixels. |
| `label.color` | string | no (default `#FFFFFF`) | Label text color. |
| `label.background` | string | no | Color behind the label text; defaults to the shape's stroke color. |
| `label.size` | number | no (default `14`) | Label font size in pixels. |
| `label.placement` | `top-left` \| `top-right` \| `bottom-left` \| `bottom-right` | no (default `top-left`) | Which corner of the rectangle the label tab anchors to — drawn outside the box and clamped into the image. |
| `format` | `png` \| `jpeg` \| `webp` | no (default `png`) | Output image format. A per-invocation `format` takes precedence. |
| `quality` | integer | no (default `80`) | Encoder quality (1–100) for the lossy formats; ignored for `png`. |

## Invocation inputs

| Input | Type | Required | Description |
|-------|------|----------|-------------|
| `image` | `Uint8Array` | yes | Buffered image bytes — PNG, JPEG, or WebP (anything the canvas decoder reads). |
| `shapes` | `array` | yes | Rectangles to draw; at least one. |
| `format` | `png` \| `jpeg` \| `webp` | no | Output image format. Takes precedence over the resource-level `format`. |
| `quality` | integer | no | Encoder quality (1–100) for the lossy formats; ignored for `png`. |

Each `shapes[]` entry:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `x`, `y` | number | yes | Top-left corner in pixels (top-left origin). May exceed the image bounds; the drawing is clipped. |
| `width`, `height` | number | yes | Box size in pixels; must be > 0. |
| `label` | string | no | Tag drawn at the box's anchor corner. |
| `color` | string | no | Per-shape override of the stroke (and label background) color. |

## Output

| Field | Type | Description |
|-------|------|-------------|
| `image` | `Uint8Array` | Annotated image as buffered bytes in the chosen format. |
| `width` | integer | Image width in pixels (unchanged from the input). |
| `height` | integer | Image height in pixels (unchanged from the input). |
| `mediaType` | string | MIME type of the encoded image (`image/png`, `image/jpeg`, or `image/webp`). |

## Errors

| Code | When |
|------|------|
| `ERR_INVALID_INPUT` | `image` is not a `Uint8Array` or not decodable as an image; a shape has non-finite coordinates or non-positive width/height; `format` is not `png`/`jpeg`/`webp`; or `quality` is not an integer between 1 and 100. |
