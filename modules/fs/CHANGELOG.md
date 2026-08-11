# Changelog
## 0.9.0 - 2026-08-11
### Added
* Filesystem operations log what they touched: writes at debug with path and size, Fs.FileRemoval at info with the path, and Fs.TreeSync with one info carrying the number of paths deleted (each path individually at debug, since a routine delta legitimately carries hundreds). A deletion is the one operation with nothing left behind to inspect afterwards — TreeSync's is recursive and force:true, so a mistyped path takes a tree and a path that never existed reports success either way. File contents are never logged.## 0.8.0 - 2026-08-09
### Added
* Fs.FileWrite and Fs.TreeSync accept raw bytes as content, alongside the existing utf8 and base64 string forms. A Uint8Array handed over by a byte-producing resource — a generated image, a decoded payload — is now written as it is, with no base64 round trip and no JS.Script hop in between. encoding does not apply to raw bytes and is ignored for them.## 0.7.0 - 2026-08-01
### Added
* The controller now ships inside the module artifact as a bundle (pkg:telo/local/js) instead of being fetched from npm at load. Importing this module needs no npm registry at run time, and its version is a single number again: metadata.version. The kernel builds the controller from source while the module is a working copy, so a checkout needs no build step.## 0.6.0 - 2026-07-31
### Added
* Data shapes are declared with the kernel built-in `Telo.JsonSchema` instead of `Type.JsonSchema`, so the module no longer imports `std/type` to describe its own contracts. Identical behaviour; `Type.JsonSchema` still resolves for anyone who prefers it, though the `type` module is now deprecated.## 0.5.0 - 2026-07-27
### Added
* Drop `metadata.namespace`. A module's location is the ref it is published under, never anything it declares about itself, and nothing reads the field any more.## 0.4.1 - 2026-07-27
### Fixed
* Rewrite the library and kind descriptions for the hub's semantic search: each one now states what it does in a single paragraph, without kind names, references to the modules that implement it, or wording that only made sense against the module's history.
Declare `metadata.categories` — the domain labels the hub groups its browse view by and the editor filters its resource picker with.## 0.4.0 - 2026-07-19
### Added
* Declare repository and license in module metadata, published as org.opencontainers.image.* annotations on OCI.## 0.3.0 - 2026-07-18
### Added
* Declare `exports.kinds` explicitly, listing every kind the module already exported implicitly, and add a `metadata.description` to every exported kind (and exported resource) so the discovery hub can index them for semantic search. No change to what importers can reference — the module previously relied on the loader treating an absent `exports.kinds` as "export everything", and now states its public kind surface outright.## 0.2.1 - 2026-07-06
### Fixed
* Quote description strings containing a colon-space inside backticks (e.g. `encoding: base64`) so the registry's strict YAML parser accepts the manifest on publish.## 0.2.0 - 2026-07-06
### Added
* Update controller @telorun/fs to 0.2.0.## 0.1.0 - 2026-06-30
### Added
* Update controller @telorun/fs to 0.1.0.## 0.0.0
