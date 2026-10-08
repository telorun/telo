# Ui.Form

A form over a data model.

| Field | | |
| --- | --- | --- |
| `model` | required | the shape of the record |
| `source.basePath` | required | [app-relative](nodes.md#addresses) URL of the collection written to |
| `fields` | every enterable property | the fields, top to bottom: `{ property }` each |

A field's label is the property's `title`, else its name.

## What a form can enter

A control enters one plain value or a list of them. A property is enterable
when it is:

- a **scalar** — typed `string`, `number`, `integer` or `boolean` (`null`
  beside it is set aside), or declaring an `enum`; or
- a **list of scalars** — typed `array` with an `items` that is one.

An object, a list of objects and a list with no `items` are not: with `fields`
left out they get no field, and the form sends nothing for them.
[`Ui.Action`](action.md) reads the same definition.

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

From the model property, in this order:

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
no generated code. It reads `type`, `required`, `enum`, `const`, `minLength`,
`maxLength`, `pattern`, `minimum`, `maximum`, `exclusiveMinimum`,
`exclusiveMaximum` and `multipleOf`, and for a list `type: array` with the
same keywords on its `items`, each item checked on its own. Every other
keyword is left to the API.
A 400's `details[]` are shown on the fields: a detail whose `path` is exactly
a shown field's property marks that field with its `message`, and every other
detail is shown under the form as `path` and `message` together.

## Refused

| Rule (`RESOURCE_RULE_VIOLATED`, in `data.rule`) | When |
| --- | --- |
| `UI_FORM_FIELD_UNKNOWN_PROPERTY` | a field names a property the model does not declare |
| `UI_FORM_FIELD_UNSUPPORTED` | a field names a property no control can enter: an object, or a list of anything but scalars |

The form refuses the same things itself when it is first read
(`ERR_UI_FORM_FIELD_UNKNOWN_PROPERTY`, `ERR_UI_FORM_FIELD_UNSUPPORTED`), for a
manifest that never passed `telo check`.
