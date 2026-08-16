# Changelog

## 0.10.2 - 2026-08-16
### Fixed
* Controllers ship as one bundle per module, selected by PURL fragment, and a module-owned library is resolved at load through the import graph instead of being copied into each dependent's bundle. A shared source file compiled into two bundles was two module scopes, so state a module kept beside its instances silently became two of them.

## 0.10.0 - 2026-08-15
### Added
* Stream.Chunk re-frames a byte stream into fixed-size pieces, buffering across the boundaries bytes happened to arrive on and splitting any that is too large. Each piece reports its offset, length, index and whether it is last, so a Content-Range header or a sequence number is expressible in CEL at the use site. One piece is held in memory at a time.## 0.9.0 - 2026-08-09
### Added
* metadata.name is now Stream, so the module contributes its kinds under the `Stream.<Kind>` canonical prefix instead of `stream.<Kind>` — a name rather than a slug, in the PascalCase form the manifest grammar asks for. Importers are unaffected: a kind is always written through the import alias the consumer picks (`<Alias>.<Kind>`), and the `exports.kinds` list is unchanged. Only a manifest that names the canonical `<module>.<Kind>` form directly — a legacy bare-string `x-telo-ref`, or a diagnostic matched by its text — sees the new prefix.## 0.8.0 - 2026-08-01
### Added
* The controller now ships inside the module artifact as a bundle (pkg:telo/local/js) instead of being fetched from npm at load. Importing this module needs no npm registry at run time, and its version is a single number again: metadata.version. The kernel builds the controller from source while the module is a working copy, so a checkout needs no build step.## 0.7.0 - 2026-07-31
### Added
* Data shapes are declared with the kernel built-in `Telo.JsonSchema` instead of `Type.JsonSchema`, so the module no longer imports `std/type` to describe its own contracts. Identical behaviour; `Type.JsonSchema` still resolves for anyone who prefers it, though the `type` module is now deprecated.## 0.6.0 - 2026-07-27
### Added
* Drop `metadata.namespace`. A module's location is the ref it is published under, never anything it declares about itself, and nothing reads the field any more.## 0.5.1 - 2026-07-27
### Fixed
* Rewrite the library and kind descriptions for the hub's semantic search: each one now states what it does in a single paragraph, without kind names, references to the modules that implement it, or wording that only made sense against the module's history. The README is corrected alongside: reference and CEL syntax the analyzer no longer accepts, unpinned version tags, and examples that named fields or kinds that do not exist.
Declare `metadata.categories` — the domain labels the hub groups its browse view by and the editor filters its resource picker with.## 0.5.0 - 2026-07-19
### Added
* Declare repository and license in module metadata, published as org.opencontainers.image.* annotations on OCI.
### Fixed
* Update controller @telorun/stream to 0.4.1.## 0.4.0 - 2026-07-12
### Added
* Update controller @telorun/stream to 0.4.0.
* Describe exported resource kinds via metadata.description for semantic discovery.## 0.3.0 - 2026-07-05
### Added
* Update controller @telorun/stream to 0.3.0.## 0.2.0 - 2026-06-04
### Added
* Update controller @telorun/stream to 0.2.0.## 0.1.0
