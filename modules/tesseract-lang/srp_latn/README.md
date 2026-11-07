# Tesseract srp_latn

The Tesseract model for Serbian (Latin script), as one ready-made model a recognizer
references. Generated from `scripts/tesseract-languages.json`: edit the table or the
generator, never this module.

## Example

```yaml
kind: Telo.Application
metadata:
  name: ReadScans
imports:
  Tesseract: oci://ghcr.io/telorun/tesseract
  SrpLatn: oci://ghcr.io/telorun/tesseract-lang/srp_latn
---
kind: Tesseract.Recognizer
metadata:
  name: recognizer
languages:
  - !ref SrpLatn.srp_latn
  - !ref Tesseract.eng
```

The imports carry no version, so they resolve to the latest release; `telo install`
pins each one to the version it resolved.

## Documentation

- [Tesseract: languages, models and getting started](https://hub.telo.run/module/oci/ghcr.io/telorun/tesseract/)
