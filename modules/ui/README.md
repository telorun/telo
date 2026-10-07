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
  a form with no fields edits its scalar ones. Adding a property changes
  nothing you have to edit.
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
| [`Ui.Filters`](docs/filters.md) | A filter bar over the tables it contains. |
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
kind: Ui.Table
metadata: { name: todos }
model: !ref Todo
source: { basePath: /api/todos }
rowStyle:
  by: !cel "row.isDone"
  cases: { "true": muted }
create: { kind: Ui.Form, model: !ref Todo, source: { basePath: /api/todos } }
delete: true
```
