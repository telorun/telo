# Transactions

`Sql.Transaction` wraps a body of work in a database transaction: it opens one,
runs the body, then commits on success or rolls back if it fails.

## Membership is ambient, and per connection

A statement does **not** join a transaction by naming it. Membership is
ambient: `Sql.Transaction` opens an [execution
zone](https://telo.run/extend/execution-zones) around its body, and every
statement reached through that body — at any depth, through any number of
intermediate resources — executes on the transaction's connection.

That is what lets a library export a sequence of writes which joins an
importer's transaction without the library naming a transaction it cannot see:

```yaml
kind: Sql.Transaction
metadata: { name: accountTx }
connection: !ref appDb
steps: !ref accountWrites      # a Run.Sequence, or any Telo.Executable
---
kind: Run.Sequence
metadata: { name: accountWrites }
steps:
  - name: insert
    invoke: !ref insertAccount
---
# No `transaction:` — joins whatever is open on its connection.
kind: Sql.Command
metadata: { name: insertAccount }
connection: !ref appDb
inputs:
  sql: "INSERT INTO accounts (email) VALUES (?)"
```

The zone is keyed on the **connection**. A statement on connection B inside a
transaction on connection A is not in that transaction and executes
non-transactionally on B — which is the truth, and is now what both the runtime
and `telo check` say. Nesting follows the same rule: a nested
`Sql.Transaction` on the same connection joins the enclosing one (one commit,
so a later failure rolls the whole thing back), while one on a different
connection opens its own.

## What `transaction:` declares

`Sql.Query`, `Sql.Command` and `Sql.Selection` each take an optional
`transaction:` reference. It does **not** bind the statement to that transaction
— membership is still ambient. What it does is **assert a requirement**: this
statement must be reached through a transaction zone on its connection.

```yaml
kind: Sql.Command
metadata: { name: insertAccount }
transaction: !ref accountTx      # ← "I must run inside a transaction"
inputs:
  sql: "INSERT INTO accounts (email) VALUES (?)"
```

Two things follow.

**At runtime**, a dispatch that reaches this statement with no such zone open
raises `ERR_ZONE_REQUIRED`, naming the connection:

```
SQL.Command 'insertAccount': no SQL.Transaction zone open on
SQLite.Connection 'appDb': the statement would execute outside any transaction
```

**At check time**, `telo check` follows every statically visible path to the
statement and reports one that provably reaches it outside a transaction —
before the route is ever exercised:

```
error  Sql.Command 'insertAccount' requires a SQL.Transaction zone on
       SQLite.Connection 'appDb', and the path
       insertAccount → accountsApi.routes[0].handler is an inbound trigger
       registration — the handler runs on a fresh context driven by a request or
       timer, outside every zone.  ZONE_REQUIREMENT_UNSATISFIED
```

Omitting `connection:` is idiomatic and fully supported: the correlation is
derived from the transaction the statement names, exactly as the controller
derives the connection itself.

A statement declaring **no** `transaction:` asserts nothing and is checked
nowhere — including inside a transaction body, which it joins ambiently. That is
also the shape a library exports: its writes make no assertion, so an importer
wrapping them needs no declaration on either side.

## What the check reports

| Where the requirement ends up | Outcome |
| --- | --- |
| An enclosing `Sql.Transaction` on the same connection | satisfied, no diagnostic |
| An enclosing transaction on a **different** connection | `ZONE_REQUIREMENT_UNSATISFIED` — it would not be transactional there |
| An HTTP route / MCP tool / timer handler | `ZONE_REQUIREMENT_UNSATISFIED` — inbound work gets a fresh context |
| A detached dispatch, or a slot that detaches on *some* dispatch (a `Cache.View` with `revalidate: background`) | `ZONE_REQUIREMENT_UNSATISFIED` — detaching sheds every zone |
| An Application's `targets:` | `ZONE_REQUIREMENT_UNSATISFIED` — nothing encloses boot |
| A stream-completion handler | `ZONE_REQUIREMENT_DEFERRED` (warning) — the drain site decides |

The check under-approximates deliberately: where it cannot decide, it warns, and
the runtime assertion remains the enforcement.

## Bodies are `Telo.Executable`

`steps:` accepts any `Telo.Executable` — a `Run.Sequence`, a `JS.Script`,
anything with an entry point. Wire the body through a sequence rather than
naming a bound statement directly: a statement's `transaction:` ref and the
transaction's `steps:` ref are both injection sites, so wiring them to each
other is an init-order cycle, while a step's `invoke:` resolves at dispatch.

## Migrations

`Sql.Migrations` runs all pending migrations in a single transaction — every
statement of every entry commits together, or the whole batch rolls back on the
first failure. Statements that cannot run inside a transaction block (e.g.
PostgreSQL `CREATE INDEX CONCURRENTLY`) are therefore not supported there.

## Known gaps

- **Membership is not declarative.** A statement bound to transaction A executed
  inside transaction B *on the same connection* still runs in B: `transaction:`
  asserts that *a* qualifying transaction is open, not that a particular one is.
- **There is no way to say "must be transactional" without naming a
  transaction**, since the assertion rides the `transaction:` field.
