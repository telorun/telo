# Declarative SQL schema with deferred reclamation

## Problem

Schema today is imperative: `Sql.Migrations` holds hand-written DDL keyed by a
durable id. The author states *how* the schema got here, never *what it is*, so
nothing can type-check a column, render a table in the editor, or tell whether
two apps agree about a table. Every declarative schema tool that solves this
(Atlas, Prisma `db push`, sqldef, Skeema) hits the same wall: a column absent
from the declaration is indistinguishable from one the author forgot, so the tool
either drops data or refuses forever and hands the problem back.

The way out is to separate *recording* a removal from *executing* it — the
tombstone-plus-grace-period shape of Cassandra's `gc_grace_seconds` and
protobuf's `reserved`, applied to schema reclamation, which no SQL tool does. The
clock is the app's own `metadata.version`.

This plan assumes the settled direction that `sql` becomes a contract-only
module: `Query` / `Command` / `Selection` / `Transaction` move to the backends
and `kysely` leaves core. Schema is planned here; that move is its own change.
The backends they move into are the new `postgres` and `sqlite` modules, not
today's `sql-postgres` / `sql-sqlite`, which are deprecated in place.

## Solution

**`sql` holds three abstracts and one library, nothing executable.**
`Sql.Connection` (existing), `Sql.Table` and `Sql.Schema`, plus the ledger
library shipped through the existing `exports.code:` entry — the `KeyedClaim`
arrangement in `@telorun/kv-store`. Backends implement everything else in full
isolation. Shared *library*, not shared *kind*: a backend never asks permission
to render a statement, only whether a tombstone has aged out. Throughout this
plan a `Sql.*` name is an abstract in `sql` and is never instantiated; every
instantiable kind is a backend kind (`Postgres.*`, `SQLite.*`), which is what
the example writes.

**Tables are backend kinds.** `Postgres.Table` declares a table in the full
Postgres vocabulary (`varchar` with a `length`, `jsonb`, `uuid`, `citext`,
arrays, enums, partial and GIN indexes, identity columns); `SQLite.Table` in
SQLite's, which is honestly smaller because the engine is. Types are
**structured, never spelled into a scalar** — `type: varchar` with `length: 64`,
not `varchar(64)` — so nothing has to parse a type back apart, and the parameter
is an editable field rather than a substring. There is deliberately no neutral type
vocabulary — a shared one is a lowest-common-denominator one, which is the ORM
abstraction this design rejects, and every ORM that starts neutral ends with a
`dialectOptions` escape hatch admitting it failed. Concrete types also sharpen
the analysis: a `length: 255` → `length: 64` narrowing is nameable where a
generic `text` says nothing.

**The `Sql.Table` abstract contracts a JSON Schema projection**, not native
types, and the projection is **declared as data by each backend** — the analyzer
performs a lookup and never learns that `citext` exists, per the topology rule.
Three annotations carry it: `x-telo-schema-map` on the field a projection keys
on, giving the schema node each value means; `x-telo-schema-projection` on the
kind, naming the entries collection (`entries`), the keying field (`type`), an
optional `name` for array-shaped entries, and the `nullable` / `array`
modifiers; and `x-telo-schema-projection-from` on a CONSUMER's slot, naming the
ref whose target declares the projection. The third is what makes the projection
reach anything: the first two say what a declaration means, and nothing else
says where that meaning is wanted.
`Postgres.Table` says `citext → string` and `bigint → integer`; `SQLite.Table`
declares its own storage classes; nothing in the analyzer changes between them.
A consumer needing Postgres specifically pins the concrete kind.

**Typing `SqlRepository.*` from a table lands in this change**, not as a
follow-up: its `table:` becomes an `x-telo-ref` (`use: schema`) at the table
kind, the ref resolves in the declaring scope, the projection runs, and its
result reaches that kind's CEL environment so a row field is type-checked at
`telo check`. It is required rather than optional because the projection is only
justified by a CEL environment that reads it — shipping the annotations with no
consumer would fix the shape of a new declaration-derived typing family before
its one use case had exercised it, and would put a `requires:` floor on both
backends for a mechanism that does nothing.

**The backend schema kind is the single schema-change kind**, absorbing
`Sql.Migrations` entirely. It *is* one namespace — `schema:` names it,
defaulting to `public` — and carries `connection`, `tables`, `version`,
`beforeMigrations`, `migrations` and `reclaim`. Of those, the `Sql.Schema`
abstract contracts only `version:`, `reclaim:` and the `status:` shape, which
is the whole backend-neutral surface; everything else is the backend's. One boot pass: take the dialect-native advisory lock, run pending
`beforeMigrations` in key order, reconcile every table in one pass, run pending
`migrations` in key order, reclaim what has aged out, record the version. Imperative and declarative schema
change need the same lock, the same bookkeeping and a defined order between
them; as separate kinds that order would live in the author's `targets:` list,
invisible and uncheckable.

Two phases rather than an ordered list of mixed items, because **reconciliation
is one global pass** — the manifest holds only current declared state, so there
is exactly one meaningful reconciliation target and thus exactly two positions
anything can occupy relative to it. The fields are asymmetric because the usage
is: `migrations:` runs after the pass and covers backfills and cleanups;
`beforeMigrations:` is the rare deliberate case of preparing ground the pass
would otherwise refuse. An imperative-only app writes `migrations:` alone and
looks exactly like `Sql.Migrations` does today.

**The runner is hand-written, per backend.** Kysely's `Migrator` cannot express
phases — it assumes one totally ordered set and treats applied keys absent from
its provider as corrupted history — and it participates in none of the advisory
locking, ledger integration or per-engine transactional-DDL rules this design
needs. The runner is small: create the table if absent, read applied keys, run
each pending key in a transaction, record it.

**The ledger** lives in the target schema — one manifest deploys to many
databases, each with its own history, so the database is the authority (the
inverse of `.changes/ledger.yaml`, a cache with the registry as authority).
Three tables: applied migrations, the observed `(metadata.version, declaration
digest)` sequence, and one tombstone per absent schema object carrying its
last-known definition and the version it went missing at. Because the *sequence*
is recorded rather than a counter, a rollback is visible — going backwards proves
older code is live and resets the counters it would have advanced. Eligibility
is a conjunction of N versions and T elapsed time; version is the primary
signal, time the backstop, since N versions can land in an afternoon.

**Reclamation is the last phase of the boot pass**, gated by the declared
policy: before-migrations, reconcile, migrations, reclaim. Declaring no
`reclaim:` block means nothing is ever dropped, so it is opt-in by declaration
rather than by invocation. What the pass tombstoned and what is now eligible is reported as
structured logging and observed state (`status:`) on the schema resource, so
there is nothing to invoke to see it. A `telo sql …` CLI verb was rejected —
the CLI's verbs are module-agnostic, so a `sql` namespace breaks the topology
rule, needs reimplementing in the Rust CLI, and hands one standard-library
module a privilege no third-party backend could obtain — and dedicated
reclamation kinds were rejected with it.

## Decisions

- **`Sql.Schema` absorbs `Sql.Migrations`; both it and `Sql.Migration` are
  removed.** They share the lock, the bookkeeping and a mandatory ordering; two
  kinds put that ordering in the author's `targets:` list where nothing checks
  it. Clean break, pre-1.0, recorded as `Added` per the driver-split precedent.
- **A `Sql.Schema` resource is exactly one namespace, and tables declare none.**
  A table belongs to whichever schema lists it, so there is no per-table
  override and no precedence question. Tables in two namespaces means two schema
  resources; schema-per-tenant falls out as one per tenant, each with its own
  migration history and reclaim clock, which is what tenants migrating
  independently requires. Rejected: naming the kind `Database`, which inverts
  containment — a database holds many schemas.
- **The kind is `Table`, not `Model`.** `Ai.Model` already exists, "model"
  invites reading it as a domain model (which the future aggregate layer will
  want the word for), and it declares exactly one physical table. Views, if they
  come, become their own kind rather than a discriminator.
- **Namespaces are created if absent and every statement is schema-qualified.**
  Creation is purely additive; relying on `search_path` would let a role or
  session default decide where DDL lands, with no error when it lands wrong.
- **Two migration fields, not one ordered list of mixed items.** A unified list
  can express table → migration → table orderings the engine cannot honour,
  since reconciliation is one pass and no historical declared state exists.
  Rejected after building both.
- **Asymmetric field names.** `migrations:` (after) is the common case and reads
  naturally alone; `beforeMigrations:` carries the qualifier because it is the
  exception. A single map with a `phase:` attribute was rejected — `after` would
  need a default, making `before` a word you can forget on exactly the migrations
  where forgetting breaks the release.
- **Phase is not part of identity.** Keys are unique across both maps, the
  applied-migrations table stores the key alone, so moving a migration between
  fields keeps its identity and does not re-run it. A key in both is an analyzer
  error.
- **An applied key with no declaration is ignored and reported, never an error.**
  Deleting decade-old migrations from a manifest is normal; kysely's corrupted-
  history error is wrong here.
- **`Sql.Schema` contracts the backend-neutral half only: `version:`,
  `reclaim:` and the `status:` shape.** Tables, migrations, the statement
  vocabulary and the runner are backend-owned, and a consumer needing Postgres
  pins the concrete kind — so contracting the full six-field vocabulary would be
  duplication wearing a contract's clothes, two backends re-declaring identical
  fields with no polymorphic use. What a `!ref` to an `Sql.Schema` slot buys is
  precisely the grace-window surface: the clock the drop is gated on, the policy
  gating it, and the observed state reporting what is pending — so reclamation
  observability and any tooling built on it are backend-neutral, while nothing
  neutral is claimed about DDL. Rejected: making it concrete with `extends`/
  `base:` per backend, which would declare the six fields once at the cost of
  putting a shared runner behind them, the ORM layer the dialect split removed.
- **Tables and reconcilers are backend kinds; `sql` holds abstracts only.** A
  neutral column-type vocabulary reintroduces the ORM layer the dialect split
  removed. Rejected: a generic kind with a `dialectOptions` escape hatch.
- **The cross-backend contract is a JSON Schema projection, not a type enum.**
  That language already exists as JSON Schema plus `x-telo-type`.
- **The projection is a declared lookup, never a computed expression.** The
  analyzer type-checks CEL and substitutes placeholders; it never evaluates, and
  a `base:`-style mapping is evaluated by the kernel at `create()` — too late for
  `telo check` to type a repository's rows, which is the projection's whole
  purpose. Rejected for that reason.
- **The projection is not `x-telo-schema-from` and cannot be expressed over it.**
  That mechanism derives a field's schema from the referenced *kind's definition
  schema*; a table's row shape lives in the *instance's* own `columns:`, which no
  definition-level derivation can reach. Two adjacent families is a real cost, so
  the distinction is stated rather than left to a reader: definition-derived
  versus declaration-derived.
- **The annotations are generic over typed-field declarations, not over kinds.**
  Any kind carrying a collection of typed entries can use them; nothing in either
  says SQL, column or table. Rejected: naming it a kind-to-kind `x-telo-mapping`,
  which promises arbitrary translation where the mechanism is a table lookup.
  They sit in the `x-telo-schema-*` family, the `x-telo-context-*` precedent.
- **Entries may be a keyed map or an array; columns use the map.** The `key`
  pointer names the identifying field when entries are an array, so ordered
  collections are expressible. Columns stay a map because names must be unique
  (structurally unrepresentable duplicates), because column order cannot be
  changed without rewriting the table so an array would imply a control the
  reconciler does not have, and because a column name is durable identity that
  tombstones key on — matching `indexes:`, `foreignKeys:` and `migrations:`.
- **Modifiers are a closed set applied in a fixed order:** `array` wraps, then
  `nullable` widens. Closed because each changes how the analyzer assembles a
  schema, so a third-party modifier would be a name nothing acts on; ordered
  because leaving it implicit is how two implementations come to disagree.
- **The projection is deliberately lossy.** `length`, precision, collation and
  check constraints do not reach it, and multi-dimensional arrays project as one
  level. CEL needs the type, nullability and repetition; the database enforces
  the rest. The alternative is a per-column schema rich enough to double as a
  validator, which would move SQL semantics into the type layer.
- **The backends are new modules: `postgres` and `sqlite`; `sql-postgres` and
  `sql-sqlite` are deprecated, not extended.** The prefix restated the abstract
  a backend implements, which is already structured metadata (`extends`), and it
  stops being true the moment a backend carries more than SQL — a Postgres module
  owns `LISTEN`/`NOTIFY`, advisory locks and its own schema vocabulary, none of
  which is a `sql` kind. The new modules take `metadata.name: Postgres` / `SQLite`
  so kinds read `Postgres.Table`, `SQLite.Table`. This is also the change that
  carries the settled `sql` contract-only split — `Query` / `Command` /
  `Selection` / `Transaction` land in the new modules rather than being moved
  inside the old ones and renamed again later. The old modules get
  `metadata.deprecated: { reason, replacedBy }` pointing at the new refs and are
  not republished with schema support; consumers move by changing one `imports:`
  entry and an alias.
- **No `requires:` floor is declared for the projection annotations.** The
  expectation was that they widen the manifest surface and so need one, but
  verification refuted it: the previous published CLI accepts all three modules
  unchanged, because a `KindSchema` body is open and an unrecognized `x-telo-*`
  key on a definition doc is tolerated. An older analyzer therefore IGNORES the
  projection rather than rejecting it — graceful degradation, exactly what an
  open body is for. Declaring a bound anyway would be a claim nothing checks,
  which is the failure class the mechanism exists to remove.
- **Reclamation runs automatically, gated by the declared policy.** The design's
  premise is that eligibility is computable; requiring a human to confirm it says
  we do not trust our own gate, and the remedy is a longer window, not an
  operator. A manual step also means it never runs, leaving dead columns forever
  — the failure mode of every tool that refuses removal, which is what this
  exists to fix. The control is declaring the policy at all; absent means never,
  and with no policy the ledger still records tombstones and reports what would
  be eligible through observed state — so a schema can run indefinitely with
  reclamation declared nowhere and still show what it would reclaim.
- **Removal tombstones, never drops.** Rejected: refusing removal forever (every
  existing tool), which never reclaims anything.
- **The clock is a `version:` field the author writes**, conventionally
  `!cel "module.version"`, required exactly when `reclaim:` is declared —
  nothing else reads it, so a migrations-only app declares neither and looks
  exactly like the imperative kind it replaces. Rejected: deriving it from a
  build id or a manifest digest. Both distort what `afterVersions` counts — a
  digest misses the ordinary release that changes only application code, so the
  budget stalls; a per-build id advances on rebuilds that shipped nothing, so it
  drops EARLIER than asked — and both replace a release version with an opaque
  id in the observed state an operator reads. A controller cannot read the root Application's
  version, and `module.*` is scoped to the *declaring* module — so a schema
  resource inside a library would silently clock on the library's version. Since
  this value gates an irreversible drop, whose version it is must be visible in
  the manifest and the author's decision, not a consequence of where the resource
  sits. Rejected: exposing the root version in the root scope, a broader kernel
  surface change than this design needs.
- **Version is the sole deploy signal; nothing is injected.** A boot at an
  unchanged version with a changed declaration updates the digest in place and
  advances nothing, so forgetting to bump costs grace progress rather than
  causing harm, and local iteration accrues zero budget.
- **Rename is expand-contract, not native `RENAME COLUMN`.** A native rename
  takes effect immediately and breaks still-running older versions — the one
  operation that would be exempt from the deferral the design exists for.
  Instead: add, copy, tombstone. `renamedFrom` goes inert when that tombstone is
  reclaimed and is then reported as deletable. Documented caveat: during the
  window writes land only in the new column, so a rollback reads stale data.
- **Classification happens at reconcile time, not at `telo check`.** Type
  narrowing, `NOT NULL` over existing NULLs, a new non-nullable column with no
  default, `UNIQUE` over duplicates and primary-key changes all depend on live
  database state, and the declaration is the only artifact so there is no static
  baseline. The analyzer validates the table document; the live classification
  happens where the database is, and it is deliberately the running pass that
  performs it. Unsafe changes fail hard, naming table, column and reason — never
  applied, never skipped, so the release stops rather than proceeding on a guess.
- **There is no dry-run mode.** A `reclaim.dryRun` flag was rejected: with
  reconciliation happening as a boot pass, exercising it means editing the
  manifest and deploying a *different artifact* than the one that will run, so it
  is a canary deploy wearing the name of a pre-deploy check — the least honest
  shape available. What it was meant to provide is already carried by observed
  state, which reports every tombstone and its remaining budget on every boot,
  under the policy the release actually declares.
- **A literal default and a SQL default expression are separate fields.**
  `default:` is a typed literal, `defaultExpression:` is raw backend SQL, and
  declaring both is an analyzer error. Nothing can tell `gen_random_uuid` the
  function from the string by looking at it, and every tool in this space splits
  them the same way (Atlas `sql()`, Prisma `dbgenerated()`, Django `db_default`).
  The split also makes the literal checkable against the column's own type
  through the JSON Schema projection, which is impossible while defaults are
  opaque SQL strings. Rejected: the `!sql` tag, whose contract is that
  interpolations are *bound* — a DDL default can bind nothing, so reusing it
  would carve out an exception in exactly the guarantee that makes it safe.
- **Foreign keys are a table-level named map, never a column-level clause.**
  Composite keys are table-level in SQL regardless, so a column-level form would
  be a second spelling of a subset — two shapes to normalize before diffing. A
  named map also gives each constraint the durable identity reconciliation needs
  to diff and tombstone it, matching `indexes:`.
- **Reconciliation defers cross-table constraints**, so declaration order is
  never load-bearing and foreign-key ordering is never the author's problem.
- **The mechanism is generic over schema objects** — indexes, tables, namespaces
  and enum values tombstone identically.
- **Ownership is RECORDED, not inferred from presence.** The version row carries
  the whole declaration, not only its digest, so "which objects does this
  resource own" is answerable from the ledger. An object in the namespace that
  has never appeared in a snapshot — a legacy table, another application's, one
  predating adoption — is invisible to both the diff and to reclamation.
  Inferring ownership from presence would make adopting an existing database a
  data-loss event, which is the one outcome the deferral exists to prevent.
  Recording the declaration rather than a fourth table also supplies a
  tombstone's last-known definition for free.
- **A `Table` is a backend kind with no `schema:` field of its own; the namespace
  belongs to the schema resource.** SQLite has exactly one namespace, so
  `SQLite.Schema` has no `schema:` field at all — the abstract contracts only the
  backend-neutral half, so a backend omitting a field the other one needs is
  expressible rather than a special case.

**Known limitation, documented:** when versions are skipped, a `beforeMigrations`
entry from a later release runs before the pass while a `migrations` entry from
an earlier one runs after it. `beforeMigrations` must therefore be self-contained
ground preparation. Reconciling to a historical declared state is impossible by
design, since only current state is declared.

## Example after the change

```yaml
kind: Postgres.Table
metadata: { name: users }
table: users
columns:
  id:          { type: uuid, primaryKey: true, defaultExpression: "gen_random_uuid()" }
  email:       { type: citext, nullable: false, unique: true }
  displayName: { type: varchar, length: 64, nullable: false, renamedFrom: name }
  plan:        { type: text, nullable: false, default: free }
  tags:        { type: text, array: true, nullable: false }
  createdAt:   { type: timestamptz, nullable: false, defaultExpression: "now()" }
---
kind: Postgres.Table
metadata: { name: orders }
table: orders
columns:
  id:         { type: bigint, primaryKey: true, identity: always }
  userId:     { type: uuid, nullable: false }
  totalCents: { type: bigint, nullable: false }
  placedAt:   { type: timestamptz, nullable: false, defaultExpression: "now()" }
indexes:
  ordersUserPlaced: { columns: [userId, placedAt] }
foreignKeys:
  ordersUser:
    columns: [userId]
    references: { table: !ref users, columns: [id] }
    onDelete: cascade
---
kind: Postgres.Schema
metadata: { name: appSchema }
connection: !ref Db
schema: app
version: !cel "module.version"
tables: [!ref users, !ref orders]
beforeMigrations:
  20260204_truncate_long_names:
    statement: "UPDATE app.users SET display_name = left(display_name, 64) WHERE length(display_name) > 64"
migrations:
  20260318_move_totals_from_invoices:
    statements:
      - "UPDATE app.orders o SET total_cents = i.total_cents FROM app.invoices i WHERE i.order_id = o.id"
      - "DROP TABLE app.invoices"
reclaim: { afterVersions: 3, afterDuration: 30d }
```

On a fresh database: the namespace is created, the before-migration runs (a
no-op), one pass creates both tables and then their constraints and indexes, the
after-migration runs, and the version is recorded. On a release narrowing
`displayName`, the before-migration makes the data fit so the pass finds the
change safe. The rename needs no migration — the pass adds `display_name`,
copies `name` into it and tombstones `name`. Deleting a column from the table
emits no DDL at all. Three released versions and thirty days later the pass
drops what has aged out; until then the resource's observed state reports each
tombstone with its remaining budget.
