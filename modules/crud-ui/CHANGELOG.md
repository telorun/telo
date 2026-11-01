# Changelog

## 0.2.0 - 2026-11-01
### Added
* New module: CrudUi.CollectionSource is where a browser reads a Crud.Collection from, and CrudUi.Admin is an admin screen over one — a filter bar, a sortable paged listing, create and edit forms and a confirmed delete, generated from the collection's shapes. relations shows related records by name in the listing, the filter bar and the forms' pickers; filters, create, edit, paging, layout and compact are handed to the generated bar and listing as written, so the screen can be drawn as a table, cards, a board, a calendar, a timeline or a tree, with another layout below the breakpoint. The expansion is ordinary ui resources, and ejecting it renders the same page.
