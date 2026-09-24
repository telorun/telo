---
description: "Tesseract.Recognizer: reading printed text from images and PDF pages, offline"
sidebar_label: Getting started
---

# Getting started with Tesseract

> Examples assume this module is imported under the alias `Tesseract`. Substitute your own alias if you import it under a different name.

`Tesseract.Recognizer` reads the printed text in one image. It implements `Ocr.Recognizer`, so its result is the contract's: the text, a 0–1 confidence, the image size, and flat lists of blocks, lines and words, each with a `box` and a `polygon` measured on the whole image.

## Reading an image

```yaml
kind: Tesseract.Recognizer
metadata: { name: recognizer }
languages: [!ref Tesseract.eng]
---
kind: Run.Sequence
metadata: { name: readReceipt }
inputType:
  kind: Telo.JsonSchema
  schema:
    type: object
    required: [photo]
    properties:
      photo: { x-telo-type: Telo.Bytes }
steps:
  - name: read
    invoke: !ref recognizer
    timeout: 30000
    inputs:
      image: !cel "inputs.photo"
outputs:
  text: !cel "steps.read.result.text"
  firstLine: !cel "steps.read.result.words.filter(w, w.line == 0).map(w, w.text).join(' ')"
  unsure: !cel "steps.read.result.words.filter(w, w.confidence < 0.6).map(w, w.text)"
```

PNG, JPEG, WebP, BMP and PNM are read, recognized by their leading bytes. Anything else — GIF, AVIF, HEIF, a PDF — is refused with `ERR_UNSUPPORTED_IMAGE` before the engine sees it.

### Per-call inputs

Beside the contract's `image` and `region`, a call may pass:

| Input | Meaning |
| --- | --- |
| `pageSegmentation` | Overrides the recognizer's configured page segmentation for this call. |
| `characterWhitelist` | Only these characters may be recognized, such as `0123456789.,` for amounts. |
| `characterBlacklist` | These characters are never recognized. |
| `preserveInterwordSpaces` | Keep runs of spaces between words in `text`. |
| `dpi` | The image's resolution, for an image whose header carries none. |
| `include` | `[hocr]`, `[tsv]` or both: the result also as hOCR (HTML) or Tesseract's TSV table. |

### Page segmentation

`pageSegmentation` says how the page is split into text before it is read. `auto` (the default) finds blocks, columns and lines on its own. For a known layout, a narrower mode is faster and more accurate:

| Mode | For |
| --- | --- |
| `auto` | A page of unknown layout. |
| `autoOsd` | The same, after detecting how the page is rotated. Needs `orientationModel`. |
| `autoOnly` | Layout analysis only, no orientation detection. |
| `singleColumn` | One column of text of variable sizes. |
| `singleBlock`, `singleBlockVertical` | One uniform block of text, horizontal or vertical. |
| `singleLine`, `rawLine` | One line; `rawLine` skips Tesseract's own line heuristics. |
| `singleWord`, `circleWord`, `singleChar` | One word, one word in a circle, one character. |
| `sparseText` | Scattered text in no particular order, such as a form or a sign. |
| `sparseTextOsd` | The same, after detecting the rotation. Needs `orientationModel`. |

### Page rotation

With `orientationModel: !ref Tesseract.osd` and an `autoOsd` or `sparseTextOsd` mode, the page's rotation is detected first and the result carries `orientation`:

```yaml
kind: Tesseract.Recognizer
metadata: { name: scans }
languages: [!ref Tesseract.eng]
orientationModel: !ref Tesseract.osd
pageSegmentation: autoOsd
```

`orientation.degrees` is how far the text is turned clockwise (0, 90, 180 or 270), `orientation.script` the writing script detected (`Latin`, `Cyrillic`, `Han`, …) and `orientation.confidence` the engine's confidence score, which is not a probability — values above 2 are generally reliable. A page with too little text to decide on carries no `orientation`. The text is read correctly either way, and boxes stay on the image as it was given. `telo check` refuses an `autoOsd` or `sparseTextOsd` recognizer that sets no `orientationModel`.

## Reading a PDF

A PDF is not an image. Render its pages with `PDF.Rasterizer` first; the rasterizer's pixels are the coordinate space the recognizer reports in:

```yaml
imports:
  Tesseract: oci://ghcr.io/telorun/tesseract@0.1.0
  Pdf: oci://ghcr.io/telorun/pdf@0.9.0
  Run: oci://ghcr.io/telorun/run@0.27.1
---
kind: Pdf.Rasterizer
metadata: { name: rasterizer }
scale: 2
---
kind: Run.Sequence
metadata: { name: readFirstPage }
inputType:
  kind: Telo.JsonSchema
  schema:
    type: object
    required: [pdf]
    properties:
      pdf: { x-telo-type: Telo.Bytes }
steps:
  - name: page
    invoke: !ref rasterizer
    inputs:
      data: !cel "inputs.pdf"
      page: 1
  - name: read
    invoke: !ref recognizer
    timeout: 30000
    inputs:
      image: !cel "steps.page.result.image"
outputs:
  text: !cel "steps.read.result.text"
  pageCount: !cel "steps.page.result.pageCount"
```

Scale 2 renders at about 144 DPI, which suits body text; a scan with small print reads better at 3. Every page of a document is the same pair of steps inside an iteration over `range(pageCount)`.

## Drawing the words back onto the page

Boxes are measured on the whole image, even when a `region` was read, so they go straight into `Image.Overlay`:

```yaml
- name: annotate
  invoke: !ref overlay
  inputs:
    image: !cel "steps.page.result.image"
    shapes: !cel >-
      steps.read.result.words
        .filter(w, w.box.width > 0 && w.box.height > 0)
        .map(w, {'x': w.box.x, 'y': w.box.y, 'width': w.box.width,
                 'height': w.box.height, 'label': w.text})
```

A word's `polygon` is its box's four corners, clockwise from the corner the text's top-left sits on — the top-left of the box for an upright page, the top-right for a page turned 90° clockwise.

## Handing the recognizer to a library

A library that accepts any OCR engine types its slot against the contract and imports only `ocr`. The application declares the recognizer and hands it over:

```yaml
imports:
  Tesseract: oci://ghcr.io/telorun/tesseract@0.1.0
  Invoices:
    source: oci://example.com/invoice-reader@1.0.0
    resources:
      recognizer: !ref recognizer
```
