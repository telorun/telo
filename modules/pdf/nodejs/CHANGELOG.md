# @telorun/pdf

## 0.2.1

### Patch Changes

- 8af345f: The `Telo.Definition` schema is now the sole resource-config contract.

  A controller module's exports become the controller instance verbatim, so an
  `export const schema` silently won over the manifest's `schema:`. The analyzer
  never loads controllers, so those overrides were invisible to `telo check` and
  to the editor, could not be pre-compiled by the validator warm (recompiling on
  every boot, and failing to persist on a read-only image), and were free to drift
  from the manifest they shadowed.

  `ControllerInstance.schema` is removed, and the kernel now validates every
  resource against its definition's schema. All 35 controller-exported schemas are
  gone: 26 were `additionalProperties: true` catch-alls that merely _disabled_ the
  manifest's stricter validation, and 9 kept their TypeBox for `Static<typeof …>`
  typing but no longer export it.

  Two manifests had already drifted and are corrected:

  - `S3.Bucket` was missing `accessKeyId` / `secretAccessKey` entirely, though its
    controller required both. They are now declared (and required) in the manifest.
  - `Assert.ModuleContext` was missing `resources` / `variables` / `secrets`.

  Controller authors: declare config in `telo.yaml`, not in code. An
  `export const schema` is now inert.

## 0.2.0

### Minor Changes

- a0dd4dc: New `std/pdf` module — `Pdf.Rasterizer` renders one PDF page to image bytes
  (pdf.js on `@napi-rs/canvas`) and `Pdf.FormFields` authors editable AcroForm
  fields (pdf-lib) at coordinates measured on that rendered image. Both kinds
  share one coordinate space — rendered-image pixels, top-left origin, at the
  configured render `scale` — so coordinates flow from rasterized previews into
  field placement without any translation in manifests. The rasterizer encodes
  to a configurable `format` (png/jpeg/webp, png default) with `quality` for the
  lossy formats, and reports the output's `mediaType` for wiring into a vision
  message's image part.
