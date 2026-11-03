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
| `SqlInstantArithmeticSchema` / `rendersInstantArithmetic` | A schema instance that also renders the current instant shifted by a duration and a bound timestamp, and the guard a consumer needing those refuses others with. |
| `SqlLockSchema` / `rendersLockSkipping` | A schema instance that also renders the lock-skipping clause of a row selection, and the guard a consumer claiming rows concurrently refuses others with. |
| `storeDurationNanos` / `storeTimestampNanos` / `utcInstantText` / `signedSecondsText` | For an engine implementing the instant members: read the `Telo.Duration` / `Telo.Timestamp` a controller is handed, and spell either as bound text at the engine's precision. |
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

## The schema instance renders instants

A consumer that records *when* something happened by the database's clock must
not spell a clock function, interval arithmetic or timestamp text itself — each
names an engine. The engine's `Schema` instance renders all three:

```ts
interface SqlInstantSchema extends SqlSchema {
  /** The SQL expression for the instant the statement holding it runs. */
  currentInstant(): string;
}

interface SqlInstantArithmeticSchema extends SqlInstantSchema {
  /** That instant shifted by a signed Telo.Duration, the duration bound. */
  currentInstantPlus(duration: CelDuration): SqlFragments;
  /** A bound Telo.Timestamp in the column's storage form. */
  instantParameter(timestamp: CelTimestamp): SqlFragments;
}
```

They are two levels so that a consumer is refused only for what it uses: one
that only records "now" asks for `SqlInstantSchema`, and keeps working over an
engine module written before the arithmetic members existed.

`currentInstant()` is read when its statement executes, never frozen at a
transaction's start. `currentInstantPlus` is the same reading shifted by a
duration — a `Telo.Duration` as the SDK hands it to a controller (`isCelDuration`),
negative for the past — that is a bound value in the returned fragments, never
statement text. `instantParameter` binds a `Telo.Timestamp` (`isCelTimestamp`).
Both check their argument at run time and throw for anything else. All three
yield the storage form of the engine's timestamp column, so values written
through any of them order chronologically against each other under a plain
comparison of the column, to the engine's precision:

| Engine | Column type | `currentInstant()` | `currentInstantPlus(d)` | `instantParameter(t)` | Precision |
| --- | --- | --- | --- | --- | --- |
| PostgreSQL | `timestamptz` | `clock_timestamp()` | `clock_timestamp()` plus an interval cast from bound hours and seconds | a `timestamptz` cast from bound UTC text | microsecond |
| SQLite | `text` | `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')` | the same, with the duration bound as a date modifier | bound text, `YYYY-MM-DDTHH:MM:SS.sssZ` | millisecond |

A duration finer than the engine's unit is truncated toward zero, a timestamp
toward the past. SQLite's `'now'` is one reading per statement, so within a
statement a shift of one millisecond is visible and exact; PostgreSQL's
`clock_timestamp()` is read at each evaluation, so two instants in one
statement are moments apart. Two statements inside one millisecond on SQLite
record one instant, so order within a millisecond needs a second ordering
column. A shift whose result the column cannot hold fails — PostgreSQL's own
range error, and on SQLite (whose date functions answer NULL there) a refusal
before the statement runs. A consumer writes `currentInstant()` into its
statement text and appends the other two members' fragments to its own
(`SqlFragments.append`), and refuses a schema instance without the members it
uses — `rendersCurrentInstant` for `currentInstant()` alone,
`rendersInstantArithmetic` for all three — rather than fall back to a clock or a
timestamp text of its own; an engine module written before a member existed must
add it.

## The schema instance renders lock skipping

A consumer that lets several claimants take rows from one table at once (a work
queue, a batched purge) must not wait on rows another transaction holds, and
must not spell the clause that says so — it is an engine's. The engine's
`Schema` instance renders it:

```ts
interface SqlLockSchema extends SqlSchema {
  /** The lock-skipping clause, or "" for an engine with no row locks. */
  skipLockedClause(): string;
}
```

The consumer appends it to a plain one-table selection and uses that selection
inside the statement that changes the rows:

```sql
UPDATE <table> SET … WHERE id IN (SELECT id FROM <table> WHERE … ORDER BY … LIMIT ? <clause>)
DELETE FROM <table> WHERE id IN (SELECT id FROM <table> WHERE … ORDER BY … LIMIT ? <clause>)
```

| Engine | Clause | Why |
| --- | --- | --- |
| PostgreSQL | `FOR UPDATE SKIP LOCKED` | rows another open transaction locked are passed over; the selected rows stay locked until this transaction ends |
| SQLite | (empty) | one writer per database: a writing transaction holds the whole file, so there is no row lock to skip and claimants are serialized |

PostgreSQL refuses the clause beside `DISTINCT`, `GROUP BY`, an aggregate or
`UNION`, so the selection stays a plain row selection. A consumer refuses a
schema instance without the member (`rendersLockSkipping`).

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
