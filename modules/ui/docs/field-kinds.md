# Field kinds

The `fields` of a [`Ui.Form`](form.md) and a [`Ui.Action`](action.md) are one
flat ordered list. Each entry is a property name, entered as its model says, or
a field kind — a kind extending `Ui.Field`, written inline or by `!ref`:

```yaml
kind: Ui.Form
metadata: { name: taskForm }
model: !ref Task
source: { basePath: /api/tasks }
groups:
  - { name: who, label: People, description: Who works on it. }
fields:
  - title
  - { kind: Ui.ChoiceField, property: owner, options: !ref people, group: who }
  - { kind: Ui.PickerField, property: watchers, options: !ref people, group: who }
  - kind: Ui.DateRangeField
    property: period
    presets:
      - { label: This month, unit: month, offset: 0 }
      - { label: Last month, unit: month, offset: -1 }
    initialPreset: This month
  - { kind: Ui.InputField, property: effort, control: slider }
state: { key: task, store: { kind: Ui.LocalStore } }
```

A property name is exactly `{ kind: Ui.InputField, property: <name> }`, and the
page document is the same for both spellings. The model still decides the
label (`title`), the hint (`description`), validation and the initial value
(`default`); the one exception is a date range's `initialPreset`, which a model
cannot express.

## `Ui.Field`

What every field kind has:

| Key | | |
| --- | --- | --- |
| `property` | required | the model property it enters; every field kind enters exactly one |
| `group` | none | the name of the [group](#groups) it is drawn in |
| `shown` | always | a [condition](conditions.md) over `values`, the record the form holds now — typed from the model of whichever form or action places the field |

A field kind judges its own fit to the model it is placed in: a rule on the
form or action referencing it, for `telo check`, and the same answer from the
kind's `invoke` when the form is first read. `Ui.Field` is a `Telo.Invocable`
taking `{ model }` — the JSON Schema of the record — and answering
`{ property, problems, spec? }`: `problems` is `[{ code, message }]`, and
`spec` — one of the four specs [below](#what-a-renderer-receives), defaults
filled — is present exactly when the model declares the property and nothing
is wrong. The owner raises `ERR_<code>` for the first problem, naming no field
kind, so a field kind from another module is placed and judged with no change
to `ui`. A field kind requiring more than `model` is refused at the `fields`
slot (`CONTRACT_SLOT_INPUTS_UNSATISFIABLE`).

## `Ui.InputField`

| Key | | |
| --- | --- | --- |
| `control` | `auto` | a `Ui.Control`: `auto`, `select`, `options`, `toggle`, `slider` or `tags` |

`auto` is the renderer's [derivation table](form.md#how-a-control-is-derived).
Whether a control fits is one predicate, `Ui.controlFits(control, property,
operator)`, exported for any module's rules — `operator` is a filter's, or
`null` for a field, whose value is a list when the property is an `array` and
is entered by its `items` then:

| Control | Fits a field's property that |
| --- | --- |
| `auto` | holds one plain value or a list of them |
| `select`, `options` | declares an `enum`, or is a boolean — or a list of either |
| `toggle` | is a boolean; off holds `false` |
| `slider` | is a number or integer declaring `minimum` and `maximum` |
| `tags` | is a list of plain values |

Its rows are `conformance/control-fits.json`, which the function and every
renderer's fit are held to.

## `Ui.ChoiceField`

| Key | | |
| --- | --- | --- |
| `options` | required | an [option source](#option-sources), over the form's `values` |
| `control` | `auto` | `auto` or `select` draw a list, `options` the options side by side |

One value, or several for a list property. `toggle`, `slider` and `tags` do not
fit a choice.

## `Ui.PickerField`

| Key | | |
| --- | --- | --- |
| `options` | required | an [option source](#option-sources), over the form's `values` |
| `surface` | a dialog with its defaults | a `Ui.Overlay` the options are searched and chosen in |

For a set too large for a list — a foreign key, an assignee. The chosen values
are drawn as their labels, linked where the source gives an `href`.

## `Ui.DateRangeField`

| Key | | |
| --- | --- | --- |
| `presets` | required | `[{ label, unit, offset }]`: the whole `unit` (`day`, `week`, `month`, `quarter`, `year`) holding today, moved by `offset` units |
| `weekStart` | `monday` | `monday` or `sunday`, for a `week` preset |
| `initialPreset` | none | the label of the preset the field starts at, as written |
| `warnLongerThan` | none | `{ unit, count }`: a longer range is shown a warning |

The property is one object of exactly `from` and `to`, each `type: string,
format: date`. Presets are computed in the viewer's time zone, at load and at
click, and a preset is shown active whenever the dates equal it. A start after
the end blocks the submission; a range longer than `warnLongerThan` shows a
warning and does not block.

## Option sources

`Ui.OptionSource` is the abstract every source of options extends: `model` (the
shape of one option's record) and accessors over `row`, a record of `model` —
`value` (what choosing it yields), `label`, `hint?` and `href?`.
`Ui.CollectionOptions` reads them from a
[collection](../../data-model/docs/collection-contract.md):

| Key | | |
| --- | --- | --- |
| `source` | required | the [`Ui.CollectionSource`](collection-source.md) read: its collection is what the list request is held to, its `basePath` the URL |
| `filters` | none | property → a fixed value or a path into `values`: equalities sent with every request, each a filter the collection accepts with `eq` and typed against its model property |
| `search` | none | `{ property, operator }`: the filter what the viewer types is sent as |
| `pageSize` | `25` | options per request, sent as `limit` |

```yaml
kind: Ui.CollectionOptions
metadata: { name: people }
model: !ref Person
value: !cel "row.id"
label: !cel "row.name"
hint: !cel "row.team"
source: !ref peopleSource
filters: { team: !cel "values.team" }
search: { property: name, operator: contains }
```

A form field over a property with a relation needs no option source of its
own: the [presentation's relation](collection-presentation.md#relations) is
one, and a picker over it is derived ([`Ui.Form`](form.md#related-records)).

- Options are read page by page by `next` as the list scrolls, at most one page
  per scroll.
- A search is sent after the typing pause a filter bar's `apply: typing` uses,
  or at once on Enter; an answer to an older search is discarded.
- A chosen value with no label in hand — an edit's record, a model default, a
  kept value — is labelled by one request filtering `value` with `in`, in
  batches of `pageSize`; a value the request does not return is dropped.
  Labels are never kept.
- While a filter it reads holds nothing, the source reads nothing and offers
  nothing. When one changes, it reads again from its first page, and the chosen
  values are held to it by the same `in` lookup: values still offered are kept,
  the rest dropped.
- Entries reading each other's values in a cycle — a source filtered by the
  property its own field enters, or two reading each other — are
  `CONTEXT_FILL_CYCLE`.

## Groups

`groups: [{ name, label, description?, shown? }]` declares labelled sections; a
field names its section by `group`. A group's fields are listed one after
another, so the list's order is the order they are drawn in. A group's `shown`
is a condition over `values`; its hidden fields are hidden fields.

## Kept values

`state` is a `Ui.StateRecord` — `{ key, address, store, fields? }`, at least one
of `address: true` and `store` written — the same record a
[filter bar](state-store.md) uses:

- `fields` lists the properties kept; omitted, every property a field shows. A
  property the model marks `writeOnly: true` is never kept. Only values are
  kept.
- A form starts from the record it edits, else the address, else the store,
  else the model's defaults and each date range's `initialPreset`.
- Values read back are held to the interpreted profile, to the current fields
  and to their option source; a store the browser refuses leaves the values in
  memory.
- The renderer spells a form's and an action's keys apart from a bar's
  (`_telo.v.<key>.<property>` in the address, `telo.ui:<mount>:v:<key>` in
  storage), so a bar and a form sharing a `key` never read each other's
  entries.

## Refused

Declared by the field kinds and the option source, each reported at the
field's place in `fields`:

| Rule | Kind | When |
| --- | --- | --- |
| `UI_FIELD_CONTROL_UNSUPPORTED` | input and choice fields | the control does not fit the property |
| `UI_FIELD_OPTION_VALUE_MISMATCH` | choice and picker fields | the source's `value` type is not the property's (or its items') |
| `UI_DATE_RANGE_PROPERTY_INVALID` | date range | the property is not an object of exactly `from` / `to`, each `format: date` |
| `UI_DATE_RANGE_DEFAULT_CONFLICT` | date range | `initialPreset` beside a model `default` on the property |
| `UI_DATE_RANGE_PRESET_UNKNOWN` | date range | `initialPreset` names no declared preset |
| `UI_DATE_RANGE_PRESET_LABEL_DUPLICATE` | date range | two presets share a label |
| `UI_OPTION_SEARCH_NOT_ACCEPTED` | collection options | `search` is not a filter pair the source's collection declares |
| `UI_OPTION_VALUE_NOT_FILTERABLE` | collection options | `value` is not `row.<property>` for a property the collection declares with `in` |
| `UI_SOURCE_FILTER_UNKNOWN_PROPERTY`, `UI_SOURCE_FILTER_NOT_ACCEPTED` | collection options | a `filters` key names a property the model does not declare, or one the collection does not accept with `eq` |

The form and action rules are listed on [`Ui.Form`](form.md#refused). Each has
its `ERR_` twin, raised when the form, the action or the option source is first
read.

## What a renderer receives

A field is its kind's spec, tagged on `type`, `group` and `shown` present when
declared. Every field carries `label` (a text record — the property's `title`,
else its name), `description` (the property's `description` as a text record,
drawn as a hint under the control, or `null`) and `labels`, the label of each
value an enumeration of the property offers (`[{ value, label }]` — a `const`
branch's `title`, else the value itself; `[]` when the property is no
enumeration):

| `type` | Members |
| --- | --- |
| `input` | `property`, `label`, `description`, `labels`, `control` |
| `choice` | `property`, `label`, `description`, `labels`, `control`, `options` |
| `picker` | `property`, `label`, `description`, `labels`, `options`, `surface` (an overlay spec) |
| `dateRange` | `property`, `label`, `description`, `labels`, `presets`, `weekStart`, `initialPreset`, `warnLongerThan?` |

A preset's `label` is a text record, and `initialPreset` is the index of the
preset the field starts at, `null` when none is declared. See
[Texts and translation](texts.md#what-a-renderer-receives).

An option source is `{ type: collection, schema, value, label, hint?, href?,
basePath, filters, pageSize, search? }`, each accessor a binding. The form and
action nodes carry `groups` (empty when none) and `state` — `{ key?, address,
store, fields }`, `store` `{ type: memory }` when none is named.
