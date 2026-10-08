# Ui.Table

A data grid over a REST collection.

| Field | | |
| --- | --- | --- |
| `model` | required | the shape of one row: a `!ref` to a `Telo.JsonSchema`, or one inline |
| `collection` | required | the [`Ui.Collection`](collection.md) declaring what the list accepts, `!ref` or inline |
| `source.basePath` | required | [app-relative](nodes.md#addresses) URL of the collection |
| `source.filters` | | property → scalar: equalities applied to every request, each a filter the collection accepts with `eq` |
| `rowKey` | `id` | the property identifying a row in item URLs |
| `columns` | derived | the columns, left to right; omitted, one per model property but the row key |
| `pageSize` | `25` | rows per page, 1–100, sent as `limit` |
| `rowStyle` | | a [style rule](nodes.md#style-rules) for the whole row |
| `create`, `edit` | | [how a form is opened](#opening-a-form): `{ form, surface?, afterSubmit?, unsaved? }` |
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
  and the collection's `query.sort` lists that property.
- **Presentation** — from the property's `type` and `format`: a boolean as Yes
  or No, a `format: date` string as a date, and so on.

So a hand-written `value: !cel "row.dueOn"` and the derived column for `dueOn`
are the same column.

## Opening a form

`create` adds a row and `edit` changes one. Each is an object naming the form
and, optionally, where and how it opens:

```yaml
create:
  form: !ref todoForm
edit:
  form: !ref todoForm
  surface: { kind: Ui.Panel, address: { name: todo } }
  afterSubmit: keep
  unsaved: discard
```

| Field | | |
| --- | --- | --- |
| `form` | required | a [`Ui.Form`](form.md), `!ref` or inline |
| `surface` | a `Ui.Dialog` with its defaults | [where the form appears](surfaces.md): any `Ui.Surface`, `!ref` or inline |
| `afterSubmit` | `close` | what the form does once the record is saved: `close`, `keep`, and on `create` also `again` |
| `unsaved` | `confirm` | whether leaving the form with unsaved input asks first (`confirm`) or drops it (`discard`) |

An edit opens over the record read by its key, not over the row shown.
`afterSubmit` and `unsaved` are described with the surfaces, under
[After a submit, and unsaved input](surfaces.md#after-a-submit-and-unsaved-input).

The object is the only spelling: `create: !ref todoForm` is refused
(`SCHEMA_VIOLATION`), as is `afterSubmit: again` on `edit`.

## Refused

| Rule (`RESOURCE_RULE_VIOLATED`, in `data.rule`) | When |
| --- | --- |
| `UI_SOURCE_FILTER_UNKNOWN_PROPERTY` | `source.filters` names a property the model does not declare |
| `UI_SOURCE_FILTER_NOT_ACCEPTED` | `source.filters` names a property the collection's `query.filters` does not declare with operator `eq` |

The table refuses the same things itself when it is first read
(`ERR_UI_SOURCE_FILTER_UNKNOWN_PROPERTY`, `ERR_UI_SOURCE_FILTER_NOT_ACCEPTED`),
for a manifest that never passed `telo check`.
