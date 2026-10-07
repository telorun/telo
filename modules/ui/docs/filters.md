# Ui.Filters

A filter bar. It is a container: every table inside its `content` obeys what
is chosen in it, and returns to its first page when that changes.

| Field | | |
| --- | --- | --- |
| `model` | required | the shape of the rows being filtered |
| `fields` | one per scalar property | `{ property, operator? }` each |
| `content` | required | one [node](nodes.md) |

```yaml
kind: Ui.Filters
metadata: { name: todoFilters }
model: !ref Todo
fields:
  - property: text
  - property: priority
    operator: gte
content: { type: composite, ref: !ref todos }
```

## Operators

`eq`, `contains`, `gt`, `gte`, `lt`, `lte`, `in` — sent as
[the collection contract](collection-contract.md) spells them. Left out, the
operator comes from the property:

| Property | Operator |
| --- | --- |
| declares `enum` | `in` |
| string | `contains` |
| boolean, number | `eq` |

A filter bar whose `content` is switched off provides no node.

## Entering a value

A property that declares `enum`, and a boolean, is chosen from a list, and the
choice applies at once. Anything else is typed, and applies when it is
committed: Enter, or leaving the field.

A typed `in` filter takes its values separated by commas — `open, blocked` is
two values — so a value that itself contains a comma cannot be entered there.

## Refused

| Rule (`RESOURCE_RULE_VIOLATED`, in `data.rule`) | When |
| --- | --- |
| `UI_FILTER_UNKNOWN_PROPERTY` | a field names a property the model does not declare |
| `UI_FILTER_OPERATOR_UNSUPPORTED` | the operator does not fit the property's type: `contains` needs a string; `gt` / `gte` / `lt` / `lte` a string or a number; nothing applies to an object or a list |

The operator rule is judged where the property declares one plain `type`.
Refused by the filter bar itself as `ERR_UI_FILTER_UNKNOWN_PROPERTY` /
`ERR_UI_FILTER_OPERATOR_UNSUPPORTED`.
