# Ui.Form

A form over a data model.

| Field | | |
| --- | --- | --- |
| `model` | required | the shape of the record |
| `source.basePath` | required | [app-relative](nodes.md#addresses) URL of the collection written to |
| `fields` | every scalar property | the fields, top to bottom: `{ property }` each |

A field's label is the property's `title`, else its name.

## Where it writes

| Placed as | Request |
| --- | --- |
| a node on a page, or a table's `create` | `POST <basePath>` |
| a table's `edit` | `PUT <basePath>/<rowKey value>`, prefilled from the row |

## What it sends

- **Creating**, the record holds each field that has a value. A field left
  empty is left out of it.
- **Editing**, the record is the whole row, because `PUT` replaces the row
  ([the collection contract](collection-contract.md#items)): every property of
  the model the row held a value for — whether or not the form shows it — with
  each field's entered value over it. A field left empty is left out, which
  clears that property. A property the row held as `null` is left out, and so
  is anything in the row the model does not declare.
- A checkbox always has a value: `true` or `false`.
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

There is no length heuristic: a long string is single-line unless the model
says it is a document.

## Validation

The node a form provides carries the model's JSON Schema, and the renderer
checks the record against it before sending — by interpreting the schema, with
no generated code. It reads `type`, `required`, `enum`, `const`, `minLength`,
`maxLength`, `pattern`, `minimum`, `maximum`, `exclusiveMinimum`,
`exclusiveMaximum` and `multipleOf`. Every other keyword is left to the API.
A 400's `details[]` are shown on the fields: a detail whose `path` is exactly
a shown field's property marks that field with its `message`, and every other
detail is shown under the form as `path` and `message` together.

## Refused

| Rule (`RESOURCE_RULE_VIOLATED`, in `data.rule`) | When |
| --- | --- |
| `UI_FORM_FIELD_UNKNOWN_PROPERTY` | a field names a property the model does not declare |

Refused by the form itself as `ERR_UI_FORM_FIELD_UNKNOWN_PROPERTY`.
