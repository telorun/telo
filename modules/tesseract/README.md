# Tesseract

Offline optical character recognition with the Tesseract engine, compiled to
WebAssembly: read the printed text in PNG, JPEG, WebP, BMP and PNM images and get
back the text, confidences, and every block, line and word with its pixel box.
Nothing is installed on the host, and every file the engine reads ships with the
module.

## Why use this

- **Runs anywhere Telo runs.** The engine and its models are module assets, so a
  recognizer works offline on every platform the Node kernel supports.
- **The engine-neutral contract.** `Tesseract.Recognizer` implements
  `Ocr.Recognizer`, so a library typed against the contract takes it unchanged.
- **English and orientation detection bundled.** `Tesseract.eng` and
  `Tesseract.osd` are exported models; other languages are importable modules, and
  a custom model is one declaration.
- **A pool with limits.** Recognitions run in parallel, one engine instance each, with a
  queue limit, size limits read from the image header before decoding, and a time
  limit per recognition. A cancelled call stops its engine.

## Kinds

| Kind | Purpose |
| --- | --- |
| `Tesseract.Recognizer` | Recognize the text in one image with the configured language models. |
| `Tesseract.Language` | A language model, located by its `.traineddata` file (re-exported from `tesseract-model`). |
| `Tesseract.OrientationModel` | The orientation and script detection model (re-exported from `tesseract-model`). |

| Exported resource | Is |
| --- | --- |
| `Tesseract.eng` | The English model. |
| `Tesseract.osd` | The orientation and script detection model. |

## Example

```yaml
kind: Telo.Application
metadata: { name: ReadScan, version: 1.0.0 }
imports:
  Tesseract: oci://ghcr.io/telorun/tesseract@0.1.0
  Run: oci://ghcr.io/telorun/run@0.27.1
targets:
  - !ref readScan
---
kind: Tesseract.Recognizer
metadata: { name: recognizer }
languages: [!ref Tesseract.eng]
---
kind: Run.Sequence
metadata: { name: readScan }
steps:
  - name: read
    invoke: !ref recognizer
    timeout: 30000
    inputs:
      image: !include-bytes ./scan.png
outputs:
  text: !cel "steps.read.result.text"
```

## Documentation

- [Getting started](./docs/getting-started.md): reading an image, reading a PDF,
  and drawing the recognized words back onto the page.
- [Languages and models](./docs/languages.md): the bundled models, language modules
  and your own models.
- [Production tuning](./docs/production.md): concurrency against memory, limits,
  deadlines and failure codes.
