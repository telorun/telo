# Changelog

## 0.11.0 - 2026-11-27
### Added
* CrudUi.Admin tests and docs follow the mutation vocabulary of ui: a board move names a Ui.Mutation the application declares, and an admin whose create page is a record form can go to the new record with an onSuccess effect over result.id, since the collection now answers a POST with the stored record.
* Requires the telo release that checks format: path-template, as the ui module it is built with does: an older telo no longer selects this version.

## 0.10.0 - 2026-11-24
### Added
* CrudUi.Admin no longer generates forms: its create and edit are Ui.Press values forwarded whole to the listing, so each points at a page the application declares (a Ui.OpenPage to a page holding a Ui.Form with record), and the previous { surface, afterSubmit, unsaved } objects are refused. An omitted create draws no create button. There is no migration, since a composite cannot add routes: write the create and edit pages and press them from the admin.

## 0.9.0 - 2026-11-22
### Added
* The admin docs draw reads with the `query` node over a `Ui.Query`, and the module requires the telo release the `ui` module it imports needs.

## 0.8.0 - 2026-11-19
### Added
* `CrudUi.Admin.press` says what pressing a record does — `{ to, label }`, the `ui` module's press — and is handed to the admin's listing whole, its `row` one record of the collection's list shape as a layout's is. With `press` written, editing a record is its edit button; without it, pressing a record opens the edit form as before. Related records' `relations` entries take `to` where they took `href`.

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
