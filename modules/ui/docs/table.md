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
| `rowActions` | none | [operations each row offers](#row-actions): `{ action, inputs, confirm? }` each |

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
  or No, a `format: date` string as a date, and so on. A `format: uri` or
  `uri-reference` string is a link, where its value is an address
  [a `link` node's `href` may hold](nodes.md#addresses); a value that is not is
  shown as plain text. A link to a page of the application moves within it;
  any other opens beside it.

So a hand-written `value: !cel "row.dueOn"` and the derived column for `dueOn`
are the same column.

### Members behind a reference

A column over a nested member (`row.owner.site`) takes its header and its
presentation from that member however the model reaches it. Every node on the
way, and the member itself, is read as the shape it names: a named shape
(`!ref File`), a pointer into the model's own definitions
(`$ref: "#/$defs/File"`, resolved in the shape it is written in), or a shape
reached through another, as deep as the references go. A keyword written
beside a reference — a `title` on the member — wins over the same keyword of
the shape it names. A union or an `allOf` on the way is not read, and the
column then shows the member's name and plain text.

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

## Row actions

`rowActions` puts buttons on every row, in the order written, before edit and
delete. Each runs a [`Ui.Action`](action.md) with values of that row:

```yaml
rowActions:
  - action: !ref archiveTodo
    inputs:
      id: !cel "row.id"
      status: archived
    confirm: Archive this task?
```

| Field | | |
| --- | --- | --- |
| `action` | required | the [`Ui.Action`](action.md) run, `!ref` or inline |
| `inputs` | required, at least one | the record sent, by input property: a path into `row`, or a fixed value |
| `confirm` | | a question asked first; left out, a press runs the action at once |

The button shows the action's `label` and sends
[its request](action-contract.md#from-a-row) to its `source.path`. A row uses
only that much of the action: its `fields` are not read, since nothing opens to
complete an input — every property the action's `inputModel` requires is bound
here. Once the operation succeeds, the tables over the same `source.basePath`
reload.

Each entry's `inputs` is checked as a record of **its own** action's
`inputModel`, so two entries over different models do not mix. `telo check`
names that model "the declared inputType" of the action:

| Written | Reported |
| --- | --- |
| a key a closed input model does not declare, a required input left out, a fixed value of the wrong type | `CONTRACT_INPUTS_MISMATCH` |
| `!cel "row.<name>"` for a property the row model does not declare | `CEL_UNKNOWN_FIELD` |
| a path whose type the input property does not take (`row.name`, a string, for an integer `id`) | `CEL_TYPE_ERROR` |
| anything but a plain path (`!cel "row.id + 1"`) | `ACCESSOR_NOT_PLAIN_CHAIN` |
| no `inputs`, an empty one, a `confirm` that is not text or is empty | `SCHEMA_VIOLATION` |

An action that declares a list is refused in a row, which has nowhere to draw
an answer (`UI_ROW_ACTION_DRAWS_LISTS`, [below](#refused)): declare an action
without `lists` for the row. `lists: []` declares none.

The table refuses a row's inputs itself when it is first read, as
`ERR_UI_ROW_ACTION_INPUTS_INVALID`: a key a closed input model does not
declare, a required input left unbound, or a fixed value its property refuses.

## Refused

| Rule (`RESOURCE_RULE_VIOLATED`, in `data.rule`) | When |
| --- | --- |
| `UI_SOURCE_FILTER_UNKNOWN_PROPERTY` | `source.filters` names a property the model does not declare |
| `UI_SOURCE_FILTER_NOT_ACCEPTED` | `source.filters` names a property the collection's `query.filters` does not declare with operator `eq` |
| `UI_ROW_ACTION_DRAWS_LISTS` | a `rowActions` entry names an action that declares at least one list |

The table refuses the same things itself when it is first read
(`ERR_UI_SOURCE_FILTER_UNKNOWN_PROPERTY`, `ERR_UI_SOURCE_FILTER_NOT_ACCEPTED`,
`ERR_UI_ROW_ACTION_DRAWS_LISTS`), for a manifest that never passed
`telo check`.

A reference on the way to a column's member that names nothing, or leads back
to itself, is `ERR_REF_UNRESOLVED` when the table is first read, naming the
table and the place in `model`. `telo check` does not report it.
