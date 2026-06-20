# Todo app — API + frontend as one unit

A complete application served from a single Telo manifest on one port:

- **Frontend** — vanilla HTML/JS/CSS in [`public/`](public/), served by `Http.Static` at `/`.
- **API** — a REST todo API (`Http.Api`) at `/api`, with handlers that are
  declarative SQL operations (`Sql.Query`).
- **Storage** — a SQLite file (`SqlSqlite.Connection`), schema created on boot by
  `Sql.Migrations`.

No build step: the frontend is plain files, so the whole app ships and runs as a
unit. This is the pairing `Http.Static` was added for — see the
[static files & frontends](../../modules/http-server/docs/static-files.md) doc.

## Run

The SQLite file is created in the **current working directory**, so run from this
directory:

```sh
telo ./examples/todo-app
```

Then open <http://127.0.0.1:8077>. The OpenAPI reference for the API is at
<http://127.0.0.1:8077/reference>. Override the port with the `PORT` env var.

## How it fits together

```
Http.Server (:8077)
├── /api  → Http.Api      ──► Sql.Query ──► SqlSqlite.Connection
└── /     → Http.Static   ──► public/ (index.html, app.js, style.css)
```

The frontend calls the same-origin API (`fetch('/api/todos')`); both are served
by the one `Http.Server`, so there is no CORS and no separate deployment.

## Routes

| Method | Path | Handler | Result |
| --- | --- | --- | --- |
| `GET` | `/api/todos` | `Sql.Query` | list, newest first |
| `POST` | `/api/todos` | `Sql.Query` (`RETURNING`) | created row (201) |
| `PATCH` | `/api/todos/{id}` | `Sql.Query` (`RETURNING`) | toggled row, or 404 |
| `DELETE` | `/api/todos/{id}` | `Sql.Query` (`RETURNING`) | 204, or 404 |

Each route maps `request.*` into the SQL `bindings` and the SQL `result.*` into
the HTTP response body via CEL.
