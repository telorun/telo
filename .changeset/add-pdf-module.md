---
"@telorun/pdf": minor
---

New `std/pdf` module — `Pdf.Rasterizer` renders one PDF page to PNG bytes
(pdf.js on `@napi-rs/canvas`) and `Pdf.FormFields` authors editable AcroForm
fields (pdf-lib) at coordinates measured on that rendered image. Both kinds
share one coordinate space — rendered-image pixels, top-left origin, at the
configured render `scale` — so coordinates flow from rasterized previews into
field placement without any translation in manifests.
