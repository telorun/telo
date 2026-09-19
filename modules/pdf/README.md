# PDF

Rasterize PDF pages to images (PNG/JPEG/WebP), read the text a document renders, and
author editable AcroForm fields at measured coordinates. Rendering and text
extraction use pdf.js; field writing uses pdf-lib.

## Why use this

- **One coordinate space** — both kinds speak pixels of the rendered image,
  top-left origin, at a render `scale`. Coordinates measured on a
  `Pdf.Rasterizer` image (by a vision model, an `Image.Overlay` preview, or a
  human) feed `Pdf.FormFields` unchanged; the conversion to PDF user space
  (points, bottom-left origin) happens inside the controller. The rasterizer reports the `scale` it
  rendered at, so the contract is wirable — pass `result.scale` into the
  `Pdf.FormFields` invocation instead of keeping two config values in sync.
- **Bytes in, bytes out** — both kinds take and produce buffered `Uint8Array`
  payloads, so they compose with `S3.Get`/`S3.Put`, `Octet.Decoder`, and HTTP
  bodies without touching the filesystem.
- **Actionable failures** — unparseable bytes, out-of-range pages, duplicate
  field names, and out-of-bounds boxes all raise `ERR_INVALID_INPUT` with the
  offending field and bounds spelled out.

## Platforms

Rendering runs on Skia, which ships as a binary per platform: macOS (Intel and
Apple Silicon), Linux x64 and arm64 on both glibc and musl, and Windows x64 and
arm64. Only the one your machine needs is downloaded. Everything else — pdf.js,
its standard fonts, CMaps, wasm decoders and worker — travels inside the module,
so running it needs no package manager and no build step.

Requires telo 0.91.0 or newer.

**One Skia per process.** The renderer's library is located through
`NAPI_RS_NATIVE_LIBRARY_PATH`, which is the wrapper's only override and is
process-wide. It is set once, before the wrapper first loads, and left: another
module loading `@napi-rs/canvas` in the same process gets the copy this module
staged. They are the same upstream release, so this costs nothing today — but it
is the kind of coupling worth knowing about before you assume two modules hold
separate canvases.

## Kinds

| Kind | Purpose |
| --- | --- |
| `Pdf.Rasterizer` | Render one page of a PDF to image bytes (png/jpeg/webp) plus pixel dimensions and page count. |
| `Pdf.Text` | Read the text a PDF renders, per page and whole-document, plus its page count. |
| `Pdf.FormFields` | Add editable AcroForm fields (text, checkbox) to a PDF at rendered-image pixel coordinates. |

## Example

```yaml
kind: Telo.Application
metadata: { name: form-stamper, version: 1.0.0 }
imports:
  Pdf: oci://ghcr.io/telorun/pdf@0.4.0
  Run: oci://ghcr.io/telorun/run@0.13.0
targets: [ !ref StampForm ]
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
kind: Run.Sequence
metadata: { name: StampForm }
inputs:
  document: {}                  # the PDF's bytes
steps:
  - name: page
    inputs: { data: !cel "inputs.document", page: 1 }
    invoke: !ref Render
  - name: fielded
    inputs:
      data: !cel "inputs.document"
      scale: !cel "steps.page.result.scale"
      fields:
        - { name: firstName, type: text, page: 1, x: 240, y: 64, width: 300, height: 40 }
    invoke: !ref AddFields
```
