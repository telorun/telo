# Design notes

Why the module's manifest is written the way it is.

## Declaration semantics

- **Table rename is native; column rename is expand-contract.** Both column names can coexist while the previous version of the app still runs. A table has no cheap equivalent: copying every row is unbounded work, and writes during the overlap would land in one table and not the other. So `renamedFrom` on a table renames immediately, and an instance still running the previous version does not find the table until it is replaced. The marker is advisory: neither name present is a fresh database and the table is created, so leaving it in the manifest is harmless.
- **Column keys are durable identity.** Tombstones key on the column name and a rename never uses a native `RENAME`, so column order carries no meaning and a duplicate name cannot be written.
- **`default` and `defaultExpression` are separate fields**, because nothing can tell a function call from a string by looking at it. Exactly one may be set, and `telo check` reports both.
- **Primary keys and identity columns are never NULL.** The engine enforces that whether or not the declaration says so, so `nullable: true` on one is a contradiction that would plan a `DROP NOT NULL` on every boot. Omitting `nullable` gives NOT NULL on such a column and NULL elsewhere, and the projected row types the key as non-null.
- **A storage-class `type` and an enum reference are a union.** The reference branch declares `type: object` because a branch with no keywords is an empty schema matching everything, so a valid storage class would match both branches.
- **Seeds are desired state, not history.** They are declared beside the shape they must satisfy rather than written as an insert migration, so their rows are typed against the table's own columns at `telo check` and a row deleted by hand returns on the next boot. They run after the reconciliation pass (the table must exist) and before `migrations:` (a one-time backfill may read reference data; nothing declared can depend on a migration that already ran). A `when:` turning false withdraws the declaration, so its rows tombstone. A row asserts only the columns it states: a column the seed declares is restored, one it omits belongs to the operator.
- **Checks and foreign keys exist only at create time.** SQLite has no `ADD CONSTRAINT`, so a later change on a live table is refused with the reason. The ledger records the declaration and the pass compares this boot's against it, so no expression parsing is needed. Foreign keys are table-level because composite keys are table-level in SQL regardless.
- **An enum has no database object.** The values render as a `CHECK` on each referencing column, but the declaration is a ledger object, which is what lets a change to it be detected. `typeName` is required because the ledger must key on something written down, or renaming the resource would abandon the history. `baseType` is needed because SQLite, unlike PostgreSQL, has no enum type that is its own base type. Renaming an enum emits no statement: the ledger key rewrite is the rename.
- **`prepare:` is named for what it is for** — the data preparation every refusal already tells the author to write. It was `beforeMigrations:`; the old spelling is rewritten at load and nothing re-runs, because the ledger stores the migration key alone.
- **`version` is the reclamation clock** and nothing else reads it, so it is required exactly when `reclaim:` is declared. The schema restates it from the abstract so it is a CEL slot here.

## Floor history

The module's `requires.telo` is measured. Its raises: the connection inherits an effect chain (a runtime discarding what `init()` returns would leak the pool silently); a column's `type:` unions a storage class with an enum reference, which an older analyzer reads as the removed string-reference form; the `native:` and `sources:` blocks; `Connection.file` as `Telo.HostPath`, and then its `entry: file` argument.

## Native addon

better-sqlite3 is used rather than `node:sqlite`, which Node 24 marks experimental and warns about on every run. There is no `requires.host.node` range: it would restate the addon's ABIs with nothing checking the two agree, and refuse the whole module where only the addon is missing. The controller bundles better-sqlite3's JavaScript, pinned in `nodejs/package.json` to `sources.better-sqlite3.version` so wrapper and addon are one release; `nodejs/tests/addon-release.test.ts` checks it.

## Bundled components

The addon statically contains SQLite itself. `sources.better-sqlite3.contains` records that version (3.51.3, read from the addon's `deps/`), so a scan of the module reports advisories filed against SQLite, and the commit of its `version-3.51.3` tag in `github.com/sqlite/sqlite` (`vcs:`), so `telo audit` and the hub check it by commit against OSV. Both move with the SQLite a better-sqlite3 release bundles.
