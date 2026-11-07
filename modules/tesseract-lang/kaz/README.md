# Tesseract kaz

The Tesseract model for Kazakh (Cyrillic script), as one ready-made model a recognizer
references. Generated from `scripts/tesseract-languages.json`: edit the table or the
generator, never this module.

## Example

```yaml
kind: Telo.Application
metadata:
  name: ReadScans
imports:
  Tesseract: oci://ghcr.io/telorun/tesseract
  Kaz: oci://ghcr.io/telorun/tesseract-lang/kaz
---
kind: Tesseract.Recognizer
metadata:
  name: recognizer
languages:
  - !ref Kaz.kaz
  - !ref Tesseract.eng
```

The imports carry no version, so they resolve to the latest release; `telo install`
pins each one to the version it resolved.

## Documentation

- [Tesseract: languages, models and getting started](https://hub.telo.run/module/oci/ghcr.io/telorun/tesseract/)
