# DataModel

What a list endpoint of records is, independent of what serves it or what draws it: the shape of a record, the property that identifies it, the filters, sort orders and facets the endpoint accepts, and the properties that point at records of other collections.

## Why use this

- **One declaration, three readers** — an API enforces it, a screen offers exactly what it declares, and a hand-written API gets a typed contract without any framework.
- **Contradictions are refused before the app runs** — a filter on a property the record does not have, an operator the property's type cannot carry, a relation whose type differs from its target's key: `telo check` reports each where it is declared, and the collection refuses itself again when created.
- **Related records without cycles** — a collection may relate to itself (`employees.managerId`) or to a collection that relates back to it; the relation reads the target's declaration only.
- **Transport-neutral** — nothing here names HTTP, SQL or a UI. A kind that serves a collection extends it and inherits the rules.

## Kinds

| Kind | Purpose |
| --- | --- |
| `DataModel.Collection` | One list endpoint: `model`, `key`, `query` (`filters`, `sort`, `facets`) and `relations`. See [Collection](docs/collection.md). |

## Example

```yaml
kind: DataModel.Collection
metadata: { name: posts }
model: !ref Post
query:
  filters:
    - { property: title, operator: contains }
    - { property: authorId, operator: in }
    - { property: publishedOn, operator: absent }
  sort: [{ property: title }]
  facets: [{ property: authorId }]
relations:
  authorId: { collection: !ref authors }
```

## Documentation

- [Collection](docs/collection.md) — the fields, operators, relations and the rules
- [The collection contract](docs/collection-contract.md) — the requests and answers an endpoint speaks, including facets and `absent`

The SQL-backed collection and its API are [`Crud.Collection`](../crud/docs/collection.md) and [`Crud.Api`](../crud/docs/api.md).
