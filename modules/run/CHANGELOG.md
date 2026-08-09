# Changelog
## 0.22.0 - 2026-08-09
### Added
* metadata.name is now Run, so the module contributes its kinds under the `Run.<Kind>` canonical prefix instead of `run.<Kind>` — a name rather than a slug, in the PascalCase form the manifest grammar asks for. Importers are unaffected: a kind is always written through the import alias the consumer picks (`<Alias>.<Kind>`), and the `exports.kinds` list is unchanged. Only a manifest that names the canonical `<module>.<Kind>` form directly — a legacy bare-string `x-telo-ref`, or a diagnostic matched by its text — sees the new prefix.## 0.21.0 - 2026-08-08
### Added
* Every `x-telo-ref` slot now declares what this module does with the target: `use: dependency` (held and read), `call` (control transfers during the invocation and returns), `detached`, `trigger.inbound`, `trigger.consumer`, or `schema` for a slot that only names a shape. Slots that accepted `Telo.Invocable | Telo.Runnable` through an `anyOf` now say `Telo.Executable`, the new built-in parent of both. Wiring manifests are unchanged — this is schema metadata, and it is what lets `telo check` answer whether control reaches a referenced resource, and when.## 0.20.0 - 2026-08-03
### Added
* Named CEL bindings and pure steps. Run.Value and Run.Choice take an optional `bindings:` map — name → CEL, read by bare name inside the kind's expressions and inside each other. Order is derived from what each expression references rather than declared, so reordering rows cannot change behaviour; evaluation is lazy and memoised per call, so a binding several decision rows share is computed once and one nothing reads is never computed at all — a binding means exactly what inlining its expression would. A cycle is BINDING_CYCLE and a name that shadows something already in scope is BINDING_NAME_RESERVED, both at `telo check`. Bindings are evaluated before any step runs, so they never see `steps.*`: for an intermediate derived from a step's result, a step now carries `value:` instead of `invoke:`. That pure step publishes `steps.<name>.result` like any other but dispatches nothing — no resource, no span, no topology node — and is part of the shared step grammar, so it works in Run.Sequence, Run.Loop, Run.Iteration and Run.Projection alike; a failure inside one is reported against the step by name, as every other step form already is. Binding names must lex as CEL identifiers, so a name no expression could ever read is rejected at `telo check` rather than silently dead.## 0.19.0 - 2026-08-01
### Added
* The controller now ships inside the module artifact as a bundle (pkg:telo/local/js) instead of being fetched from npm at load. Importing this module needs no npm registry at run time, and its version is a single number again: metadata.version. The kernel builds the controller from source while the module is a working copy, so a checkout needs no build step.## 0.18.0 - 2026-07-31
### Added
* Update controller @telorun/run to 0.13.0.
* Data shapes are declared with the kernel built-in `Telo.JsonSchema` instead of `Type.JsonSchema`, so the module no longer imports `std/type` to describe its own contracts. Identical behaviour; `Type.JsonSchema` still resolves for anyone who prefers it, though the `type` module is now deprecated.## 0.17.0 - 2026-07-29
### Added
* Update controller @telorun/run to 0.12.0.## 0.16.0 - 2026-07-29
### Added
* Update controller @telorun/run to 0.11.0.## 0.15.0 - 2026-07-27
### Added
* Reference slots name their target as an alias-qualified kind (`<Alias>.<Kind>`, `Self.<Kind>`, `Telo.<Kind>`) instead of the `<namespace>/<module>#<Kind>` identity string, so a constraint resolves through this module's own `imports:` map and stays pinned to the version it imports. `metadata.namespace` is dropped — a module's location is the ref it is published under, never anything it declares about itself.## 0.14.1 - 2026-07-27
### Fixed
* Rewrite the library and kind descriptions for the hub's semantic search: each one now states what it does in a single paragraph, without kind names, references to the modules that implement it, or wording that only made sense against the module's history. The README is corrected alongside: reference and CEL syntax the analyzer no longer accepts, unpinned version tags, and examples that named fields or kinds that do not exist.
Declare `metadata.categories` — the domain labels the hub groups its browse view by and the editor filters its resource picker with.## 0.14.0 - 2026-07-27
### Added
* Update controller @telorun/run to 0.10.0.## 0.13.0 - 2026-07-19
### Added
* Declare repository and license in module metadata, published as org.opencontainers.image.* annotations on OCI.## 0.12.0 - 2026-07-12
### Added
* Describe exported resource kinds via metadata.description for semantic discovery.## 0.11.1 - 2026-06-24
### Fixed
* Update controller @telorun/run to 0.9.1.## 0.11.0 - 2026-06-20
### Added
* Update controller @telorun/run to 0.9.0.## 0.10.0 - 2026-06-14
### Added
* Update controller @telorun/run to 0.8.0.## 0.9.0 - 2026-06-13
### Added
* Update controller @telorun/run to 0.7.0.
* Add Run.Value: a declarative invocable that returns a CEL-evaluated value (or a constant), replacing Js.Script for pure value shaping.## 0.8.0 - 2026-06-07
### Added
* Update controller @telorun/run to 0.6.0.
* Step `invoke` examples reference resources with the unified `!ref` form.## 0.7.0 - 2026-06-06
### Added
* README: bringing up dependencies with a sequence's with:/targets: (a Run.Sequence can start an Http.Server or DB for its steps); targets is not Application-only.## 0.6.0 - 2026-06-06
### Added
* Clarify Run.Sequence inputs/outputs docs — inputs declares the input contract (JSON Schema map, {} = dyn), outputs is the CEL map producing the caller-visible result. Adds a schema example and a "Sequence as an HTTP handler" README example.## 0.5.0 - 2026-06-05
### Added
* Update controller @telorun/run to 0.5.0.## 0.4.1
