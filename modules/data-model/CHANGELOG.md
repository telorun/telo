# Changelog

## 0.3.0 - 2026-11-09
### Added
* A collection can declare `query.search: { properties }`, a list of at least one string property: one text matches a record when any of them contains it, ignoring case, and a request carries it as `search=<text>`. `search` is now a reserved query name, so a filter on a property called `search` is refused (`DATA_MODEL_FILTER_RESERVED_NAME`), and a search over an undeclared property or one that is not a string is refused (`DATA_MODEL_SEARCH_UNKNOWN_PROPERTY`, `DATA_MODEL_SEARCH_UNSUPPORTED`).
### Fixed
* The telo requirement that static checking cannot see is now a `restrictions:` entry carrying its reason, and `requires.telo` holds the measured floor.

## 0.2.2 - 2026-11-08
### Fixed
* Documentation links now point at telo.run pages and hub module pages instead of the repository tree.

## 0.2.1 - 2026-11-01
### Fixed
* Reformatted the manifest to the canonical layout (short lists and maps in flow style); no change in behaviour.

## 0.2.0 - 2026-11-01
### Added
* New module: DataModel.Collection describes one list endpoint of records — the record shape, its key, the filters, sort orders and facets it accepts, and relations from a property to another collection's records. Operators are eq, contains, gt, gte, lt, lte, in and the new absent, which matches records whose property is null or missing; the facet request is part of the documented collection contract. A filter, sort, facet or relation that contradicts the model is refused by telo check and again when the collection is created, and a collection may relate to itself or to one that relates back to it.
