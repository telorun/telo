---
"@telorun/sql": patch
---

`Sql.Migration` now accepts an optional top-level `version:` field that the `Sql.Migrations` runner uses as the durable ledger key written to the migrations tracking table. When `version` is omitted, the runner falls back to `metadata.name` — existing manifests keep working untouched.

The split lets `metadata.name` stay a legal Telo resource handle (`^[a-zA-Z_][a-zA-Z0-9_]*$`, so no leading digits — CEL-safe) while `version` holds the timestamp-prefixed ledger key that migration tools conventionally use (`version` is what `golang-migrate`, `pressly/goose`, `diesel`, `sqlx`, `refinery`, and Rails `schema_migrations` all call this slot). Existing migrations with digit-prefixed `metadata.name` values continue to apply; move them to a `Migration_`-prefixed `metadata.name` + matching `version:` when convenient.

```yaml
kind: Sql.Migration
metadata:
  name: Migration_20260401120000_CreateUsers
version: 20260401120000_CreateUsers
sql: |
  CREATE TABLE users (...)
```
