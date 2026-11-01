# Ui.Filters

A filter bar. It is a container: every [listing](listing.md) inside its
`content` obeys what is applied in it, in any layout, and returns to its first
page when that changes.

| Field | | |
| --- | --- | --- |
| `presentation` | required | the [`Ui.CollectionPresentation`](collection-presentation.md) filtered, `!ref` or inline: its collection declares what the list accepts and the shape of a record |
| `fields` | every filter the collection accepts | the filters, in order — [below](#fields) |
| `presets` | none | named sets of values — [below](#presets) |
| `policy` | every default | how the bar behaves — [below](#policy) |
| `content` | required | one [node](nodes.md) |

```yaml
kind: Ui.Filters
metadata: { name: todoFilters }
presentation: !ref todosPresentation
content: { type: composite, ref: !ref todos }
```

A filter bar whose `content` is switched off provides no node.

## Fields

With `fields` left out, the bar shows one control per entry of the
collection's `query.filters`, in the order declared, each with the operator
declared. Each control is drawn from the collection's `model` property of that
name — its title, its type, its `enum`. The collection itself guarantees every
entry names a property its model declares, with an operator its type carries.

Listed, `fields` chooses and orders them. A field is one filter, so its
operator is written; a property is filtered two ways by two fields, which are
drawn together under one label, each captioned by its operator's word
(`Manager is`, `Manager not set`). No two fields share a property and an
operator: the bar's state, its defaults and its presets name a filter by that
pair.

| Key | | |
| --- | --- | --- |
| `property` | required | a property of the collection's `model` |
| `operator` | required | `eq`, `contains`, `gt`, `gte`, `lt`, `lte`, `in`, `absent` — sent as [the collection contract](../../data-model/docs/collection-contract.md) spells them |
| `pinned` | `false` | kept outside whatever the bar folds into, always on show, never removable |
| `control` | `auto` | how the value is entered — [below](#controls) |
| `values` | `all` | which choices are offered — [below](#related-records-and-present-values) |
| `options` | none | any [`Ui.OptionSource`](field-kinds.md#option-sources): where the choices and their labels come from, in place of the property's relation or `enum` |
| `default` | none | what the filter holds until the viewer changes it: one value, or a list under `in`; only `true` under `absent` |

```yaml
fields:
  - { property: text, operator: contains, pinned: true }
  - { property: status, operator: in, control: options, default: [open, blocked] }
  - { property: isDone, operator: eq, control: toggle }
  - { property: archived, operator: eq, control: none, default: false }
```

No operator is implied by a property's type: the collection declares it, or
the field does.

### Controls

| `control` | Draws | Needs |
| --- | --- | --- |
| `auto` | a list for a property with `enum` and for a boolean, a typed box otherwise | — |
| `select` | a list to choose from; any number of entries under `in` | an `enum`, or a boolean |
| `options` | the values side by side; any number of them under `in` | an `enum`, or a boolean |
| `toggle` | a switch: on asks for the rows where the property is true — or, under `absent`, where it is missing — off asks for nothing; it holds true or nothing: `false` is not a `default` or preset value for it | a boolean, with `eq`; any property under `absent` |
| `slider` | a slider between the property's `minimum` and `maximum`, stepping by its `multipleOf` — by 1 for an integer that declares none | a number or an integer declaring both, with `eq` or a comparison |
| `tags` | values typed one at a time, each removable | `in` |
| `none` | nothing | — |

A filter under `absent` is entered with a switch: `auto` draws one.

A filter with `control: none` is drawn nowhere — not in the bar, not in the
summary, not in the count of a folded bar. It holds what its `default` or a
preset gives it, and the list is filtered by that.

A typed `in` filter under `auto` takes its values separated by commas —
`open, blocked` is two values — so a value that itself contains a comma is
entered with `tags`.

## Related records and present values

A field over a property whose relation the presentation presents offers the
related records, read from the relation's `source` and drawn with its `label`
and `hint`; its node carries that relation's option source as `options`. A
field's own `options` replaces where its choices and labels come from, a
relation or not; its value must be of the property's type.

`values` decides which of them are offered:

- `all` (the default) — every value the property can hold: every related
  record, or every value of its `enum`.
- `present` — only the values that occur in the records the bar's other
  filters leave, each shown with its count, from the
  [facet request](../../data-model/docs/collection-contract.md); related keys
  are labelled through the relation, or the field's `options`, one batched
  `in` request per page of the answer. It works for any faceted property, a
  relation or not, and needs the property listed under the collection's
  `query.facets`.

The screen decides: declaring a facet on the collection never changes a bar by
itself, so a bar without `values: present` is the same with or without one.

The bar's node carries its presentation's source `basePath` as written. A
`values: present` field's facet request goes there, under the bar's other
filters and those of any bar around it, and every change announced for that
path — a write, a delete, a row action, `notifyChanged` — reads the values and
their counts again, whether or not the bar holds a listing. Each value is shown
through the renderer's `valueCount` word, `{$label} ({$count})`.

```yaml
fields:
  - { property: authorId, operator: eq, values: present }
```

## Presets

```yaml
presets:
  - label: Open
    values:
      - { property: isDone, operator: eq, value: false }
      - { property: status, operator: in, value: [open, blocked] }
  - label: Finished
    values:
      - { property: isDone, operator: eq, value: true }
```

Presets are drawn as one exclusive choice. Choosing one sets the filters the
presets name **between them** — here `isDone` and `status` — to what it says,
clearing those it does not name, and leaves every other filter as it was. So
`Finished` clears `status`, and neither touches a typed `text`.

Which preset is active is read off the bar's values, never stored: it is the
first whose values the bar holds exactly, however they came to be — chosen,
typed, restored from the address. A value is written as a field's `default`
is: one value, or a list under `in`.

## Policy

`policy` is a `Ui.FilterPolicy` record. Every member is optional
and none decides which others may be written: every combination is valid.

| Key | Values (default) | |
| --- | --- | --- |
| `show` | `all` \| `chosen` (`all`) | under `chosen` a filter is on show when it is pinned, was added from the bar's list, or holds a value; removing one clears it |
| `placement` | a [`Ui.FilterPlacement`](filter-placement.md) (`{ kind: Ui.AbovePlacement }`) | where the controls sit relative to the content |
| `controls` | `direct` \| `chips` (`direct`) | under `chips` each filter is a chip naming it and its value, which opens its control |
| `apply` | `commit` \| `typing` \| `button` (`commit`) | when a change reaches the list |
| `summary` | `none` \| `chips` (`none`) | under `chips`, a row of removable chips, one per filter holding a value |
| `state` | `{ key, address, store, fields? }` (in memory) | [where the bar's state is kept](state-store.md) — a `Ui.StateRecord`, shared with forms and actions; `fields` limits which properties' filters are kept (`UI_STATE_FIELD_UNKNOWN` for one no filter shows) |

```yaml
policy:
  show: chosen
  placement: { kind: Ui.AsidePlacement, compact: { kind: Ui.CollapsiblePlacement } }
  apply: typing
  summary: chips
  state: { key: todos, address: true, store: { kind: Ui.LocalStore } }
```

`apply`:

- `commit` — a choice applies at once; typed text when it is committed, by
  Enter or by leaving the field.
- `typing` — a choice applies at once; typed text after a short pause.
- `button` — what is typed or picked in a filter's control waits for the
  bar's Apply button. A preset, Reset and removing a filter through a summary
  chip do not wait: each reaches the list when it is made, and applies with it
  whatever was waiting.

Fixed, whatever the policy: Reset returns every filter to its declared
`default`; the toggle of a folded bar shows how many filters hold a value; a
pinned filter stays outside whatever folds, and under `show: chosen` is always
on show; Apply and Reset stay outside whatever folds.

Under `show: chosen`, removing a filter that declares a `default` clears the
default too: the filter leaves the bar holding nothing, and Reset brings it
back.

## Refused

| Rule (`RESOURCE_RULE_VIOLATED`, in `data.rule`) | When |
| --- | --- |
| `UI_FILTER_NOT_ACCEPTED` | a field's `{ property, operator }` is not a pair the collection's `query.filters` declares |
| `UI_FILTER_VALUES_NOT_FACETED` | `values: present` on a property the collection does not list under `query.facets` |
| `UI_FILTER_OPTION_VALUE_MISMATCH` | a field's `options` yields values of another type than its property holds |
| `UI_FILTER_DUPLICATE` | two fields share a property and an operator |
| `UI_FILTER_DEFAULT_INVALID` | a `default` is not of the property's type or not one of its `enum`; or is a list without `in`; or one value with `in`; or anything but `true` under `absent`; or `false` for a filter entered with a `toggle`, which holds true or nothing |
| `UI_FILTER_CONTROL_UNSUPPORTED` | a `control` its filter cannot be entered with — the *Needs* column [above](#controls) |
| `UI_FILTER_PRESET_UNKNOWN_FILTER` | a preset value names a property and operator the bar does not show |
| `UI_FILTER_PRESET_VALUE_INVALID` | a preset value fails what a `default` is held to, or is `false` for a filter entered with a `toggle`, which holds true or nothing |
| `UI_FILTER_PRESET_LABEL_DUPLICATE` | two presets share a label |

Each is refused by `telo check` and, under the same name prefixed `ERR_`, by
the filter bar itself when it is first read. That a filter names a property
of the model with an operator its type carries is
[the collection's own guarantee](../../data-model/docs/collection.md). The
default and preset rules judge a property where it declares one plain
`type`. The control rule
reads a property's types with `null` set aside, so a nullable boolean takes a
`toggle` and a nullable number a `slider`.

A `policy` key outside the table, a value outside a key's list, and a `state`
that keeps nothing — neither `address: true` nor a `store` — are each a
`SCHEMA_VIOLATION`. A resource of the wrong kind at `placement` or `store` is
`REFERENCE_KIND_MISMATCH`.

### Warned

`UI_FILTER_PINNED_UNUSED` — a field is `pinned` on a bar that never folds,
so every filter is on show whatever is pinned. It is reported for an omitted
placement (`RESOURCE_RULE_VIOLATED`), and for a `Ui.AbovePlacement` with no
`compact` (`REFERRER_RULE_VIOLATED`), while `show` is `all`. A
`Ui.AsidePlacement` folds on a narrow viewport whether or not it names a
`compact`, so it is not warned. It is a warning: the manifest runs.
