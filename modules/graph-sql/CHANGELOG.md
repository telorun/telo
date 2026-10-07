# Changelog

## 0.3.0 - 2026-10-07
### Added
* Released under the MIT License from this version: the manifest declares license MIT, and the published artifact carries the MIT license text in a LICENSE file at the module root. Versions already published keep the license they shipped with.

## 0.2.0 - 2026-09-29
### Added
* New module: a knowledge graph stored in ordinary SQL tables the application declares in its engine schema — one table per node type and per relationship type, cascading foreign keys for deletes, and multi-hop traversals as one recursive query, on SQLite and PostgreSQL. Every table is addressed in the namespace of the store's schema, whatever the connection's search_path, so a graph can live in a non-default PostgreSQL namespace and schema-per-tenant is one store per tenant schema.
