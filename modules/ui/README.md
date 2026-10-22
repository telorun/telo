# UI

A vocabulary for user interfaces written as data. A page is a tree of nodes —
layout, text, links, images — and of **composites**: a data table over a REST
collection, a form over a data model, a button that runs an operation and
draws its answer, a filter bar, a custom component. This
module holds the vocabulary and the controllers that resolve it; it ships no
code for a browser. A renderer, such as [`ui-react`](../ui-react/README.md),
turns what it produces into a web application.

## Why use this

- **The interface is checked with the rest of the manifest.** A column reads a
  property of the row model through a typed accessor, so renaming the property
  is an error at `telo check`, not a blank cell in production.
- **Derived by default.** A table with no columns shows the model's properties;
  a form with no fields edits every property a control can enter; a filter bar
  with no fields shows every filter the collection accepts. Adding a property
  changes nothing you have to edit.
- **A screen offers only what its API accepts.** A collection declares the
  filters and sorts its list takes, and tables and filter bars are drawn from
  that declaration, never from a guess about the row's types.
- **How a form opens is declared, not built.** A table names the surface its
  create and edit forms appear in — a dialog, a drawer, a panel beside the
  list, a page of its own — with an address to link to and a replacement for
  narrow screens.
- **How a filter bar behaves is declared too.** Which filters are on show,
  where the controls sit, how each is entered, when a change applies, what it
  starts from and whether the choice survives a reload or travels in a link
  are keys of the bar, checked like the rest.
- **What could not be drawn is refused when the manifest is checked.** A form
  or an action listing a property no control can enter
  (`UI_FIELD_UNSUPPORTED`), a field kind whose control or options do not fit
  its property — judged by the kind itself, from whichever module it comes —
  and an action
  clearing its answer on a property its input does not have
  (`UI_ACTION_CLEAR_UNKNOWN_PROPERTY`) are reported by `telo check`, and
  refused again by the resource itself for a manifest that never passed it.
- **An operation's answer is drawn as content.** An action draws a success as
  its `result` tree and anything else as its `failure` tree, then refreshes the
  readers and tables a success changed and navigates where its answer says; a
  table's or a list's row draws the answer of the action it ran in place of its
  button.
- **What is drawn can depend on data, declared as data.** A node's `shown` is a
  condition — a value it names and a schema the value must satisfy — decided in
  the browser, while `when` decides on the server what is delivered at all. A
  condition that can never hold for the type it reads is refused by
  `telo check`.
- **Every word on screen can be translated.** Labels, headings, presets, a
  model's titles and enumeration labels and the renderer's own words are texts
  in the module's `lang:`; a heading over data names its values
  (`{ text, values }`), so a plural is chosen in the page, and a placeholder
  nothing fills is refused by `telo check`.
- **Nothing is reachable only through a shortcut.** Whatever a higher-level
  kind produces can be written by hand in this vocabulary.
- **A backend module can describe its own interface** without depending on any
  renderer.

## Kinds

| Kind | Purpose |
| --- | --- |
| [`Ui.View`](docs/view.md) | One node tree, placed wherever it is needed. |
| [`Ui.Data`](docs/data.md) | A record read when the page is drawn, and the trees drawn over it: a sign-in gate, an account panel, a context card. |
| [`Ui.Table`](docs/table.md) | A data grid over a collection. |
| [`Ui.Form`](docs/form.md) | A form over a data model. |
| [`Ui.InputField`, `Ui.ChoiceField`, `Ui.PickerField`, `Ui.DateRangeField`](docs/field-kinds.md) | A form's or an action's fields: a named control, a choice or a picker over options read from an API, a date range with presets. |
| [`Ui.Field`](docs/field-kinds.md#uifield) | The contract every field kind answers through, judging its own fit to the model it is placed in. |
| [`Ui.CollectionOptions`](docs/field-kinds.md#option-sources) | A field's options, read, searched and labelled through the collection contract. |
| [`Ui.OptionSource`](docs/field-kinds.md#option-sources) | The contract every source of options provides through. |
| [`Ui.Action`](docs/action.md) | A button that runs an operation: a form for its input, its answer and its failure drawn as node trees, navigation and refreshes after a success, serial or parallel presses, or a place on every row of a table or a list. |
| [`Ui.Dialog`, `Ui.Drawer`, `Ui.Popover`, `Ui.InlineSurface`, `Ui.Panel`, `Ui.PageSurface`](docs/surfaces.md) | Where a form opens: over the page, in line, beside the list, or in place of the page. |
| [`Ui.Surface`, `Ui.Overlay`](docs/surfaces.md#the-two-abstracts) | The contracts every surface, and every floating one, provides through. |
| [`Ui.Filters`](docs/filters.md) | A filter bar over the tables it contains. |
| [`Ui.AbovePlacement`, `Ui.AsidePlacement`, `Ui.CollapsiblePlacement`, `Ui.OverlayPlacement`](docs/filter-placement.md) | Where a filter bar's controls sit: above its content, beside it, folded behind a toggle, or in an overlay. |
| [`Ui.FilterPlacement`](docs/filter-placement.md) | The contract every placement provides through. |
| [`Ui.LocalStore`, `Ui.SessionStore`](docs/state-store.md#stores) | Where a filter bar's, a form's or an action's values are kept between visits. |
| [`Ui.StateStore`](docs/state-store.md#stores) | The contract every store provides through. |
| [`Ui.Collection`](docs/collection.md) | What a collection's list accepts: its filters and sorts. |
| [`Ui.Component`](docs/component.md) | A custom browser component, with its properties. |
| [`Ui.ComponentExport`](docs/component-export.md) | Publishes a component a module ships. |
| [`Ui.DesignTokens`](docs/design-tokens.md) | The brand: colours, radii, spacing, shadows, type sizes and typefaces by name, read by any renderer's theme. |
| [`Ui.Composite`](docs/composite.md) | The contract every composite provides through. |
| [`Ui.Words`](docs/texts.md#the-renderers-own-words) | The words a renderer draws on its own — loading, save, a pager's range, each validation message — one text per id; `Ui.words` is the English set. |

Which fields are texts, a text over data (`Ui.BoundText`), the renderer's words and what a renderer translates are in [Texts and translation](docs/texts.md).
The node vocabulary and the style list are in [Nodes](docs/nodes.md);
`when`, `shown`, `Ui.Condition`, `Ui.Enablement`, `Ui.QueryParameters` and the
interpreted profile `Ui.Match` are in [Conditions](docs/conditions.md). What a
table's `source` speaks is [the collection contract](docs/collection-contract.md),
what a reader's speaks is [the record contract](docs/record-contract.md), and
what an action's speaks is [the action contract](docs/action-contract.md).
A renderer's controller addresses browser files through the module's code
entry, [`@telorun/ui`](docs/composite.md#for-a-renderers-controller-telorunui).

## Example

```yaml
kind: Telo.JsonSchema
metadata: { name: Todo }
schema:
  type: object
  required: [text]
  properties:
    id: { type: integer }
    text: { type: string, title: Task, minLength: 1 }
    isDone: { type: boolean, title: Done }
    dueOn: { type: string, title: Due, format: date }
---
kind: Ui.Collection
metadata: { name: todoCollection }
query:
  filters:
    - { property: text, operator: contains }
    - { property: isDone, operator: eq }
  sort:
    - { property: dueOn }
---
kind: Ui.Table
metadata: { name: todos }
model: !ref Todo
collection: !ref todoCollection
source: { basePath: /api/todos }
rowStyle:
  by: !cel "row.isDone"
  cases: { "true": muted }
create:
  form: { kind: Ui.Form, model: !ref Todo, source: { basePath: /api/todos } }
delete: true
```
