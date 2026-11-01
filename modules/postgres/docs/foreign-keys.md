# Foreign keys

`Postgres.Table.foreignKeys` is a map keyed by constraint name, which is the
key's durable identity. Each entry is the entry every `Sql.Table` takes:
`columns`, `references: { table, columns }`, and optionally `onDelete` and
`onUpdate` (`cascade`, `restrict`, `set null`, `set default`, `no action`). The
entry is described under [Foreign keys](../../sql/docs/declarative-schema.md#foreign-keys).

```yaml
kind: Postgres.Table
metadata: { name: posts }
table: posts
columns:
  id: { type: bigserial, primaryKey: true }
  author_id: { type: bigint }
foreignKeys:
  posts_author:
    columns: [author_id]
    references: { table: !ref authors, columns: [id] }
    onDelete: cascade
```

- A key is added with `ADD CONSTRAINT` in a phase after the tables, so a key may
  name a table declared below it, point at its own table (`parent_id`), or at a
  table that points back.
- A live key is matched to the declaration by its name, and compared in full:
  its columns, target and referential actions.
- Removing a key from the declaration tombstones it; it is dropped with
  `DROP CONSTRAINT` once the schema's `reclaim` window passes.
- A key naming a column the table does not declare, or listing a different number
  of columns on each side, is refused by `telo check`.
