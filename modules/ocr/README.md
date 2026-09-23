# OCR

The engine-neutral contract for optical character recognition: read the printed
text in one image and get back the text, a confidence score, and every block,
line and word with its pixel box and outline polygon.

## Why use this

- **Accept any engine.** A library, template or blueprint that needs OCR types its
  slot against `Ocr.Recognizer` and imports only this module. The application
  decides which engine to run, and swapping it is swapping one resource.
- **One vocabulary for results.** Text, confidence, the image size, and flat lists
  of blocks, lines and words linked by index. CEL filters words directly, with no
  tree to walk.
- **Coordinates you can draw with.** Every box and polygon is measured on the
  whole image, even when only a region was read, so recognized words can be drawn
  back onto the page without conversion.
- **One set of failure codes.** Every engine reports a bad call, an unreadable or
  oversized image, a busy engine and an engine failure with the same codes, so a
  caller's `catches:` and retry policy do not depend on the engine.

## Kinds

| Kind | Purpose |
| --- | --- |
| `Ocr.Recognizer` | Abstract: recognize the text in one image, optionally inside a rectangle. |

This is an abstract with no implementation of its own. An engine module extends
it, and the application declares that engine's recognizer.

## Example

A library that reads any engine's output. Its importer supplies the recognizer:

```yaml
kind: Telo.Library
metadata: { name: InvoiceReader, version: 1.0.0 }
imports:
  Ocr: oci://ghcr.io/telorun/ocr@0.2.0
  Run: oci://ghcr.io/telorun/run@0.27.1
resources:
  recognizer: { kind: Ocr.Recognizer }
exports:
  resources: [readHeader]
---
kind: Run.Sequence
metadata: { name: readHeader }
inputType:
  kind: Telo.JsonSchema
  schema:
    type: object
    required: [page]
    properties:
      page: { x-telo-type: Telo.Bytes }
steps:
  - name: read
    invoke: !ref recognizer
    timeout: 30000
    inputs:
      image: !cel "inputs.page"
      region: { x: 0, y: 0, width: 1240, height: 300 }
outputs:
  text: !cel "steps.read.result.text"
  sure: !cel "steps.read.result.words.filter(w, w.confidence >= 0.8).map(w, w.text)"
```

## Documentation

- [`Ocr.Recognizer`](./docs/recognizer.md): the contract, coordinates, failure
  codes, deadlines, and how an engine maps onto it.
