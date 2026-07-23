# Collection

Pure, CEL-driven reshaping of a collection of records — grouping, aggregation, ordering, joining. Data-shape primitives that take a list and return a new list: no I/O, no control flow. Every kind covers an operation native CEL **cannot** express (CEL already does `map` / `filter` / `sort` on scalars).

## Why use this

- **Declarative, type-checked reshaping** — fold, dedupe, sort, batch, and join records with CEL only. No `JavaScript.Script`; the operations stay visually editable and statically analyzable.
- **Transport-neutral** — operates over any array of records, wherever it came from (an HTTP body, a SQL result, a stream drained to a list).
- **Composes with `std/run`** — where `Run.Projection` / `Run.Iteration` loop invocable step bodies (control flow), `Collection` reshapes data with CEL only. Same subject, different layer.

## Kinds

| Kind | Purpose |
| --- | --- |
| `Collection.GroupBy` | Partition by a CEL key tuple; reduce each group into a row (`sum` / `avg` / `min` / `max` / `size`), optionally ordered. |
| `Collection.Summarize` | Reduce a whole collection to one summary row — `GroupBy` with a single implicit group. |
| `Collection.Sort` | Order a collection by N CEL keys (each asc/desc), applied as tie-breakers. |
| `Collection.Distinct` | Keep the first element per distinct CEL key tuple, preserving input order. |
| `Collection.Chunk` | Split a collection into consecutive batches of at most `size`. |
| `Collection.Join` | Match two collections on a CEL key from each side (`inner` / `left`); shape rows with `select`. |

> **CEL integers are BigInt.** `size(group)` yields a BigInt (int64 precision); a plain JSON serializer downstream can't encode it. Wrap counts bound for JSON output in `double(...)` — e.g. `!cel "double(size(group))"`. `sum` / `avg` already return JSON numbers.

## Example

```yaml
kind: Collection.GroupBy
metadata: { name: Report }
collection: !cel "inputs.items"
key:
  user: !cel "item.author.name"
  project: !cel "item.issue.project.name"
aggregate:
  minutes: !cel "sum(group.map(w, w.duration.minutes))"
  hours: !cel "round(sum(group.map(w, w.duration.minutes)) / 60.0 * 100.0) / 100.0"
orderBy:
  - by: !cel "row.user"
  - by: !cel "row.project"
```

Returns `{ rows }` — one row per distinct `(user, project)`, each row the key fields merged with the aggregate fields, ordered by user then project.
