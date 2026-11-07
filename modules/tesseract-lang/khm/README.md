# Tesseract khm

The Tesseract model for Khmer (Khmer script), as one ready-made model a recognizer
references. Generated from `scripts/tesseract-languages.json`: edit the table or the
generator, never this module.

## Example

```yaml
kind: Telo.Application
metadata:
  name: ReadScans
imports:
  Tesseract: oci://ghcr.io/telorun/tesseract
  Khm: oci://ghcr.io/telorun/tesseract-lang/khm
---
kind: Tesseract.Recognizer
metadata:
  name: recognizer
languages:
  - !ref Khm.khm
  - !ref Tesseract.eng
```

The imports carry no version, so they resolve to the latest release; `telo install`
pins each one to the version it resolved.

## Documentation

- [Tesseract: languages, models and getting started](https://hub.telo.run/module/oci/ghcr.io/telorun/tesseract/)
