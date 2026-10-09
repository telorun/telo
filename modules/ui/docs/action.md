# Ui.Action

A button that runs an operation, with a form for what the operation takes and
lists drawn from what it answers.

| Field | | |
| --- | --- | --- |
| `inputModel` | required | the shape of the record sent: a `!ref` to a `Telo.JsonSchema`, or one inline |
| `outputModel` | | the shape of the answer; lists are read from it |
| `source.path` | required | [app-relative](nodes.md#addresses) URL of the operation |
| `label` | required | the text of the button |
| `fields` | every enterable property | the fields, top to bottom: `{ property }` each, none twice |
| `lists` | none | what is drawn from the answer, top to bottom |

The operation must speak [the action contract](action-contract.md): one `POST`
with a JSON body.

```yaml
kind: Ui.Action
metadata: { name: generateReports }
inputModel: !ref ReportRequest
outputModel: !ref ReportAnswer
source: { path: /api/reports }
label: Generate
lists:
  - heading: Files
    rows: !cel "result.files"
    columns:
      - value: !cel "row.name"
      - header: Download
        value: !cel "row.url"
```

An action is a [composite](composite.md): it is placed on a page with
`{ type: composite, ref: !ref generateReports }`, or
[offered on each row of a table](table.md#row-actions).

## Fields

The form is the one a [`Ui.Form`](form.md) draws: a labelled control per field,
[derived from the property](form.md#how-a-control-is-derived), validated in the
page against `inputModel` before anything is sent.

With `fields` left out there is one per property
[a control can enter](form.md#what-a-form-can-enter), in declaration order. An
input model with no properties gives a button and nothing else.

## Lists

Each entry of `lists` is one table drawn under the form once the operation has
answered:

| Field | | |
| --- | --- | --- |
| `heading` | | a heading above the table |
| `rows` | required | the list in the answer, as a path into `result` |
| `columns` | required, at least one | `{ header?, value }` each; `value` a path into `row` or `result`, or a fixed value |

`rows` and `value` are [accessors](https://telo.run/docs/extend/accessor-fields):
a plain chain, never an expression.

- `result` is the answer, typed from `outputModel`. With no `outputModel` it
  has no members, so any `result.<name>` is `CEL_UNKNOWN_FIELD`.
- `row` is one element of the list that entry's own `rows` names, typed from
  that list's `items`. `telo check` types it where the items are written in
  the answer model itself or one `!ref` away from it: an element shape
  reached through two named shapes leaves `row` untyped, and a misspelled
  member is then not reported.

A column takes the rest from the member its value names, as a table's column
does: its header is the member's `title`, else its name, unless `header` is
given, and its values are shown as the member's `type` and `format` say — a
`format: uri` or `uri-reference` string [as a link](table.md#columns). The
member is [followed through any reference](table.md#members-behind-a-reference),
at any depth, whether or not `telo check` types `row` that far.

Without `lists` the answer is not read.

## What `telo check` says

| Written | Reported |
| --- | --- |
| `value: !cel "row.nmae"`, `rows: !cel "result.fiels"` | `CEL_UNKNOWN_FIELD`, listing the declared members |
| `rows` naming something that is not a list | `CEL_TYPE_ERROR` |
| `rows: !cel "size(result.files)"`, or any other expression | `ACCESSOR_NOT_PLAIN_CHAIN` |
| a key the kind does not take (`method: PUT`) | `SCHEMA_VIOLATION` |

## Refused

| Rule (`RESOURCE_RULE_VIOLATED`, in `data.rule`) | When |
| --- | --- |
| `UI_ACTION_FIELD_UNKNOWN_PROPERTY` | a field names a property `inputModel` does not declare |
| `UI_ACTION_FIELD_UNSUPPORTED` | a field names a property no control can enter: an object, or a list of anything but scalars |
| `UI_ACTION_REQUIRED_INPUT_NOT_ENTERED` | a property `inputModel` requires has no field — it is missing from `fields`, or `fields` is left out and no control can enter it |

The action refuses the same things itself when it is first read, as
`ERR_UI_ACTION_FIELD_UNKNOWN_PROPERTY`, `ERR_UI_ACTION_FIELD_UNSUPPORTED` and
`ERR_UI_ACTION_REQUIRED_INPUT_NOT_ENTERED`, for a manifest that never passed
`telo check`.

A reference on the way to a list or to a column's member that names nothing,
or leads back to itself, is `ERR_REF_UNRESOLVED` when the action is first
read, naming the action and the place in `outputModel`. `telo check` does not
report it.

## What a renderer receives

An `action` node, every member present:

| Member | |
| --- | --- |
| `schema` | the input model's JSON Schema |
| `path`, `label` | as declared |
| `fields` | `{ property, label }` each, the label being the property's `title`, else its name |
| `lists` | one entry per declared list; an empty list when there are none |

A list is `{ rows, columns, heading? }`: `rows` a binding, `heading` present
exactly when one is declared, and each column `{ header, value, present? }` —
`header` always filled, `value` a binding, `present` the member's `type` and
`format` where it declares either.
