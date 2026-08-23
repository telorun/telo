# Changelog

## 0.11.0 - 2026-08-23
### Added
* Controllers return their effects from `init()` / `run()` instead of implementing `teardown()`: each allocation is written beside the inverse that undoes it, and the runtime unwinds them last-in-first-out. A failure part-way through startup now recovers what it already allocated — a bound port releases the kernel hold and unregisters the routes, a connection that fails its health check destroys its pool — and the retry starts from a freshly constructed resource. Declares `requires: telo: '>=0.82.0'`, since an older runtime discards what a controller returns and would allocate nothing.

## 0.10.0 - 2026-08-20
### Deprecated
* Deprecated in favour of the unprefixed postgres / sqlite modules, which carry the same Connection kind plus declarative schema and reclamation. The sql- prefix restated the abstract this module implements, which extends already records, and it stops being true now that a backend owns engine-specific surface that is not a sql kind. Consumers change one imports: entry; the alias and every kind: spelling are unchanged.

## 0.9.3 - 2026-08-16
### Fixed
* Controllers ship as one bundle per module, selected by PURL fragment, and a module-owned library is resolved at load through the import graph instead of being copied into each dependent's bundle. A shared source file compiled into two bundles was two module scopes, so state a module kept beside its instances silently became two of them.

## 0.9.1 - 2026-08-12
### Fixed
* Statements run through this connection now emit a `debug` log record each, plus records for transaction start, commit and rollback. The behaviour comes from `SqlConnectionBase`, which this module extends and whose source is inlined into its bundled controller — so the published artifact changed without any file under this module changing. Bound parameters are never logged; the statement text is the parameterized template. Republished so an import pinned to this module resolves to bytes that match the shared library it was built from.## 0.9.0 - 2026-08-09
### Added
* metadata.name is now Postgres, so the module contributes its kinds under the `Postgres.<Kind>` canonical prefix instead of `sql-postgres.<Kind>` — a name rather than a slug, in the PascalCase form the manifest grammar asks for. Importers are unaffected: a kind is always written through the import alias the consumer picks (`<Alias>.<Kind>`), and the `exports.kinds` list is unchanged. Only a manifest that names the canonical `<module>.<Kind>` form directly — a legacy bare-string `x-telo-ref`, or a diagnostic matched by its text — sees the new prefix.## 0.8.0 - 2026-08-08
### Added
* The connection passes its `ResourceContext` to `SqlConnectionBase`, which now carries transaction state through the kernel's execution-zone stack (keyed per connection) rather than a module-global store. No manifest change — pooling, `sslmode` handling and the liveness sweep are untouched.## 0.7.0 - 2026-08-01
### Added
* The controller now ships inside the module artifact as a bundle (pkg:telo/local/js) instead of being fetched from npm at load. Importing this module needs no npm registry at run time, and its version is a single number again: metadata.version. The kernel builds the controller from source while the module is a working copy, so a checkout needs no build step.## 0.6.0 - 2026-07-29
### Added
* Update controller @telorun/sql-postgres to 0.3.0.## 0.5.0 - 2026-07-27
### Added
* Drop `metadata.namespace`. A module's location is the ref it is published under, never anything it declares about itself, and nothing reads the field any more.## 0.4.2 - 2026-07-27
### Fixed
* Rewrite the library and kind descriptions for the hub's semantic search: each one now states what it does in a single paragraph, without kind names, references to the modules that implement it, or wording that only made sense against the module's history. The README is corrected alongside: reference and CEL syntax the analyzer no longer accepts, unpinned version tags, and examples that named fields or kinds that do not exist.
Declare `metadata.categories` — the domain labels the hub groups its browse view by and the editor filters its resource picker with.## 0.4.1 - 2026-07-27
### Fixed
* Update controller @telorun/sql-postgres to 0.2.1.## 0.4.0 - 2026-07-19
### Added
* Declare repository and license in module metadata, published as org.opencontainers.image.* annotations on OCI.## 0.3.0 - 2026-07-12
### Added
* Describe exported resource kinds via metadata.description for semantic discovery.## 0.2.0 - 2026-06-20
### Added
* Update controller @telorun/sql-postgres to 0.2.0.## 0.1.0
