# Changelog

## 0.10.0 - 2026-08-29
### Deprecated
* Merged into the `openai` module, which serves every OpenAI endpoint — chat, images and embeddings — under one import. One module per SYSTEM rather than per endpoint, so moderation, audio, batch and files arrive there as further kinds rather than as a module apiece. The rename rides the release that already breaks every consumer's imports; done later it would be a second break of the same manifests. `telo upgrade` moves a pin within a ref and does not cross a rename, so a consumer edits its `imports:` by hand once.

## 0.9.2 - 2026-08-16
### Fixed
* Controllers ship as one bundle per module, selected by PURL fragment, and a module-owned library is resolved at load through the import graph instead of being copied into each dependent's bundle. A shared source file compiled into two bundles was two module scopes, so state a module kept beside its instances silently became two of them.

## 0.9.0 - 2026-08-09
### Added
* metadata.name is now EmbeddingOpenAI, so the module contributes its kinds under the `EmbeddingOpenAI.<Kind>` canonical prefix instead of `embedding-openai.<Kind>` — a name rather than a slug, in the PascalCase form the manifest grammar asks for. Importers are unaffected: a kind is always written through the import alias the consumer picks (`<Alias>.<Kind>`), and the `exports.kinds` list is unchanged. Only a manifest that names the canonical `<module>.<Kind>` form directly — a legacy bare-string `x-telo-ref`, or a diagnostic matched by its text — sees the new prefix.## 0.8.0 - 2026-08-01
### Added
* The controller now ships inside the module artifact as a bundle (pkg:telo/local/js) instead of being fetched from npm at load. Importing this module needs no npm registry at run time, and its version is a single number again: metadata.version. The kernel builds the controller from source while the module is a working copy, so a checkout needs no build step.## 0.7.0 - 2026-07-27
### Added
* Drop `metadata.namespace`. A module's location is the ref it is published under, never anything it declares about itself, and nothing reads the field any more.## 0.6.2 - 2026-07-27
### Fixed
* Rewrite the library and kind descriptions for the hub's semantic search: each one now states what it does in a single paragraph, without kind names, references to the modules that implement it, or wording that only made sense against the module's history.
Declare `metadata.categories` — the domain labels the hub groups its browse view by and the editor filters its resource picker with.## 0.6.1 - 2026-07-27
### Fixed
* Update controller @telorun/embedding-openai to 0.4.1.## 0.6.0 - 2026-07-19
### Added
* Update controller @telorun/embedding-openai to 0.4.0.## 0.5.0 - 2026-07-19
### Added
* Declare repository and license in module metadata, published as org.opencontainers.image.* annotations on OCI.## 0.4.0 - 2026-07-18
### Added
* Update controller @telorun/embedding-openai to 0.3.0.## 0.3.0 - 2026-07-12
### Added
* Describe exported resource kinds via metadata.description for semantic discovery.## 0.2.0 - 2026-06-20
### Added
* Update controller @telorun/embedding-openai to 0.2.0.## 0.1.0
