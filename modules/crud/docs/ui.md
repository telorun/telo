# Crud.Ui

An admin screen over a CRUD collection from one declaration: a filter bar, a
sortable paged table, one form used to create and to edit a row, and a
confirmed delete on every row.

| Field | | |
| --- | --- | --- |
| `model` | required | the shape of one row — the model the `Crud.Resource` is given |
| `basePath` | required | app-relative URL the collection is mounted at: `/` followed by anything but `/` or `\`, with no control character |

It does not reference the `Crud.Resource`: name the same model in both, and
give `basePath` the path the resource is mounted at.

```yaml
kind: Crud.Resource
metadata: { name: tasks }
connection: !ref db
singular: task
plural: tasks
model: !ref Task
---
kind: UiReact.App
metadata: { name: admin }
title: Tasks
pages:
  - path: /
    title: Tasks
    children:
      - type: composite
        ref: { kind: Crud.Ui, model: !ref Task, basePath: /api/tasks }
---
kind: Http.Server
metadata: { name: server }
port: !cel "ports.http"
mounts:
  - { path: /api/tasks, mount: !ref tasks }
  - { path: /admin, mount: !ref admin }
```

`Crud.Ui` is a composite of the `ui` module's vocabulary, so it is placed like
any other and drawn by whichever renderer the application mounts. This module
depends on no renderer.

## What it does

- Filters, columns and form fields are derived from the model, one per
  property, so a property added to the model appears with no edit here. `id`
  identifies a row and is not shown.
- Create sends `POST <basePath>` and returns to the first page.
- Edit opens the same form filled from the row and sends `PUT <basePath>/<id>`
  with the whole record: what the row held, with each field's entered value
  over it. `PUT` replaces the row, so a field emptied is a property cleared.
- Delete asks first, sends `DELETE <basePath>/<id>`, and reloads.

## What it expands into

`Crud.Ui` holds nothing that cannot be written by hand. For
`{ model: !ref Task, basePath: /api/tasks }` it is exactly:

```yaml
kind: Ui.Form
metadata: { name: taskForm }
model: !ref Task
source: { basePath: /api/tasks }
---
kind: Ui.Table
metadata: { name: taskTable }
model: !ref Task
source: { basePath: /api/tasks }
rowKey: id
create: !ref taskForm
edit: !ref taskForm
delete: true
---
kind: Ui.Filters
metadata: { name: taskFilters }
model: !ref Task
content: { type: composite, ref: !ref taskTable }
```

placed as `{ type: composite, ref: !ref taskFilters }`. The two produce the
same page, node for node.

## Ejecting

When the screen needs something `Crud.Ui` has no field for — chosen columns, a
custom cell, a row style, fewer filters, a different form for editing — replace
it with the listing above and edit that. Import `ui` under an alias (`Ui`) to
write the three kinds, and change the page's node from the `Crud.Ui` to
`{ type: composite, ref: !ref taskFilters }`. Nothing else moves: the routes,
the model and the renderer are the same.

## Renaming a property

The generated screen follows the model, so a rename needs no edit here. A place
the application names the old property itself — a hand-written column
(`row.text`), a filter field — is reported by `telo check`.
