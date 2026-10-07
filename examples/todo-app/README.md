# Todo app — API + admin UI from one manifest

A complete application served from a single Telo manifest on one port, with no
hand-written frontend:

- **API** — the whole REST surface is one `Crud.Resource` over the `todos` table,
  mounted at `/api/todos`. No handlers, no SQL, no route list.
- **UI** — a `UiReact.App` mounted at `/`: a filterable, sortable, paged table
  with a create / edit form and delete. There is no HTML, JavaScript or CSS in
  this example.
- **Storage** — a SQLite file (`SQLite.Connection`), schema created on boot by
  `SQLite.Schema`.

The API and the UI share one model (`Todo`). The table's columns, the filters
and the form's fields are derived from it, so adding a property to the model
adds it to the screen — and renaming one is a `telo check` error wherever the
manifest still names the old one, not a page that silently breaks.

## Run

The SQLite file (`todo.db`) is created in the **current working directory**, so
run from this directory:

```sh
telo ./examples/todo-app
```

Then open <http://127.0.0.1:8077>. Override the port with the `PORT` env var.

The UI modules are not released yet, so this example imports the modules of
this workspace by relative path and runs only from a checkout. Its imports
become pinned `oci://` refs, like every other example's, once they are.

## How it fits together

```
Http.Server (:8077)
├── /api/todos → Crud.Resource ──► SQLite.Connection
└── /          → UiReact.App
                 ├── /      Crud.Ui    (filters, table, form, delete — derived)
                 └── /done  Ui.Table   (the same, written out by hand)
```

The UI calls the same-origin API, so there is no CORS and no separate
deployment.

## Two pages, two levels

- **`/`** is one declaration: `Crud.Ui` with the model and the path the API is
  mounted at. Everything on the page comes from the model.
- **`/done`** is what that one line stands for, written by hand and changed: a
  `Ui.Table` with a fixed filter (`isDone: true`), one chosen column and a row
  style. Nothing `Crud.Ui` generates is out of reach — when a screen needs
  something of its own, replace the one line with the kinds it expands into
  (listed in [`Crud.Ui`'s doc](../../modules/crud/docs/ui.md)) and edit those.

A value from a row is written as an accessor — `!cel "row.text"` — which is
checked against the model and resolved in the browser; no expression engine
ships to the client.

## Styling

`Ui.Theme` sets design tokens (here the accent colour and a corner radius).
Every element the UI renders carries a stable `data-telo-part` attribute, so a
stylesheet listed under the app's `stylesheets:` can restyle anything — see the
[styling contract](../../modules/ui-react/docs/app.md).

## Routes

`Crud.Resource` derives all five from `plural: todos` / `singular: todo` and the
model — the table below is what it generates, not what the manifest lists:

| Method | Path | Result |
| --- | --- | --- |
| `GET` | `/api/todos` | 200, one page: `{ rows, total, next }` |
| `GET` | `/api/todos/{todoId}` | 200 with the todo, or 404 |
| `POST` | `/api/todos` | 201, echoing the accepted body |
| `PUT` | `/api/todos/{todoId}` | 200; replaces the todo with the body, or 404 |
| `DELETE` | `/api/todos/{todoId}` | 204, or 404 |

The list takes `limit`, `cursor`, `sort` (`sort=-text`) and filters by property
(`isDone=true`, `text.contains=milk`) — see the
[list route](../../modules/crud/docs/list-route.md).

The model is enforced on the way in, with no conversion: a `POST` missing
`text` or `isDone`, with an unknown property, or with a value of the wrong type
is a 400 naming the field, before anything touches the database. A `PUT` body
is the whole todo. Column names are the snake_case
form of each property, so `isDone` reads and writes `is_done`.
