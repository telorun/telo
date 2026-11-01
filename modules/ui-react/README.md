# UI React

Serves a [`Ui`](../ui/README.md) interface as a web application. `UiReact.App`
is a mount: put it on an `Http.Server` and the pages it declares become a
working application — navigation, listings, forms, filters, buttons that
run an operation and draw its answer, swappable themes — drawn in the browser
by a React renderer this module ships prebuilt.

## Why use this

- **No frontend build.** Pages are data; one renderer interprets them. There
  is no generated code and nothing to compile per application.
- **Per-request pages.** A node's `when:` and its text may read the request's
  headers, so a role or a tenant decides what a page shows.
- **A menu that fits the screen.** The [navigation](docs/app.md#navigation) is
  a tree of pages, links and groups — a menu bar with dropdowns and submenus,
  or a sidebar collapsing to a rail of icons that remembers its open groups,
  and below the breakpoint a menu button opening a drawer or a bottom tab bar
  — written as data, naming pages by reference so a library's pages join it
  unchanged. An entry's [icon](docs/app.md#icons) is drawn in the colour of
  its text, so a theme colours it as it colours text.
- **Data on page load, drawn by condition.** A [`Ui.Data`](../ui/docs/data.md)
  is read when it is drawn — a loading state first, a failure state for a
  refused read — and read again on window focus or when a request inside it
  answers 401, so a sign-in gate is a reader and a condition. A node's `shown`
  is decided in the browser over the answer, the page's query parameters or a
  form's values; hidden content keeps what it holds and requests nothing.
- **Operations that answer in place.** An action draws its answer, or why it
  failed, under its form; a row's action draws its answer in place of its
  button. A success refreshes the readers and listings it changed and can move
  the page, and a serial action's presses run one after another.
- **Swappable themes, separate brand.** An application picks its look with one
  reference — [`theme: !ref UiReact.defaultTheme`](docs/theme.md), or a theme
  another module publishes — and its brand with [`Ui.DesignTokens`](../ui/docs/design-tokens.md)
  under `tokens:`, so changing one keeps the other. A theme may also draw its
  own selects, menus and dialogs, and is held to the renderer's contract by
  [`ui-react-conformance`](../ui-react-conformance/README.md) from its own tests.
- **Contained or full-width pages.** A page is drawn within the look's measure,
  centred, or across all the room beside the navigation — chosen for the whole
  application (`pageWidth`) or per page (`width`), the measure and the inset
  design tokens (`width.page`, `space.page`); the header's content lines up
  with a contained page under every theme, beside a sidebar too, or spans the
  bar (`header.width`).
- **Styling is a published contract.** Every element carries a stable part
  name; your stylesheet is applied last and always wins.
- **Controls behind a contract.** Every interactive leaf — text boxes, choices,
  lists, dialogs, menus, navigation, tabs, tooltips, glyphs — is drawn through
  one published
  [controls contract](docs/controls-abi.md), with its behaviour as data and an
  interpreter to check an implementation against it; the built-ins are its
  reference implementation.
- **Accessible controls.** Dialogs trap the focus and close on Escape, choice
  lists and checkboxes work from the keyboard, and icon buttons are named —
  in a light and a dark scheme that follow the viewer's system.
- **Forms open where the manifest says.** Every [surface](../ui/docs/surfaces.md)
  is drawn — dialog, drawer, popover, inline, panel, page — with an open form
  in the address, a replacement below a breakpoint, and a question before
  unsaved input is lost.
- **Fields that keep up with the viewer.** Every [field kind](../ui/docs/field-kinds.md)
  is drawn — named controls, choices and pickers over options read, searched
  and labelled from an API, date ranges with presets in the viewer's time zone,
  labelled groups — checked against the model as values are entered, and kept
  in the address or a store between visits.
- **Listings that keep their place.** A [`Ui.Listing`](../ui/docs/listing.md)
  is drawn as a table, a list, cards, a kanban board, a calendar, a timeline
  or a tree — read as its layout's read plan says, and paged by a pager, a
  "Load more" button or infinite scroll, drawing only the pages in view. A
  card dragged to another column, an event to another day or a record under
  another parent runs the layout's move, with a "Move to" menu as its keyboard
  path. A write anywhere
  on the page reloads every listing of that collection without losing the
  viewer's place, an open form or what it holds, and a related record is shown
  by its label, looked up in batches. [How listings behave](docs/app.md#listings-and-filter-bars).
- **Filter bars as declared.** Every [placement](../ui/docs/filter-placement.md)
  and every control is drawn — a bar above or beside the list, folded behind
  a toggle or in an overlay; chips, switches, sliders, tags, presets — and the
  chosen filters are kept [in the address or the browser's
  storage](docs/urls.md#filter-state) when the bar says so. A filter over a
  related record offers those records by name, and can offer only the values
  present under the other filters, each with its count.
- **Operations without a script.** A [`Ui.Action`](../ui/docs/action.md) is
  drawn as a form and a button: the record is checked in the page, posted,
  and the lists the action declares are drawn from the answer — links
  included. A listing offers the same operations on each record, with a question
  first where one is declared.
- **Lists are entered, not just shown.** A list property is a group of options
  or typed tags, in every form.
- **Served in the viewer's language.** With a translator, every text — page
  titles, labels, a model's titles and enumeration labels, the renderer's own
  words — is translated on the server for the language a request asks for
  (`lang:`, from `Accept-Language` or a cookie), the browser choosing plural
  forms and formatting numbers; each document says which headers it varies
  on, and one copy is kept per language.
- **An open seam.** A module ships its own React components, and they get
  navigation, requests and refresh from the host — and its own listing layouts
  (a map, a seat plan), given the records the renderer reads under the
  [layout contract](docs/layouts-abi.md).

## Kinds

| Kind | Purpose |
| --- | --- |
| [`UiReact.App`](docs/app.md) | An application of pages, mounted on an HTTP server. |
| [`UiReact.Theme`](docs/theme.md) | A look: stylesheets, token defaults and, optionally, control sets drawn in place of the built-ins. |
| [`UiReact.Controls`](docs/theme.md#control-sets) | A set of controls a module ships, written against the [controls contract](docs/controls-abi.md). |

| Instance | Purpose |
| --- | --- |
| [`UiReact.defaultTheme`](docs/theme.md#the-default-theme) | The built-in look: every part styled, light and dark. |

Also: [what it serves](docs/urls.md), [the styling contract](docs/styling.md),
[the controls contract](docs/controls-abi.md) every text box, choice, list,
overlay and glyph is drawn under, [the component ABI](docs/component-abi.md),
and [the layout contract](docs/layouts-abi.md) a module's listing layout is
written against.

## Example

```yaml
kind: Telo.Application
metadata: { name: TodoAdmin, version: 1.0.0 }
lang: en
imports:
  Http: oci://ghcr.io/telorun/http-server
  DataModel: oci://ghcr.io/telorun/data-model
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
  required: [id, text]
  properties:
    id: { type: integer }
    text: { type: string, title: Task, minLength: 1 }
    isDone: { type: boolean, title: Done }
---
kind: Telo.JsonSchema
metadata: { name: TodoInput }
schema:
  type: object
  required: [text]
  properties:
    text: { type: string, title: Task, minLength: 1 }
    isDone: { type: boolean, title: Done }
---
# What the collection's list accepts: the listing sorts only by what it lists.
kind: Ui.CollectionPresentation
metadata: { name: todos }
source:
  kind: Ui.CollectionSource
  basePath: /api/todos
  collection:
    kind: DataModel.Collection
    model: !ref Todo
    query: { filters: [], sort: [{ property: text }] }
---
kind: UiReact.App
metadata: { name: admin }
title: Todo Admin
words: !ref Ui.words
theme: !ref UiReact.defaultTheme
tokens: { kind: Ui.DesignTokens, color.accent: "#1d4ed8" }
pages:
  - kind: Ui.Page
    path: /
    title: Todos
    children:
      - type: composite
        ref:
          kind: Ui.Listing
          presentation: !ref todos
          model: !ref Todo
          create:
            form: { kind: Ui.Form, model: !ref TodoInput, presentation: !ref todos }
          delete: true
---
kind: Http.Server
metadata: { name: server }
listen:
  port: !cel "ports.http"
mounts:
  - path: /api/todos
    mount: !ref todosApi     # anything speaking the collection contract
  - path: /
    mount: !ref admin
```

The renderer's own words — button labels, validation messages — are `ui`'s
[words](../ui/docs/texts.md#the-renderers-own-words), English in `Ui.words`
and translated like any other text; see [Languages](docs/app.md#languages).
