# Changelog
## 0.2.0 - 2026-06-20
### Added
* New module `std/crud`. `Crud.Resource` is a single declarative Telo.Mount that exposes a full REST CRUD API (list / read / create / update / delete) over a SQL table — point it at a `Sql.Connection` and a table, then mount it on an `Http.Server`. Purely templated: it composes sql-repository's SQL handlers with an http-server `Http.Api` via the new `mount:` template dispatch, no controller code.## 0.1.0
