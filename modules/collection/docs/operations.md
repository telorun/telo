# Collection operations

Beyond [`GroupBy`](group-by.md) and [`Fold`](fold.md), the module covers five more reshaping operations that native CEL cannot express. All are `Telo.Invocable`: invoke them from a `Run.Sequence` step or a boot target. All read `collection` (CEL or literal) that must resolve to an array, and none perform I/O.

## `Collection.Summarize`

Reduces a whole collection to a single summary object — `GroupBy` with one implicit group. The `aggregate` CEL map sees `group` (the full collection). Returns `{ summary }`.

```yaml
kind: Collection.Summarize
metadata: { name: Totals }
collection: !cel "inputs.orders"
aggregate:
  count: !cel "size(group)"
  total: !cel "sum(group.map(o, o.amount))"
  average: !cel "avg(group.map(o, o.amount))"
```

When the answer depends on what earlier elements produced — a running balance, an allocation that stops when the money runs out — the aggregators are not enough; that is [`Collection.Fold`](fold.md), which carries state you define from element to element.

## `Collection.Sort`

Orders a collection by a list of CEL keys, each ascending or descending, applied as tie-breakers. Stable — equal elements keep input order. Native CEL `sort()` orders scalars only; this sorts records by computed keys. Each `order[].by` sees `item`, `index`, `items`, `inputs`. Returns `{ items }`.

```yaml
kind: Collection.Sort
metadata: { name: ByNameThenAge }
collection: !cel "inputs.people"
order:
  - by: !cel "item.lastName"
  - by: !cel "item.age"
    descending: true
```

## `Collection.Distinct`

Keeps the first element for each distinct `key` tuple, preserving input order. Native CEL `distinct()` is scalar identity only; this dedupes by a computed key. Returns `{ items }`.

```yaml
kind: Collection.Distinct
metadata: { name: OnePerUser }
collection: !cel "inputs.events"
key:
  user: !cel "item.userId"
```

## `Collection.Chunk`

Splits a collection into consecutive batches of at most `size` elements — the trailing batch may be shorter. Useful for bounding batch/page size before a downstream `Run.Iteration`. Returns `{ chunks }` (an array of arrays).

```yaml
kind: Collection.Chunk
metadata: { name: Batches }
collection: !cel "inputs.records"
size: 100
```

## `Collection.Join`

Matches two collections on a CEL key from each side. `inner` (default) emits one row per matched `(left, right)` pair; `left` also emits unmatched left rows with `right` bound to `null`. `on.left` / `on.right` compute the match keys; `select` shapes each output row (sees `left` and `right`; defaults to `{ left, right }`). Returns `{ rows }`.

```yaml
kind: Collection.Join
metadata: { name: OrdersWithCustomer }
left: !cel "inputs.orders"
right: !cel "inputs.customers"
type: left
on:
  left: !cel "left.customerId"
  right: !cel "right.id"
select:
  orderId: !cel "left.id"
  customer: !cel "right != null ? right.name : 'unknown'"
```

The right side is indexed by its key once, so the join is linear in `len(left) + len(right)`. In a `left` join, guard `right` for null in `select` (it is null on unmatched rows).

## A note on integer counts

`size(...)` returns a CEL **integer** — int64, not a double. It needs no cast anywhere: it serializes to JSON as its exact digits, satisfies a `type: integer` slot, and compares equal to an integer literal in `Assert.Equals`. Write `count: !cel "size(group)"`.

`double(...)` remains meaningful for what it says — moving a value into the double domain, which CEL needs when an integer takes part in arithmetic with one (`double(size(x)) / total`). It is not a serialization step.

**Grouping / deduping / joining by an integer key works.** `GroupBy.key`, `Distinct.key`, and `Join.on` may compute integer keys (`size(...)`, integer arithmetic); a `size()`-derived key matches the same value arriving as a plain JSON int.
