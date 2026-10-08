# UI

A vocabulary for user interfaces written as data. A page is a tree of nodes —
layout, text, links, images — and of **composites**: a data table over a REST
collection, a form over a data model, a filter bar, a custom component. This
module holds the vocabulary and the controllers that resolve it; it ships no
code for a browser. A renderer, such as [`ui-react`](../ui-react/README.md),
turns what it produces into a web application.

## Why use this

- **The interface is checked with the rest of the manifest.** A column reads a
  property of the row model through a typed accessor, so renaming the property
  is an error at `telo check`, not a blank cell in production.
- **Derived by default.** A table with no columns shows the model's properties;
  a form with no fields edits its scalar ones; a filter bar with no fields
  shows every filter the collection accepts. Adding a property changes nothing
  you have to edit.
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
- **Nothing is reachable only through a shortcut.** Whatever a higher-level
  kind produces can be written by hand in this vocabulary.
- **A backend module can describe its own interface** without depending on any
  renderer.

## Kinds

| Kind | Purpose |
| --- | --- |
| [`Ui.View`](docs/view.md) | One node tree, placed wherever it is needed. |
| [`Ui.Table`](docs/table.md) | A data grid over a collection. |
| [`Ui.Form`](docs/form.md) | A form over a data model. |
| [`Ui.Dialog`, `Ui.Drawer`, `Ui.Popover`, `Ui.InlineSurface`, `Ui.Panel`, `Ui.PageSurface`](docs/surfaces.md) | Where a form opens: over the page, in line, beside the list, or in place of the page. |
| [`Ui.Surface`, `Ui.Overlay`](docs/surfaces.md#the-two-abstracts) | The contracts every surface, and every floating one, provides through. |
| [`Ui.Filters`](docs/filters.md) | A filter bar over the tables it contains. |
| [`Ui.AbovePlacement`, `Ui.AsidePlacement`, `Ui.CollapsiblePlacement`, `Ui.OverlayPlacement`](docs/filter-placement.md) | Where a filter bar's controls sit: above its content, beside it, folded behind a toggle, or in an overlay. |
| [`Ui.FilterPlacement`](docs/filter-placement.md) | The contract every placement provides through. |
| [`Ui.LocalStore`, `Ui.SessionStore`](docs/state-store.md#stores) | Where a filter bar's state is kept between visits. |
| [`Ui.StateStore`](docs/state-store.md#stores) | The contract every store provides through. |
| [`Ui.Collection`](docs/collection.md) | What a collection's list accepts: its filters and sorts. |
| [`Ui.Component`](docs/component.md) | A custom browser component, with its properties. |
| [`Ui.ComponentExport`](docs/component-export.md) | Publishes a component a module ships. |
| [`Ui.Theme`](docs/theme.md) | Design tokens. |
| [`Ui.Composite`](docs/composite.md) | The contract every composite provides through. |

The node vocabulary and the style list are in [Nodes](docs/nodes.md); what a
table's `source` speaks is [the collection contract](docs/collection-contract.md).
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
