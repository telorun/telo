# Changelog
## 0.17.0 - 2026-08-14
### Added
* Assert.Manifest gains a `fix:` matcher on expected errors and warnings: a substring against the diagnostic's suggested replacement, so a test can assert the repair a diagnostic offers and not only its message. A diagnostic that offers no repair never matches, so the matcher also pins that one was produced.## 0.16.0 - 2026-08-11
### Added
* Assert.Equals compares a CEL integer against an integer literal. A CEL int is int64 — a BigInt — while an expected: literal comes out of YAML as a plain number, and YAML has no way to write the other, so every integer-valued expression was unassertable without first casting it to a float. Equality is exact in both directions: the literal must be integral and round-trip to the same int64, so 3 matches 3 but neither 3.5 nor a magnitude a double cannot represent.## 0.15.0 - 2026-08-09
### Added
* metadata.name is now Assert, so the module contributes its kinds under the `Assert.<Kind>` canonical prefix instead of `assert.<Kind>` — a name rather than a slug, in the PascalCase form the manifest grammar asks for. Importers are unaffected: a kind is always written through the import alias the consumer picks (`<Alias>.<Kind>`), and the `exports.kinds` list is unchanged. Only a manifest that names the canonical `<module>.<Kind>` form directly — a legacy bare-string `x-telo-ref`, or a diagnostic matched by its text — sees the new prefix.## 0.14.0 - 2026-08-01
### Added
* The controller now ships inside the module artifact as a bundle (pkg:telo/local/js) instead of being fetched from npm at load. Importing this module needs no npm registry at run time, and its version is a single number again: metadata.version. The kernel builds the controller from source while the module is a working copy, so a checkout needs no build step.## 0.13.1 - 2026-08-01
### Fixed
* Update controller @telorun/assert to 0.8.2.## 0.13.0 - 2026-07-31
### Added
* Data shapes are declared with the kernel built-in `Telo.JsonSchema` instead of `Type.JsonSchema`, so the module no longer imports `std/type` to describe its own contracts. Identical behaviour; `Type.JsonSchema` still resolves for anyone who prefers it, though the `type` module is now deprecated.
### Fixed
* Update controller @telorun/assert to 0.8.1.## 0.12.0 - 2026-07-30
### Added
* Update controller @telorun/assert to 0.8.0.## 0.11.3 - 2026-07-29
### Fixed
* Update controller @telorun/assert to 0.7.41.## 0.11.2 - 2026-07-29
### Fixed
* Update controller @telorun/assert to 0.7.40.## 0.11.1 - 2026-07-27
### Fixed
* Update controller @telorun/assert to 0.7.39.## 0.11.0 - 2026-07-27
### Added
* Drop `metadata.namespace`. A module's location is the ref it is published under, never anything it declares about itself, and nothing reads the field any more.
### Fixed
* Update controller @telorun/assert to 0.7.38.## 0.10.7 - 2026-07-27
### Fixed
* Rewrite the library and kind descriptions for the hub's semantic search: each one now states what it does in a single paragraph, without kind names, references to the modules that implement it, or wording that only made sense against the module's history. Kinds that carried no description at all now have one. The README is corrected alongside: reference and CEL syntax the analyzer no longer accepts, unpinned version tags, and examples that named fields or kinds that do not exist.
Declare `metadata.categories` — the domain labels the hub groups its browse view by and the editor filters its resource picker with.## 0.10.6 - 2026-07-27
### Fixed
* Update controller @telorun/assert to 0.7.37.## 0.10.5 - 2026-07-25
### Fixed
* Update controller @telorun/assert to 0.7.36.## 0.10.4 - 2026-07-23
### Fixed
* Update controller @telorun/assert to 0.7.35.## 0.10.3 - 2026-07-22
### Fixed
* Update controller @telorun/assert to 0.7.34.## 0.10.2 - 2026-07-21
### Fixed
* Update controller @telorun/assert to 0.7.33.## 0.10.1 - 2026-07-20
### Fixed
* Update controller @telorun/assert to 0.7.32.## 0.10.0 - 2026-07-19
### Added
* Declare repository and license in module metadata, published as org.opencontainers.image.* annotations on OCI.
### Fixed
* Update controller @telorun/assert to 0.7.31.## 0.9.5 - 2026-07-18
### Fixed
* Update controller @telorun/assert to 0.7.30.## 0.9.4 - 2026-07-18
### Fixed
* Update controller @telorun/assert to 0.7.29.## 0.9.3 - 2026-07-17
### Fixed
* Update controller @telorun/assert to 0.7.28.## 0.9.2 - 2026-07-14
### Fixed
* Update controller @telorun/assert to 0.7.27.## 0.9.1 - 2026-07-14
### Fixed
* Update controller @telorun/assert to 0.7.26.## 0.9.0 - 2026-07-12
### Added
* Describe exported resource kinds via metadata.description for semantic discovery.
### Fixed
* Update controller @telorun/assert to 0.7.25.## 0.8.15 - 2026-07-10
### Fixed
* Update controller @telorun/assert to 0.7.24.## 0.8.14 - 2026-07-06
### Fixed
* Update controller @telorun/assert to 0.7.23.## 0.8.13 - 2026-07-05
### Fixed
* Update controller @telorun/assert to 0.7.22.## 0.8.12 - 2026-06-28
### Fixed
* Update controller @telorun/assert to 0.7.21.## 0.8.11 - 2026-06-24
### Fixed
* Update controller @telorun/assert to 0.7.20.## 0.8.10 - 2026-06-23
### Fixed
* Update controller @telorun/assert to 0.7.19.## 0.8.9 - 2026-06-21
### Fixed
* Update controller @telorun/assert to 0.7.18.## 0.8.8 - 2026-06-20
### Fixed
* Update controller @telorun/assert to 0.7.17.## 0.8.7 - 2026-06-20
### Fixed
* Update controller @telorun/assert to 0.7.16.## 0.8.6 - 2026-06-20
### Fixed
* Update controller @telorun/assert to 0.7.15.## 0.8.5 - 2026-06-15
### Fixed
* Update controller @telorun/assert to 0.7.14.## 0.8.4 - 2026-06-14
### Fixed
* Update controller @telorun/assert to 0.7.13.## 0.8.3 - 2026-06-13
### Fixed
* Update controller @telorun/assert to 0.7.12.## 0.8.2 - 2026-06-11
### Fixed
* Update controller @telorun/assert to 0.7.11.## 0.8.1 - 2026-06-10
### Fixed
* Update controller @telorun/assert to 0.7.10.## 0.8.0 - 2026-06-07
### Added
* Schema `examples:` on its kinds so the MCP `get_module_manifest` tool gives authors a copyable template per kind.
### Fixed
* Update controller @telorun/assert to 0.7.9.## 0.7.8 - 2026-06-07
### Fixed
* Update controller @telorun/assert to 0.7.8.## 0.7.7 - 2026-06-06
### Fixed
* Update controller @telorun/assert to 0.7.7.## 0.7.6 - 2026-06-06
### Fixed
* Update controller @telorun/assert to 0.7.6.## 0.7.5 - 2026-06-06
### Fixed
* Update controller @telorun/assert to 0.7.5.## 0.7.4 - 2026-06-04
### Fixed
* Update controller @telorun/assert to 0.7.4.## 0.7.3 - 2026-06-03
### Fixed
* Update controller @telorun/assert to 0.7.3.## 0.7.2
