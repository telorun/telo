# Ui.Form

A form over a data model, written to a collection. It lives on a
[page](page.md), placed among its nodes like any composite: the page reached by
its own address is a full page, and opened from a [press](presses.md) it is
drawn in the press's [surface](surfaces.md).

| Field | | |
| --- | --- | --- |
| `model` | required | the shape of the record the form sends |
| `record` | required | the record the form writes: [`{ presentation, key? }`](#what-it-edits) |
| `initialValues` | the address and store, then the model's defaults | the record the form [starts from](#what-it-starts-from): a plain chain over the roots where the form is placed |
| `unsaved` | `confirm` | [whether leaving with unsaved input asks first](#the-form-owns-its-lifecycle): `confirm` or `discard` |
| `afterSubmit` | `close` | [what the form does once the record is saved](#the-form-owns-its-lifecycle): `close`, `keep` or `again` |
| `fields` | every enterable property | the fields, top to bottom: a property name, or a [field kind](field-kinds.md) |
| `groups` | none | labelled sections the fields name by `group` ([field kinds](field-kinds.md#groups)) |
| `state` | not kept | where the values entered are kept between visits ([kept values](field-kinds.md#kept-values)) |

```yaml
kind: Ui.Form
metadata: { name: taskForm }
model: !ref TaskInput
record: { presentation: !ref tasksPresentation, key: !cel "data.id" }
initialValues: !cel "data"
```

A property name is exactly `{ kind: Ui.InputField, property: <name> }`: the
page document is the same for both spellings. A field's label is the
property's `title`, else its name.

## Related records

A property whose relation the presentation presents is entered with a
[picker](field-kinds.md#uipickerfield) of the related records — searched with
the relation's `search`, labelled with its `label` and `hint`, linked with its
`to` — whether it is named bare in `fields` or `fields` is left out, so a
post form shows an author picker with nothing written beyond the relation. A
field kind written for the property wins.

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

## What it edits

`record.presentation` names the collection written to — its source's `basePath`
is where, its relations how related records are offered. `record.key` says
which stored record the form edits: a plain chain to that record's key value,
over the roots where the form is placed — `data.id` inside a query node,
`params.id` on a page whose path variable is the key. Its type is held to the
collection's key property: `params.id` is a string, so over a collection keyed
by an integer it is `CEL_TYPE_ERROR`, and a literal of another type is
`SCHEMA_VIOLATION`. The roots are the ones a destination reads
(`row`, `data`, `query`, `params`, `values`, `result`, `input`), each in scope
only where the place binds it: one that is not is `CEL_UNKNOWN_IDENTIFIER`.

| `record.key` | Request |
| --- | --- |
| written | `PATCH <basePath>/<key value>` with `content-type: application/merge-patch+json` |
| omitted | `POST <basePath>` |

Either write announces `<basePath>` and `<basePath>/<key value>`, so the
listing and the reads of that record read again. The key is explicit: a form
that inferred "the record I was started from" would write wherever its query
happened to read.

**The collection's write shapes.** A form is checked against the shape its
write is held to — `schemas.create` without `record.key`, `schemas.update` with
it:

| Rule (`RESOURCE_RULE_VIOLATED`, `REFERRER_RULE_VIOLATED` for the update shape, in `data.rule`) | When |
| --- | --- |
| `UI_WRITE_UNDECLARED` | the collection declares no shape for the write the form makes |
| `UI_WRITE_SHAPE_MISMATCH` | a property of `model` the shape does not declare, or declares with another type |

Both are refused again when the form is first read (`ERR_UI_WRITE_UNDECLARED`,
`ERR_UI_WRITE_SHAPE_MISMATCH`), for a manifest that never passed `telo check`.

## What it starts from

An edit page reads the record with a [`query`](query.md) node at the item's
address and places the form among its children with `initialValues` over
`data`; the query's `ETag` is the validator the form's `PATCH` carries.

```yaml
children:
  - type: query
    query: { kind: Ui.Query, model: !ref Task, url: { path: "/api/tasks/{id}", pathParams: { id: !cel "params.id" } } }
    content:
      - type: composite
        ref:
          kind: Ui.Form
          model: !ref TaskInput
          record: { presentation: !ref tasksPresentation, key: !cel "data.id" }
          initialValues: !cel "data"
```

A form starts from `initialValues` when it is drawn, and the address and its
`state` store are read only where `initialValues` is absent. It starts again,
the unsaved-input question asked first, when the resolved address of the query
its `initialValues` reads changes; a re-read at the same address keeps the form
and what was typed. `initialValues` is held to fit `model`.

## The form owns its lifecycle

`unsaved` and `afterSubmit` are the form's, so the same form behaves alike in a
surface and on a page of its own.

- `unsaved: confirm` asks before unsaved input is dropped by anything that
  closes the form — its surface closing, a move to another page, another record
  opening in the same surface — and `discard` drops it
  ([the guard](surfaces.md#after-a-submit-and-unsaved-input)).
- `afterSubmit: close` closes the surface the form's page is open in, and on a page of its own the
  form stays, saved. `keep` leaves it open with its values; `again` returns it
  to the values it started from — on a create page a fresh record, on an edit
  page the saved one.

The listing reloads after every submit.

## What it sends

- **Creating** (no `record.key`), the record holds each field that has a value. A field left
  empty is left out of it.
- **Editing** (`record.key`), the form starts from `initialValues`. What it sends is the merge
  patch (RFC 7396) of the shown properties whose value differs from that
  record: the entered value for one that changed, `null` for one emptied, and
  for an object only the members that changed (a removed one as `null`); a list
  is sent whole. A property the form does not show, or did not change, is not named, so a form
  over a narrower model than the record leaves every other column as it is, and
  a form that changed nothing sends `{}`, which the collection answers with the
  stored record. The patch and the `If-Match` it carries are pinned by
  `conformance/merge-patch.json`.
- The `ETag` of the last read or write at the item's path, when the server sent
  one, is sent back as `If-Match`
  ([preconditions](action-contract.md#preconditions)). When another save came
  first the collection answers `412`: the form shows the problem's `code`
  (`ERR_UI_PRECONDITION_FAILED` without one), keeps every value entered, reads
  the record again for its new validator, and pressing save again sends the
  same changes against the current record.
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
A 400's `data.issues` are shown on the fields: an issue whose `pointer`'s first
segment after `/body` is a shown field's property — `/body/period/from`
reaches the field entering `period` — marks that field until it changes again,
worded by its `keyword` and `params` as the browser's own validation words that
keyword ([`ui`'s own texts](texts.md#uis-own-texts)), so a refusal the API
finds reads like one the browser finds. Every other issue is shown under the
form as its path and that text; a 400 with no issues shows its `detail`.

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
| `UI_WRITE_UNDECLARED`, `UI_WRITE_SHAPE_MISMATCH` | [the collection's write shapes](#what-it-edits) |

What a field kind refuses of its own fit is its kind's rule, reported at the
field's place in `fields` ([field kinds](field-kinds.md#refused)). The form
refuses the same things itself when it is first read (`ERR_<code>`), asking
each field kind for its own answer, for a manifest that never passed
`telo check`.
