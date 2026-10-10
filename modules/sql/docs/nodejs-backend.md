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
| `SqlSchema` / `isSqlSchema` | The contract an engine's `Schema` instance implements for consumers addressing its tables. |
| `assertListedTable` | The membership check behind `SqlSchema.qualifiedTableName`. |
| `SqlInstantSchema` / `rendersCurrentInstant` | A schema instance that also renders the current instant, and the guard a consumer recording database time refuses others with. |
| `readInt64Column` / `readTimestampColumn` | Read a 64-bit integer column and a timestamp column whatever form the engine's driver hands them over in. |
| `SqlFragments` / `sqlComparison` / `sqlWhere` | Build the fragments-and-values argument of `executeTemplate`: statement text with a bound value in every gap, one null-aware comparison, and the `WHERE` joiner. |

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
  // Required: the database's clock in epoch milliseconds, read at statement time.
  renderCurrentTimeMillis() {
    return "CAST(EXTRACT(EPOCH FROM clock_timestamp()) * 1000 AS BIGINT)";
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
  Extend the base's chain: `super.init(ctx).effect("health check", …)`. The
  base's step round-trips the connection and carries `db.destroy()` as its
  inverse; each `.effect(...)` you add carries its own, and unwinding runs them
  in reverse — so `postgres` stops its liveness sweep before the pool is
  destroyed without stating that order anywhere.
- **`executeScript(sql)`** — when the driver has a native multi-statement entry
  point. The default hands the whole script to `execute` as one statement;
  `sqlite` overrides it to call the driver's `exec`.

## The dialect interface

```ts
interface SqlDialect {
  readonly placeholderStyle: "numbered" | "qmark";
  quoteIdentifier(name: string): string;
  renderIn(column: string, values: unknown[], addParam: (v: unknown) => string): string;
  /** Required. The database's current time in integer epoch milliseconds, read
   *  when the statement runs. */
  renderCurrentTimeMillis(): string;
}
```

`renderCurrentTimeMillis()` is required: a consumer that measures ages across
processes (`record-stream-sql`'s journal store) reads time from the database, and
refuses a connection whose dialect does not supply it. A backend written before
the member existed must add it.

`dialect.placeholderStyle` is the single spelling of the bind style — the
`SqlConnection` interface carries no mirror of it. A consumer that binds its own
parameters (`kv-store-sql`) reads it from the dialect.

## The schema instance addresses its tables

An engine's `Schema` controller returns an instance implementing `SqlSchema`:

```ts
interface SqlSchema extends ResourceInstance {
  /** Required. The qualified, quoted name of a table this schema lists. */
  qualifiedTableName(table: DeclaredTable): string;
}
```

It renders the name from the schema's own namespace and the engine's quoting —
the same qualification its schema driver writes DDL with — and throws for a table
the schema does not list (`assertListedTable`). The namespace is configuration,
so the member answers from the moment the instance is created, before the
schema's pass has run. A consumer addressing a declared table resolves the
schema instance and refuses one without the member — an engine module written
before it existed must add it — rather than falling back to an unqualified name.

## The schema instance renders the current instant

A consumer that records *when* something happened by the database's clock must
not spell a clock function itself — that names an engine. The engine's `Schema`
instance renders it:

```ts
interface SqlInstantSchema extends SqlSchema {
  /** The SQL expression for the instant the statement holding it runs. */
  currentInstant(): string;
}
```

The expression is read when its statement executes, never frozen at a
transaction's start, and yields the storage form of that engine's timestamp
column, so values written through it sort chronologically under a plain
comparison of the column:

| Engine | Column type | Expression | Stored as |
| --- | --- | --- | --- |
| PostgreSQL | `timestamptz` | `clock_timestamp()` | a native timestamp, to the microsecond |
| SQLite | `text` | `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')` | fixed-width UTC text, `YYYY-MM-DDTHH:MM:SS.sssZ` |

SQLite has no timestamp type and a millisecond clock: two statements inside one
millisecond record one instant, so order within a millisecond needs a second
ordering column. A consumer writes the expression into its statement text —
it is the engine's own, never a value from a caller — and refuses a schema
instance without the member (`rendersCurrentInstant`) rather than fall back to
a clock of its own; an engine module written before the member existed must add
it.

## Reading integers and instants back

Two column types reach a consumer in a form that depends on the driver:

- **`readInt64Column(value): bigint`** — a 64-bit integer arrives as a number, a
  bigint or decimal text (PostgreSQL returns `bigint` as text, since a double
  cannot hold it). The reader answers the exact value across the whole int64
  range, and refuses a number already past 2^53 — it lost precision before it
  was read — and anything that is not an integer.
- **`readTimestampColumn(value): Date`** — an instant arrives as the driver's
  `Date`, or as the fixed-width UTC text SQLite stores. Any other text is
  refused rather than guessed at.

Both exist so that a consumer written against `Sql.Connection` reads these
columns without asking which engine it is on.

## Building a statement for `executeTemplate`

`executeTemplate` takes literal text fragments with one bound value between each
pair, and renders each gap as the dialect's own placeholder. Three exports build
that argument, so a consumer never concatenates a value into statement text:

- **`SqlFragments`** — the builder. `text(sql)` appends statement text,
  `value(v)` a gap holding a bound value, `valueList(values, separator)` several,
  and `append(other)` another builder's text and values in order; `fragments`
  and `boundValues` are what `executeTemplate` takes. An identifier is only ever
  written into the text, already quoted by the dialect, from a declaration; a
  value is only ever a gap.
- **`sqlComparison(column, operator, value)`** — one comparison as a builder,
  over the operators `eq`, `ne`, `lt`, `lte`, `gt` and `gte`. A null value under
  `eq` renders `IS NULL` and under `ne` `IS NOT NULL`; under any other operator
  it is bound as it is, and a comparison with NULL matches no row. `column` is
  statement text, so it must be a quoted identifier from a declaration.
- **`sqlWhere(conditions)`** — ` WHERE a AND b` over a list of conditions, and
  nothing for an empty list.

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
