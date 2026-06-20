# @telorun/sql

## 0.8.0

### Minor Changes

- 03b8579: Split the `sql` module into a driver-agnostic core plus per-driver backend modules, mirroring `cache` / `cache-memory` / `cache-redis`.

  - `sql` core keeps the `Sql.Connection` abstract and the `Query` / `Command` / `Selection` / `Transaction` / `Migrations` operations, and now depends on `kysely` only. The connection contract is exported (`@telorun/sql` barrel + `@telorun/sql/connection`: `SqlConnectionResource`, `createSqlConnection`, `resolveSqlConnection`, `SqliteDb`) so backends and downstream modules can build/reuse connections.
  - `sql-postgres` (`SqlPostgres.Connection`, owns `pg`) and `sql-sqlite` (`SqlSqlite.Connection`, owns `better-sqlite3` / `bun:sqlite`) provide the concrete connections, each `extends Sql.Connection`.
  - Operations renamed for declarative nouns: `Sql.Exec` → `Sql.Command`, `Sql.Select` → `Sql.Selection`.

  Migration: replace `Sql.PostgresConnection` / `Sql.SqliteConnection` with `SqlPostgres.Connection` / `SqlSqlite.Connection` (add the backend module import), and `Sql.Exec` / `Sql.Select` with `Sql.Command` / `Sql.Selection`. The `sql` bump is kept minor: the module is pre-1.0 and the change is recorded as `Added` rather than forcing a 1.0.0 major.

## 0.7.2

### Patch Changes

- b1dd65c: Fix `Sql.SqliteConnection` failing to load under the controller bundler with
  `ERR_UNSUPPORTED_ESM_URL_SCHEME` (`Received protocol 'bun:'`). The driver was
  selected with a `typeof Bun` guard plus relative `import("./sqlite-driver-bun.js")`
  / `import("./sqlite-driver-node.js")` calls; bundling inlined both drivers and
  hoisted `bun:sqlite` into an unconditional top-level static import that Node's
  ESM loader rejects before the guard runs. The connection now imports the
  package's own `@telorun/sql/sqlite-driver` subpath export, which the bundler
  externalizes and the resolver maps per runtime (Bun → `bun:sqlite`, Node →
  `better-sqlite3`).

## 0.7.1

### Patch Changes

- c89e79b: fix(kernel,sql): resolve cross-module/runnable boot & step targets that passed `telo check` but failed at runtime

  Three "green check, red run" defects in cross-module dispatch:

  - A boot `target` that is a `!ref` to a `Run.Sequence` threw `Resource not found
for invocation: undefined.invoke`. The boot runner matched the inline-invoke
    branch on any target exposing `invoke()` before the runnable branch — but a
    live `Run.Sequence` instance exposes both `run()` and `invoke()`. Guard the
    inline-invoke branch with `!isRunnableInstance(target)` so a live instance runs
    via `run()`.
  - A `Run.Sequence` step `invoke: !ref X` (or boot inline-invoke) targeting a pure
    `Telo.Runnable` threw `does not have an invoke method`, even though the step
    schema explicitly accepts `telo#Runnable`. `invoke`/`invokeResolved` now fall
    back to `run()` when the resolved instance has no `invoke()` (side effects only,
    no result), honoring the declared contract.
  - `Sql` connection refs (`connection: !ref Domain.Db`) reached through a nested
    import boundary failed with `Resource 'Db' not found in module context`. The
    resolver ignored the `alias` on a cross-module ref and did a bare local lookup;
    it now routes alias-qualified refs through `resolveImportedInstance` (mirroring
    the http-client client ref).

## 0.7.0

### Minor Changes

- 64debb5: `Sql.Connection` is now an abstract implemented by two concrete kinds: `Sql.PostgresConnection` (`connectionString` + `pool`) and `Sql.SqliteConnection` (`file`). Consumers keep referencing `std/sql#Connection`; a concrete connection satisfies the ref. Each connection knows its driver's native bind-placeholder style. The generic scheme-based `Sql.Connection` kind is removed — migrate `connectionString: sqlite:…` / `postgres:…` declarations to the matching concrete kind (SQLite uses `file:`).

  `Sql.Query` / `Sql.Exec` now support inline parameterized SQL via the `!sql` tag: `sql: !sql "… WHERE id = ${{ x }}"` binds each interpolation as a parameter (dialect-neutral, injection-safe), never splicing it into the text. The `bindings` array remains as an escape hatch for hand-written `?` / `$n` placeholders; combining a `!sql` template with `bindings` is rejected.

## 0.6.0

### Minor Changes

- ea57e10: `Sql.Migrations` can now own its migrations directly as a keyed `migrations` map — each key is the durable ledger id (and run order / identity). Each value is either a single `statement` or an ordered list of `statements`. This replaces the need for separate `Sql.Migration` provider resources discovered by an implicit module-scope scan.

  All pending migrations run in a **single transaction** (PostgreSQL natively via Kysely; SQLite via a transactional-DDL adapter override), so a multi-statement schema change applies atomically or rolls back as a whole.

  Backwards compatible: standalone `Sql.Migration` resources are still discovered and merged into the migration set (the map takes precedence on key collisions); `Sql.Migration` is now deprecated in favour of the inline map.

## 0.5.1

### Patch Changes

- adc248b: Loosen the `@telorun/sdk` peer dependency range from an exact pin to `*`.

  The sdk is a host-provided peer (the kernel supplies the single shared instance, so `Stream` and other sdk class identities stay intact for CEL's runtime type-checker). Pinning it via `workspace:*` published as an exact version, which made every sdk release fall out of range and forced a spurious major bump of all peer-dependents. Declaring the peer range as `*` (with a `workspace:*` devDependency to preserve local linking) keeps the single-instance guarantee while preventing the false major-bump cascade.

## 0.5.0

### Patch Changes

- Updated dependencies [ae0bf77]
  - @telorun/sdk@0.13.0

## 0.4.0

### Minor Changes

- abc82c8: **BREAKING:** `Sql.Connection` now derives the database driver from the `connectionString` URL scheme. The `driver` and `file` fields (and the discrete PostgreSQL fields `host`, `port`, `database`, `user`, `password`, `ssl`) have been removed; `connectionString` is now the single required field and its scheme is mandatory.

  - PostgreSQL: `postgres://` or `postgresql://`. TLS is configured via the standard libpq `?sslmode=` query parameter (`disable`, `require`, `verify-ca`, `verify-full`) instead of the `ssl` boolean — `?sslmode=require` reproduces the old `ssl: true` relaxed-CA behaviour.
  - SQLite: `sqlite:` (`sqlite::memory:`, `sqlite:./data.db`, `sqlite:///abs/path.db`) instead of `driver: sqlite` + `file:`.

  Migration: replace `driver: sqlite` + `file: ./x.db` with `connectionString: sqlite:./x.db` (and `file: ":memory:"` with `connectionString: "sqlite::memory:"`); drop `driver: postgres` and move any `ssl: true` into the URL as `?sslmode=require`.

## 0.3.1

### Patch Changes

- 4c1a50b: Refresh in-tree documentation version pins to the current registry latest.

## 0.3.0

### Patch Changes

- be79957: Move `@telorun/sdk` to `peerDependencies` across the kernel, analyzer, templating, and every module.

  The SDK carries the `Stream` class registered with `@marcbachmann/cel-js` for stream-typed CEL values. cel-js identifies object types by constructor identity, so a second copy of `@telorun/sdk` in the install tree silently breaks streaming-typed evaluations with `Unsupported type: Stream`. The contract was previously enforced with three layered mechanisms (a generated `dist/generated/runtime-deps.json` driving install-root `dependencies`, `overrides` + `pnpm.overrides` blocks, and a `globalThis`-keyed singleton in `stream.ts`); the build artifact silently degraded when the kernel was run without a build step, defeating the layering.

  The new shape:

  - Every package that imports `@telorun/sdk` declares it as a `peerDependency`. Consumers (the kernel's install root, the CLI, apps) provide a single copy and `peerDependencies` cause npm/pnpm to resolve every transitive import to it.
  - The kernel's `NpmControllerLoader` no longer reads `runtime-deps.json`; the realm-collapse name list is a hardcoded constant (`REALM_COLLAPSE_NAMES = ["@telorun/sdk"]`) in `npm-loader.ts`. The install-root `package.json` it writes drops the `overrides` and `pnpm.overrides` blocks — peer-dep resolution makes them redundant.
  - `scripts/generate-runtime-deps.mjs` and the generated artifact are removed; `scripts/prepack-bake-overrides.mjs` no longer chains the runtime-deps regeneration.
  - The `globalThis` singleton in `sdk/nodejs/src/stream.ts` is **kept** as a safety net for environments that still end up with mismatched SDK copies (e.g. a controller install from a tarball that predates this change).

  Consumers installing `@telorun/kernel` or any module directly must now ensure `@telorun/sdk` is present in their dependency tree. The kernel already lists it via the install root for any manifest it boots, so kernel-driven usage is unaffected.

- Updated dependencies [849f57a]
- Updated dependencies [be79957]
  - @telorun/sdk@0.12.0

## 0.2.3

### Patch Changes

- Updated dependencies [58362c4]
  - @telorun/sdk@0.11.1

## 0.2.2

### Patch Changes

- Updated dependencies [f1c35bc]
- Updated dependencies [47f7d83]
  - @telorun/sdk@0.10.0

## 0.2.1

### Patch Changes

- d3ed5a5: Annotate multi-line authoring fields with `x-telo-widget: code` so the telo editor renders a Monaco editor instead of a single-line text input. `Ai.Text.system` and `Ai.TextStream.system` get `text/markdown`; `Sql.Query.inputs.sql`, `Sql.Exec.inputs.sql`, and `Sql.Migration.sql` get `application/sql`; `Starlark.Script.code` gets the widget without a `contentMediaType` (Monaco has no Starlark language, so it falls back to plaintext rather than mis-highlighting as Python).

## 0.2.0

### Minor Changes

- f74bfa2: `Sql.Connection` with `driver: sqlite` now auto-creates the parent directory of the `file:` path on init (mirroring `mkdir -p`). Manifests can use paths like `./tmp/chat-history.sqlite` without a separate filesystem-prep step. Skipped for `:memory:` and `file::memory:?…` URIs (no filesystem touch needed) and when the parent resolves to `.` or `/` (already exists).

## 0.1.9

### Patch Changes

- Updated dependencies [b62e535]
  - @telorun/sdk@0.7.0

## 0.1.8

### Patch Changes

- Updated dependencies [dccd3a6]
- Updated dependencies [2e0ad31]
  - @telorun/sdk@0.6.0

## 0.1.7

### Patch Changes

- Updated dependencies [f76dd0f]
- Updated dependencies [fc4a562]
  - @telorun/sdk@0.5.0

## 0.1.6

### Patch Changes

- f061c35: `Sql.Migration` now accepts an optional top-level `version:` field that the `Sql.Migrations` runner uses as the durable ledger key written to the migrations tracking table. When `version` is omitted, the runner falls back to `metadata.name` — existing manifests keep working untouched.

  The split lets `metadata.name` stay a legal Telo resource handle (`^[a-zA-Z_][a-zA-Z0-9_]*$`, so no leading digits — CEL-safe) while `version` holds the timestamp-prefixed ledger key that migration tools conventionally use (`version` is what `golang-migrate`, `pressly/goose`, `diesel`, `sqlx`, `refinery`, and Rails `schema_migrations` all call this slot). Existing migrations with digit-prefixed `metadata.name` values continue to apply; move them to a `Migration_`-prefixed `metadata.name` + matching `version:` when convenient.

  ```yaml
  kind: Sql.Migration
  metadata:
    name: Migration_20260401120000_CreateUsers
  version: 20260401120000_CreateUsers
  sql: |
    CREATE TABLE users (...)
  ```

## 0.1.5

### Patch Changes

- Updated dependencies [3c4ac58]
  - @telorun/sdk@0.3.2

## 0.1.4

### Patch Changes

- Updated dependencies [353d7e5]
  - @telorun/sdk@0.3.0

## 0.1.3

### Patch Changes

- Updated dependencies
  - @telorun/sdk@0.2.8

## 0.1.2

### Patch Changes

- Updated dependencies
  - @telorun/sdk@0.2.7

## 0.1.1

### Patch Changes

- Automated release.
- Updated dependencies
  - @telorun/sdk@0.2.6
