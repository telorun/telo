# Changelog
## 0.20.0 - 2026-08-09
### Added
* metadata.name is now SQL, so the module contributes its kinds under the `SQL.<Kind>` canonical prefix instead of `sql.<Kind>` — a name rather than a slug, in the PascalCase form the manifest grammar asks for. Importers are unaffected: a kind is always written through the import alias the consumer picks (`<Alias>.<Kind>`), and the `exports.kinds` list is unchanged. Only a manifest that names the canonical `<module>.<Kind>` form directly — a legacy bare-string `x-telo-ref`, or a diagnostic matched by its text — sees the new prefix.## 0.19.0 - 2026-08-08
### Added
* Every `x-telo-ref` slot now declares what this module does with the target: `use: dependency` (held and read), `call` (control transfers during the invocation and returns), `detached`, `trigger.inbound`, `trigger.consumer`, or `schema` for a slot that only names a shape. Slots that accepted `Telo.Invocable | Telo.Runnable` through an `anyOf` now say `Telo.Executable`, the new built-in parent of both. Wiring manifests are unchanged — this is schema metadata, and it is what lets `telo check` answer whether control reaches a referenced resource, and when.
* Transaction membership is now carried by the kernel's execution-zone stack and keyed PER CONNECTION, which fixes four defects at once. A statement that declares `transaction:` previously threw on every path — including inside its own transaction — because the ambient store was one `AsyncLocalStorage` per controller bundle; a nested `Sql.Transaction` never joined the enclosing one for the same reason; a statement declared on connection B inside connection A's transaction executed on A's connection; and a detached dispatch raced the commit. `transaction:` now declares a REQUIREMENT (`x-telo-requires-zone`, correlated on the connection, deriving it from the transaction when `connection:` is omitted), so `telo check` reports a path that reaches the statement outside a transaction — at an HTTP route, a detached dispatch, or boot — before it ever executes, and the runtime raises `ERR_ZONE_REQUIRED` naming the connection. `Sql.Transaction.steps` widens from `Telo.Invocable` to `Telo.Executable`, so a `Run.Sequence` body is finally expressible — which is what makes a bound statement inside its own transaction writable at all, the direct wiring having been an init-order cycle. See `docs/transactions.md`.
### Fixed
* Sql.Transaction: the forwarded-inputs slot is now declared as `inputs`, the field the controller actually reads. The schema previously spelled it `bindings`, which nothing read — authoring it was silently ignored, and `inputs:` was rejected by validation. The slot is a CEL region whose expressions read the caller's invocation input as `inputs.<field>` (the controller binds it under that name, matching how a Run.Sequence step's inputs read), and the forwarding path is now covered by a manifest test. Note the rename is author-facing: a manifest still writing `bindings:` on a Sql.Transaction now fails validation instead of being silently ignored.## 0.18.0 - 2026-08-03
### Added
* Structured deprecation on Sql.Migration. The kind's replacement was previously stated only in prose inside its description, where nothing could badge it or link it. It now carries `metadata.deprecated` with a `reason` and `replacedBy: Self.Migrations`, which the hub resolves through this manifest's own imports into a target a consumer can follow. Behaviour is unchanged — a standalone Sql.Migration is still discovered by any Sql.Migrations in the same module scope and merged into its set.## 0.17.0 - 2026-08-01
### Added
* The controller now ships inside the module artifact as a bundle (pkg:telo/local/js) instead of being fetched from npm at load. Importing this module needs no npm registry at run time, and its version is a single number again: metadata.version. The kernel builds the controller from source while the module is a working copy, so a checkout needs no build step.## 0.16.0 - 2026-07-29
### Added
* Update controller @telorun/sql to 0.10.0.## 0.15.0 - 2026-07-27
### Added
* Reference slots name their target as an alias-qualified kind (`<Alias>.<Kind>`, `Self.<Kind>`, `Telo.<Kind>`) instead of the `<namespace>/<module>#<Kind>` identity string, so a constraint resolves through this module's own `imports:` map and stays pinned to the version it imports. `metadata.namespace` is dropped — a module's location is the ref it is published under, never anything it declares about itself.## 0.14.1 - 2026-07-27
### Fixed
* Rewrite the library and kind descriptions for the hub's semantic search: each one now states what it does in a single paragraph, without kind names, references to the modules that implement it, or wording that only made sense against the module's history. The README is corrected alongside: reference and CEL syntax the analyzer no longer accepts, unpinned version tags, and examples that named fields or kinds that do not exist.
Declare `metadata.categories` — the domain labels the hub groups its browse view by and the editor filters its resource picker with.## 0.14.0 - 2026-07-27
### Added
* Update controller @telorun/sql to 0.9.0.## 0.13.0 - 2026-07-19
### Added
* Declare repository and license in module metadata, published as org.opencontainers.image.* annotations on OCI.## 0.12.0 - 2026-07-18
### Added
* Declare `exports.kinds` explicitly, listing every kind the module already exported implicitly, and add a `metadata.description` to every exported kind (and exported resource) so the discovery hub can index them for semantic search. No change to what importers can reference — the module previously relied on the loader treating an absent `exports.kinds` as "export everything", and now states its public kind surface outright.## 0.11.0 - 2026-06-24
### Added
* Annotate Sql.Selection 'where', 'having', 'limit', and 'offset' as CEL slots (x-telo-context over 'inputs') so the analyzer recognizes them as evaluated fields. The controller already expanded them at invoke time; without the annotation the new CEL_IN_NON_EVAL_FIELD check flagged a !cel there as never evaluated.## 0.10.0 - 2026-06-20
### Added
* Update controller @telorun/sql to 0.8.0.## 0.9.2 - 2026-06-15
### Fixed
* Update controller @telorun/sql to 0.7.2.## 0.9.1 - 2026-06-10
### Fixed
* Update controller @telorun/sql to 0.7.1.## 0.9.0 - 2026-06-07
### Added
* Schema `examples:` on its kinds so the MCP `get_module_manifest` tool gives authors a copyable template per kind.
* Connection / transaction / type reference slots use the unified `!ref` form; the legacy `oneOf` string / `{kind, name}` shapes are removed from the schema.## 0.8.0 - 2026-06-06
### Added
* README: reusing Sql.Query/Exec/Select as top-level named handlers across routes/sequences, and that Sql.Connection is abstract (instantiate Sql.PostgresConnection / Sql.SqliteConnection).## 0.7.0 - 2026-06-06
### Added
* Update controller @telorun/sql to 0.7.0.
* Clarify Sql.Query / Sql.Exec bindings docs — bindings is a regular YAML array; tag each element with its own scalar !cel leaf rather than one inline CEL list literal (avoids homogeneous-typing errors). Adds a schema example.## 0.6.0 - 2026-06-06
### Added
* Update controller @telorun/sql to 0.6.0.
### Fixed
* Document the SQLite single-statement limit on migration/query/exec SQL fields.## 0.5.1
