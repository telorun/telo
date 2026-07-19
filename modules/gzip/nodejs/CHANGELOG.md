# @telorun/gzip

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

- 030bfdd: Add `std/gzip` (`Gzip.Encoder` / `Gzip.Decoder` — gzip ↔ gunzip a `Stream<Uint8Array>`) and `std/tar` (`Tar.Pack` — build a tar byte stream from `{ path, contents }` entries; `Tar.Extract` — pull one named entry out of a tar byte stream). Both are streaming, codec-composable building blocks for reading and writing `.tar.gz` payloads (e.g. module artifacts) without buffering the whole archive.
