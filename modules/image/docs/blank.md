---
description: "Image.Blank: produce a solid-color canvas as PNG bytes"
sidebar_label: Image.Blank
---

# Image.Blank

> Examples below assume this module is imported with an `imports:` entry under alias `Image`. Kind references follow that alias — substitute your own if you import it under a different name.

Produces a solid-color canvas as PNG bytes — the seed of an image pipeline
(compose with `Image.Overlay`) or a hermetic test fixture that replaces
embedded base64 images.

An unrecognized CSS color is rejected with `ERR_INVALID_INPUT` rather than
silently producing a default-colored canvas (the underlying canvas API keeps
its previous fill color on invalid assignment).

---

## Example

```yaml
kind: Image.Blank
metadata: { name: Canvas }
```

```yaml
- name: board
  inputs: { width: 800, height: 600, color: "#003366" }
  invoke: !ref Canvas
- name: marked
  inputs:
    image: "${{ steps.board.result.image }}"
    shapes:
      - { x: 40, y: 40, width: 200, height: 120, label: "header" }
  invoke: !ref DrawBoxes
```

---

## Configuration

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `color` | string | no (default `#FFFFFF`) | CSS fill color. A per-invocation `color` takes precedence. |
| `format` | `png` \| `jpeg` \| `webp` | no (default `png`) | Output image format. A per-invocation `format` takes precedence. |
| `quality` | integer | no (default `80`) | Encoder quality (1–100) for the lossy formats; ignored for `png`. |

## Invocation inputs

| Input | Type | Required | Description |
|-------|------|----------|-------------|
| `width` | integer | yes | Canvas width in pixels, 1–16384. |
| `height` | integer | yes | Canvas height in pixels, 1–16384. |
| `color` | string | no | CSS fill color. Takes precedence over the resource-level `color`. |
| `format` | `png` \| `jpeg` \| `webp` | no | Output image format. Takes precedence over the resource-level `format`. |
| `quality` | integer | no | Encoder quality (1–100) for the lossy formats; ignored for `png`. |

## Output

| Field | Type | Description |
|-------|------|-------------|
| `image` | `Uint8Array` | Solid-color canvas as buffered image bytes in the chosen format. |
| `width` | integer | Canvas width in pixels (echoed back). |
| `height` | integer | Canvas height in pixels (echoed back). |
| `mediaType` | string | MIME type of the encoded image (`image/png`, `image/jpeg`, or `image/webp`). |

## Errors

| Code | When |
|------|------|
| `ERR_INVALID_INPUT` | `width`/`height` is not an integer between 1 and 16384, `color` is not a recognized CSS color, `format` is not `png`/`jpeg`/`webp`, or `quality` is not an integer between 1 and 100. |
