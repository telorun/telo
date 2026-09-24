---
description: "TesseractModel.Model, Language and OrientationModel: trained Tesseract model files as resources"
sidebar_label: Model kinds
---

# Model kinds

> Examples assume this module is imported under the alias `TesseractModel`. An application usually reaches the same kinds through the engine's re-export (`Tesseract.Language`, `Tesseract.OrientationModel`).

A Tesseract model is a `.traineddata` file. This module declares it as a resource: where the file is and, for a language, which code it was trained under. Declaring one reads nothing. The recognizer that references it reads the file into each of its engines.

## `TesseractModel.Model`

The abstract every model kind extends, with capability `Telo.Provider`.

| Field | Type | Meaning |
| --- | --- | --- |
| `data` | `Telo.HostPath`, required | The `.traineddata` file, gzip-compressed or raw. |

`data` is an absolute path on the host. Write `!module-path` for a file that ships with your module, or bind it to an application variable typed `Telo.HostPath`; a relative string is refused (`HOST_PATH_RELATIVE`). The recognizer tells gzip from raw by the file's header, so both work without saying which. A raw file is what a custom or fine-tuned model usually is.

## `TesseractModel.Language`

A text-recognition model. Extends `Model` and adds:

| Field | Type | Meaning |
| --- | --- | --- |
| `code` | string, required | The model's Tesseract code, such as `eng`, `deu` or `chi_sim`. Lowercase letters, digits and `_`, starting with a letter. |

The recognizer passes `code` to the engine as the language name. The file name is never read, so a file called anything works as long as `code` names what it was trained as.

```yaml
kind: TesseractModel.Language
metadata: { name: receipts }
code: eng_receipts
data: !module-path ./models/eng_receipts.traineddata
```

## `TesseractModel.OrientationModel`

The orientation and script detection model (Tesseract's `osd`). Extends `Model` and carries no `code`. A recognizer uses it to detect how the page is rotated and which script it is written in.

```yaml
kind: TesseractModel.OrientationModel
metadata: { name: osd }
data: !module-path ./models/osd.traineddata.gz
```

It is a kind of its own, not a `Language` with a reserved code, so a recognition slot and an orientation slot each accept only their own kind. `telo check` refuses a mixed-up model at the reference instead of the engine failing at boot.

## Published reading

Each model publishes exactly what a recognizer needs:

| Kind | `resources.<name>` |
| --- | --- |
| `Language` | `{ data, code }` |
| `OrientationModel` | `{ data }` |

A recognizer reads a model only through this reading, never through its class. A model declared against one version of this module therefore works with a recognizer that imported another.

## Why this module is separate from the engine

Language modules import this module, never the engine:

- **Releases.** In this repository's release system, an import edge bumps its dependent whenever the dependency is released. If about 120 language modules imported the engine, every engine release would republish all of them. This module holds only the model kinds, so it almost never changes.
- **Scopes.** Each import opens its own isolated scope. A language module importing the engine would create an engine scope, with its own bundled models, per language.
- **Downloads.** With two engine versions in one application, the engine's assets would be fetched twice.

The engine imports this module and re-exports `Language` and `OrientationModel`, so an application declaring a custom model imports only the engine.
