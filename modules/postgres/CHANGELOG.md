# Changelog

## 0.4.0 - 2026-08-26
### Added
* 'beforeMigrations:' is now 'prepare:', named for what it is FOR — data preparation for a narrowing the reconciliation pass is about to attempt — which is what every refusal already tells the author to write. The old spelling still loads: a manifest migration rewrites the key, and nothing re-runs because the ledger stores the migration key alone.
* Declared enum types: a Sql.Enum abstract with Postgres.Enum and SQLite.Enum backends, listed by the schema that owns them in 'enums:', referenced from a column's 'type:', and projected into the row contract as an enum on either engine. A column naming an enum its schema does not list fails 'telo check'.
* Named check constraints ('checks:', keyed by constraint name, raw engine SQL;
PostgreSQL adds 'validate: deferred' for NOT VALID, SQLite emits them at create
time and refuses a later change), native table and enum renames ('renamedFrom:',
applied in a phase ahead of everything else and rewriting the ledger entry),
declared seed rows ('seeds:' with a durable 'key', typed against the table's own
columns and reclaimed under the ordinary policy when removed), and PostgreSQL
'extensions:' as a reconciled object. Removing a check is immediate — a dropped
constraint loses nothing — while a removed enum value is recorded and kept,
because no engine can drop one.

Seed keys are checked at 'telo check' in both directions: a key naming a column
the table does not declare, and a row supplying no value for one. Both were
previously decidable only at boot, against a real database — the position
SQL_INDEX_UNKNOWN_COLUMN already took one field over. A structured seed value is
serialized as JSON rather than stringified, which used to write '[object Object]'
into a jsonb column silently.

Whether a reconciliation phase may share a transaction is now the driver's
answer ('transactionalPhase'), not a PostgreSQL rule written into the shared
phase list. Renaming a table now carries its checks and seed rows to the new
ledger key — two hand-written lists of "what belongs to a table" had drifted, so
a rename tombstoned them and the seed-row reclamation later failed on every
boot. A ledger record that cannot be read is refused rather than treated as
absent, which had let a changed enum declaration pass while every existing table
went on enforcing the old values.

## 0.3.0 - 2026-08-23
### Added
* Controllers return their effects from `init()` / `run()` instead of implementing `teardown()`: each allocation is written beside the inverse that undoes it, and the runtime unwinds them last-in-first-out. A failure part-way through startup now recovers what it already allocated — a bound port releases the kernel hold and unregisters the routes, a connection that fails its health check destroys its pool — and the retry starts from a freshly constructed resource. Declares `requires: telo: '>=0.82.0'`, since an older runtime discards what a controller returns and would allocate nothing.

## 0.2.1 - 2026-08-21
### Fixed
* A foreign key's 'references.table' was read while the table resource was still being created, and the kernel replaces a reference with the instance it names only when that instance already exists — so on the pass where it did not, every cross-table foreign key failed with "'references.table' does not name a table". The target is now resolved to its DECLARATION, which carries the physical name whether or not the table has been constructed, so the slot needs no ordering edge.
* Introspection read back index and foreign-key column lists as a raw string instead of an array, so every existing primary key, single-column unique and index compared as absent. A second boot then refused to start, demanding a primary key be added in a 'beforeMigrations:' entry — on the constraint the first boot had created. The column arrays are cast to text[], which node-postgres parses; pg_attribute.attname is of type name, whose array type it has no parser for.

## 0.2.0 - 2026-08-20
### Added
* A connection can subscribe to a PostgreSQL notification channel and send on one (listen / notify). The subscription gets its own connection rather than a pooled one — a listener holds its connection for as long as it is subscribed — and replays every subscription after a reconnect, since LISTEN is a property of the connection that carried it. Reported rather than raised on a drop: a lost notification is a lost optimisation, and a poller is what makes recovery certain.
* Table and Schema declare their cross-field invariants as resource rules, so an index naming a column the table does not declare, a foreign key whose two sides differ in length, a renamedFrom still declared, and a composite primaryKey are reported by `telo check` instead of at boot — several of them previously failed only after `beforeMigrations:` had already changed the database. `reclaim.afterDuration: 0ms` is now a warning rather than passing silently. The controllers keep every guard: a library caller reaching `runSchemaPass` directly never passed through `telo check`.
* Table and Schema kinds: declare the table, not the DDL. The boot pass creates what is absent, applies imperative migrations before and after it, and records a removal instead of executing it — a tombstoned object is dropped only once the declared number of released versions and the declared time have passed, so the version still running keeps reading it. A change that cannot be applied safely to existing data fails hard naming the table, column and reason. Each type vocabulary is the engine's own, and projects to JSON Schema so consumers can type the rows they read.
### Fixed
* Schema safety hardening. Every ledger row is now scoped to the schema resource that wrote it, so a namespace reached by two schema resources keeps two independent sets of objects, clocks and migration histories — previously the second boot recorded its own declaration as the whole truth and would tombstone, then drop, the other owner's tables. A primary key or identity column is non-nullable whether or not the declaration says so, which stops every boot after the first planning a DROP NOT NULL on a key. A tombstoned object the engine cannot drop is reported with a reason instead of attempted, since attempting it would fail that boot and every boot after it. A rename that changes the column's type is refused with the reason rather than reaching the engine as a raw assignment error or, on SQLite, silently storing unconverted values. Declarations that cannot mean anything are refused at resource creation, naming the field.
* The six table-structure rules — an index or foreign key naming an undeclared column, foreign-key arity, renamedFrom naming itself or a column still declared, and a composite primary key — are declared once on Sql.Table instead of per backend. They check relationships the shared reconciler already enforces at boot for every backend, so declaring them per backend meant each new engine shipped without them: the identical table was two telo check errors on Postgres and clean on SQLite. The abstract now carries the structural half of the declaration (the fields the reconciler reads) so the rules' pointers resolve there; each engine still owns its whole type vocabulary.

## 0.1.0
### Added
* Initial release. Replaces `sql-postgres`, which is deprecated: the `sql-` prefix restated the abstract this module implements, which `extends` already records, and it stops being true now the module owns PostgreSQL-specific surface that is not a `sql` kind. The `Connection` kind and its schema are unchanged — consumers change one `imports:` entry and keep their alias and every `kind:` spelling.
