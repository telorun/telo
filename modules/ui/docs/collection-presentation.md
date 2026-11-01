# Ui.CollectionPresentation

How one set of screens shows a collection: where its records are read from,
and how each related record is read, labelled and searched. A
[listing](listing.md), a [filter bar](filters.md) and a [form](form.md) over
the same records name one presentation.

| Field | | |
| --- | --- | --- |
| `source` | required | the [`Ui.CollectionSource`](collection-source.md) the records are read from, `!ref` or inline |
| `relations` | none | `<property>: { source, label, hint?, href?, search?, pageSize? }`, the shape `Ui.Relations` |

```yaml
kind: Ui.CollectionPresentation
metadata: { name: postsPresentation }
source: { kind: Ui.CollectionSource, collection: !ref posts, basePath: /api/posts }
relations:
  authorId:
    source: !ref authorsSource
    label: !cel "row.name"
    search: { property: name, operator: contains }
```

## Relations

Which properties point at another collection's records is the collection's own
[`relations`](../../data-model/docs/collection.md); a presentation says only
how those records are shown. A relation's value is never written here: it is
always the target's `key`, which the collection guarantees can be looked up
with `in`.

| Field | | |
| --- | --- | --- |
| `source` | required | the [`Ui.CollectionSource`](collection-source.md) the related records are read from; its collection is the relation's target |
| `label` | required | how a related record is shown: a path into it (`row.name`) or a fixed text |
| `hint` | none | text shown beside the label, a path into the record |
| `href` | none | where a related record links to, a path into the record |
| `search` | none | the filter what the viewer types is sent as when choosing one: a `{ property, operator }` pair the target collection accepts |
| `pageSize` | `25` | related records per request, 1–100: a page of choices, and at most this many keys per label lookup |

From one relation:

- a [listing](listing.md#related-records) column, or a `value` node, over
  `row.<property>` shows the related record's label instead of its key;
- a [filter bar](filters.md#related-records-and-present-values) field over the property offers
  the related records, by label;
- a [form](form.md) enters the property with a picker of the related records,
  unless a field is written for it.

A relation the presentation does not present is shown, filtered and entered
by its key. `label`, `hint` and `href` read `row`, the related record, typed
from the `model` of the entry's own source's collection: `row.nmae` is refused
by `telo check` where it is written, naming the members the record has.

## Refused

| Rule (`RESOURCE_RULE_VIOLATED`, in `data.rule`) | When |
| --- | --- |
| `UI_RELATION_UNDECLARED` | `relations` names a property the collection declares no relation for |
| `UI_RELATION_TARGET_MISMATCH` | an entry's `source` reads another collection than the relation's target |
| `UI_RELATION_SEARCH_NOT_ACCEPTED` | an entry's `search` is not a filter pair the target collection declares |

The presentation refuses the same things itself when it starts
(`ERR_UI_RELATION_UNDECLARED`, `ERR_UI_RELATION_TARGET_MISMATCH`,
`ERR_UI_RELATION_SEARCH_NOT_ACCEPTED`), for a manifest that never passed
`telo check`. A relation whose target the collection names through an import
of its own module is judged at start only when the presentation's module can
name that target too; `telo check` judges every one.
