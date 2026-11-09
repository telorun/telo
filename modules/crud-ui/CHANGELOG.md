# Changelog

## 0.5.0 - 2026-11-09
### Added
* Breaking: the `filters` policy takes `show`, `controls` and `summary` on its `placement` instead of beside it, following `ui`; a bar over a collection declaring `query.search` gains a search.
### Fixed
* The telo requirement that static checking cannot see is now a `restrictions:` entry carrying its reason, and `requires.telo` holds the measured floor.

## 0.4.1 - 2026-11-08
### Fixed
* Documentation links now point at telo.run pages and hub module pages instead of the repository tree.

## 0.2.1 - 2026-11-01
### Fixed
* Reformatted the manifest to the canonical layout (short lists and maps in flow style); no change in behaviour.

## 0.2.0 - 2026-11-01
### Added
* New module: CrudUi.CollectionSource is where a browser reads a Crud.Collection from, and CrudUi.Admin is an admin screen over one — a filter bar, a sortable paged listing, create and edit forms and a confirmed delete, generated from the collection's shapes. relations shows related records by name in the listing, the filter bar and the forms' pickers; filters, create, edit, paging, layout and compact are handed to the generated bar and listing as written, so the screen can be drawn as a table, cards, a board, a calendar, a timeline or a tree, with another layout below the breakpoint. The expansion is ordinary ui resources, and ejecting it renders the same page.
