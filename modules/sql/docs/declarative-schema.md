# Declarative schema

Schema used to be imperative: hand-written DDL keyed by a durable id. The author
stated *how* the schema got here, never *what it is*, so nothing could type a
column, render a table in the editor, or tell whether two apps agreed about a
table.

The declarative form states the table. Each backend owns the vocabulary
(`Postgres.Table`, `SQLite.Table`) and a `Schema` resource brings the database to
what is declared, at start-up, in one pass.

```yaml
kind: Postgres.Table
metadata: { name: users }
table: users
columns:
  id:    { type: uuid, primaryKey: true, defaultExpression: "gen_random_uuid()" }
  email: { type: citext, nullable: false, unique: true }
  plan:  { type: text, nullable: false, default: free }
---
kind: Postgres.Schema
metadata: { name: appSchema }
connection: !ref db
schema: app
version: !cel "module.version"
tables: [!ref users]
reclaim: { afterVersions: 3, afterDuration: 30d }
```

## Domains — a type refinement, always declared

A column's `type:` holds a storage class **or a reference to a declared enum**.
The enum is a declaration of its own, listed by the schema that owns it exactly
as a table is:

```yaml
kind: Postgres.Enum
metadata: { name: messageRole }
typeName: message_role
values: [system, user, assistant]
---
kind: Postgres.Table
metadata: { name: messages }
table: messages
columns:
  role: { type: !ref messageRole, nullable: false }
---
kind: Postgres.Schema
metadata: { name: appSchema }
connection: !ref db
enums: [!ref messageRole]
tables: [!ref messages]
```

**The declaration says what the values are; the backend picks the rendering.**
PostgreSQL has a first-class construct and uses it (`CREATE TYPE … AS ENUM`, a
schema object with a physical `typeName`). SQLite has no named types at all, so
`SQLite.Enum` names a `baseType` from its storage classes and the values are
rendered as a `CHECK` on every column that references the enum. Same
declaration, same projected row contract, two engine-native renderings.

**A domain crosses into the row projection** — `{ type: string, enum: [...] }` on
either engine — which is a deliberate exception to the projection's lossiness.
Length, precision and collation stop at the boundary because the database
enforces them; a domain crosses because it *is* the type at the granularity a
consumer acts on: the enum in a CRUD model's OpenAPI operation, a completion list
in the editor, a filter a repository can reject before the query.

**The schema's `enums:` is what says it owns the type.** Deriving the set from
the columns instead would make deleting the last column that used a type silently
un-declare it, tombstone it and eventually drop it — a schema removal nobody
wrote. A column naming an enum its schema does not list fails `telo check`
(`SQL_ENUM_NOT_DECLARED`), and the pass refuses it again before any statement
runs, for the caller who reached the library directly.

### Adding and removing values

A value added to the declaration is added to the type, in its own phase ahead of
the reconciliation pass — `ALTER TYPE … ADD VALUE` cannot be used in the
transaction that adds it, so a column can name the new value on the same boot.

A value **removed** is recorded and left in the type: PostgreSQL cannot drop an
enum label without a new type, a column rewrite per user and a drop. It is
reported as `status.retainedEnumValues` so the cost is visible rather than
silent. The opposite of a removed *object*, and for the opposite reason — a
dropped column is deferred because it CAN be executed later, while this cannot be
executed at all.

## Predicates — named table-level checks

A `checks:` map beside `indexes:` and `foreignKeys:`, keyed by constraint name,
each entry carrying an expression in that backend's own SQL:

```yaml
checks:
  balance_non_negative:
    expression: "balance_cents >= 0"
  sent_implies_timestamp:
    expression: "status <> 'sent' OR sent_at IS NOT NULL"
    validate: deferred
```

Raw backend SQL rather than a structured predicate vocabulary, for the reason
there is no neutral type vocabulary: a lowest-common-denominator predicate
language would fail on the predicates people actually write, which correlate
columns. The precedent is `defaultExpression`, already raw engine SQL beside a
typed `default`.

The consequence is stated rather than papered over: **nothing reads the
expression**, so a check naming a column the table does not declare is not
catchable the way an index's column list is. The engine reports it when the
constraint is added.

**A scalar bound is a predicate, not a domain**, so there is no `min` / `max`
column keyword — nothing in a CRUD model or a repository filter could have acted
on a bound anyway.

**Removing a check is immediate — no tombstone, no reclaim.** A dropped column
can lose data, which is why removals are recorded and reclaimed on a policy; a
dropped constraint loses nothing, so recording it would put a grace window on a
free removal and leave the declaration disagreeing with the database for a
release cycle.

On PostgreSQL `validate: deferred` renders `NOT VALID`: the predicate is enforced
for new rows immediately and the existing ones are scanned on a later pass, so
adding a constraint to a large table does not hold a lock while every row is
read. SQLite has no `ADD CONSTRAINT`, so a check exists only as part of the table
it was created with — emitted at create time, and a later change refused with the
reason.

## Seeds — rows the table is declared to hold

Reference data is desired state, not history, so it is declared beside the shape
it must satisfy:

```yaml
seeds:
  key: [name]
  rows:
    - { name: admin,  label: Administrator, rank: 100 }
    - { name: viewer, label: Viewer }
```

**On the table, not on the schema, because that is what makes the rows
checkable.** The row projection already turns `columns:` into a JSON Schema of
the row, so a misspelled column, a string in an integer column or a null in a
`nullable: false` one is a `telo check` error on the row's own line.

**`key:` is durable identity** — the columns that decide whether a row is the
same row, and what the upsert conflicts on. It is checked at `telo check` in both
directions: a key naming a column the table does not declare is
`SQL_SEED_KEY_UNKNOWN_COLUMN` on that key entry, and a row supplying no value for
one is `SQL_SEED_ROW_MISSING_KEY` on that row. Both were previously decidable only
at boot, against a real database. A `when:` written as `!cel` does not disable
either: each rule reads only the key, never the whole block.

**A structured value is stored as JSON.** A `json` / `jsonb` column projects to an
open schema — a JSON column genuinely holds any JSON value — so a row may declare
an object or an array there, and it is serialized rather than stringified. On an
engine with no JSON type that is the same text `json_extract` reads; on a column
whose type is not JSON the engine rejects it, which is a loud failure rather than
the `[object Object]` a plain string conversion used to write.

**A row asserts the columns it states and no others.** `viewer` above declares no
`rank`, so the insert leaves it to the column default and the update leaves
whatever is there alone. That is the answer to a seeded row edited in place: a
column the seed declares is restored on the next boot, because that is what
declaring it means; one it does not is the operator's.

**A row removed from `rows:` is recorded, not deleted** — the tombstone rule every
other object follows, reclaimed under the same policy. Deleting rows is
irreversible; nothing about a row makes it the one object worth exempting.

Seeds re-apply on every boot, bounded by what is declared, so a row deleted by
hand comes back. Nothing is read back: the upsert is the whole mechanism, and the
only history required is the previous declaration the ledger already holds.

An environment-conditional seed is a `when:` on the block:

```yaml
seeds:
  key: [name]
  when: !cel "variables.environment != 'production'"
  rows:
    - { name: demo, label: Demo }
```

with the trap stated: **a `when:` that turns false is a declaration withdrawn**,
so those rows tombstone on the next boot of a database that had them.

## Provisioning is a declaration, not a bucket

`citext` needs an extension before any column can use it. Declared, it is
reconciled ahead of everything else:

```yaml
kind: Postgres.Schema
extensions: [citext, pgcrypto]
```

Smuggled into `migrations:` as `CREATE EXTENSION IF NOT EXISTS`, it is desired
state wearing a migration's clothes: no release it belongs to, and a migration
key that is a lie the first time the entry is deleted. Removing one is recorded
rather than executed — an extension is database-wide, so something outside this
schema may be using it and `DROP EXTENSION` would take every dependent object
with it.

## Removal is recorded, not executed

Every declarative schema tool hits the same wall: a column absent from the
declaration is indistinguishable from one the author forgot, so the tool either
drops data or refuses forever and hands the problem back.

Telo separates *recording* a removal from *executing* it. Deleting a column from
the declaration emits no DDL at all — the object is **tombstoned**, with its
last-known definition and the version it went missing at. It is dropped only once
the declared policy has been met: N released versions observed **and** T elapsed.
Until then the version still running keeps reading it.

- **The clock is `version:`**, which you write, conventionally
  `!cel "module.version"`. It is required exactly when `reclaim:` is declared and
  read by nothing else, so an app that only runs migrations declares neither and
  looks just like the imperative kind it replaced. It is not injected: `module.*`
  is scoped to the declaring module, so a schema resource inside a library would
  silently clock on the library's version — and this value gates an irreversible
  drop, so it is the author's to state. Deriving it from a build id or a manifest
  hash was rejected for the same reason and because both distort the count: a
  hash misses the ordinary release that changes only application code, while a
  per-build id ages a tombstone out on rebuilds that shipped nothing.
- **A rollback resets progress**, rather than pausing it. Booting a version that
  was already seen at or before the removal proves older code is still live, so
  both counters restart from that observation.
- **A boot at an unchanged version advances nothing.** Forgetting to bump costs
  grace progress rather than causing harm, and local iteration accrues no budget.
- **No policy means nothing is ever dropped.** The ledger still records
  tombstones and reports what *would* be eligible through observed state, so a
  schema can run indefinitely with reclamation declared nowhere and still show
  what it is holding.

What the pass did is observed state on the schema resource — there is nothing to
invoke to see it:

```yaml
!cel "resources.appSchema.status.pendingReclamation"
```

## Ownership

A schema resource reconciles only what it has declared. The ledger records each
boot's declaration, so an object in the namespace that has never appeared in one
— a legacy table, another application's, one predating adoption — is invisible to
both the diff and to reclamation. Adopting an existing database is therefore
safe: nothing you have not declared is ever tombstoned.

## Two schemas over one namespace

A namespace can be reached by more than one schema resource — two libraries in
one application, or two applications over one database. Each needs a history of
its own, because the ledger records the **declaration**, and a shared one would
make each read the other's tables as removed.

They are kept apart by **name**, with `ledger:`:

```yaml
kind: Postgres.Schema
metadata: { name: billingSchema }
ledger: billing        # telo_schema_billing_{migrations,versions,tombstones}
```

Omitted, the tables are `telo_schema_{migrations,versions,tombstones}`. This is
the same separation `flyway.table`, Liquibase's `databaseChangeLogTableName` and
Alembic's `version_table` provide, and it has a property an identity column
would not: because the identity is **written down**, renaming the resource — or
the application — changes nothing.

`ledger:` is durable identity, in the same sense a migration key is. Changing it
abandons the history under the old name, so every migration re-runs against the
new one.

**One physical table has one schema resource that manages it.** Separate ledgers
keep two resources' *histories* apart, which says nothing about the tables
themselves — and two resources declaring one table is worse than a shared
history: remove it from one and that schema drops it while the other recreates it
empty. Two schema resources declaring the same table on one connection are
refused for that reason, as are two naming the same ledger. Two *applications* doing it cannot be seen from inside either —
as they cannot by any tool that separates history this way — so that one is a
rule rather than a check: **if two applications share a namespace, give each its
own `ledger:`.**

## What the pass refuses

A refusal is decided before any DDL runs, names the table, the column and the
reason, and stops the release. Nothing is applied and nothing is skipped.

Some are decided from the declaration alone, at resource creation, before a
connection is even opened: a table with no columns, two columns marked
`primaryKey`, a column renamed from itself or from a column the table still
declares, an index or foreign key over a column that does not exist, a foreign
key whose two sides have different arity, a column declared both `nullable` and
`primaryKey`, and — per engine — an identity column the engine cannot express
there.

**Most of those are reported by `telo check`**, before anything runs at all. The
`Table` kind declares them as resource rules (`x-telo-resource-rules`, see the
[Resource Rules](../../../docs/extend/resource-rules.md) guide), so a mistyped
index column is a diagnostic in CI and in the editor rather than a boot failure —
which matters because `prepare:` executes before reconciliation, so a
manifest wrong in a way only reconciliation notices has already changed the
database by the time it is told. The controller keeps every one of them as a
runtime guard as well: a library caller reaching `runSchemaPass` directly never
passed through `telo check`.

`reclaim: { afterDuration: 0ms }` is reported there too, as a warning. It is
legal — `afterVersions` alone then gates the drop — but it switches off the
backstop that exists because several releases can land in an afternoon.

The rest need the live database: a narrowing type change, `NOT NULL` over a
column that currently holds NULLs, and a rename whose copy would not survive the
type change. Those are what `prepare:` is for.

**A foreign key reads its target's DECLARATION, not its resource.** What it needs
from `references.table` is the physical name, which the declaration carries
whether or not that table has been constructed — so the slot registers no
ordering edge, and declaration order never matters. On an engine with
`ADD CONSTRAINT` the key is created in a later phase than the tables, so a key
may name a table declared below it.

**Known limitation: a key may not point at a table that cannot be constructed
before it.** A table that references ITSELF (a `parent_id` tree) and a mutually
referencing pair are both refused at boot, because the kernel resolves a `!ref`
before the resource that holds it is created and neither can satisfy that. Both
are otherwise ordinary and both are creatable on PostgreSQL. Declare such a key
in a `prepare:` entry until this is lifted.

**Where the engine cannot name a key, the key is matched by structure.** SQLite
emits a foreign key only as part of `CREATE TABLE` and reports it back unnamed,
so a declaration is matched to a live key by its columns, its target and its
referential actions rather than by the name the manifest gave it. Matching by
name there would read a table's own key as missing on every boot after the one
that created it, and refuse to add what the engine cannot add — an application
that starts once. A match is consumed, so two keys with identical structure pair
up one for one and a key genuinely absent from the database is still reported.

**Renaming a SQLite foreign key leaves a tombstone that never clears.** The key
itself needs no DDL — its structure is unchanged, so it still matches — but the
old NAME is no longer declared, so it is tombstoned, and SQLite has no
`DROP CONSTRAINT` to reclaim it with. It sits in `status.pendingReclamation` as
`unreclaimable` for good. Nothing is broken by it; if the entry is unwanted,
rebuild the table in a `migrations:` entry, which retires the old name with it.

**An object this engine cannot drop is never attempted.** SQLite has no
`DROP CONSTRAINT`, so a tombstoned foreign key there is reported through
`status.pendingReclamation` with an `unreclaimable` reason rather than retried:
attempting it would fail the boot, and since the tombstone stays eligible, every
boot after it. A drop that fails for a reason the engine could not declare in
advance — a dependent view, a lock timeout — is reported the same way and leaves
its tombstone standing. **A drop that cannot happen is never why an application
stops starting.**

**A dropped table takes its own columns, indexes and constraints with it**, so
only the table is tombstoned, and reclamation drops dependents before the things
they hang off (foreign key, index, column, table).

**The declaration is compared in full**, not partly. A column's type,
nullability, default, key membership and uniqueness; an index's columns and
whether it is unique; a foreign key's columns, target and referential actions.
A difference the engine cannot apply in place becomes a refusal with the reason —
never silence, which would leave the manifest asserting a constraint the database
is not enforcing.

**Elapsed time is measured by the database, not by the application.** One replica
with a skewed clock would otherwise satisfy `afterDuration` on its own, and the
drop is irreversible; the ledger already treats the database as the authority for
history, so the clock gating destruction comes from there too.

## Renaming

### A table or a type — native, and immediate

```yaml
kind: Postgres.Table
metadata: { name: messages }
table: conversation_messages
renamedFrom: messages
```

**Unlike a column, this is a native rename, and the difference is not an
oversight.** A column rename is expand-contract because both names can coexist
while the previous version of the app is still running. A table has no cheap
equivalent: copying every row is unbounded work, and writes during the overlap
would land in one table and not the other. So the rename is immediate, and the
cost is stated where you read it: **between the rename and the new deployment, an
instance still running the previous version does not find the table.**

The marker is not optional sugar. The reconciler cannot tell a rename from a
drop-and-create, and the wrong guess creates an empty table beside a tombstoned
populated one — or, for a type, alters every column that uses it, a table rewrite
each.

It is **advisory**, so it can be left in the manifest indefinitely:

| state | what happens |
| --- | --- |
| neither name present | a fresh database — the object is simply created |
| predecessor present, successor absent | the rename itself |
| successor present, predecessor gone | finished everywhere; reported as an inert rename |
| **both present** | **refused, naming both** |
| predecessor not owned by this ledger | **refused** |

Both present is refused rather than guessed at because it is either a
half-finished earlier run or an object created independently, and those want
opposite repairs. A rename **rewrites the ledger entry** from the old key to the
new one: tombstoning the old and creating the new would record a drop-and-create
even though the database did the cheap thing.

Renames run in the phase **ahead of everything else**, including `prepare:`,
because a migration key runs exactly once ever — so with renames first an entry
naming the table has one correct spelling whichever boot it lands on. The cost is
one shape: an entry whose *purpose* is to clear the destination name cannot work,
because the rename refuses first.

On SQLite an enum rename emits **no statement at all** — the `CHECK`s on
referencing tables never named the type, so the ledger key rewrite IS the rename.

### A column — expand-contract

A rename is expand-contract, never a native `RENAME COLUMN`:

```yaml
displayName: { type: varchar, length: 64, renamedFrom: name }
```

The pass adds `display_name`, copies `name` into it, and tombstones `name`. A
native rename takes effect immediately and breaks the version still running — the
one operation that would be exempt from the deferral this design exists for.
During the window writes land only in the new column, so a rollback reads stale
data.

A rename that also changes the type is two changes wearing one name, and the copy
is the unsafe half: an engine may refuse the assignment outright, or — SQLite,
which applies affinity rather than rejecting — store the source's values
unconverted under the new declared type. So it is classified like any other
unsafe change and refused by name, before any DDL runs. Reusing a column NAME at
a different type is the same story by a different route: the column is still
there holding data, so the pass treats it as an alteration of that column, never
as a drop and recreate.

Once the source has been reclaimed the `renamedFrom:` has nothing left to copy
and nothing left to hold: the rename is finished everywhere, and the mention is
dead manifest text. The pass reports it as `status.inertRenames` rather than
leaving you to work out when it is safe to delete. A source that is already gone
is never tombstoned again — re-recording a column that no longer exists would
eventually emit a `DROP` for it.

## Imperative migrations, still

Backfills, cleanups and data conversions are not declarative and never will be.
Both phases sit on the same resource, so their order relative to the
reconciliation pass is defined rather than left to the author's `targets:` list:

- `prepare:` runs **before** the pass — the rare deliberate case of
  preparing ground the pass would otherwise refuse (making values fit a column
  that is about to narrow).
- `migrations:` runs **after** it — the common case.

Keys are unique across both maps and the ledger stores the key alone, so moving
an entry between them keeps its identity and does not re-run it. An applied key
with no declaration left is reported, never an error: deleting decade-old
migrations from a manifest is normal.

## Unsafe changes stop the release

Type narrowing, `NOT NULL` over existing NULLs, a new non-nullable column with no
default — all depend on live database state, and the declaration is the only
artifact, so there is no static baseline to check against. The pass classifies
against the real database and **fails hard**, naming table, column and reason.
Nothing is applied and nothing is skipped. The remedy is a `prepare:`
entry that makes the data fit.

There is deliberately no dry-run mode. With reconciliation happening as a boot
pass, exercising one would mean editing the manifest and deploying a *different
artifact* than the one that will run — a canary deploy wearing the name of a
pre-deploy check. Observed state already reports every tombstone and its
remaining budget on every boot, under the policy the release actually declares.

## Why there is no neutral type vocabulary

`Postgres.Table` speaks PostgreSQL (`citext`, `jsonb`, arrays, identity columns,
GIN indexes); `SQLite.Table` speaks SQLite's five storage classes, which is
honestly smaller because the engine is. A shared type language would be a
lowest-common-denominator one — the ORM abstraction this design rejects, and the
one every tool that starts neutral ends up escaping with a `dialectOptions` hatch.

What crosses the boundary instead is a **JSON Schema projection** of the row,
declared as data by each backend, so a consumer can type the rows it reads
without the analyzer learning that `citext` exists. That is what lets
`SqlRepository.*` type its filters and rows from the table it references — a
misspelled column is an error at `telo check`, not at the database.

Types are structured, never spelled into a scalar: `type: varchar` with
`length: 64`, not `varchar(64)`. Nothing has to parse a type back apart, and the
parameter is an editable field rather than a substring.
