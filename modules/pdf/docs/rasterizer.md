---
description: "Pdf.Rasterizer: render one PDF page to PNG bytes"
sidebar_label: Pdf.Rasterizer
---

# Pdf.Rasterizer

> Examples below assume this module is imported with an `imports:` entry under alias `Pdf`. Kind references follow that alias — substitute your own if you import it under a different name.

Renders one page of a PDF to image bytes (PNG by default; JPEG or WebP to
shrink the payload for a vision model) via pdf.js on a server-side canvas
(`@napi-rs/canvas`). The reported `width`/`height` are the rendered pixel
dimensions at the configured `scale` — the coordinate space downstream
consumers (`Pdf.FormFields`, `Image.Overlay`) measure against.

---

## Example

```yaml
kind: Pdf.Rasterizer
metadata: { name: Render }
scale: 2
```

```yaml
- name: page
  inputs:
    data: "${{ steps.fetch.result.bytes }}"
    page: 1
  invoke: !ref Render
```

---

## Configuration

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `scale` | `number` | no (default `1`) | Render scale over the PDF's native size (1 ≈ 72 DPI), capped at 8. Pin to the same value as the `Pdf.FormFields` consuming the measured coordinates. |
| `format` | `png` \| `jpeg` \| `webp` | no (default `png`) | Output image format. A per-invocation `format` takes precedence. |
| `quality` | integer | no (default `80`) | Encoder quality (1–100) for the lossy formats; ignored for `png`. |

## Invocation inputs

| Input | Type | Required | Description |
|-------|------|----------|-------------|
| `data` | `Uint8Array` | yes | Buffered PDF bytes (e.g. the `bytes` produced by `Octet.Decoder`, or an `S3.Get` body collected to bytes). |
| `page` | `integer` | no (default `1`) | 1-based page number to render. |
| `format` | `png` \| `jpeg` \| `webp` | no | Output image format. Takes precedence over the resource-level `format`. |
| `quality` | integer | no | Encoder quality (1–100) for the lossy formats; ignored for `png`. |

## Output

| Field | Type | Description |
|-------|------|-------------|
| `image` | `Uint8Array` | Rendered page as buffered image bytes in the chosen format. |
| `width` | `integer` | Rendered image width in pixels (page width × scale). |
| `height` | `integer` | Rendered image height in pixels (page height × scale). |
| `pageCount` | `integer` | Total number of pages in the document. |
| `scale` | `number` | The render scale the image was produced at — wire it into a `Pdf.FormFields` invocation's `scale` so the coordinate contract is a value, not a convention. |
| `mediaType` | string | MIME type of the encoded image (`image/png`, `image/jpeg`, or `image/webp`) — wire into a vision message's image part. |

## Errors

| Code | Raised when |
|------|-------------|
| `ERR_INVALID_INPUT` | `data` is not a `Uint8Array`, the bytes are not parseable as a PDF, `page` exceeds the document's page count, `format` is not `png`/`jpeg`/`webp`, or `quality` is not an integer between 1 and 100. |
