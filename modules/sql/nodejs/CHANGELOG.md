# @telorun/sql

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
