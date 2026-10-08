# Ui.Collection

What a collection's list request accepts: the filters it may carry and the
properties it may be sorted by. A [`Ui.Table`](table.md) and a
[`Ui.Filters`](filters.md) take one as `collection`, and offer exactly what it
declares.

| Field | | |
| --- | --- | --- |
| `query.filters` | required | the accepted filters: `{ property, operator }` each, no pair twice; `[]` for none |
| `query.sort` | required | the properties a list may be sorted by: `{ property }` each, none twice; `[]` for none |

`query` and both of its lists are always written. `operator` is one of `eq`,
`contains`, `gt`, `gte`, `lt`, `lte`, `in`.

```yaml
kind: Ui.Collection
metadata: { name: todoCollection }
query:
  filters:
    - { property: text, operator: contains }
    - { property: isDone, operator: eq }
    - { property: dueOn, operator: gte }
    - { property: dueOn, operator: lte }
  sort:
    - { property: dueOn }
---
kind: Ui.Table
metadata: { name: todos }
model: !ref Todo
collection: !ref todoCollection
source: { basePath: /api/todos }
```

## What it decides

- A filter bar with no `fields` shows one control per `query.filters` entry, in
  the order declared, with the operator declared. A listed field must be one of
  those pairs.
- A table column sorts where its value is `row.<property>` and `query.sort`
  lists the property.
- A table's fixed `source.filters` are each a property declared with `eq`.

Nothing is implied by a row model: a scalar property the collection does not
list is neither filtered nor sorted by.

## Declaring one for an API

A `Ui.Collection` describes an API; it does not enforce anything on it. Write
one beside a hand-written API, listing what that API's list accepts under
[the collection contract](collection-contract.md).

A kind that serves a collection can extend this one, so a single resource is
both what the API enforces and what the screen offers — a `collection` slot
accepts any resource whose kind extends `Ui.Collection`.

## Reading it

`resources.<name>.query` is the declared block.
