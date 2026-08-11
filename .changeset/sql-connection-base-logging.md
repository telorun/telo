---
"@telorun/sql": patch
---

`SqlConnectionBase` logs the statements it runs.

This reaches third-party backends: the class is the published extension point, so a backend that extends it now emits a `debug` record per statement (`db.query.text`, `db.response.returned_rows`, `db.client.operation.duration` in seconds) and `debug` records for transaction start, commit and rollback — without changing anything on its side.

Bound parameters are never logged; the values are the row data. The statement text is safe for a parameterized query, since it is the template, and is `debug`-only regardless.
