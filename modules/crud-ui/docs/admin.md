# CrudUi.Admin

An admin screen over a CRUD collection from one declaration: a filter bar, a
sortable paged listing, create and edit buttons that open pages you declare, and
a confirmed delete on every record.

| Field | | |
| --- | --- | --- |
| `source` | required | a `CrudUi.CollectionSource`: the [`Crud.Collection`](https://hub.telo.run/module/oci/ghcr.io/telorun/crud/) and the `basePath` its [`Crud.Api`](https://hub.telo.run/module/oci/ghcr.io/telorun/crud/) is served at |
| `relations` | optional | how each related record is read, labelled and searched, keyed by a property the collection relates: `{ source, label, hint?, to?, search?, pageSize? }`, as on a [collection presentation](https://hub.telo.run/module/oci/ghcr.io/telorun/ui/) |
| `filters` | optional | how the filter bar behaves — a [filter policy](https://hub.telo.run/module/oci/ghcr.io/telorun/ui/): `placement` (which carries `show`, `controls` and `summary`), `apply`, `state` |
| `create` | optional | the create button — a [press](https://hub.telo.run/module/oci/ghcr.io/telorun/ui/): `to`, usually an opened page of a new record, and `label` (defaults to `create`); over `values`, the property values a layout's create gesture proposes |
| `edit` | optional | the edit button of each record — a press: `to`, usually an opened page of that record over `row`, and `label` (defaults to `edit`) |
| `paging` | optional | how further pages are reached: `pages`, `more` or `scroll` ([the listing](https://hub.telo.run/module/oci/ghcr.io/telorun/ui/)) |
| `layout` | optional | how the records are drawn — a [listing layout](https://hub.telo.run/module/oci/ghcr.io/telorun/ui/): a table, a list, cards, a board, a calendar, a timeline, a tree or a component |
| `compact` | optional | the layout drawn below the application's breakpoint |
| `press` | optional | what pressing a record does — a [press](https://hub.telo.run/module/oci/ghcr.io/telorun/ui/): `to`, where it goes, and `label`, its name, both over `row` |

## The source

`CrudUi.CollectionSource` is a `Ui.CollectionSource` whose collection is a
`Crud.Collection`, so the admin reads each operation's shape from it: the list
shape for the listing and the record shape for the filter bar; the create and
update shapes are the ones your pages' forms are checked against. It is accepted wherever a `Ui.CollectionSource`
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
filter offers authors by name, both read from `authorsSource`. Whether the filter offers every author
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
  placement: { kind: Ui.AbovePlacement, show: chosen, summary: chips }
  state: { key: tasks, address: true, store: { kind: Ui.LocalStore } }
create:
  to: { kind: Ui.OpenPage, page: !ref newTaskPage, surface: { kind: Ui.Drawer, side: end } }
edit:
  to:
    kind: Ui.OpenPage
    page: !ref taskPage
    pathParams: { id: !cel "row.id" }
    surface: { kind: Ui.Panel, address: { name: task } }
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

- `filters` is the bar's whole policy, handed to it as written: `show`, `controls` and `summary` are written on its `placement`. Writing neither `fields` nor `search`, the bar searches when the collection declares `query.search`, with `state.fields` able to list `search`.
- `create` and `edit` are presses handed to the listing whole: the create
  button and each record's edit button open the pages they name, in the surface
  they name. See [Create and edit pages](#create-and-edit-pages).
- `paging`, `layout` and `compact` are handed to the listing as written. A
  layout's `row` is one record of the collection's list shape, so a column or a
  card reads only what the list returns.
- A board's `move` names an operation the application declares itself — a
  `Ui.Action` over a route of its own — since the collection's API serves no
  move route.

A surface, a placement, a store, a layout and a destination are resources of
the `ui` module, chosen by `kind:` and written inline or as a `!ref`; import
`ui` to name one.

**The defaults are the `ui` side's.** `CrudUi.Admin` declares none and passes
each key on as written (`paging` restating only the listing's three values, so
an editor offers them), so a key left out means exactly what leaving it out of
a `Ui.Listing` or a `Ui.Filters` means — a table with one column per list
property but the key, paged with a pager,
and a bar above the listing that shows every filter and keeps its state in
memory. Without `create` the listing draws no create button, and without `edit`
no edit button. A misspelled key, a value outside a set, a resource of the wrong kind
and a layout the collection cannot read — a board grouped by a property it does
not filter by equality — are reported by `telo check` at the `CrudUi.Admin`
that wrote them.

`CrudUi.Admin` is a composite of the `ui` module's vocabulary, so it is placed
like any other and drawn by whichever renderer the application mounts. This
module depends on no renderer.

## Create and edit pages

`CrudUi.Admin` generates no forms: a composite cannot add routes to an
application. A record's create and edit screens are `Ui.Page`s you declare,
each holding a `Ui.Form` whose `record` names the collection; `create` and
`edit` are the presses that open them. The form's `record.presentation` is a
`Ui.CollectionPresentation` over the same source, `record.key` makes it send
`PATCH <basePath>/<key>` instead of `POST <basePath>`, and the form is checked
against the collection's `schemas.create` / `schemas.update`:

```yaml
kind: Ui.CollectionPresentation
metadata: { name: tasksPresentation }
source: !ref tasksSource
---
kind: Ui.Page
metadata: { name: newTaskPage }
path: /tasks/new
title: New task
query: { text: { type: string } }
children:
  - type: composite
    ref:
      kind: Ui.Form
      model: !ref Task
      record: { presentation: !ref tasksPresentation }
      initialValues: !cel "query"
      afterSubmit: again
---
kind: Ui.Page
metadata: { name: taskPage }
path: /tasks/{id}
title: Task
children:
  - type: query
    query:
      kind: Ui.Query
      model: !ref TaskRecord
      url: { path: "/api/tasks/{id}", pathParams: { id: !cel "params.id" } }
    content:
      - type: composite
        ref:
          kind: Ui.Form
          model: !ref Task
          record: { presentation: !ref tasksPresentation, key: !cel "data.id" }
          initialValues: !cel "data"
---
kind: CrudUi.Admin
metadata: { name: taskScreen }
source: !ref tasksSource
create:
  to:
    kind: Ui.OpenPage
    page: !ref newTaskPage
    queryParams: { text: !cel "values.text" }
edit:
  to: { kind: Ui.OpenPage, page: !ref taskPage, pathParams: { id: !cel "row.id" } }
```

The application lists both pages in its `pages`. `create` is over `values`, the
property values a layout's create gesture proposes — a board column's create
proposes that column's value — typed as the list shape with every member
optional, `{}` from the listing's own button; `edit` is over `row`, one record
of the list shape. A destination or label naming a property the list does not
return is reported by `telo check` at the admin. The same pages open from
anywhere that goes somewhere, and are full pages at their own addresses.

## Opening a record

Without `press`, pressing a record does what `edit` says. `press` says what
pressing it does instead — here, the task's own page opened over the list in a
dialog — and the record's edit button stays:

```yaml
kind: CrudUi.Admin
metadata: { name: taskScreen }
source: !ref tasksSource
edit:
  to: { kind: Ui.OpenPage, page: !ref taskPage, pathParams: { id: !cel "row.id" } }
press:
  to: { kind: Ui.OpenPage, page: !ref taskPage, pathParams: { id: !cel "row.id" } }
  label: { text: "Open {$text}", values: { text: !cel "row.text" } }
```

`press` is handed to the listing whole. Its `row` is one record of the
collection's list shape, as a layout's is. `label` is the press's accessible
name; include the text the record shows.

## What it does

- The listing's columns come from the collection's `list` shape, one per
  property, so a property added to it appears with no edit here. `id`
  identifies a record and is not shown.
- The filter bar shows one control per entry of the collection's
  `query.filters`, in that order and with that operator, drawn from the
  collection's `model`, preceded by a search over the properties its
  `query.search` lists, when it declares one. A column sorts where `query.sort` lists its property.
  So the screen offers exactly the queries the API accepts.
- Create, from your create page's form, sends `POST <basePath>`.
- Edit, from your edit page's form, which a `query` node filled from
  `GET <basePath>/<id>`, sends `PATCH <basePath>/<id>`: the merge patch of the
  properties the person changed, an emptied field as `null`. A column of
  `update` the form does not show is left as it is. The `ETag` the read carried goes back as
  `If-Match`, so when someone else saved the record first the save answers
  `412`, the form keeps what was typed and reads the record again, and
  pressing save again sends it against the current record.
- Delete asks first and sends `DELETE <basePath>/<id>`, carrying as `If-Match`
  the `ETag` of the record's last read or write on the page when there was one
  (a record never opened is deleted without a precondition), and reloads; a
  record changed since that read answers `412`, the dialog says so and the
  listing reads again.

The list route's query and answers are in
[the list route](https://hub.telo.run/module/oci/ghcr.io/telorun/crud/).

## What it expands into

`CrudUi.Admin` holds nothing that cannot be written by hand. For the
declaration under [Presentation](#presentation), over a collection whose
`model` is `TaskRecord` and whose `list` is `TaskRow`, it is exactly:

```yaml
kind: Ui.CollectionPresentation
metadata: { name: taskPresentation }
source: !ref tasksSource
---
kind: Ui.Listing
metadata: { name: taskListing }
presentation: !ref taskPresentation
model: !ref TaskRow
paging: more
create:
  to: { kind: Ui.OpenPage, page: !ref newTaskPage, surface: { kind: Ui.Drawer, side: end } }
edit:
  to:
    kind: Ui.OpenPage
    page: !ref taskPage
    pathParams: { id: !cel "row.id" }
    surface: { kind: Ui.Panel, address: { name: task } }
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
  placement: { kind: Ui.AbovePlacement, show: chosen, summary: chips }
  state: { key: tasks, address: true, store: { kind: Ui.LocalStore } }
content: { type: composite, ref: !ref taskListing }
```

placed as `{ type: composite, ref: !ref taskFilters }`. The presentation holds
`relations` when the admin writes them; the listing holds `create` and `edit` as written; the bar holds `policy` when `filters` is
written; the listing holds `paging`, `layout`, `compact` and `press` when they
are written. The pages are yours either way. The two produce the same page, node for node — every member is on the
wire either way, a default where nothing was written. The listing's `model` is
the `list` shape and the bar reads the collection's `model`, so the bar can
filter by a property no column shows.

## Ejecting

How the bar behaves, where the pages open and how the records are drawn need no
eject — those are the keys above. When the screen needs something
`CrudUi.Admin` has no field for — a row style, a page size, fixed filters, row
actions, an empty state, fewer filters, a filter that is pinned, has a default
or a control of its own, offers only the values present, presets — replace it with the listing above and
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
