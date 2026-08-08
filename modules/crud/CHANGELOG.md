# Changelog
## 0.8.0 - 2026-08-08
### Added
* Every `x-telo-ref` slot now declares what this module does with the target: `use: dependency` (held and read), `call` (control transfers during the invocation and returns), `detached`, `trigger.inbound`, `trigger.consumer`, or `schema` for a slot that only names a shape. Slots that accepted `Telo.Invocable | Telo.Runnable` through an `anyOf` now say `Telo.Executable`, the new built-in parent of both. Wiring manifests are unchanged — this is schema metadata, and it is what lets `telo check` answer whether control reaches a referenced resource, and when.## 0.7.0 - 2026-07-31
### Added
* Data shapes are declared with the kernel built-in `Telo.JsonSchema` instead of `Type.JsonSchema`, so the module no longer imports `std/type` to describe its own contracts. Identical behaviour; `Type.JsonSchema` still resolves for anyone who prefers it, though the `type` module is now deprecated.## 0.6.0 - 2026-07-27
### Added
* Reference slots name their target as an alias-qualified kind (`<Alias>.<Kind>`, `Self.<Kind>`, `Telo.<Kind>`) instead of the `<namespace>/<module>#<Kind>` identity string, so a constraint resolves through this module's own `imports:` map and stays pinned to the version it imports. `metadata.namespace` is dropped — a module's location is the ref it is published under, never anything it declares about itself.## 0.5.1 - 2026-07-27
### Fixed
* Rewrite the library and kind descriptions for the hub's semantic search: each one now states what it does in a single paragraph, without kind names, references to the modules that implement it, or wording that only made sense against the module's history. Kinds that carried no description at all now have one. The README is corrected alongside: reference and CEL syntax the analyzer no longer accepts, unpinned version tags, and examples that named fields or kinds that do not exist.
Declare `metadata.categories` — the domain labels the hub groups its browse view by and the editor filters its resource picker with.## 0.5.0 - 2026-07-19
### Added
* Declare repository and license in module metadata, published as org.opencontainers.image.* annotations on OCI.## 0.4.0 - 2026-07-12
### Added
* Describe exported resource kinds via metadata.description for semantic discovery.## 0.3.0 - 2026-06-23
### Added
* Add a required `model` (a `Type.JsonSchema`) to `Crud.Resource` that validates request bodies — POST against the full schema, PUT against a partial where nothing is required.
* Add `singular`/`plural` names to `Crud.Resource`. `table` now defaults from `plural` and the item path parameter from `<singular>Id` (overridable via `idParam`, renaming only the URL parameter — the PK column stays `id`); the generated OpenAPI operations are named from the singular/plural nouns and tagged with `plural`.
* Translate between camelCase model properties and snake_case database columns — writes map `dueDate` → `due_date`, reads alias `due_date AS dueDate` so responses stay camelCase. `Crud.Resource` now builds its SQL directly (no longer via `sql-repository`).## 0.2.0 - 2026-06-20
### Added
* New module `std/crud`. `Crud.Resource` is a single declarative Telo.Mount that exposes a full REST CRUD API (list / read / create / update / delete) over a SQL table — point it at a `Sql.Connection` and a table, then mount it on an `Http.Server`. Purely templated: it composes sql-repository's SQL handlers with an http-server `Http.Api` via the new `mount:` template dispatch, no controller code.## 0.1.0
