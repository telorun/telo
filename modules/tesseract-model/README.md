# Tesseract model

The model kinds for Tesseract OCR: a language recognition model and the page
orientation and script detection model, each a `.traineddata` file located by
path. A recognizer takes models by reference, so a bundled model, a language
module's model and your own custom or fine-tuned model are wired the same way.

## Why use this

- **Models are resources.** A recognizer lists the models it loads by `!ref`,
  and `telo check` refuses a reference of the wrong kind: a language where the
  orientation model belongs, or the other way round.
- **Your own model is one declaration.** Point `data` at a `.traineddata` file,
  gzip-compressed or raw, with `!module-path` or a host-path variable, and give
  the language code the model was trained under.
- **Declaring loads nothing.** A model only publishes where its file is and what
  it is called. The recognizer that references it reads the file into its own
  engine.

## Kinds

| Kind | Purpose |
| --- | --- |
| `TesseractModel.Model` | Abstract: a trained model file, located by `data`. |
| `TesseractModel.Language` | A text-recognition model, named by its language `code`. |
| `TesseractModel.OrientationModel` | The orientation and script detection model. |

An application normally does not import this module. The engine re-exports
`Language` and `OrientationModel`, and each language module exports a ready-made
`Language` instance.

## Example

A fine-tuned model shipped with the application, declared through the engine's
re-export:

```yaml
kind: Tesseract.Language
metadata: { name: receipts }
code: eng_receipts
data: !module-path ./models/eng_receipts.traineddata
```

## Documentation

- [Model kinds](./docs/models.md): the three kinds, their published reading, and
  why language modules import this module rather than the engine.
