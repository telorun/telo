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

Two resources. The connection says *where* the database is; the migrations say
what must exist in it before anything runs:

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
  - !ref Migrate
  - !ref Server
ports:
  http:
    env: PORT
    default: 8080
---
kind: SQLite.Connection
metadata:
  name: Db
file: ./notes.db
---
kind: SQLite.Table
metadata:
  name: Notes
table: notes
columns:
  id: { type: integer, primaryKey: true, identity: always }
  title: { type: text, nullable: false }
  body: { type: text, nullable: false }
---
kind: SQLite.Schema
metadata:
  name: Migrate
connection: !ref Db
tables:
  - !ref Notes
```

Three things to notice:

- **Two imports, not one.** `sql` declares the vocabulary — `Connection`,
  `Query`, `Command`, `Transaction`. `sqlite` implements the connection.
  That split is what section 5 cashes in.
- **`Migrate` is first in `targets:`.** Boot targets run in the order written,
  so the table exists before the server accepts a request. The schema is
  *declared*, not migrated to: the pass creates what is absent and records what
  was removed, so re-running the app is a no-op.
- **Nothing declares an ordering between `Db` and `Migrate`.** `Migrate`
  references `Db`, and that reference *is* the ordering.

## 2. Reading and writing

`Sql.Command` changes data and reports how many rows it touched. `Sql.Query`
reads rows back. Both take their statement **from the call site**, which is what
lets one resource serve several routes:

```yaml
kind: Sql.Command
metadata:
  name: InsertNote
connection: !ref Db
---
kind: Sql.Query
metadata:
  name: ListNotes
connection: !ref Db
```

and the routes supply the SQL:

```yaml
kind: Http.Api
metadata:
  name: Notes
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
    handler: !ref InsertNote
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
    handler: !ref ListNotes
    inputs:
      sql: "SELECT id, title, body FROM notes ORDER BY id"
    returns:
      - status: 200
        content:
          application/json:
            body: !cel "result.rows"
```

```bash
curl -X POST localhost:8080/v1/notes \
  -H 'content-type: application/json' \
  -d '{"title":"first","body":"hello"}'
# {"created":1}

curl localhost:8080/v1/notes
# [{"id":1,"title":"first","body":"hello"}]
```

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
gives you the operation without the statement:

```yaml
imports:
  SqlRepository: oci://ghcr.io/telorun/sql-repository@<version>
---
kind: SqlRepository.Create
metadata:
  name: InsertNote
connection: !ref Db
table: !ref Notes
---
kind: SqlRepository.Read
metadata:
  name: ReadNotes
connection: !ref Db
table: !ref Notes
```

One resource per **operation**, not per route — `ReadNotes` serves both the list
and the by-id route, because the filter is a call-site input:

```yaml
  - request:
      path: /notes
      method: POST
    handler: !ref InsertNote
    inputs:
      data:
        title: !cel "request.body.title"
        body: !cel "request.body.body"

  - request: { path: /notes, method: GET }
    handler: !ref ReadNotes
    inputs:
      filters: {}

  - request:
      path: /notes/{id}
      method: GET
      schema:
        params:
          type: object
          required: [id]
          properties:
            id: { type: integer }
    handler: !ref ReadNotes
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
  name: Transfer
connection: !ref Db
steps: !ref TransferSteps
inputs:
  amount: !cel "inputs.amount"
---
kind: Run.Sequence
metadata:
  name: TransferSteps
steps:
  - name: Debit
    invoke: !ref Move
    inputs:
      sql: !sql "UPDATE accounts SET balance = balance - ${{ inputs.amount }} WHERE name = 'alice'"
  - name: Credit
    invoke: !ref Move
    inputs:
      sql: !sql "UPDATE accounts SET balance = balance + ${{ inputs.amount }} WHERE name = 'bob'"
---
kind: Sql.Command
metadata:
  name: Move
transaction: !ref Transfer
```

`Move` declares `transaction: !ref Transfer` and **no `connection:`** — the
connection is derived from the transaction it joins. If either step fails, both
roll back.

### The compiler knows a statement is in the wrong place

`transaction:` is not documentation. It is a requirement that "I must be reached
through a `Sql.Transaction` on this connection", and `telo check` verifies it by
walking every path that can reach the resource. Put `Move` straight into
`targets:` and the check fails before anything runs:

```
error  Sql.Command 'Move' requires a sql.Transaction zone on SQLite.Connection 'Db',
       and the path Move → TxDemo.targets[3] reaches the application's boot targets,
       which nothing encloses. the statement would execute outside any transaction.
       ZONE_REQUIREMENT_UNSATISFIED
```

That is an [execution zone](/extend/execution-zones). The general shape — a
resource that only makes sense inside another's body — is not SQL-specific.

## 5. Swapping the backend

`Sql.Connection` is a `Telo.Abstract`: a contract with no implementation.
`SQLite.Connection` extends it, and so does the Postgres backend. Every slot in
this guide — `Migrate`, `InsertNote`, `ListNotes` — declares that it takes a
`Sql.Connection`, so it accepts either.

Moving to Postgres is an import and a connection resource. No route, no
statement, and no handler changes:

```yaml
imports:
  Postgres: oci://ghcr.io/telorun/postgres@<version>
---
kind: Postgres.Connection
metadata:
  name: Db
connectionString: !cel "secrets.databaseUrl"
```

Keep the resource named `Db` and every `!ref Db` in the manifest still resolves.
This is the payoff for the two imports in section 1: the vocabulary your
manifest is written against is not the same thing as the driver behind it.

## Where to go next

- **Don't hardcode the file path** — bind it to the environment with
  `variables:` / `secrets:`, as [Configuring an application](/learn/configuration)
  covers. A database URL belongs in `secrets:`, which is redacted from logs.
- **Test it** — [Testing your manifests](/build/testing). A `:memory:` SQLite
  connection gives each test a fresh database with no cleanup.
- **The full field reference** for every kind here is on the
  [hub](https://hub.telo.run), read from the published manifest.
- **Working examples** — `feedback-api-repo` (repository handlers), `todo-app`
  (generated CRUD), and `url-shortener` in the [examples](/examples) index.
