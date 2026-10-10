# Changelog

## 0.10.0 - 2026-10-10
### Added
* New kind Image.Fit: scales an image down to fit within maxWidth and maxHeight (each 1 to 16384), keeping its aspect ratio and never enlarging it, and always re-encodes it, so no input metadata survives. Inputs: image (bytes), maxWidth, maxHeight, and format and quality overriding the resource's; resource fields format (png, jpeg or webp, default png), quality (1 to 100, default 80), maxBytes (default 26214400) and maxPixels (default 40000000). Outputs: image, width, height and mediaType. It reads PNG, JPEG, WebP and GIF: an EXIF orientation is applied wherever the file carries one (a JPEG, a WebP, a PNG) and the box is measured on the upright image; a GIF is taken as stored and an animated one yields its first frame. Two codes are declared. ERR_IMAGE_TOO_LARGE, with data limit (maxBytes or maxPixels) and max, is raised from the header before anything is decoded. ERR_UNSUPPORTED_IMAGE is raised for bytes that are not a readable image of those four formats: from the signature or header before decoding, or when the decoder rejects a corrupt or truncated body. The controller package gains the ./fit export.
### Fixed
* The canvas decoder moves from 1.0.0 to 1.0.10. An image whose signature is recognised but whose body is corrupt or cut short is now an error the caller can catch, where it ended the whole process: Image.Fit raises ERR_UNSUPPORTED_IMAGE and Image.Overlay raises ERR_INVALID_INPUT. The pdf module stages the same version, since it points every canvas loaded after it in the process at its own decoder file.

## 0.9.0 - 2026-10-07
### Added
* Released under the MIT License from this version: the manifest declares license MIT, and the published artifact carries the MIT license text in a LICENSE file at the module root. Versions already published keep the license they shipped with.

## 0.8.0 - 2026-10-03
### Added
* Breaking: the image slots of `Image.Blank` (output `image`) and `Image.Overlay` (input `image`, output `image`) are declared as bytes (`Telo.Bytes`) instead of `type: object`. An `image` argument that is not bytes now fails the call with `ERR_INPUT_INVALID` before the controller runs, where it raised `ERR_INVALID_INPUT`, and `telo check` reports an expression of another type. The outputs no longer fit a slot declared as a JSON type; pass them to a slot declared as bytes.

## 0.7.0 - 2026-08-09
### Added
* metadata.name is now Image, so the module contributes its kinds under the `Image.<Kind>` canonical prefix instead of `image.<Kind>` — a name rather than a slug, in the PascalCase form the manifest grammar asks for. Importers are unaffected: a kind is always written through the import alias the consumer picks (`<Alias>.<Kind>`), and the `exports.kinds` list is unchanged. Only a manifest that names the canonical `<module>.<Kind>` form directly — a legacy bare-string `x-telo-ref`, or a diagnostic matched by its text — sees the new prefix.## 0.6.0 - 2026-07-31
### Added
* Update controller @telorun/image to 0.3.0.
* Data shapes are declared with the kernel built-in `Telo.JsonSchema` instead of `Type.JsonSchema`, so the module no longer imports `std/type` to describe its own contracts. Identical behaviour; `Type.JsonSchema` still resolves for anyone who prefers it, though the `type` module is now deprecated.## 0.5.0 - 2026-07-27
### Added
* Drop `metadata.namespace`. A module's location is the ref it is published under, never anything it declares about itself, and nothing reads the field any more.## 0.4.1 - 2026-07-27
### Fixed
* Rewrite the library and kind descriptions for the hub's semantic search: each one now states what it does in a single paragraph, without kind names, references to the modules that implement it, or wording that only made sense against the module's history. The README is corrected alongside: reference and CEL syntax the analyzer no longer accepts, unpinned version tags, and examples that named fields or kinds that do not exist.
Declare `metadata.categories` — the domain labels the hub groups its browse view by and the editor filters its resource picker with.## 0.4.0 - 2026-07-19
### Added
* Declare repository and license in module metadata, published as org.opencontainers.image.* annotations on OCI.
### Fixed
* Update controller @telorun/image to 0.2.1.## 0.3.0 - 2026-07-12
### Added
* Describe exported resource kinds via metadata.description for semantic discovery.## 0.2.0 - 2026-06-13
### Added
* Update controller @telorun/image to 0.2.0.## 0.1.0
