# Todo app — API + frontend as one unit

A complete application served from a single Telo manifest on one port:

- **API** — the whole REST surface is one `Crud.Resource` over the `todos` table,
  mounted at `/api/todos`. No handlers, no SQL, no route list.
- **Frontend** — vanilla HTML/JS/CSS in [`public/`](public/), served by
  `Http.Static` at `/`.
- **Storage** — a SQLite file (`SQLite.Connection`), schema created on boot by
  `SQLite.Schema`.

No build step: the frontend is plain files, so the whole app ships and runs as a
unit. This is the pairing `Http.Static` was added for — see the
[static files & frontends](../../modules/http-server/docs/static-files.md) doc.

## Run

The SQLite file (`todo.db`) is created in the **current working directory**, so
run from this directory:

```sh
telo ./examples/todo-app
```

Then open <http://127.0.0.1:8077>. The OpenAPI reference for the API is at
<http://127.0.0.1:8077/reference>. Override the port with the `PORT` env var.

## How it fits together

```
Http.Server (:8077)
├── /api/todos → Crud.Resource ──► SQLite.Connection
└── /          → Http.Static   ──► public/ (index.html, app.js, style.css)
```

The frontend calls the same-origin API (`fetch('/api/todos')`); both are served
by the one `Http.Server`, so there is no CORS and no separate deployment.

## Routes

`Crud.Resource` derives all five from `plural: todos` / `singular: todo` and the
`model:` schema — the table below is what it generates, not what the manifest
lists:

| Method | Path | Result |
| --- | --- | --- |
| `GET` | `/api/todos` | 200, the list |
| `GET` | `/api/todos/{todoId}` | 200 with the row, or 404 |
| `POST` | `/api/todos` | 201, echoing the accepted body |
| `PUT` | `/api/todos/{todoId}` | 200 with the applied columns, or 404 |
| `DELETE` | `/api/todos/{todoId}` | 204, or 404 |

The `model:` schema is enforced on the way in (a `POST` missing `text`, or with
an unknown property, is a 400 before anything touches the database) and drives
the generated OpenAPI document. Column names are the snake_case form of each
property, so `isDone` reads and writes `is_done`.
