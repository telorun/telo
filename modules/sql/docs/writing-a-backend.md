# Writing a SQL backend

A backend (`sql-postgres`, `sql-sqlite`, …) is a module that declares a kind
extending `Sql.Connection` and ships a controller producing a live connection.
This module owns the operations — `Sql.Query`, `Sql.Command`, `Sql.Selection`,
`Sql.Transaction`, `Sql.Migrations` — and knows nothing about which databases
exist: no driver enum, no branch on a database name. Everything specific to a
database lives in the backend implementing it.

Nothing here is tied to a runtime. A backend may be written in any language Telo
can host; what follows is what it owes, not how to build it. For the Node/
TypeScript helper library, see [Node backends](nodejs-backend.md).

## The manifest side

```yaml
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
  required: [connectionString]
  properties: { ... }
```

- **`capability: Telo.Provider`** — a connection is a configured handle, not
  something callers invoke. It is inherited from `Sql.Connection` and cannot be
  changed.
- **`extends: Sql.Connection`** — what makes the kind accepted at every
  `x-telo-ref: Sql.Connection` slot the operations declare.
- **Close the schema.** `additionalProperties: false` turns a misspelled option
  into a `telo check` error instead of a setting that silently never applies.
- **Connection-level transport settings belong in the connection string**, where
  the database's own ecosystem already spells them once — TLS, keepalives,
  connect timeouts. Pool settings have no such standard and are schema
  properties.

## What a connection must do

The operations dispatch these, so every backend provides them under whatever
name its language uses:

| Behaviour | Contract |
| --- | --- |
| Execute a statement | Take SQL text plus positional parameters, return rows and an affected-row count. |
| Execute a template | Take literal fragments and values, interleave the driver-native placeholder, bind values positionally — never splice a value into the text. |
| Execute a script | Run a multi-statement script. |
| Transaction | Run a callback with an executor whose statements share one transaction; the operations inside must pick it up implicitly. |
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

Adding a database that differs in some further construct means adding to this
list and answering it in every dialect. That is the point: a difference is
declared once, in the open, rather than becoming a branch inside a shared code
path.

## Lifecycle

- **Construction builds; nothing observable happens.** No sockets opened as a
  side effect, no timers started.
- **`init()` proves the connection works** and is where recurring work — a
  liveness sweep, a background reaper — starts. A resource whose `init()` throws
  is never torn down, so anything started earlier would be left running with no
  owner.
- **`teardown()` releases everything the backend owns**, including whatever
  `init()` started.
- **A connection failing must never terminate the process.** It surfaces as a
  failed operation to the caller that was using it, and nowhere else. Some
  runtimes give this for free; some do not — see
  [connection lifetime](../../sql-postgres/docs/connection-lifetime.md) for the
  full invariant a pooled backend holds and why proactive liveness is part of it.

## Driver-specific types

A type describing one driver's handle belongs in the backend module, never in
the shared one. `SqliteDb` lives in `sql-sqlite`; nothing driver-specific is
exported from the `sql` module in any language.
