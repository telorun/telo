# Todo app — API + admin UI from one manifest

A complete application served from a single Telo manifest on one port, with no
hand-written frontend:

- **API** — the whole REST surface is one `Crud.Resource` over the `todos` table,
  mounted at `/api/todos`. No handlers, no SQL, no route list.
- **UI** — a `UiReact.App` mounted at `/`: a filterable, sortable, paged table
  with create and edit forms and delete. There is no HTML, JavaScript or CSS in
  this example.
- **Storage** — a SQLite file (`SQLite.Connection`), schema created on boot by
  `SQLite.Schema`.

The API and the UI share one model (`todoModel`). It declares what the list may
be filtered and sorted by — `text` by `contains`, `isDone` by equality, `dueOn` by a range of days, sorted
by `text`, `dueOn` or `createdAt` — so the API refuses every other query and the screen
offers exactly those controls. It also names a todo's shape for each operation: `NewTodo` is what creates one — its title alone —
`TodoEdit` extends it with `isDone` and `dueOn` for an update, and `Todo` extends that with
the key and `createdAt`, which the table fills in. The table's columns and
the forms' fields are derived from those shapes, so adding a
property adds it to the screen — and renaming one is a `telo check` error
wherever the manifest still names the old one, not a page that silently breaks.
The create form has one field and the edit form three; `createdAt` is shown in
the table and in no form, and a request that sends it is refused.

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
                 ├── /        Crud.Ui     (filters, table, forms, delete — derived)
                 └── /status  Ui.Filters  (the same, written out by hand)
```

The UI calls the same-origin API, so there is no CORS and no separate
deployment.

## Two pages, two levels

- **`/`** is one declaration: `Crud.Ui` with the model and the path the API is
  mounted at. Everything on the page comes from the model. Three more keys say
  how it behaves, not what it shows:
  - `filters` — the bar shows only the filters you choose from its list,
    summarises the active ones as removable chips, and keeps them under the key
    `todos` in the page's address and in the browser's local storage, so a
    filtered list can be shared as a link and is still filtered on the next
    visit.
  - `create` — a new todo is entered in a drawer at the end edge (a full-size
    dialog on a narrow screen) that stays open, emptied, for the next one.
  - `edit` — a todo is edited in a drawer at the end edge too. The drawer has an
    address (`?_telo.open.todo=<id>`), so an open todo is a link too, and
    leaving it with unsaved input asks first.

  A key left out takes the default of the table or the bar it reaches;
  `Crud.Ui` adds none of its own.
- **`/status`** is what that one declaration stands for, written by hand, for
  what `Crud.Ui` has no key for: a `Ui.Filters` whose bar folds a range of due
  days behind a toggle, with the text search pinned outside the fold, an `isDone` filter that has no control and is set only by the presets
  **All** / **Open** / **Done**, and a `Ui.Table` whose two openers say nothing
  but their form — so each opens as the table decides, in a dialog that closes
  after a save. Nothing `Crud.Ui` generates is out of reach — when a screen needs
  something of its own, replace the one declaration with the kinds it expands into
  (listed in [`Crud.Ui`'s doc](../../modules/crud/docs/ui.md)) and edit those.

Every surface, placement and store here is a resource of the `ui` module chosen
by `kind:` — `Ui.Drawer`, `Ui.Dialog`, `Ui.CollapsiblePlacement`,
`Ui.LocalStore` — and declared inline, since each is used once.

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
| `POST` | `/api/todos` | 201 with the stored todo — not done, `id` and `createdAt` included; the body is `{ "text": … }` |
| `PUT` | `/api/todos/{todoId}` | 200 with the stored todo; replaces its `text`, `isDone` and `dueOn`, or 404 |
| `DELETE` | `/api/todos/{todoId}` | 204, or 404 |

The list takes `limit`, `cursor`, `sort` (`sort=-text`) and the filters the
model declares (`isDone=true`, `text.contains=milk`, and a date range as
`dueOn.gte=2026-10-01&dueOn.lte=2026-10-31`, both days included); anything else — `text=milk`,
`sort=id` — is a 400 naming the parameter. See the
[list route](../../modules/crud/docs/list-route.md).

The model is enforced on the way in, with no conversion: a `POST` missing
`text`, with a property its shape does not declare (`isDone` and `createdAt`
among them), or with a value of the wrong type is a 400 naming the field,
before anything touches the database. A `PUT` body holds `text` and `isDone`, and `dueOn` when the todo has a due day. Column names are the snake_case
form of each property, so `isDone` reads and writes `is_done`.
