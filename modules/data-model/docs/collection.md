# DataModel.Collection

One list endpoint of records, described independently of what serves it or
what draws it. An API enforces it, a screen offers exactly what it declares,
and `telo check` refuses a declaration that contradicts the record shape.

| Field | | |
| --- | --- | --- |
| `model` | required | the shape of one record as it is read (a `Telo.JsonSchema`) |
| `key` | `id` | the property identifying a record; the model declares it and lists it as required |
| `query.filters` | required | the accepted filters: `{ property, operator }` each, no pair twice; `[]` for none |
| `query.sort` | required | the properties a list may be sorted by: `{ property }` each; `[]` for none |
| `query.facets` | none | properties whose present values, with counts, the endpoint answers: `{ property }` each |
| `relations` | none | `<property>: { collection }`, where `collection` is another `DataModel.Collection` |

`operator` is one of `eq`, `contains`, `gt`, `gte`, `lt`, `lte`, `in`, `absent`.
The wire spelling of each, and the facet request, are in
[the collection contract](collection-contract.md).

```yaml
kind: Telo.JsonSchema
metadata: { name: Post }
schema:
  type: object
  required: [id, title, authorId]
  properties:
    id: { type: integer }
    title: { type: string }
    authorId: { type: integer }
    publishedOn: { type: [string, "null"], format: date }
---
kind: DataModel.Collection
metadata: { name: posts }
model: !ref Post
query:
  filters:
    - { property: id, operator: in }
    - { property: title, operator: contains }
    - { property: authorId, operator: eq }
    - { property: publishedOn, operator: absent }
  sort: [{ property: title }]
  facets: [{ property: authorId }]
relations:
  authorId: { collection: !ref authors }
```

## Relations

A relation's property holds the target's `key` (a list property holds a list of
keys); the entry never restates which property of the target it matches. The
reference reads the target's declaration only, so a collection may relate to
itself (`employees.managerId`) and two may relate to each other without an
initialization cycle.

## Operators

`eq` and `in` fit a string, number, integer or boolean property, `contains` a
string, `gt` / `gte` / `lt` / `lte` a string or a number. A property declaring
no type takes any of these. `absent` matches records whose property is null or
missing, and fits a property the model leaves out of `required` or admits
`null`; on any other property it is refused, because the model says it can
never be absent. No operator applies to an object or a list.

## What is refused

Each is reported by `telo check` where the collection is declared, and again,
with an `ERR_` prefix, when the collection is created.

| Code | When |
| --- | --- |
| `DATA_MODEL_KEY_UNDECLARED` | the model does not declare `key`, or does not list it as required |
| `DATA_MODEL_FILTER_UNKNOWN_PROPERTY` | a filter names a property the model does not declare |
| `DATA_MODEL_FILTER_OPERATOR_UNSUPPORTED` | the operator does not fit the property's type |
| `DATA_MODEL_FILTER_RESERVED_NAME` | a filter property is a reserved query name: `limit`, `cursor`, `sort`, `facet`, or anything starting `_telo` |
| `DATA_MODEL_SORT_UNKNOWN_PROPERTY` | a sort names a property the model does not declare |
| `DATA_MODEL_SORT_UNSUPPORTED` | the sorted property does not hold one plain value |
| `DATA_MODEL_FACET_UNKNOWN_PROPERTY` | a facet names a property the model does not declare |
| `DATA_MODEL_FACET_UNSUPPORTED` | the faceted property does not hold one plain value |
| `DATA_MODEL_RELATION_UNKNOWN_PROPERTY` | a relation names a property the model does not declare |
| `DATA_MODEL_RELATION_VALUE_MISMATCH` | the property's type (`null` aside, by item type for a list) differs from the type of the target's key |
| `DATA_MODEL_RELATION_KEY_NOT_FILTERABLE` | the target does not accept `{ property: <its key>, operator: in }`, so related records cannot be fetched in one batched request |

A relation whose target lives in another module is checked when the collection
is created; `telo check` reports `RESOURCE_RULE_SKIPPED` for the type rule
there, since it cannot read the other module's model.

## Extending it

A kind that serves a collection `extends` this one, so a single resource is
both what the API enforces and what the screen offers: any slot that accepts a
`DataModel.Collection` accepts it. The rules above are inherited and added to,
never redeclared. Its controller runs the same guards through the module's code
library, `@telorun/data-model`: `readCollection` reads a collection's model,
query and relation targets, and `collectionProblems` returns what the table
above refuses, each as `{ code, message }`, to be raised as `ERR_<code>`.

[`Crud.Collection`](../../crud/docs/collection.md) is the SQL-backed one and
[`Crud.Api`](../../crud/docs/api.md) serves it.

## Reading it

`resources.<name>.model.schema`, `resources.<name>.key` and
`resources.<name>.query` are the declared blocks.
