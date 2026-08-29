# Changelog

## 0.11.0 - 2026-08-29
### Added
* `Sse.Decoder` — byte chunks in, one record per frame out, emitted as each frame arrives rather than collected at the end. `data` is handed over as text and never parsed: the format says nothing about what a payload is, and a stream of JSON frames routinely ends with a sentinel that is not JSON. Comments and keep-alives are skipped, multi-line payloads are joined, an id persists across frames as the format specifies, and a trailing frame that never got its blank line is dispatched rather than discarded — a one-shot HTTP response has no second delivery.
### Fixed
* An error frame carries the failing error's `code` when it has one. A stream now fails by rejecting, so this frame is the whole of what a client gets, and a bare message is not something it can branch on.

## 0.10.3 - 2026-08-16
### Fixed
* Controllers ship as one bundle per module, selected by PURL fragment, and a module-owned library is resolved at load through the import graph instead of being copied into each dependent's bundle. A shared source file compiled into two bundles was two module scopes, so state a module kept beside its instances silently became two of them.

## 0.10.1 - 2026-08-11
### Fixed
* Sse.Encoder logs an upstream failure that happens mid-stream. The terminal 'event: error' frame tells the client, but the stream has already been handed to the transport — the failure never reaches the caller and the response still completes 200, so nothing was reported server-side.## 0.10.0 - 2026-08-09
### Added
* metadata.name is now SseCodec, so the module contributes its kinds under the `SseCodec.<Kind>` canonical prefix instead of `sse-codec.<Kind>` — a name rather than a slug, in the PascalCase form the manifest grammar asks for. Importers are unaffected: a kind is always written through the import alias the consumer picks (`<Alias>.<Kind>`), and the `exports.kinds` list is unchanged. Only a manifest that names the canonical `<module>.<Kind>` form directly — a legacy bare-string `x-telo-ref`, or a diagnostic matched by its text — sees the new prefix.## 0.9.0 - 2026-08-01
### Added
* The controller now ships inside the module artifact as a bundle (pkg:telo/local/js) instead of being fetched from npm at load. Importing this module needs no npm registry at run time, and its version is a single number again: metadata.version. The kernel builds the controller from source while the module is a working copy, so a checkout needs no build step.## 0.8.0 - 2026-07-27
### Added
* Drop `metadata.namespace`. A module's location is the ref it is published under, never anything it declares about itself, and nothing reads the field any more.## 0.7.1 - 2026-07-27
### Fixed
* Rewrite the library and kind descriptions for the hub's semantic search: each one now states what it does in a single paragraph, without kind names, references to the modules that implement it, or wording that only made sense against the module's history. The README is corrected alongside: reference and CEL syntax the analyzer no longer accepts, unpinned version tags, and examples that named fields or kinds that do not exist.
Declare `metadata.categories` — the domain labels the hub groups its browse view by and the editor filters its resource picker with.## 0.7.0 - 2026-07-19
### Added
* Declare repository and license in module metadata, published as org.opencontainers.image.* annotations on OCI.
### Fixed
* Update controller @telorun/sse-codec to 0.5.1.## 0.6.0 - 2026-07-12
### Added
* Describe exported resource kinds via metadata.description for semantic discovery.## 0.5.0 - 2026-07-06
### Added
* Update controller @telorun/sse-codec to 0.5.0.## 0.4.1
