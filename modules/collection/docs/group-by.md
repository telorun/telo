# `Collection.GroupBy`

Partitions a collection by a CEL key tuple and reduces each group into an output row. It exists to cover the one aggregation that pure CEL cannot express — folding N records into M groups. The per-group reductions stay CEL, so the whole rollup is declarative, type-checked, and visually editable.

`capability: Telo.Invocable` — invoke it from a `Run.Sequence` step or a boot target; it returns `{ rows }`.

## Fields

| Field | Required | Meaning |
| --- | --- | --- |
| `collection` | yes | CEL (or literal) resolving to the array of records to group. Sees `inputs`. |
| `key` | yes | CEL map (field → expression) evaluated per element. The tuple of values identifies the group; the fields pass through into every output row. Sees `item`, `index`, `items`, `inputs`. |
| `aggregate` | no | CEL map evaluated once per group and merged into the row. Sees `key` (the group's key object) and `group` (its elements). |
| `orderBy` | no | Ordering of the output rows; each entry `{ by, descending? }` sorts by a CEL key over `row`, entries applying as tie-breakers. |

## Aggregating a group

Inside `aggregate`, `group` is the array of records in the group, so reductions are ordinary CEL over `group.map(...)`:

| Reduction | CEL |
| --- | --- |
| sum | `!cel "sum(group.map(w, w.amount))"` |
| average | `!cel "avg(group.map(w, w.amount))"` |
| count | `!cel "size(group)"` |
| min / max | `!cel "min(group.map(w, w.amount))"` / `!cel "max(group.map(w, w.amount))"` |

`sum` and `avg` are `std` CEL reducers (siblings of `min` / `max` / `size`), usable in any CEL expression, not just here.

> `size(group)` is a CEL integer — a **BigInt** (int64). A bare BigInt can't be JSON-serialized downstream; wrap counts bound for JSON output in `double(...)`. `sum` / `avg` already return JSON numbers. See [operations.md](operations.md#a-note-on-bigint) for the full note.

To reduce a whole collection (no grouping), use [`Collection.Summarize`](operations.md#collectionsummarize) — `GroupBy` with a single implicit group.

> CEL arithmetic is type-exact: divide a `double` by a `double`. Write `/ 60.0`, not `/ 60`, or the analyzer reports `no such overload: double / int`.

## Example

Group YouTrack work items by user + project, sum the logged minutes, derive hours, order the rows:

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

Given four items across `(Ann, Apollo)`, `(Bob, Apollo)`, `(Ann, Zephyr)`, this returns:

```yaml
rows:
  - { user: Ann, project: Apollo, minutes: 120, hours: 2 }
  - { user: Ann, project: Zephyr, minutes: 60,  hours: 1 }
  - { user: Bob, project: Apollo, minutes: 45,  hours: 0.75 }
```

## When not to use it

`Collection.GroupBy` reshapes data with CEL only. If each group needs to *invoke* something (call a service per group, run a step body), that's control flow — use `Run.Iteration` / `Run.Projection` instead. If the data is already in a database, group it there with `Sql.Selection`'s `group by`.
