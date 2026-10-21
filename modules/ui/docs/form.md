# Ui.Form

A form over a data model.

| Field | | |
| --- | --- | --- |
| `model` | required | the shape of the record |
| `source.basePath` | required | [app-relative](nodes.md#addresses) URL of the collection written to |
| `fields` | every enterable property | the fields, top to bottom: a property name, or a [field kind](field-kinds.md) |
| `groups` | none | labelled sections the fields name by `group` ([field kinds](field-kinds.md#groups)) |
| `state` | not kept | where the values entered are kept between visits ([kept values](field-kinds.md#kept-values)) |

A property name is exactly `{ kind: Ui.InputField, property: <name> }`: the
page document is the same for both spellings. A field's label is the
property's `title`, else its name.

## Fields drawn on a condition

A field's `shown` is a [condition](conditions.md) over `values` — the record
the form holds now, typed from `model` and read only by a condition:

```yaml
fields:
  - kind
  - kind: Ui.InputField
    property: detail
    shown: { at: !cel "values.kind", matches: { const: other } }
```

A hidden field keeps what it holds, and its value is neither sent nor checked.
The record is still held to the model: a property the model requires whose
field is hidden blocks the submission, with the finding shown under the form.
`values.x` outside a form or an action is refused by `telo check`.

## What a form can enter

A control enters one plain value or a list of them. A property is enterable
when it is:

- a **scalar** — typed `string`, `number`, `integer` or `boolean` (`null`
  beside it is set aside), or declaring an `enum`; or
- a **list of scalars** — typed `array` with an `items` that is one.

An object, a list of objects and a list with no `items` are not: with `fields`
left out they get no field, and the form sends nothing for them. A field kind
may enter one anyway — a [date range](field-kinds.md#uidaterangefield) enters
an object. [`Ui.Action`](action.md) reads the same definition, and an input
field's `auto` control fits exactly what a property name can enter.

## Where it writes

| Placed as | Request |
| --- | --- |
| a node on a page, or a table's `create` | `POST <basePath>` |
| a table's `edit` | `PUT <basePath>/<rowKey value>`, prefilled from the record read at `GET <basePath>/<rowKey value>` |

## What it sends

- **Creating**, the record holds each field that has a value. A field left
  empty is left out of it.
- **Editing**, the form first reads the record by its key, because a row of
  the list may hold less than the record does. What it sends is every property
  of the form's model the record held a value for — whether or not the form
  shows it — with each field's entered value over it, because `PUT` replaces
  ([the collection contract](collection-contract.md#items)). A field left
  empty is left out, which clears that property. A property the record held as
  `null` is left out, and so is anything in the record the model does not
  declare — so a form over a narrower model than the record sends only what
  that model names.
- A checkbox always has a value: `true` or `false`.
- A list with nothing chosen or typed is left out, like an empty field.
- A required field left empty is refused in the page, on the field, and
  nothing is sent.

## How a control is derived

An input field's `control` names one ([field kinds](field-kinds.md#uiinputfield));
`auto`, and a property name, derive it from the model property, in this order:

| Property | Control |
| --- | --- |
| `type` includes `boolean` | checkbox |
| declares `enum` | select |
| `type` includes `number` or `integer` | number input |
| `format: date` / `date-time` / `time` | date, date-and-time, time input |
| string with `contentMediaType` beginning `text/` | multi-line text |
| any other string | single-line text |

A list is entered as a whole, by what its `items` are:

| `items` | Control |
| --- | --- |
| declares `enum` | a multi-choice group, one option per value |
| any other scalar | typed tags: each entry is one item, read as the item's type |

There is no length heuristic: a long string is single-line unless the model
says it is a document.

## Validation

The node a form provides carries the model's JSON Schema, and the renderer
checks the record against it before sending — by interpreting the schema, with
no generated code. It reads the [interpreted profile](conditions.md#the-interpreted-profile) —
`type`, `const`, `enum`, `not`, `allOf`, `anyOf`, `required`, `properties`,
`items`, `minItems`, `maxItems`, `uniqueItems`, `minLength`, `maxLength`,
`pattern`, the numeric bounds and `multipleOf` — the same keywords a condition
is written in, so a form and a condition cannot disagree about one. Every
other keyword — a `pattern` outside `re2-pattern` included — stays legal and is
left to the API. A field's findings are shown as values are entered, once the
field has been touched, and every field's on a submission.
A 400's `details[]` are shown on the fields: a detail whose `path` begins with
a shown field's property — `period.from` reaches the field entering `period` —
marks that field with its `message` until it changes again, and every other
detail is shown under the form as `path` and `message` together.

## Refused

| Rule (`RESOURCE_RULE_VIOLATED`, in `data.rule`) | When |
| --- | --- |
| `UI_FIELD_UNKNOWN_PROPERTY` | a field names a property the model does not declare |
| `UI_FIELD_UNSUPPORTED` | a property name names a property no control can enter: an object, or a list of anything but scalars |
| `UI_FIELD_REQUIRED_NOT_ENTERED` | a property the model requires has no field |
| `UI_FIELD_DUPLICATE` | two fields enter one property |
| `UI_FIELD_GROUP_UNKNOWN` | a field names a group `groups` does not declare |
| `UI_FIELD_GROUP_SPLIT` | a group's fields are not listed one after another |
| `UI_FIELD_GROUP_DUPLICATE` | two groups share a name |
| `UI_STATE_FIELD_UNKNOWN` | `state.fields` names a property no field shows |

What a field kind refuses of its own fit is its kind's rule, reported at the
field's place in `fields` ([field kinds](field-kinds.md#refused)). The form
refuses the same things itself when it is first read (`ERR_<code>`), asking
each field kind for its own answer, for a manifest that never passed
`telo check`.
