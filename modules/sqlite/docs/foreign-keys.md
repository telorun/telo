# Foreign keys

`SQLite.Table.foreignKeys` is a map keyed by constraint name. Each entry is the
entry every `Sql.Table` takes: `columns`, `references: { table, columns }`, and
optionally `onDelete` and `onUpdate` (`cascade`, `restrict`, `set null`,
`set default`, `no action`), described under
[Foreign keys](../../sql/docs/declarative-schema.md#foreign-keys).

```yaml
kind: SQLite.Table
metadata: { name: posts }
table: posts
columns:
  id: { type: integer, primaryKey: true }
  author_id: { type: integer }
foreignKeys:
  posts_author:
    columns: [author_id]
    references: { table: !ref authors, columns: [id] }
    onDelete: cascade
```

- **Enforced.** The connection switches `foreign_keys` on and reads it back, so a
  write naming a missing parent row is refused and deleting a parent runs the
  key's `onDelete` action. See the [README](../README.md#declarative-schema).
- **Only at creation.** SQLite has no `ADD CONSTRAINT`: a key is emitted as part of
  `CREATE TABLE`, and changing one on an existing table is refused with the
  reason. Declare a key when its table is first declared.
- **Matched by structure.** SQLite reports a key back unnamed, so a declaration is
  matched to the live key by its columns, target and actions rather than its
  name. Renaming a key therefore needs no DDL and leaves a tombstone nothing can
  drop.
- A key may point at its own table or at a table that points back.
