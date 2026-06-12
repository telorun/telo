# PDF

Rasterize PDF pages to PNG images and author editable AcroForm fields at
measured coordinates. Rendering uses pdf.js on a server-side canvas; field
writing uses pdf-lib.

## Why use this

- **One coordinate space** — both kinds speak pixels of the rendered image,
  top-left origin, at a render `scale`. Coordinates measured on a
  `Pdf.Rasterizer` image (by a vision model or a human) feed `Pdf.FormFields`
  unchanged; the conversion to PDF user space (points, bottom-left origin)
  happens inside the controller. The rasterizer reports the `scale` it
  rendered at, so the contract is wirable — pass `result.scale` into the
  `Pdf.FormFields` invocation instead of keeping two config values in sync.
- **Bytes in, bytes out** — both kinds take and produce buffered `Uint8Array`
  payloads, so they compose with `S3.Get`/`S3.Put`, `Octet.Decoder`, and HTTP
  bodies without touching the filesystem.
- **Actionable failures** — unparseable bytes, out-of-range pages, duplicate
  field names, and out-of-bounds boxes all raise `ERR_INVALID_INPUT` with the
  offending field and bounds spelled out.

## Kinds

| Kind | Purpose |
| --- | --- |
| `Pdf.Rasterizer` | Render one page of a PDF to PNG bytes plus pixel dimensions and page count. |
| `Pdf.FormFields` | Add editable AcroForm fields (text, checkbox) to a PDF at rendered-image pixel coordinates. |

## Example

```yaml
kind: Telo.Application
metadata: { name: form-stamper, version: 1.0.0 }
imports:
  Pdf: std/pdf@latest
---
kind: Pdf.Rasterizer
metadata: { name: Render }
scale: 2
---
kind: Pdf.FormFields
metadata: { name: AddFields }
---
# Render page 1, then place a text field using coordinates measured on the
# image — the render's scale is wired through, so the two can't drift.
- name: page
  inputs: { data: "${{ steps.fetch.result.bytes }}", page: 1 }
  invoke: !ref Render
- name: fielded
  inputs:
    data: "${{ steps.fetch.result.bytes }}"
    scale: "${{ steps.page.result.scale }}"
    fields:
      - { name: firstName, type: text, page: 1, x: 240, y: 64, width: 300, height: 40 }
  invoke: !ref AddFields
```
