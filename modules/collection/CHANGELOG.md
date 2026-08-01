# Changelog
## 0.4.0 - 2026-08-01
### Added
* The controller now ships inside the module artifact as a bundle (pkg:telo/local/js) instead of being fetched from npm at load. Importing this module needs no npm registry at run time, and its version is a single number again: metadata.version. The kernel builds the controller from source while the module is a working copy, so a checkout needs no build step.## 0.3.0 - 2026-07-31
### Added
* Data shapes are declared with the kernel built-in `Telo.JsonSchema` instead of `Type.JsonSchema`, so the module no longer imports `std/type` to describe its own contracts. Identical behaviour; `Type.JsonSchema` still resolves for anyone who prefers it, though the `type` module is now deprecated.## 0.2.0 - 2026-07-27
### Added
* Drop `metadata.namespace`. A module's location is the ref it is published under, never anything it declares about itself, and nothing reads the field any more.## 0.1.1 - 2026-07-27
### Fixed
* Rewrite the library and kind descriptions for the hub's semantic search: each one now states what it does in a single paragraph, without kind names, references to the modules that implement it, or wording that only made sense against the module's history.
Declare `metadata.categories` — the domain labels the hub groups its browse view by and the editor filters its resource picker with.## 0.1.0
