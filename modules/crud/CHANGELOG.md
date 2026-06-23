# Changelog
## 0.3.0 - 2026-06-23
### Added
* Add a required `model` (a `Type.JsonSchema`) to `Crud.Resource` that validates request bodies — POST against the full schema, PUT against a partial where nothing is required.
* Add `singular`/`plural` names to `Crud.Resource`. `table` now defaults from `plural` and the item path parameter from `<singular>Id` (overridable via `idParam`, renaming only the URL parameter — the PK column stays `id`); the generated OpenAPI operations are named from the singular/plural nouns and tagged with `plural`.
* Translate between camelCase model properties and snake_case database columns — writes map `dueDate` → `due_date`, reads alias `due_date AS dueDate` so responses stay camelCase. `Crud.Resource` now builds its SQL directly (no longer via `sql-repository`).## 0.2.0 - 2026-06-20
### Added
* New module `std/crud`. `Crud.Resource` is a single declarative Telo.Mount that exposes a full REST CRUD API (list / read / create / update / delete) over a SQL table — point it at a `Sql.Connection` and a table, then mount it on an `Http.Server`. Purely templated: it composes sql-repository's SQL handlers with an http-server `Http.Api` via the new `mount:` template dispatch, no controller code.## 0.1.0
