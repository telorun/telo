# UI React

Serves a [`Ui`](../ui/README.md) interface as a web application. `UiReact.App`
is a mount: put it on an `Http.Server` and the pages it declares become a
working application — navigation, data tables, forms, filters, buttons that
run an operation and draw its answer, theming — drawn
in the browser by a React renderer this module ships prebuilt.

## Why use this

- **No frontend build.** Pages are data; one renderer interprets them. There
  is no generated code and nothing to compile per application.
- **Per-request pages.** A node's `when:` and its text may read the request's
  headers, so a role or a tenant decides what a page shows.
- **Styling is a published contract.** Every element carries a stable part
  name; your stylesheet is applied last and always wins.
- **Accessible controls.** Dialogs trap the focus and close on Escape, choice
  lists and checkboxes work from the keyboard, and icon buttons are named —
  in a light and a dark scheme that follow the viewer's system.
- **Forms open where the manifest says.** Every [surface](../ui/docs/surfaces.md)
  is drawn — dialog, drawer, popover, inline, panel, page — with an open form
  in the address, a replacement below a breakpoint, and a question before
  unsaved input is lost.
- **Filter bars as declared.** Every [placement](../ui/docs/filter-placement.md)
  and every control is drawn — a bar above or beside the list, folded behind
  a toggle or in an overlay; chips, switches, sliders, tags, presets — and the
  chosen filters are kept [in the address or the browser's
  storage](docs/urls.md#filter-state) when the bar says so.
- **Operations without a script.** A [`Ui.Action`](../ui/docs/action.md) is
  drawn as a form and a button: the record is checked in the page, posted,
  and the lists the action declares are drawn from the answer — links
  included. A table offers the same operations on each row, with a question
  first where one is declared.
- **Lists are entered, not just shown.** A list property is a group of options
  or typed tags, in every form.
- **An open seam.** A module ships its own React components, and they get
  navigation, requests and refresh from the host.

## Kinds

| Kind | Purpose |
| --- | --- |
| [`UiReact.App`](docs/app.md) | An application of pages, mounted on an HTTP server. |

Also: [what it serves](docs/urls.md), [the styling contract](docs/styling.md),
and [the component ABI](docs/component-abi.md).

## Example

```yaml
kind: Telo.Application
metadata: { name: TodoAdmin, version: 1.0.0 }
imports:
  Http: oci://ghcr.io/telorun/http-server
  Ui: oci://ghcr.io/telorun/ui
  UiReact: oci://ghcr.io/telorun/ui-react
ports:
  http: { env: PORT, default: 8080 }
targets: [!ref server]
---
kind: Telo.JsonSchema
metadata: { name: Todo }
schema:
  type: object
  required: [text]
  properties:
    id: { type: integer }
    text: { type: string, title: Task, minLength: 1 }
    isDone: { type: boolean, title: Done }
---
# What the collection's list accepts: the table sorts only by what it lists.
kind: Ui.Collection
metadata: { name: todoCollection }
query:
  filters: []
  sort:
    - { property: text }
---
kind: UiReact.App
metadata: { name: admin }
title: Todo Admin
pages:
  - path: /
    title: Todos
    children:
      - type: composite
        ref:
          kind: Ui.Table
          model: !ref Todo
          collection: !ref todoCollection
          source: { basePath: /api/todos }
          create:
            form: { kind: Ui.Form, model: !ref Todo, source: { basePath: /api/todos } }
          delete: true
---
kind: Http.Server
metadata: { name: server }
port: !cel "ports.http"
mounts:
  - path: /api/todos
    mount: !ref todosApi     # anything speaking the collection contract
  - path: /
    mount: !ref admin
```

The renderer's built-in strings — button labels, validation messages — are
English.
