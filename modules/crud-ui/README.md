# CrudUi

A ready admin screen over a CRUD collection from one declaration: a filter bar, a paged listing, create and edit forms and a confirmed delete, generated from the collection's shapes and drawn by whichever `ui` renderer the application mounts.

## Why use this

- **One declaration, a whole screen** — columns, form fields and filters come from the collection, so a property added to it appears with no edit.
- **Exactly the queries the API accepts** — the bar offers the collection's declared filters and a column sorts where the collection sorts.
- **Related records by name** — `relations` labels a related record in the listing, offers it by name in the filter bar and picks it in the forms, from the related collection's own source.
- **Drawn any way** — a table by default, or cards, a board, a calendar, a timeline or a tree, with another layout on narrow screens and a pager, "Load more" or infinite scroll.
- **Checked where written** — a misspelled key, a value outside a set and a layout the collection cannot read are reported by `telo check` at the admin.
- **Nothing hidden** — the screen is ordinary `ui` resources, so ejecting it to edit by hand renders the same page.

## Kinds

| Kind | Purpose |
| --- | --- |
| `CrudUi.CollectionSource` | Where a browser reads a `Crud.Collection` from: the collection and its API's `basePath`. A `Ui.CollectionSource`. |
| `CrudUi.Admin` | The admin screen over one source. See [Admin](docs/admin.md). |

## Example

```yaml
kind: CrudUi.CollectionSource
metadata: { name: postsSource }
collection: !ref posts
basePath: /api/posts
---
kind: CrudUi.Admin
metadata: { name: postsAdmin }
source: !ref postsSource
relations:
  authorId: { source: !ref authorsSource, label: !cel "row.name" }
layout: { kind: Ui.BoardLayout, groups: { property: status } }
```

## Documentation

- [Admin](docs/admin.md) — the fields, what the screen does, what it expands into and how to eject it

The collection and its API are [`Crud.Collection`](../crud/docs/collection.md) and [`Crud.Api`](../crud/docs/api.md); the listing and its layouts are [`Ui.Listing`](../ui/docs/listing.md) and [the listing layouts](../ui/docs/listing-layouts.md).
