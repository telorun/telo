# Ui.Table

A data grid over a REST collection.

| Field | | |
| --- | --- | --- |
| `model` | required | the shape of one row: a `!ref` to a `Telo.JsonSchema`, or one inline |
| `source.basePath` | required | [app-relative](nodes.md#addresses) URL of the collection |
| `source.filters` | | property → scalar: equalities applied to every request |
| `rowKey` | `id` | the property identifying a row in item URLs |
| `columns` | derived | the columns, left to right |
| `pageSize` | `25` | rows per page, 1–100, sent as `limit` |
| `rowStyle` | | a [style rule](nodes.md#style-rules) for the whole row |
| `create`, `edit` | | a [`Ui.Form`](form.md), `!ref` or inline |
| `delete` | `false` | whether each row offers a confirmed delete |

The collection must speak [the collection contract](collection-contract.md).

## Columns

A column is exactly one of:

```yaml
columns:
  - header: Task                 # optional
    value: !cel "row.text"       # an accessor: a chain into the row, or a fixed value
    style:                       # optional style rule for the cell
      by: !cel "row.priority"
      cases: { "1": danger }
  - header: State
    cell:                        # a Ui.Component drawn in the cell
      kind: Ui.Component
      component: !ref Badges.statusPill
      model: !ref Todo
      props: { done: !cel "row.isDone" }
```

`row` is typed from `model`, so a property the model does not declare is
`CEL_UNKNOWN_FIELD` at `telo check`.

With `columns` left out there is one column per model property, in declaration
order.

Whether written or derived, a value column takes everything else from the
property its value names:

- **Header** — the property's `title`, else its name, unless `header` is given.
- **Sorting** — a column is sortable exactly when its value is `row.<property>`
  and the property is scalar.
- **Presentation** — from the property's `type` and `format`: a boolean as Yes
  or No, a `format: date` string as a date, and so on.

So a hand-written `value: !cel "row.dueOn"` and the derived column for `dueOn`
are the same column.

## Refused

| Rule (`RESOURCE_RULE_VIOLATED`, in `data.rule`) | When |
| --- | --- |
| `UI_SOURCE_FILTER_UNKNOWN_PROPERTY` | `source.filters` names a property the model does not declare |

The table refuses the same thing itself when it is first read
(`ERR_UI_SOURCE_FILTER_UNKNOWN_PROPERTY`), for a manifest that never passed
`telo check`.
