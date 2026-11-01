# Ui.CollectionSource

A collection as the browser reaches it: the declared
[collection](../../data-model/docs/collection.md) — what a record is, its key,
and the filters, sort orders and facets its list request accepts — and where
its list endpoint is.

| Field | | |
| --- | --- | --- |
| `collection` | required | the `DataModel.Collection` read — or a kind extending it — `!ref` or inline |
| `basePath` | required | [app-relative](nodes.md#addresses) URL of the collection |

```yaml
kind: Ui.CollectionSource
metadata: { name: authorsSource }
collection: !ref authors
basePath: /api/authors
```

Whatever serves `basePath` speaks
[the collection contract](../../data-model/docs/collection-contract.md). One
authors URL written once is used by every screen over authors and by every
picker of an author: a [presentation](collection-presentation.md) of authors, a
relation pointing at authors, and a
[`Ui.CollectionOptions`](field-kinds.md#option-sources) all name the same
source.

A source carries no relations, so an option source reading it can never form
a cycle. A kind narrowing `collection` to a kind extending
`DataModel.Collection` extends this one.

A write, a delete, a row action, `notifyChanged(basePath)` and an action's
`onSuccess.refreshes` naming the source's `basePath` reload every listing over
it, and every facet request over it.
