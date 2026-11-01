# Crud.Collection

The records of one database table, as one list endpoint describes them: the
shape of a record, what a list may be filtered, sorted and faceted by, and the
properties that point at another collection's records — everything a
[`DataModel.Collection`](../../data-model/docs/collection.md) declares — plus the
shape of each write and of a list row, and the table the records are stored
in. A [`Crud.Api`](api.md) serves it, and a screen reading the same collection
offers exactly what the API accepts.

| Field | | |
| --- | --- | --- |
| `model` | required | one record as it is read, `id` included |
| `table` | required | the `Sql.Table` the records are stored in (`SQLite.Table`, `Postgres.Table`) |
| `schemas.list` | required | one row of the list, `id` included |
| `schemas.create` | required | the body that creates a record, without `id` |
| `schemas.update` | required | the body that updates a record, without `id` |
| `query.filters` | required | the filters a list accepts: `{ property, operator }` each; `[]` for none |
| `query.sort` | required | the properties a list may be sorted by: `{ property }` each; `[]` for none |
| `query.facets` | none | the properties whose present values, with counts, a facet request answers |
| `relations` | none | `<property>: { collection }`, the collection whose key the property holds |
| `key` | `id` | always `id`, the table's primary key |

Each shape is a `Telo.JsonSchema`, by `!ref` or written in place. A collection
is a `DataModel.Collection`, so it is accepted wherever one is, and the data
model's rules — filters, sorts, facets and relations measured against `model` —
hold of it too ([what is refused](../../data-model/docs/collection.md#what-is-refused)).

```yaml
kind: SQLite.Table
metadata: { name: todosTable }
table: todos
columns:
  id: { type: integer, primaryKey: true, identity: always }
  text: { type: text, nullable: false }
  is_done: { type: integer, nullable: false, default: 0 }
  created_at: { type: text, defaultExpression: "datetime('now')" }
---
# What a client writes.
kind: Telo.JsonSchema
metadata: { name: TodoDraft }
schema:
  type: object
  required: [text]
  additionalProperties: false
  properties:
    text: { type: string, minLength: 1 }
    isDone: { type: boolean }
---
# What is read back: the draft, the key, and what the table fills in.
kind: Telo.JsonSchema
metadata: { name: Todo }
extends: TodoDraft
schema:
  type: object
  required: [id, isDone]
  properties:
    id: { type: integer }
    createdAt: { type: string }
---
kind: Crud.Collection
metadata: { name: todos }
model: !ref Todo
table: !ref todosTable
schemas: { list: !ref Todo, create: !ref TodoDraft, update: !ref TodoDraft }
query:
  filters: [{ property: text, operator: contains }, { property: isDone, operator: eq }]
  sort: [{ property: createdAt }]
  facets: [{ property: isDone }]
```

## The table

A property is stored in the snake_case column of its name — `dueOn` in
`due_on` — and every property of `model` needs a column in the table's
`columns` (its row contract; an internal column is not one). The key is the
column `id`, declared `primaryKey: true`. The collection does not create or
migrate the table: list it in your engine's `Schema` beside its other tables.

## The declared query

A list request may use only what `query` lists. Nothing is implied by a shape:
a property of `model` no entry names cannot be filtered or sorted by, and a
property listed under one operator is not accepted under another.

- **`filters`** — one entry per accepted pair. `operator` is one of `eq`,
  `contains`, `gt`, `gte`, `lt`, `lte`, `in` and `absent`; a property filtered
  two ways is two entries (`dueOn` with `gte`, `dueOn` with `lte`). `absent`
  fits a property `model` leaves optional or lets be `null`.
- **`sort`** — the properties `sort=` may name, in either direction. `id` is
  not implied: `sort=id` works only when it is listed. With no `sort` a list is
  ordered by `id`, and `id` breaks every tie.
- **`facets`** — the properties a facet request may name; omitted, none.
- `filters` and `sort` are written even when empty.

Declare what the table can answer cheaply — a filter, a sort or a facet over
an unindexed column is a scan on every request. `GET <prefix>/{id}` reads one
record by its key whatever `query` declares.

How each is spelled in a URL: [the list route](list-route.md).

## Relations

`relations.authorId: { collection: !ref authors }` says that `authorId` holds
the key of an `authors` record. Where the target is a collection with a table
of its own, and this collection's table has a foreign key on the property's
column (`author_id`), that foreign key must reference the target's table, and
the target's key column at the position the property's column has in it — so
`{ columns: [author_id], references: { table: !ref authorsTable, columns: [id] } }`.
A relation with no foreign key on its column, and a foreign key no relation
names, are not compared.

A relation is a declaration read, so a collection may relate to itself
(`employees.managerId` → `employees`) and two may relate to each other.

## Sharing properties

A shape is declared once and extended, never derived: `extends:` folds the
parent's properties and `required` into the child, so `text` above is written
in one place and read through both shapes. Nothing is computed from a flag —
`readOnly` and `writeOnly` on a property reach the OpenAPI document and change
no shape.

| Wanted | Declare |
| --- | --- |
| a column the table fills in (`createdAt`) | in `model` only |
| a column optional to write, always present to read (`NOT NULL DEFAULT`) | in the write shape, and in `model`'s `required` |
| a property set once and never changed | in `create` and `model`, left out of `update` |
| a list without a heavy column | a `list` shape declaring fewer properties than `model` |

## What each shape governs

| Shape | Governs |
| --- | --- |
| `model` | `GET <prefix>/{id}`, the answer of `POST` and `PUT`, and the properties `query` and `relations` may name, with their types |
| `schemas.list` | the properties of each row of `GET <prefix>` |
| `schemas.create` | the `POST` body, and the columns an insert may name |
| `schemas.update` | the `PUT` body, and the columns a replace sets — every other column keeps its value |

## Refused

`model` is the widest shape: the other three fall within it. Each rule is
`RESOURCE_RULE_VIOLATED` at `telo check`, with its name in `data.rule`, and the
same name prefixed `ERR_` when the collection is created.

| Rule | When |
| --- | --- |
| `CRUD_COLLECTION_KEY_UNDECLARED` | `schemas.list` does not declare `id`, or does not list it in `required` |
| `CRUD_COLLECTION_KEY_WRITABLE` | `create` or `update` declares `id` |
| `CRUD_COLLECTION_WRITE_SHAPE_OPEN` | `create` or `update` does not set `additionalProperties: false` |
| `CRUD_COLLECTION_PROPERTY_NOT_READABLE` | `list`, `create` or `update` declares a property `model` does not |
| `CRUD_COLLECTION_PROPERTY_TYPE_DIFFERS` | a property's `type` differs from `model`'s, `null` aside |
| `CRUD_COLLECTION_UPDATE_REQUIRES_OPTIONAL` | `update` requires a property `model` leaves optional |
| `CRUD_COLLECTION_PROPERTY_UNKNOWN_COLUMN` | a `model` property has no snake_case column in the table's `columns` |
| `CRUD_COLLECTION_TABLE_KEY_NOT_PRIMARY` | the table's column `id` is missing or not `primaryKey: true` |
| `CRUD_COLLECTION_RELATION_FOREIGN_KEY_MISMATCH` | the foreign key on a relation's column references another table, or another column than the target's key at that column's position |

`CRUD_COLLECTION_PROPERTY_NOT_READABLE`, `_PROPERTY_TYPE_DIFFERS` and
`_UPDATE_REQUIRES_OPTIONAL` are what make a record read sendable: `model`'s
properties, restricted to those `update` declares, are a body `PUT` accepts.

Both `telo check` and the collection, when it is created, compare the PHYSICAL
tables — the `table` each table resource stores — reading every reference in
the module that wrote it: the foreign key's in the table's module, the target's
table in the target's. So a foreign key naming another module's table resource
of the same name is refused, and one naming another table resource that stores
the target's table is accepted.
