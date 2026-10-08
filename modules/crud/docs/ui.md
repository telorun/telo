# Crud.Ui

An admin screen over a CRUD collection from one declaration: a filter bar, a
sortable paged table, a form to create a row and one to edit it, and a
confirmed delete on every row.

| Field | | |
| --- | --- | --- |
| `model` | required | the [`Crud.Model`](model.md) the `Crud.Resource` is given |
| `basePath` | required | app-relative URL the collection is mounted at: `/` followed by anything but `/` or `\`, with no control character |
| `filters` | optional | how the filter bar behaves — a [filter policy](../../ui/docs/filters.md): `show`, `placement`, `controls`, `apply`, `summary`, `state` |
| `create` | optional | how the create form opens: `surface` (a [surface](../../ui/docs/surfaces.md) kind), `afterSubmit` (`close` \| `again` \| `keep`), `unsaved` (`confirm` \| `discard`) |
| `edit` | optional | how the edit form opens: the same three, with `afterSubmit` `close` \| `keep` |

It does not reference the `Crud.Resource`: name the same model in both, and
give `basePath` the path the resource is mounted at.

```yaml
kind: Crud.Resource
metadata: { name: tasks }
connection: !ref db
singular: task
plural: tasks
model: !ref taskModel
---
kind: UiReact.App
metadata: { name: admin }
title: Tasks
pages:
  - path: /
    title: Tasks
    children:
      - type: composite
        ref: { kind: Crud.Ui, model: !ref taskModel, basePath: /api/tasks }
---
kind: Http.Server
metadata: { name: server }
port: !cel "ports.http"
mounts:
  - { path: /api/tasks, mount: !ref tasks }
  - { path: /admin, mount: !ref admin }
```

## Presentation

The three optional keys say how the screen behaves, not what it shows:

```yaml
kind: Crud.Ui
metadata: { name: taskScreen }
model: !ref taskModel
basePath: /api/tasks
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
```

- `filters` is the bar's whole policy, handed to it as written: which filters
  are on show, where the controls sit (a placement kind), how each is entered,
  when a change applies, what summarises it, and where the state is kept (the
  page's address, a store kind, or both).
- `create` and `edit` each name the surface their form opens in — a dialog, a
  drawer, a popover, inline, a panel beside the list, or a page of its own —
  what the form does once its record is saved, and whether leaving unsaved
  input asks first.

A surface, a placement and a store are resources of the `ui` module, chosen by
`kind:` and written inline or as a `!ref`; import `ui` to name one.

**The defaults are the table's and the bar's.** `Crud.Ui` declares none and
passes each key on as written, so a key left out means exactly what leaving it
out of a `Ui.Table` or a `Ui.Filters` means — a dialog that closes after a save
and asks before dropping unsaved input, and a bar above the table that shows
every filter and keeps its state in memory. `create: {}` is the same as no
`create`. A misspelled key, a value outside a set or a resource of the wrong
kind is reported by `telo check` at the `Crud.Ui` that wrote it.

`Crud.Ui` is a composite of the `ui` module's vocabulary, so it is placed like
any other and drawn by whichever renderer the application mounts. This module
depends on no renderer.

## What it does

- The table's columns come from the model's `list` shape, the create form's
  fields from `create` and the edit form's from `update`, one per property, so
  a property added to a shape appears with no edit here. `id` identifies a row
  and is not shown.
- The filter bar shows one control per entry of the model's `query.filters`,
  in that order and with that operator, drawn from the `read` shape's
  property. A column sorts where `query.sort` lists its property. So the
  screen offers exactly the queries the API accepts.
- Create sends `POST <basePath>` and returns to the first page.
- Edit reads the record from `GET <basePath>/<id>`, opens its form filled from
  it, and sends `PUT <basePath>/<id>` with what the record held of the
  `update` shape, each field's entered value over it. `PUT` replaces, so a
  field emptied is a property cleared; a property the form does not edit is
  sent back as it was read.
- Delete asks first, sends `DELETE <basePath>/<id>`, and reloads.

## What it expands into

`Crud.Ui` holds nothing that cannot be written by hand. For
the declaration under [Presentation](#presentation), over a model whose `create`
and `update` are `Task`, whose `read` is `TaskRecord` and whose `list` is
`TaskRow`, it is exactly:

```yaml
kind: Ui.Form
metadata: { name: taskCreateForm }
model: !ref Task
source: { basePath: /api/tasks }
---
kind: Ui.Form
metadata: { name: taskEditForm }
model: !ref Task
source: { basePath: /api/tasks }
---
kind: Ui.Table
metadata: { name: taskTable }
model: !ref TaskRow
collection: !ref taskModel
source: { basePath: /api/tasks }
rowKey: id
create:
  form: !ref taskCreateForm
  surface: { kind: Ui.Drawer, side: end }
  afterSubmit: again
edit:
  form: !ref taskEditForm
  surface: { kind: Ui.Panel, address: { name: task } }
  unsaved: confirm
delete: true
---
kind: Ui.Filters
metadata: { name: taskFilters }
model: !ref TaskRecord
collection: !ref taskModel
policy:
  show: chosen
  summary: chips
  state: { key: tasks, address: true, store: { kind: Ui.LocalStore } }
content: { type: composite, ref: !ref taskTable }
```

placed as `{ type: composite, ref: !ref taskFilters }`. An opener holds `form`
and whatever `create` / `edit` wrote beside it; the bar holds `policy` when
`filters` is written. With none of the three keys, `create` and `edit` are
`{ form: … }` alone and the bar has no `policy`. The two produce the
same page, node for node — every member of an opener and of the policy is on
the wire either way, a default where nothing was written. The table's `model` is the `list` shape and the
bar's the `read` shape, so the bar can filter by a property no column shows.

## Ejecting

How the bar behaves and how the two forms open need no eject — those are the
three keys above. When the screen needs something `Crud.Ui` has no field for —
chosen columns, a custom cell, a row style, a page size, fewer filters, a
filter that is pinned, has a default or a control of its own, presets, chosen
form fields, a different form for editing — replace
it with the listing above and edit that. A bar showing fewer filters lists
them under `fields`, each a pair the model declares, and that is where
`pinned`, `control` and `default` are written; `presets` sit beside it. Import `ui` under an alias (`Ui`) to
write the three kinds, and change the page's node from the `Crud.Ui` to
`{ type: composite, ref: !ref taskFilters }`. Nothing else moves: the routes,
the model and the renderer are the same.

## Renaming a property

The generated screen follows the model's shapes, so a rename needs no edit here. A place
the application names the old property itself — a hand-written column
(`row.text`), a filter field — is reported by `telo check`.
