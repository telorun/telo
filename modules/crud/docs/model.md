# Crud.Model

The shapes of one collection's records, one per operation, and what its list
may be filtered and sorted by. A `Crud.Resource` serves them and a `Crud.Ui`
draws them, so the API and its screen are given the same model: the API accepts
exactly the queries the screen offers.

| Field | | |
| --- | --- | --- |
| `schemas.read` | required | one record as it is read, `id` included |
| `schemas.list` | required | one row of the list, `id` included |
| `schemas.create` | required | the body that creates a record, without `id` |
| `schemas.update` | required | the body that updates a record, without `id` |
| `query.filters` | required | the filters a list accepts: `{ property, operator }` each, no pair twice; `[]` for none |
| `query.sort` | required | the properties a list may be sorted by: `{ property }` each, none twice; `[]` for none |

Each shape is a `Telo.JsonSchema`, by `!ref` or written in place. All four are
named even where two are the same shape.

A model is a [`Ui.Collection`](../../ui/docs/collection.md): it is what a
`Ui.Table` or a `Ui.Filters` over the same collection takes as `collection`.

```yaml
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
kind: Crud.Model
metadata: { name: todoModel }
schemas:
  read: !ref Todo
  list: !ref Todo
  create: !ref TodoDraft
  update: !ref TodoDraft
query:
  filters:
    - { property: text, operator: contains }
    - { property: isDone, operator: eq }
  sort:
    - { property: createdAt }
```

## The declared query

A list request may use only what `query` lists. Nothing is implied by a shape:
a property of `read` that no entry names cannot be filtered or sorted by, and a
property listed under one operator is not accepted under another.

- **`filters`** — one entry per accepted pair. `operator` is one of `eq`,
  `contains`, `gt`, `gte`, `lt`, `lte`, `in`; a property filtered two ways is
  two entries (`dueOn` with `gte`, `dueOn` with `lte`).
- **`sort`** — the properties `sort=` may name, in either direction. `id` is
  not implied: `sort=id` works only when it is listed. With no `sort` a list is
  ordered by `id`, and `id` breaks every tie.
- Both keys are written even when empty. A model that leaves `query`, or one
  of its two lists, out is a `SCHEMA_VIOLATION` naming the key.

Declare what the table can answer cheaply — a filter or a sort over an
unindexed column is a scan on every request. `GET <prefix>/{id}` reads one
record by its key whatever `query` declares.

How each pair is spelled in a URL: [the list route](list-route.md).

## Sharing properties

A shape is declared once and extended, never derived: `extends:` folds the
parent's properties and `required` into the child, so `text` above is written
in one place and read through both shapes. Nothing is computed from a flag —
`readOnly` and `writeOnly` on a property reach the OpenAPI document and change
no shape.

The usual arrangements:

| Wanted | Declare |
| --- | --- |
| a column the table fills in (`createdAt`) | in the read shape only |
| a column optional to write, always present to read (`NOT NULL DEFAULT`) | in the write shape, and in the read shape's `required` |
| a property set once and never changed | in `create` and `read`, left out of `update` |
| a list without a heavy column | a `list` shape declaring fewer properties than `read` |

## What each shape governs

| Shape | Governs |
| --- | --- |
| `read` | `GET <prefix>/{id}`, the answer of `POST` and `PUT`, and the properties `query` may name, with their types |
| `list` | the properties of each row of `GET <prefix>` |
| `create` | the `POST` body, and the columns an insert may name |
| `update` | the `PUT` body, and the columns a replace sets — every other column keeps its value |

`query` names `read`'s properties, so a row can be found by a property its
row does not show.

## Refused

`read` is the widest shape: the other three fall within it, and so does
everything `query` names. Each rule is
`RESOURCE_RULE_VIOLATED` at `telo check`, with its name in `data.rule`, and
the same name prefixed `ERR_` when the model is created.

| Rule | When |
| --- | --- |
| `CRUD_MODEL_KEY_UNDECLARED` | `read` or `list` does not declare `id`, or does not list it in `required` |
| `CRUD_MODEL_KEY_WRITABLE` | `create` or `update` declares `id` |
| `CRUD_MODEL_WRITE_SHAPE_OPEN` | `create` or `update` does not set `additionalProperties: false` |
| `CRUD_MODEL_PROPERTY_NOT_READABLE` | `list`, `create` or `update` declares a property `read` does not |
| `CRUD_MODEL_PROPERTY_TYPE_DIFFERS` | a property's `type` differs from `read`'s, `null` aside |
| `CRUD_MODEL_UPDATE_REQUIRES_OPTIONAL` | `update` requires a property `read` leaves optional |
| `CRUD_MODEL_FILTER_UNKNOWN_PROPERTY` | a `query.filters` entry names a property `read` does not declare |
| `CRUD_MODEL_FILTER_OPERATOR_UNSUPPORTED` | a `query.filters` operator does not fit the property's type: `contains` needs a string; `gt` / `gte` / `lt` / `lte` a string or a number; nothing applies to an object or a list |
| `CRUD_MODEL_FILTER_RESERVED_NAME` | a `query.filters` entry names a property called `limit`, `cursor` or `sort`, or beginning `_telo` — a filter is sent under its property's name, and those are the list route's own parameters |
| `CRUD_MODEL_SORT_UNKNOWN_PROPERTY` | a `query.sort` entry names a property `read` does not declare |
| `CRUD_MODEL_SORT_UNSUPPORTED` | a `query.sort` entry names a property that holds an object or a list |

`CRUD_MODEL_PROPERTY_NOT_READABLE`, `CRUD_MODEL_PROPERTY_TYPE_DIFFERS` and
`CRUD_MODEL_UPDATE_REQUIRES_OPTIONAL` are what make a record read sendable:
`read`'s properties, restricted to those `update` declares, are a body `PUT`
accepts.

A property's type, for an operator and for a sort, is every type it declares
with `null` aside (`type: [integer, "null"]` is an integer), or the types of
its listed values where it declares only `enum`. A property declaring neither
takes any operator. The list route judges a request the same way, so a filter
the model accepts is never refused for its operator.
