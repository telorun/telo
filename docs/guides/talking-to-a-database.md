---
description: "Connect a Telo application to SQL: a connection, migrations, injection-safe statements with !sql, repository handlers without hand-written SQL, and all-or-nothing transactions."
---

# Talking to a database

[Your first HTTP API](/learn/first-http-api) returned a value it made up. This
guide gives it somewhere to keep things: a connection, a schema, reads and
writes, and transactions that either all happen or none do.

Everything here is SQL. For key/value storage, caching or vector search, search
the [standard library](/reference/standard-library) — the shapes are the same.

## 1. A connection and a table

The connection says *where* the database is; the migrations say what must exist
in it before anything runs; the server is what the requests will reach. Put every
document in this guide into one `notes-api/telo.yaml`:

```yaml
kind: Telo.Application
metadata:
  name: NotesApi
  version: 1.0.0
imports:
  Http: oci://ghcr.io/telorun/http-server@<version>
  Sql: oci://ghcr.io/telorun/sql@<version>
  SQLite: oci://ghcr.io/telorun/sqlite@<version>
targets:
  - !ref migrate
  - !ref server
ports:
  http:
    env: PORT
    default: 8080
variables:
  dbFile:
    env: DB_FILE
    type: string
    x-telo-type: { name: Telo.HostPath, entry: file }
    default: ./notes.db
---
kind: SQLite.Connection
metadata:
  name: db
file: !cel "variables.dbFile"
---
kind: SQLite.Table
metadata:
  name: notes
table: notes
columns:
  id: { type: integer, primaryKey: true, identity: always }
  title: { type: text, nullable: false }
  body: { type: text, nullable: false }
---
kind: SQLite.Schema
metadata:
  name: migrate
connection: !ref db
tables:
  - !ref notes
---
kind: Http.Server
metadata:
  name: server
listen:
  port: !cel "ports.http"
mounts:
  - path: /v1
    mount: !ref notesApi
```

Four things to notice:

- **The file is a `Telo.HostPath` variable.** A path on the machine running the
  app is never a plain string: `x-telo-type: Telo.HostPath` makes `./notes.db`
  resolve against the directory you run `telo` in, and `DB_FILE` moves it
  elsewhere. `entry: file` says it names a file, not a directory.

- **Two imports, not one.** `sql` declares the vocabulary — `Connection`,
  `Query`, `Command`, `Transaction`. `sqlite` implements the connection.
  That split is what section 5 cashes in.
- **`migrate` is first in `targets:`.** Boot targets run in the order written,
  so the table exists before the server accepts a request. The schema is
  *declared*, not migrated to: the pass creates what is absent and records what
  was removed, so re-running the app is a no-op.
- **Nothing declares an ordering between `db` and `migrate`.** `migrate`
  references `db`, and that reference *is* the ordering.

## 2. Reading and writing

`Sql.Command` changes data and reports how many rows it touched. `Sql.Query`
reads rows back. Both take their statement **from the call site**, which is what
lets one resource serve several routes:

```yaml
kind: Sql.Command
metadata:
  name: insertNote
connection: !ref db
---
kind: Sql.Query
metadata:
  name: listNotes
connection: !ref db
```

and the router `server` mounts at `/v1` supplies the SQL:

```yaml
kind: Http.Api
metadata:
  name: notesApi
routes:
  - request:
      path: /notes
      method: POST
      schema:
        body:
          type: object
          additionalProperties: false
          required: [title, body]
          properties:
            title: { type: string, minLength: 1 }
            body: { type: string }
    handler: !ref insertNote
    inputs:
      sql: !sql "INSERT INTO notes (title, body) VALUES (${{ request.body.title }}, ${{ request.body.body }})"
    returns:
      - status: 201
        content:
          application/json:
            body:
              created: !cel "result.rowCount"

  - request:
      path: /notes
      method: GET
    handler: !ref listNotes
    inputs:
      sql: "SELECT id, title, body FROM notes ORDER BY id"
    returns:
      - status: 200
        content:
          application/json:
            body: !cel "result.rows"
```

```bash
telo ./notes-api
```

```bash
curl -X POST localhost:8080/v1/notes \
  -H 'content-type: application/json' \
  -d '{"title":"first","body":"hello"}'
# {"created":1}

curl localhost:8080/v1/notes
# [{"id":1,"title":"first","body":"hello"}]
```

The database is created on first start, so `notes.db` appears in the directory
you ran from.

`result.rows` and `result.rowCount` are the whole result surface: a `Query`
returns rows, a `Command` returns a count.

### `!sql` binds parameters — it does not build a string

This is the one thing to take away from the page. `!sql` is its own YAML tag,
not a `!cel` string, and every `${{ … }}` inside it becomes a **bound
parameter** rather than text spliced into the statement:

```yaml
sql: !sql "INSERT INTO notes (title, body) VALUES (${{ request.body.title }}, ${{ request.body.body }})"
```

The driver receives `INSERT INTO notes (title, body) VALUES (?, ?)` and two
values. So this does exactly what it looks like:

```bash
curl -X POST localhost:8080/v1/notes -H 'content-type: application/json' \
  -d '{"title":"x\"); DROP TABLE notes; --","body":"b"}'
# {"created":1}

curl localhost:8080/v1/notes
# [{"id":1,…},{"id":2,"title":"x\"); DROP TABLE notes; --","body":"b"}]
```

The attack is stored as a title. Nothing was executed, and `notes` is still
there. It is also **dialect-neutral** — the connection emits its own
placeholder style, so the same statement works on SQLite and PostgreSQL.

Never build a statement with `!cel` string concatenation. That splices text, and
the example above would have dropped the table.

## 3. Skipping SQL for plain table access

When a route is just "insert a row" or "select by column", `sql-repository`
gives you the operation without the statement. Add the import, then replace
`insertNote` and `listNotes` with these:

```yaml
imports:
  SqlRepository: oci://ghcr.io/telorun/sql-repository@<version>
---
kind: SqlRepository.Create
metadata:
  name: insertNote
connection: !ref db
table: !ref notes
---
kind: SqlRepository.Read
metadata:
  name: readNotes
connection: !ref db
table: !ref notes
```

One resource per **operation**, not per route — `readNotes` serves both the list
and the by-id route, because the filter is a call-site input. The routes of
`notesApi` become:

```yaml
  - request: { path: /notes, method: POST }
    handler: !ref insertNote
    inputs:
      data:
        title: !cel "request.body.title"
        body: !cel "request.body.body"
    returns:
      - status: 201
        content:
          application/json:
            body: { created: !cel "result.rowCount" }

  - request: { path: /notes, method: GET }
    handler: !ref readNotes
    inputs:
      filters: {}
    returns:
      - status: 200
        content:
          application/json:
            body: !cel "result.rows"

  - request:
      path: /notes/{id}
      method: GET
      schema:
        params:
          type: object
          required: [id]
          properties:
            id: { type: integer }
    handler: !ref readNotes
    inputs:
      filters:
        id: !cel "request.params.id"
    returns:
      - status: 200
        when: !cel "size(result.rows) > 0"
        content:
          application/json:
            body: !cel "result.rows[0]"
      - status: 404
        content:
          application/json:
            body: { message: Not found }
```

Filter values bind as parameters, exactly as `!sql` does. Reach for
`SqlRepository.*` when the queries are plain table access, and for `Sql.Query`
the moment you need a join, an aggregate, or anything else SQL is better at.
There is also a `crud` module that generates the whole REST surface from a table
— see the `todo-app` example.

## 4. All of it, or none of it

Two writes that must not half-happen go inside a `Sql.Transaction`. Its `steps:`
is a resource to run inside the transaction — usually a `Run.Sequence`:

```yaml
kind: Sql.Transaction
metadata:
  name: transfer
connection: !ref db
steps: !ref transferSteps
inputs:
  amount: !cel "inputs.amount"
---
kind: Run.Sequence
metadata:
  name: transferSteps
steps:
  - name: debit
    invoke: !ref move
    inputs:
      sql: !sql "UPDATE accounts SET balance = balance - ${{ inputs.amount }} WHERE name = 'alice'"
  - name: credit
    invoke: !ref move
    inputs:
      sql: !sql "UPDATE accounts SET balance = balance + ${{ inputs.amount }} WHERE name = 'bob'"
---
kind: Sql.Command
metadata:
  name: move
transaction: !ref transfer
```

`move` declares `transaction: !ref transfer` and **no `connection:`** — the
connection is derived from the transaction it joins. If either step fails, both
roll back. The transaction runs when something invokes it — a route's `handler:`,
or a step: `invoke: !ref transfer` with `inputs: { amount: 30 }`. (The
`accounts` table is declared like `notes`, and the `Run` import is
`oci://ghcr.io/telorun/run@<version>`.)

### The compiler knows a statement is in the wrong place

`transaction:` is not documentation. It is a requirement that "I must be reached
through a `Sql.Transaction` on this connection", and `telo check` verifies it by
walking every path that can reach the resource. Invoke `move` from a step of a
sequence that is not inside the transaction, and the check fails before anything
runs:

```yaml
kind: Run.Sequence
metadata:
  name: oops
steps:
  - name: pay
    invoke: !ref move
    inputs:
      sql: "UPDATE accounts SET balance = balance - 1 WHERE name = 'alice'"
```

```
error  Sql.Command 'move' requires a SQL.Transaction zone on SQLite.Connection 'db',
       and the path move → oops → NotesApi.targets[2] reaches the application's boot targets,
       which nothing encloses. the statement would execute outside any transaction.
       ZONE_REQUIREMENT_UNSATISFIED
```

(Here `oops` is listed in `targets:`; the path would end at a route's handler
or any other entry point the same way.)

That is an [execution zone](/extend/execution-zones). The general shape — a
resource that only makes sense inside another's body — is not SQL-specific.

## 5. Swapping the backend

`Sql.Connection` is a `Telo.Abstract`: a contract with no implementation.
`SQLite.Connection` extends it, and so does the Postgres backend. Every slot in
this guide — `migrate`, `insertNote`, `listNotes` — declares that it takes a
`Sql.Connection`, so it accepts either.

Moving to Postgres is an import, a need for the database, and a connection
resource opened over it. No route, no statement, and no handler changes:

```yaml
imports:
  Postgres: oci://ghcr.io/telorun/postgres@<version>
needs:
  databaseAccess:
    kind: Postgres.DatabaseAccess
    version: ">=15.0.0"
    env: { url: DATABASE_URL }
---
kind: Postgres.Connection
metadata:
  name: db
access: !ref databaseAccess
```

`needs:` sits in the application document beside `imports:`. The database's
address is read from `DATABASE_URL` when the application loads — a URL whose
password is redacted from every log line — and the connection checks the
server's version against `>=15.0.0` when it starts, refusing to start against an
older one. [Declaring a need](/learn/declaring-a-need) covers needs in full.

Keep the resource named `db` and every `!ref db` in the manifest still resolves.
This is the payoff for the two imports in section 1: the vocabulary your
manifest is written against is not the same thing as the driver behind it.

## Where to go next

- **Move the file** — it is already a `Telo.HostPath` variable, so `DB_FILE=/var/lib/notes/notes.db`
  needs no edit; [Configuring an application](/learn/configuration#file-paths)
  covers the type. A database's address belongs in a need, as section 5 shows.
- **Test it** — [Testing your manifests](/build/testing). A `:memory:` SQLite
  connection gives each test a fresh database with no cleanup.
- **The full field reference** for every kind here is on the
  [hub](https://hub.telo.run), read from the published manifest.
- **Working examples** — `feedback-api-repo` (repository handlers), `todo-app`
  (generated CRUD), and `url-shortener` in the [examples](/examples) index.
