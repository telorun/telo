# CrudUi.Admin

An admin screen over a CRUD collection from one declaration: a filter bar, a
sortable paged listing, a form to create a record and one to edit it, and a
confirmed delete on every record.

| Field | | |
| --- | --- | --- |
| `source` | required | a `CrudUi.CollectionSource`: the [`Crud.Collection`](../../crud/docs/collection.md) and the `basePath` its [`Crud.Api`](../../crud/docs/api.md) is served at |
| `relations` | optional | how each related record is read, labelled and searched, keyed by a property the collection relates: `{ source, label, hint?, href?, search?, pageSize? }`, as on a [collection presentation](../../ui/docs/collection-presentation.md) |
| `filters` | optional | how the filter bar behaves — a [filter policy](../../ui/docs/filters.md): `show`, `placement`, `controls`, `apply`, `summary`, `state` |
| `create` | optional | how the create form opens: `surface` (a [surface](../../ui/docs/surfaces.md) kind), `afterSubmit` (`close` \| `again` \| `keep`), `unsaved` (`confirm` \| `discard`) |
| `edit` | optional | how the edit form opens: the same three, with `afterSubmit` `close` \| `keep` |
| `paging` | optional | how further pages are reached: `pages`, `more` or `scroll` ([the listing](../../ui/docs/listing.md)) |
| `layout` | optional | how the records are drawn — a [listing layout](../../ui/docs/listing-layouts.md): a table, a list, cards, a board, a calendar, a timeline, a tree or a component |
| `compact` | optional | the layout drawn below the application's breakpoint |

## The source

`CrudUi.CollectionSource` is a `Ui.CollectionSource` whose collection is a
`Crud.Collection`, so the admin reads each operation's shape from it: the list
shape for the listing, the create and update shapes for the two forms, and the
record shape for the filter bar. It is accepted wherever a `Ui.CollectionSource`
is, so the same source serves a hand-written listing, a picker or another
admin's relation.

Give `basePath` the path the `Crud.Api` is served at under the application's
mount. With the application at `/admin`, `basePath: /api/tasks` reads
`/admin/api/tasks`.

```yaml
kind: Crud.Api
metadata: { name: tasksApi }
connection: !ref db
singular: task
plural: tasks
collection: !ref tasks
---
kind: CrudUi.CollectionSource
metadata: { name: tasksSource }
collection: !ref tasks
basePath: /api/tasks
---
kind: UiReact.App
metadata: { name: admin }
title: Tasks
words: !ref Ui.words
theme: !ref UiReact.defaultTheme
pages:
  - kind: Ui.Page
    path: /
    title: Tasks
    children:
      - type: composite
        ref: { kind: CrudUi.Admin, source: !ref tasksSource }
---
kind: Http.Server
metadata: { name: server }
listen:
  port: !cel "ports.http"
mounts:
  - { path: /admin/api/tasks, mount: !ref tasksApi }
  - { path: /admin, mount: !ref admin }
```

## Related records

A property the collection relates to another collection (`posts.authorId` →
authors) is shown through `relations`, and nothing else is restated:

```yaml
kind: CrudUi.Admin
metadata: { name: postsAdmin }
source: !ref postsSource
relations:
  authorId:
    source: !ref authorsSource
    label: !cel "row.name"
    search: { property: name, operator: contains }
```

The listing's author column shows the author's name, the filter bar's author
filter offers authors by name, and both forms enter the author with a picker of
authors, all read from `authorsSource`. Whether the filter offers every author
or only those present with their counts is the bar's `values` setting, which
needs an eject.

## Presentation

The optional keys say how the screen behaves and how the records are drawn,
not what they are:

```yaml
kind: CrudUi.Admin
metadata: { name: taskScreen }
source: !ref tasksSource
filters:
  show: chosen
  summary: chips
  state: { key: tasks, address: true, store: { kind: Ui.LocalStore } }
create:
  surface: { kind: Ui.Drawer, side: end }
  afterSubmit: again
edit:
  surface: { kind: Ui.Panel, address: { name: task } }
  unsaved: confirm
paging: more
layout:
  kind: Ui.TableLayout
  columns:
    - value: !cel "row.text"
    - { header: Due, value: !cel "row.dueOn" }
compact:
  kind: Ui.CardLayout
  size: small
  content: { type: value, value: !cel "row.text" }
```

- `filters` is the bar's whole policy, handed to it as written.
- `create` and `edit` each name the surface their form opens in, what the form
  does once its record is saved, and whether leaving unsaved input asks first.
- `paging`, `layout` and `compact` are handed to the listing as written. A
  layout's `row` is one record of the collection's list shape, so a column or a
  card reads only what the list returns.
- A board's `move` names an operation the application declares itself — a
  `Ui.Action` over a route of its own — since the collection's API serves no
  move route.

A surface, a placement, a store and a layout are resources of the `ui` module,
chosen by `kind:` and written inline or as a `!ref`; import `ui` to name one.

**The defaults are the `ui` side's.** `CrudUi.Admin` declares none and passes
each key on as written (`paging` restating only the listing's three values, so
an editor offers them), so a key left out means exactly what leaving it out of
a `Ui.Listing` or a `Ui.Filters` means — a table with one column per list
property but the key, paged with a pager, a dialog that closes after a save and
asks before dropping unsaved input, and a bar above the listing that shows
every filter and keeps its state in memory. `create: {}` is the same as no
`create`. A misspelled key, a value outside a set, a resource of the wrong kind
and a layout the collection cannot read — a board grouped by a property it does
not filter by equality — are reported by `telo check` at the `CrudUi.Admin`
that wrote them.

`CrudUi.Admin` is a composite of the `ui` module's vocabulary, so it is placed
like any other and drawn by whichever renderer the application mounts. This
module depends on no renderer.

## What it does

- The listing's columns come from the collection's `list` shape, the create
  form's fields from `create` and the edit form's from `update`, one per
  property, so a property added to a shape appears with no edit here. `id`
  identifies a record and is not shown.
- The filter bar shows one control per entry of the collection's
  `query.filters`, in that order and with that operator, drawn from the
  collection's `model`. A column sorts where `query.sort` lists its property.
  So the screen offers exactly the queries the API accepts.
- Create sends `POST <basePath>` and returns to the first page.
- Edit reads the record from `GET <basePath>/<id>`, opens its form filled from
  it, and sends `PUT <basePath>/<id>` with what the record held of the
  `update` shape, each field's entered value over it. `PUT` replaces, so a
  field emptied is a property cleared.
- Delete asks first, sends `DELETE <basePath>/<id>`, and reloads.

The list route's query and answers are in
[the list route](../../crud/docs/list-route.md).

## What it expands into

`CrudUi.Admin` holds nothing that cannot be written by hand. For the
declaration under [Presentation](#presentation), over a collection whose
`create` and `update` are `Task`, whose `model` is `TaskRecord` and whose
`list` is `TaskRow`, it is exactly:

```yaml
kind: Ui.CollectionPresentation
metadata: { name: taskPresentation }
source: !ref tasksSource
---
kind: Ui.Form
metadata: { name: taskCreateForm }
model: !ref Task
presentation: !ref taskPresentation
---
kind: Ui.Form
metadata: { name: taskEditForm }
model: !ref Task
presentation: !ref taskPresentation
---
kind: Ui.Listing
metadata: { name: taskListing }
presentation: !ref taskPresentation
model: !ref TaskRow
paging: more
create:
  form: !ref taskCreateForm
  surface: { kind: Ui.Drawer, side: end }
  afterSubmit: again
edit:
  form: !ref taskEditForm
  surface: { kind: Ui.Panel, address: { name: task } }
  unsaved: confirm
delete: true
layout:
  kind: Ui.TableLayout
  columns:
    - value: !cel "row.text"
    - { header: Due, value: !cel "row.dueOn" }
compact:
  kind: Ui.CardLayout
  size: small
  content: { type: value, value: !cel "row.text" }
---
kind: Ui.Filters
metadata: { name: taskFilters }
presentation: !ref taskPresentation
policy:
  show: chosen
  summary: chips
  state: { key: tasks, address: true, store: { kind: Ui.LocalStore } }
content: { type: composite, ref: !ref taskListing }
```

placed as `{ type: composite, ref: !ref taskFilters }`. The presentation holds
`relations` when the admin writes them; an opener holds `form` and whatever
`create` / `edit` wrote beside it; the bar holds `policy` when `filters` is
written; the listing holds `paging`, `layout` and `compact` when they are
written. The two produce the same page, node for node — every member is on the
wire either way, a default where nothing was written. The listing's `model` is
the `list` shape and the bar reads the collection's `model`, so the bar can
filter by a property no column shows.

## Ejecting

How the bar behaves, how the forms open and how the records are drawn need no
eject — those are the keys above. When the screen needs something
`CrudUi.Admin` has no field for — a row style, a page size, fixed filters, row
actions, an empty state, fewer filters, a filter that is pinned, has a default
or a control of its own, offers only the values present, presets, chosen form
fields, a different form for editing — replace it with the listing above and
edit that. A bar showing fewer filters lists them under `fields`, each a pair
the collection declares, and that is where `pinned`, `control`, `values` and
`default` are written; `presets` sit beside it. Import `ui` under an alias
(`Ui`) to write the kinds, and change the page's node from the `CrudUi.Admin` to
`{ type: composite, ref: !ref taskFilters }`. Nothing else moves: the routes,
the collection, the source and the renderer are the same.

## Renaming a property

The generated screen follows the collection's shapes, so a rename needs no edit
here. A place the application names the old property itself — a column of a
layout written at the admin (`row.text`), a hand-written column, a filter field
— is reported by `telo check`, each once.
