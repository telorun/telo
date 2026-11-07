# Tesseract frk

The Tesseract model for German Fraktur (Fraktur script), as one ready-made model a recognizer
references. Generated from `scripts/tesseract-languages.json`: edit the table or the
generator, never this module.

## Example

```yaml
kind: Telo.Application
metadata:
  name: ReadScans
imports:
  Tesseract: oci://ghcr.io/telorun/tesseract
  Frk: oci://ghcr.io/telorun/tesseract-lang/frk
---
kind: Tesseract.Recognizer
metadata:
  name: recognizer
languages:
  - !ref Frk.frk
  - !ref Tesseract.eng
```

The imports carry no version, so they resolve to the latest release; `telo install`
pins each one to the version it resolved.

## Documentation

- [Tesseract: languages, models and getting started](https://hub.telo.run/module/oci/ghcr.io/telorun/tesseract/)
