# Writing a SQL backend

A backend (`postgres`, `sqlite`, …) is a module that declares a kind
extending `Sql.Connection` and ships a controller producing a live connection.
This module owns the operations — `Sql.Query`, `Sql.Command`, `Sql.Selection`,
`Sql.Transaction` — and knows nothing about which databases
exist: no driver enum, no branch on a database name. Everything specific to a
database lives in the backend implementing it.

Nothing here is tied to a runtime. A backend may be written in any language Telo
can host; what follows is what it owes, not how to build it. For the Node/
TypeScript helper library, see [Node backends](nodejs-backend.md).

## The manifest side

A backend for a database reached over the network declares two kinds: a **need
type** for access to that database, and the connection opened over it.

```yaml
kind: Telo.NeedType
metadata:
  name: DatabaseAccess
version: semver
features: [<extension names a need may ask for>]
fields:
  url:
    x-telo-type: { name: Telo.Url, scheme: { enum: [<the database's schemes>] } }
    x-telo-sensitive: true
required: [url]
---
kind: Telo.Definition
metadata:
  name: Connection
capability: Telo.Provider
extends: Sql.Connection
controllers:
  - <a PURL for this module's controller>
schema:
  type: object
  additionalProperties: false
  required: [access]
  properties:
    access:
      x-telo-ref:
        kind: Self.DatabaseAccess
        use: dependency
        observes: [version, features]
    pool: { ... }
```

- **Access is a need, never a string field.** An application declares
  `needs: { databaseAccess: { kind: <Backend>.DatabaseAccess } }` and writes
  `access: !ref databaseAccess`, so the address and credentials are supplied by
  whoever runs it (an environment variable, a library importer) and are listed by
  `telo needs report` before anything boots. A test writes a fulfilment inline
  instead: `access: { kind: <Backend>.DatabaseAccess, fields: { url: … } }`.
  Guides: [Writing a need type](https://telo.run/extend/need-types),
  [Consuming needs](https://telo.run/extend/consuming-needs).
- **Report what the server is.** `observes: [version, features]` makes the
  controller report the server's version and the features it found when the
  connection starts (`ctx.resolveNeed` opens the fulfilment, `ctx.verifyNeed`
  reports), so a need asking for a newer server or a missing extension refuses to
  start with `ERR_NEED_UNMET` rather than failing at its first statement. A
  database with no versions or features to report declares neither on its need
  type and drops `observes`.
- **`capability: Telo.Provider`** — a connection is a configured handle, not
  something callers invoke. It is inherited from `Sql.Connection` and cannot be
  changed.
- **`extends: Sql.Connection`** — what makes the kind accepted at every
  `x-telo-ref: Sql.Connection` slot the operations declare.
- **Close the schema.** `additionalProperties: false` turns a misspelled option
  into a `telo check` error instead of a setting that silently never applies.
- **Connection-level transport settings belong in the access URL's query**, where
  the database's own ecosystem already spells them once — TLS, keepalives,
  connect timeouts. Pool settings have no such standard and are schema
  properties.

A database that lives in the application's own process or file (SQLite) has no
access to ask for: its connection takes the file as a `Telo.HostPath` instead.

## What a connection must do

The operations dispatch these, so every backend provides them under whatever
name its language uses:

| Behaviour | Contract |
| --- | --- |
| Execute a statement | Take SQL text plus positional parameters, return rows and an affected-row count. |
| Execute a template | Take literal fragments and values, interleave the driver-native placeholder, bind values positionally — never splice a value into the text. |
| Execute a script | Run a multi-statement script. |
| Open a transaction | Begin one and let the caller bind the open executor to the zone entry it mints; commit or roll back when the body settles. |
| Report an open transaction | Say whether a transaction zone correlated on *this* connection has an executor open here — the nesting check. |
| Row count | Normalize "rows affected" across drivers. |

Values are **always bound, never interpolated** — that is the guarantee `!sql`
templates rest on, and it is what keeps a manifest's inline `${{ }}` parameters
injection-safe on every backend.

## The dialect

A backend declares the constructs that genuinely differ between databases, so
the shared operations never branch on which database is behind a connection:

- **Placeholder style** — numbered (`$1`, `$2`) or positional (`?`). Fixes how
  templates bind and how consumers that build their own statements parameterize.
- **Identifier quoting** — ANSI double quotes for most; a dialect that differs
  (MySQL backticks) supplies its own.
- **Set membership** — PostgreSQL binds a whole array to one placeholder
  (`= ANY($1)`); SQLite has no array type and expands one placeholder per
  element.
- **Current time** — required: an SQL expression for the database's current
  wall-clock time as integer milliseconds since the Unix epoch, read when the
  statement runs rather than frozen at a transaction's start. A consumer that
  compares ages across processes (a journal judging whether a writer in another
  process is still alive) needs the database's one clock, not each host's.
  SQLite: `CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)`;
  PostgreSQL: `CAST(EXTRACT(EPOCH FROM clock_timestamp()) * 1000 AS BIGINT)`.

Adding a database that differs in some further construct means adding to this
list and answering it in every dialect. That is the point: a difference is
declared once, in the open, rather than becoming a branch inside a shared code
path.

## Transaction state belongs to the connection instance

Transaction membership is ambient and keyed per connection, carried by the
kernel's [execution-zone](https://telo.run/extend/execution-zones) stack. The
kernel owns the stack; a backend owns only the mapping from a zone entry to the
executor it opened.

That mapping **must live on the connection instance** — the object both the
transaction controller and the operations hold by reference — and never at
module scope.

Module-scoped state is a scope per *bundle*, and a bundle is a module graph. A
module now builds one bundle for all its kinds, and a library another module owns
is resolved at load rather than copied into each dependent, so one module is one
scope in the common case. It is not a guarantee you can lean on, and two live
cases say so:

- **An npm-delivered controller resolves the library from npm.** `sqlite`
  ships as `pkg:npm`, so its tarball's own `@telorun/sql` is a second scope,
  separate from the one `sql`'s kinds and the bundled backends share. Nothing
  reports this — the kernel cannot see inside another delivery mode's package —
  and it is the split that exists today.
- **Two dependents pinning different versions** of one library legitimately run
  two scopes, since that is genuinely different code. The kernel warns about that
  one, because it can see it.

Holding the mapping on the instance is what makes the write and the read meet
regardless of either. (Before both — zones, and one bundle per
module — this was a live bug here: `transaction:` threw on every path, including
inside its own transaction, because six controller bundles held six copies of the
map.)

The same rule fixes what a miss must do. When a caller passes an explicit zone
this connection did not open, **throw** — the caller declared a requirement, and
falling back to the unzoned executor would run the statement outside the
transaction it asked for. A loud failure is strictly better than silently
non-transactional writes.

## Lifecycle

- **Construction builds; nothing observable happens.** No sockets opened as a
  side effect, no timers started.
- **`init()` proves the connection works** and is where recurring work — a
  liveness sweep, a background reaper — starts. It RETURNS the effects that
  started them, each paired with its inverse, so an `init()` that throws
  part-way recovers what it already allocated rather than leaving it running
  with no owner.
- **There is no `teardown()`.** What releases the backend's resources is what
  `init()` returned; extend the base chain rather than restating the order.
- **A connection failing must never terminate the process.** It surfaces as a
  failed operation to the caller that was using it, and nowhere else. Some
  runtimes give this for free; some do not — see
  [connection lifetime](../../postgres/docs/connection-lifetime.md) for the
  full invariant a pooled backend holds and why proactive liveness is part of it.

## Driver-specific types

A type describing one driver's handle belongs in the backend module, never in
the shared one. `SqliteDb` lives in `sqlite`; nothing driver-specific is
exported from the `sql` module in any language.
