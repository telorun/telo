# Node backends

The `@telorun/sql` npm package is the Node/TypeScript helper library for writing
a SQL backend. It exists so backends do not each reimplement statement
execution and transaction scoping; it is **not** the contract. For what a
backend owes regardless of runtime, see
[writing a SQL backend](writing-a-backend.md).

This library is built on [kysely](https://kysely.dev). That is an
implementation choice of the Node half, not part of the `Sql.Connection`
contract — a backend in another language answers the same contract through
whatever its ecosystem provides.

## What it exports

| Export | Role |
| --- | --- |
| `SqlConnection` | The interface every operation programs against. |
| `SqlDialect` | The SQL constructs that differ between databases. |
| `SqlConnectionBase` | Abstract class implementing the dialect-neutral half. |
| `quoteAnsiIdentifier` | ANSI identifier quoting, for dialects that follow it. |
| `resolveSqlConnection` / `isSqlConnection` | Resolve a `connection` `!ref` slot. |

A backend supplies a `SqlDialect`, extends `SqlConnectionBase`, and overrides
only what is genuinely its own.

```ts
import { quoteAnsiIdentifier, SqlConnectionBase, type SqlDialect } from "@telorun/sql";

const myDialect: SqlDialect = {
  placeholderStyle: "numbered",
  quoteIdentifier: quoteAnsiIdentifier,
  renderIn(column, values, addParam) {
    return `${column} = ANY(${addParam(values)})`;
  },
};

class MyConnection extends SqlConnectionBase {
  constructor(db: Kysely<any>, ctx: ResourceContext) {
    super(db, myDialect, ctx);
  }
}

export async function create(resource: MyManifest, ctx: ResourceContext) {
  return new MyConnection(buildKysely(resource), ctx);
}
```

`SqlConnectionBase` implements `execute`, `executeTemplate`, `runInTransaction`,
`hasOpenTransaction`, `toRowCount`, `init`, `teardown` and `snapshot` over a
kysely instance. Nothing in it is database-specific.

The `ResourceContext` is required: transaction membership is ambient and keyed
per connection, so the base reads the kernel's zone stack (`ctx.zonesFor(this)`)
to find whether a transaction is open on *this* connection. It keeps the
executor map as an instance field, never at module scope — see
[transaction state](writing-a-backend.md#transaction-state-belongs-to-the-connection-instance)
for why that distinction is load-bearing rather than stylistic.

## What a backend overrides

- **`init()`** — to start recurring work once the connection has proved itself.
  Call `super.init()` first; it round-trips the connection. `sql-postgres`
  starts its liveness sweep here.
- **`teardown()`** — when the backend owns resources kysely does not. Call
  `super.teardown()`; it destroys the kysely instance and its pool.
  `sql-postgres` stops its sweep first.
- **`executeScript(sql)`** — when the driver has a native multi-statement entry
  point. The default hands the whole script to `execute` as one statement;
  `sql-sqlite` overrides it to call the driver's `exec`.

## The dialect interface

```ts
interface SqlDialect {
  readonly placeholderStyle: "numbered" | "qmark";
  quoteIdentifier(name: string): string;
  renderIn(column: string, values: unknown[], addParam: (v: unknown) => string): string;
}
```

`dialect.placeholderStyle` is the single spelling of the bind style — the
`SqlConnection` interface carries no mirror of it. A consumer that binds its own
parameters (`kv-store-sql`) reads it from the dialect.

## `kysely` is optional on the interface

`SqlConnection.kysely` is declared optional so the contract stays implementable
by a driver kysely does not support. `SqlConnectionBase` always provides it.
The schema runner is what needs it — it groups DDL and each migration atomically —
and fails with an explicit message when a connection does not have one. Every
other operation goes through `execute` / `executeTemplate`.

## Placeholders are the dialect's job

Anything assembling SQL must take its placeholder from the dialect rather than
assuming a style. Getting this wrong is quiet: emitting `$1` against SQLite
raises `Too many parameter values were provided` under Node, while `bun:sqlite`
accepts `$1` as a *named* parameter and appears to work. A test that only runs
under one of the two runtimes will not catch it.
