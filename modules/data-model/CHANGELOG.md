# Changelog

## 0.2.1 - 2026-11-01
### Fixed
* Reformatted the manifest to the canonical layout (short lists and maps in flow style); no change in behaviour.

## 0.2.0 - 2026-11-01
### Added
* New module: DataModel.Collection describes one list endpoint of records — the record shape, its key, the filters, sort orders and facets it accepts, and relations from a property to another collection's records. Operators are eq, contains, gt, gte, lt, lte, in and the new absent, which matches records whose property is null or missing; the facet request is part of the documented collection contract. A filter, sort, facet or relation that contradicts the model is refused by telo check and again when the collection is created, and a collection may relate to itself or to one that relates back to it.
