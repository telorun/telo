---
status: draft
priority: high
depends-on: []
packages: [modules/ui, modules/ui-react, modules/ui-react-radix, modules/crud-ui, examples/ui-showcase, examples/chat, apps/hub, apps/authoring-agent, docs]
---

# Pressing anything, and pages that open in place

## Problem

Only three things in a screen react to a press: a `link` navigates, a `button` node or row action runs an action, and a listing's `edit` opener opens a form. Everything else is inert:

- A card in `Ui.CardLayout`, a table row, a board card, a calendar event, a `badge`, an `image`, a `value` cannot do anything when pressed. Making a card open something means putting a `link` inside it.
- Nothing but a form opens over the current page. A record's page (`/posts/{id}`) can only be navigated to, leaving the list behind; there is no way to show it in a dialog or drawer.
- "Where pressing this goes" is spelled `href` on a `value` node, a `list` column, a `Ui.TableLayout` column and a relation, and nothing else can say it.

## Surface

**Added**

- `press` — key on the `box`, `stack`, `columns`, `text`, `badge`, `image`, `svg`, `value` and `time` nodes, on `list` and `Ui.TableLayout` columns, on a `Ui.CollectionPresentation` relation, on `Ui.Listing` and on `CrudUi.Admin`: what pressing it does.
- `Ui.Press` — abstract over the press kinds, declaring `label`, a required `Ui.BoundText`: the press's accessible name.
- `Ui.Navigate` — press kind `{ href, label }`: moves to an address.
- `Ui.OpenPage` — press kind `{ page, pathParams?, queryParams?, surface?, label }`: opens a page over the current one in a `Ui.ViewportOverlay`.
- `Ui.PressSpec` — the wire form of a press, `type` one of `navigate | openPage`, as `press` on every pressable `Ui.SpecNode` branch, `list` column and relation spec.
- `ui_react_layouts-2` — the layout contract's next generation: a record's `press` member, `onOpen` running the press, `selected` reporting it; the renderer hosts `-1` and `-2`.
- `press` — styling part: the element spanning a pressed node or record, its geometry reserved to the renderer's base layer.

**Changed**

- `_telo.open.<name>` — for an opened page, holds the page's app-relative address (`_telo.open.post=%2Fposts%2Fhello`).
- `data-selected` on a record part — also set while the page its press opened is open.
- The reserved (part, property) pairs — `press` (`position`, `inset`, `z-index`), any part holding a `press`, a `table-cell` of a pressed `table-row` and interactive content after a `press` (`position`), reported by `CheckTheme` when a theme sets them.

**Removed**

- `href` on the `value` node, on `list` and `Ui.TableLayout` columns and on a relation — `SCHEMA_VIOLATION`; `press: { kind: Ui.Navigate, href, label }` replaces it.
- `href` on the wire's `value` branch, `list` column branches and relation spec — `press` carries it.

## Solution

**Two press kinds under one abstract.** `press` is a reference slot (`x-telo-ref`, `use: dependency`, kind `Ui.Press`) holding an inline declaration, so a press is checked with its own schema and typed regions wherever it is written, inside a node tree included. Anything but a `Ui.Press` at the slot is `REFERENCE_KIND_MISMATCH`. `Ui.Press` is a `Telo.Provider` abstract whose `outputType` is `Ui.PressSpec`; unlike `Ui.Surface`, which declares no schema, it declares the one key every press shares, `label`.

- `Ui.Navigate` — `href` is a `Ui.Address`. Drawn as a real `<a>`, so it opens in a new tab like any link.
- `Ui.OpenPage` — `page` is a `use: schema` reference to a `Ui.Page` (a declaration read, as `Ui.Address` reads a page's `path`, so two pages may open each other); `pathParams` carries `x-telo-path-params-for: { template: /page, through: path }`, so a missing or unknown variable is `PATH_PARAMETER_UNBOUND` / `PATH_PARAMETER_UNUSED`; `queryParams` is an address's; `surface`, the surface it opens in over a page, is a `use: dependency` reference to a `Ui.ViewportOverlay` (a dialog or a drawer, since a whole page has no anchor), a `Ui.Dialog` when omitted, filled by `ui`. The renderer fetches the opened page's own page document — the one a navigation to its address fetches — and draws its children in the surface, titled by the page's `title`, else by the press's `label`. A page no application lists draws the not-found page in the surface, as a link to it would.

A press's accessors — `href`, `pathParams`, `queryParams`, `label`'s values — read the roots in scope where it is written (`row`, `data`, `query`, `params`, `values`, `result`, `input`), each typed from the referrer's binding (`x-telo-context-from-referrer`); a root absent there is `CEL_UNKNOWN_IDENTIFIER`. A relation's press reads `row` as the related record, as its `href` did.

**The accessible name is `label`**, required, so it is checked statically (`SCHEMA_VIOLATION` when absent, `CEL_UNKNOWN_FIELD` for a misspelt value), crosses the wire as one text and names the press element the same way in every renderer and layout component. Being a `Ui.BoundText` it names each record (`Read {$title}`); it should contain the visible text, so speech input finds it. Nothing is computed from drawn content: a card is named by its label rather than announced as all of its text.

Running an action stays the `button` node and row actions; a third press kind running one would be a second spelling of those with a second place to draw the answer.

**Where `press` replaces `href`.** On a `value` node, a `list` column, a `Ui.TableLayout` column and a relation, `press` is the only way to say what pressing does, and `href` there is `SCHEMA_VIOLATION`. A `link` node, a `menu` item and a `Ui.CollectionOptions` choice keep `href`, since each is the link itself. There is no manifest migration: matching the `Ui.` prefix and every hosting kind in a data migration is the obstacle the composable chat plan declined; in-repo manifests are updated and the `ui` fragment describes the break.

**A pressed container** uses the covering-target pattern, and its geometry is the renderer's, reserved in its base layer as the page width is, so no theme, control set or layout component restates it: the `press` element is the first child of the element it covers (of a table row's first cell), absolutely positioned at `inset: 0`; the covered element is positioned as its containing block (a pressed `table-row` itself, its cells left unpositioned); and interactive content after it inside the covered element — links, buttons, form controls, `label`, `summary`, `[tabindex]`, `[contenteditable]` — is positioned, so it paints above the press by tree order and stays separately reachable. A nested pressed container is raised by the same rule, so nesting presses needs no rule. A theme paints only the press's focus ring:

```css
[data-telo-part="press"]:focus-visible { outline: 2px solid currentColor; outline-offset: 2px; border-radius: inherit; }
```

Text inside a pressed container cannot be drag-selected, the pattern's own cost.

**A listing's press is explicit.** `Ui.Listing.press` says what pressing a record does, over `row`; written, the record's edit stays on its edit button. Without `press` a record press is what it is today: the `edit` opener. No resource changes another's press, so editing a shared presentation never changes a listing over it. `CrudUi.Admin.press` is forwarded whole to its listing, `row` typed from `source.collection.schemas.list` as its `layout` is.

**Opened pages.** The page shell hosts one opened page at a time. With `surface.address: { name }` the open page is `_telo.open.<name>=<app-relative address>`, so a reload or a shared link reopens it; a cold load opens it in the surface of the first press, in document order, whose surface declares that name, whatever page the value names, and a value that is not an app-relative address opens nothing and is dropped by replace. A name belongs to its first owner on the page — a listing (its `create` and `edit` sharing it, as today), a filter overlay, a `tabs` node or a page press — and a later owner of the same name keeps its state in memory.

An opened page is a context its own presses navigate: an `Ui.OpenPage` pressed inside it keeps the host surface — its kind, name and `compact` — replaces only the content, takes the history entry and rewrites `_telo.open.<name>` to the new page's address. A `Ui.Navigate` inside it navigates the application, which closes it. A press on the underlying page while a non-modal surface is open opens its page in its own surface, closing the current one and taking its entry, so Back never walks a chain of opened pages; when both presses name one surface declaration (two cards of one listing) the surface stays and only its content changes. Escape and close shut it, drop its parameter and return focus to the underlying element that opened what is shown. Every address an opened page's own nodes would write (`_telo.open.*`, `_telo.f.*`, `_telo.v.*`) is kept in memory, so only the opened page's address enters the host's.

```text
/?_telo.open.post=%2Fposts%2Fhello                       the posts page, post "hello" open in the end drawer
/?_telo.open.post=%2Fauthors%2Fada%3Ffrom%3Dhello        "About the author" pressed inside it: the same drawer, now Ada's page
/posts/hello                                             post "hello" as a page of its own
```

**Selection.** A record part carries `data-selected` while a press of its own content (the listing's `press`, or a column's or `value` node's inside it) leads to where the viewer is: its resolved address — path and query, `_telo*` parameters aside — equals the current address for `Ui.Navigate`, or the open page's address for `Ui.OpenPage`. A relation label's press never selects its row.

**Layouts.** Every built-in layout draws the record press across the whole record (table row, list item, card, board card, calendar and timeline event, tree item). Drawing a press is a new required behaviour, so it is `ui_react_layouts-2`, and the renderer hosts both generations: a `-2` record gains `press` — the element the renderer draws for the listing's press, `null` without one — which a component places as its record root's first child; `selected` holds whether that press leads to where the viewer is, and the component sets `data-selected` from it; `onOpen(key)` runs the press, else the `edit` opener, `can.open` holding for either. A `-1` component is handed records with no `press` and `selected` always `false`, and still opens records, press included, through `onOpen`. A `-2` component under a renderer hosting only `-1` is replaced by `ERR_UI_COMPONENT_ABI_UNSUPPORTED` naming `ui_react_layouts-2` at start. The built-ins move to `-2`. A component layout written for it:

```yaml
kind: Telo.Library
metadata:
  name: GalleryLayout
  version: 1.0.0
  description: A gallery of records drawn by a browser component, each record opening as its listing's press says.
requires: { telo: ">=unreleased" }
imports:
  Ui: ../../modules/ui
exports:
  resources: [gallery]
  browser:
    - specifier: "@example/gallery"
      path: ./browser/gallery.js
      source: ./browser/src/gallery.tsx
      abi: ui_react_layouts-2
      external: [react]
      exports: [Gallery]
---
kind: Ui.ComponentExport
metadata: { name: gallery }
entry: "@example/gallery"
export: Gallery
props: { kind: Telo.JsonSchema, schema: { type: object, additionalProperties: false, properties: {} } }
```

```tsx
import type { LayoutProps } from "@telorun/ui-react-contract";

export function Gallery({ records }: LayoutProps) {
  return (
    <ul className="gallery">
      {records.map((record) => (
        <li key={record.key} className="gallery-item" data-selected={record.selected || undefined}>
          {record.press}
          <h3>{String(record.row.title)}</h3>
          {record.actions}
        </li>
      ))}
    </ul>
  );
}
```

**Wire.** Every pressable `Ui.SpecNode` branch, `list` column and relation spec carries `press` (null when absent), a `Ui.PressSpec` whose `type` is one-to-one with the kind; its `href` is the wire's existing address shape — a template and bindings resolved in the browser, since `row` exists only there — its `label` the wire's text or bound text, and `ui` fills the surface, so a renderer reads no default. The author page's badge, then the card listing's press:

```json
{
  "type": "navigate",
  "href": { "path": { "value": "/" }, "pathParams": {}, "queryParams": {} },
  "label": { "text": "All posts", "context": null, "lang": "en", "computed": false }
}
```

```json
{
  "type": "openPage",
  "href": { "path": { "value": "/posts/{id}" }, "pathParams": { "id": { "root": "row", "path": ["id"] } }, "queryParams": {} },
  "label": {
    "text": { "text": "Open {$title}", "context": null, "lang": "en", "computed": false },
    "values": { "title": { "root": "row", "path": ["title"] } }
  },
  "surface": {
    "type": "drawer",
    "side": "end",
    "size": "medium",
    "modal": true,
    "dismiss": { "escape": true, "outside": true, "closeButton": true },
    "address": { "name": "post" }
  }
}
```

## Example

Before — a card can open a post only through a link inside it, a column and a relation say where they go with `href`, and every record page is reached by leaving the list:

```yaml
kind: Telo.Library
metadata:
  name: BlogScreens
  version: 1.0.0
  description: Screens over a blog's posts and their authors.
requires: { telo: ">=0.133.0" }
lang: en
imports:
  DataModel: ../../modules/data-model
  Ui: ../../modules/ui
  UiReact: ../../modules/ui-react
exports:
  resources: [ui]
---
kind: Telo.JsonSchema
metadata: { name: Author }
schema:
  type: object
  required: [id, name]
  properties: { id: { type: string }, name: { type: string, title: Name } }
---
kind: Telo.JsonSchema
metadata: { name: Post }
schema:
  type: object
  required: [id, title, authorId]
  properties:
    id: { type: string }
    title: { type: string, title: Title }
    authorId: { type: string, title: Author }
---
kind: DataModel.Collection
metadata: { name: authors }
model: !ref Author
query: { filters: [{ property: id, operator: in }], sort: [] }
---
kind: Ui.CollectionPresentation
metadata: { name: postsPresentation }
source:
  kind: Ui.CollectionSource
  basePath: /api/posts
  collection:
    kind: DataModel.Collection
    model: !ref Post
    query: { filters: [{ property: id, operator: in }], sort: [{ property: title }] }
    relations: { authorId: { collection: !ref authors } }
relations:
  authorId:
    source: { kind: Ui.CollectionSource, collection: !ref authors, basePath: /api/authors }
    label: !cel "row.name"
    href: { path: !ref authorPage, pathParams: { id: !cel "row.id" } }
---
kind: Ui.Page
metadata: { name: postPage }
path: /posts/{id}
title: Post
children:
  - type: composite
    ref:
      kind: Ui.Data
      model: !ref Post
      source: { path: "/api/posts/{id}", pathParams: { id: !cel "params.id" } }
      content: { type: text, style: heading, text: { text: "{$title}", values: { title: !cel "data.title" } } }
---
kind: Ui.Page
metadata: { name: authorPage }
path: /authors/{id}
title: Author
children:
  - type: composite
    ref:
      kind: Ui.Data
      model: !ref Author
      source: { path: "/api/authors/{id}", pathParams: { id: !cel "params.id" } }
      content: { type: value, value: !cel "data.name" }
---
kind: UiReact.App
metadata: { name: ui }
title: Blog
theme: !ref UiReact.defaultTheme
pages:
  - kind: Ui.Page
    path: /
    title: Posts
    children:
      - type: composite
        ref:
          kind: Ui.Listing
          presentation: !ref postsPresentation
          model: !ref Post
          layout:
            kind: Ui.CardLayout
            content:
              type: stack
              children:
                - { type: text, text: { text: "{$title}", values: { title: !cel "row.title" } } }
                - type: link
                  text: Open
                  href: { path: !ref postPage, pathParams: { id: !cel "row.id" } }
  - kind: Ui.Page
    path: /table
    title: Post table
    children:
      - type: composite
        ref:
          kind: Ui.Listing
          presentation: !ref postsPresentation
          model: !ref Post
          layout:
            kind: Ui.TableLayout
            columns:
              - value: !cel "row.title"
                href: { path: !ref postPage, pathParams: { id: !cel "row.id" } }
              - value: !cel "row.authorId"
  - !ref postPage
  - !ref authorPage
```

After — the whole card opens the post in an end drawer kept in the address, the card's own link still goes to the full page, the author's label opens the author's page in a dialog, the post's "About the author" turns the drawer into the author's page, the author's page opens each of the author's posts in turn and goes back to the post it came from, and its badge navigates to the list:

```yaml
kind: Telo.Library
metadata:
  name: BlogScreens
  version: 1.1.0
  description: Screens over a blog's posts and their authors, each record opening over the list.
requires: { telo: ">=unreleased" }
lang: en
imports:
  DataModel: ../../modules/data-model
  Ui: ../../modules/ui
  UiReact: ../../modules/ui-react
exports:
  resources: [ui]
---
kind: Telo.JsonSchema
metadata: { name: Author }
schema:
  type: object
  required: [id, name]
  properties: { id: { type: string }, name: { type: string, title: Name } }
---
kind: Telo.JsonSchema
metadata: { name: Post }
schema:
  type: object
  required: [id, title, authorId]
  properties:
    id: { type: string }
    title: { type: string, title: Title }
    body: { type: string, title: Body }
    authorId: { type: string, title: Author }
---
kind: DataModel.Collection
metadata: { name: authors }
model: !ref Author
query: { filters: [{ property: id, operator: in }], sort: [] }
---
kind: Ui.CollectionPresentation
metadata: { name: postsPresentation }
source:
  kind: Ui.CollectionSource
  basePath: /api/posts
  collection:
    kind: DataModel.Collection
    model: !ref Post
    query: { filters: [{ property: id, operator: in }, { property: authorId, operator: eq }], sort: [{ property: title }] }
    relations: { authorId: { collection: !ref authors } }
relations:
  authorId:
    source: { kind: Ui.CollectionSource, collection: !ref authors, basePath: /api/authors }
    label: !cel "row.name"
    # `row` is the author; the page opens in a dialog, unaddressed.
    press:
      kind: Ui.OpenPage
      page: !ref authorPage
      pathParams: { id: !cel "row.id" }
      label: { text: "{$name}", values: { name: !cel "row.name" } }
---
kind: Ui.Page
metadata: { name: postsPage }
path: /
title: Posts
children:
  - type: composite
    ref:
      kind: Ui.Listing
      presentation: !ref postsPresentation
      model: !ref Post
      # Pressing a card opens the post in an end drawer: `?_telo.open.post=%2Fposts%2Fhello`.
      press:
        kind: Ui.OpenPage
        page: !ref postPage
        pathParams: { id: !cel "row.id" }
        label: { text: "Open {$title}", values: { title: !cel "row.title" } }
        surface: { kind: Ui.Drawer, side: end, address: { name: post } }
      # With `press` written, editing is the record's edit button.
      edit: { form: { kind: Ui.Form, model: !ref Post, presentation: !ref postsPresentation, fields: [title, body, authorId] } }
      layout:
        kind: Ui.CardLayout
        size: small
        content:
          type: stack
          children:
            - { type: text, text: { text: "{$title}", values: { title: !cel "row.title" } } }
            # A target of its own above the card's: it goes to the full page.
            - type: link
              text: Full page
              href: { path: !ref postPage, pathParams: { id: !cel "row.id" } }
---
kind: Ui.Page
metadata: { name: postPage }
path: /posts/{id}
title: Post
children:
  - type: composite
    ref:
      kind: Ui.Data
      model: !ref Post
      source: { path: "/api/posts/{id}", pathParams: { id: !cel "params.id" } }
      content:
        type: stack
        children:
          - { type: text, style: heading, text: { text: "{$title}", values: { title: !cel "data.title" } } }
          - { type: value, value: !cel "data.body" }
          # Opened inside the post's drawer, the author's page replaces it there.
          - type: text
            text: About the author
            press:
              kind: Ui.OpenPage
              page: !ref authorPage
              pathParams: { id: !cel "data.authorId" }
              queryParams: { from: !cel "data.id" }
              label: About the author
---
kind: Ui.Page
metadata: { name: authorPage }
path: /authors/{id}
title: Author
# The post this page was opened from, when it was.
query: { from: { type: string } }
children:
  - type: composite
    ref:
      kind: Ui.Data
      model: !ref Author
      source: { path: "/api/authors/{id}", pathParams: { id: !cel "params.id" } }
      content:
        type: stack
        children:
          - { type: value, value: !cel "data.name" }
          - type: badge
            text: All posts
            press: { kind: Ui.Navigate, href: { path: !ref postsPage }, label: All posts }
  - type: text
    text: Back to the post
    shown: { at: !cel "query.from", matches: { type: string } }
    press:
      kind: Ui.OpenPage
      page: !ref postPage
      pathParams: { id: !cel "query.from" }
      label: Back to the post
  # The author's posts. Pressing one opens it — over the list, or replacing
  # this page when it is itself open over another.
  - type: composite
    ref:
      kind: Ui.Listing
      presentation: !ref postsPresentation
      model: !ref Post
      filters: { authorId: !cel "params.id" }
      press:
        kind: Ui.OpenPage
        page: !ref postPage
        pathParams: { id: !cel "row.id" }
        label: { text: "Read {$title}", values: { title: !cel "row.title" } }
      layout: { kind: Ui.ListLayout }
---
kind: UiReact.App
metadata: { name: ui }
title: Blog
theme: !ref UiReact.defaultTheme
pages:
  - !ref postsPage
  - kind: Ui.Page
    path: /table
    title: Post table
    children:
      - type: composite
        ref:
          kind: Ui.Listing
          presentation: !ref postsPresentation
          model: !ref Post
          layout:
            kind: Ui.TableLayout
            columns:
              - value: !cel "row.title"
                press:
                  kind: Ui.Navigate
                  href: { path: !ref postPage, pathParams: { id: !cel "row.id" } }
                  label: { text: "{$title}", values: { title: !cel "row.title" } }
              # The author's label opens the author's page, as the presentation says.
              - value: !cel "row.authorId"
  - !ref postPage
  - !ref authorPage
```

An Admin opens its rows the same way:

```yaml
kind: Telo.Library
metadata:
  name: TaskScreens
  version: 1.0.0
  description: An admin over tasks whose rows open each task over the list.
requires: { telo: ">=unreleased" }
lang: en
imports:
  Crud: ../../modules/crud
  CrudUi: ../../modules/crud-ui
  Ui: ../../modules/ui
  UiReact: ../../modules/ui-react
  SQLite: ../../modules/sqlite
exports:
  resources: [ui]
---
kind: Telo.JsonSchema
metadata: { name: NewTask }
schema:
  type: object
  required: [title]
  additionalProperties: false
  properties: { title: { type: string, title: Title, minLength: 1 } }
---
kind: Telo.JsonSchema
metadata: { name: Task }
extends: NewTask
schema:
  type: object
  required: [id]
  properties: { id: { type: integer } }
---
kind: SQLite.Table
metadata: { name: tasksTable }
table: tasks
columns:
  id: { type: integer, primaryKey: true, identity: always }
  title: { type: text, nullable: false }
---
kind: Ui.Page
metadata: { name: taskPage }
path: /tasks/{id}
title: Task
children:
  - type: composite
    ref:
      kind: Ui.Data
      model: !ref Task
      source: { path: "/api/tasks/{id}", pathParams: { id: !cel "params.id" } }
      content: { type: value, value: !cel "data.title" }
---
kind: UiReact.App
metadata: { name: ui }
title: Tasks
theme: !ref UiReact.defaultTheme
pages:
  - kind: Ui.Page
    path: /
    title: Tasks
    children:
      - type: composite
        ref:
          kind: CrudUi.Admin
          source:
            kind: CrudUi.CollectionSource
            basePath: /api/tasks
            collection:
              kind: Crud.Collection
              model: !ref Task
              table: !ref tasksTable
              schemas: { list: !ref Task, create: !ref NewTask, update: !ref NewTask }
              query: { filters: [], sort: [{ property: title }] }
          press:
            kind: Ui.OpenPage
            page: !ref taskPage
            pathParams: { id: !cel "row.id" }
            label: { text: "Open {$title}", values: { title: !cel "row.title" } }
  - !ref taskPage
```

Refused — every line marked below is reported by `telo check` where it is written, and the kernel refuses the same at load:

```yaml
kind: Telo.Library
metadata:
  name: BlogRefused
  version: 1.0.0
  description: Presses that are refused.
requires: { telo: ">=unreleased" }
lang: en
imports:
  Ui: ../../modules/ui
---
kind: Telo.JsonSchema
metadata: { name: Author }
schema: { type: object, required: [id], properties: { id: { type: string } } }
---
kind: Ui.Page
metadata: { name: authorPage }
path: /authors/{id}
title: Author
children: [{ type: text, text: An author }]
---
kind: Ui.Page
metadata: { name: homePage }
path: /
title: Home
children:
  # PATH_PARAMETER_UNBOUND — `/authors/{id}` needs `id`.
  - { type: text, text: Newest author, press: { kind: Ui.OpenPage, page: !ref authorPage, label: Newest author } }
  # REFERENCE_KIND_MISMATCH — `page` names a Ui.Page.
  - { type: badge, text: Authors, press: { kind: Ui.OpenPage, page: !ref Author, label: Authors } }
  # CEL_UNKNOWN_IDENTIFIER — a page's own nodes bind no `row`.
  - type: text
    text: First author
    press: { kind: Ui.OpenPage, page: !ref authorPage, pathParams: { id: !cel "row.id" }, label: First author }
  # SCHEMA_VIOLATION — a press needs a `label`.
  - { type: text, text: Ada, press: { kind: Ui.OpenPage, page: !ref authorPage, pathParams: { id: ada } } }
  # SCHEMA_VIOLATION — `href` is gone from `value`; write `press: { kind: Ui.Navigate, href, label }`.
  - { type: value, value: ada, href: { path: !ref authorPage, pathParams: { id: ada } } }
  # REFERENCE_KIND_MISMATCH — a press is a Ui.Press.
  - { type: text, text: Close, press: { kind: Ui.Dialog } }
  # REFERENCE_KIND_MISMATCH — a page opens in a Ui.ViewportOverlay: a dialog or a drawer.
  - type: text
    text: Ada in a popover
    press:
      kind: Ui.OpenPage
      page: !ref authorPage
      pathParams: { id: ada }
      label: Ada
      surface: { kind: Ui.Popover, side: bottom }
```

## Verify

- On `/`, pressing a card opens the post in an end drawer and the address becomes `/?_telo.open.post=%2Fposts%2Fhello`; the card carries `data-selected` while its post is open, and no other card does; reloading reopens it; Escape closes it, drops the parameter and returns focus to the card. The card's "Full page" link navigates to `/posts/hello`, by mouse and by keyboard, without opening the drawer.
- Inside the open post, "About the author" leaves the drawer open, the address becomes `/?_telo.open.post=%2Fauthors%2Fada%3Ffrom%3Dhello` with no new history entry, and "Back to the post" is shown; reloading reopens Ada's page in the drawer; pressing one of her posts there replaces it again; Back after closing returns to `/`. `postPage` and `authorPage` open each other and pass `telo check` and boot. "All posts" navigates the application to `/` and closes the drawer.
- With a non-modal drawer open, pressing another card swaps the drawer's content and replaces the entry; a press on a listing whose surface has another name closes the drawer and writes only its own key.
- On `/table`, the title cell is a real `<a>` to `/posts/<id>` that opens in a new tab, and the author label opens the author's page in a dialog, unaddressed, without selecting its row.
- Every press element's accessible name is exactly its formatted `label` ("Open Hello world", "Ada"); no renderer code reads text out of drawn content to name anything.
- With `press` written, the record's edit button opens the `edit` form; a listing with `edit` and no `press` behaves as today.
- A fixture holding a filter bar and an addressed `edit` opener inside an opened page writes neither to the host's address.
- Each refused line above is reported by `telo check` with the code shown, and fails a consumer's run with its kernel twin; `href` on a `list` column, a `Ui.TableLayout` column and a relation is `SCHEMA_VIOLATION` too.
- A press inside a `Ui.Data` tree inside a `list` column types `data` and `row` from the referrer — one fixture with a field misspelt in each is `CEL_UNKNOWN_FIELD` twice.
- Layouts: the layout vectors hold `press` as the first child of each built-in record root (of the first cell for a table); the hosted generations are `ui_react_layouts-1` and `-2` and an unknown one is refused; a `-2` component under a renderer hosting only `-1` is replaced by `ERR_UI_COMPONENT_ABI_UNSUPPORTED` naming `ui_react_layouts-2`; a `-1` component opens records through `onOpen` and runs the listing's press; the `GalleryLayout` component draws `record.press` and sets `data-selected` from `selected`.
- In a real browser engine — happy-dom does no layout — a pointer on a card, a table row and a component record lands on the press over text and on a nested link, row action or control over those.
- `CheckTheme` passes for both built-in themes and the showcase brand theme with no geometry declared for `press`, and reports a theme that sets one of the new reserved pairs.
- The `TaskScreens` Admin opens `/tasks/<id>` in a dialog from a row.

## Bookkeeping

Docs: `ui` `nodes.md`, `presses.md` (new: the two kinds, `label` containing the visible text), `listing.md`, `listing-layouts.md`, `collection-presentation.md`, `surfaces.md` (a page opened in a surface, the context rule, the non-modal case, first owner of a name); `ui-react` `urls.md` (the opened page's address, the two-key cold load, in-memory addresses inside it), `layouts-abi.md` (both generations, the `-1` lane, `record.press` as the record root's first child, the root never `static`, a non-interactive element a component positions inside a record taking `pointer-events: none`), `styling.md` (the `press` part, the reserved rows, `data-selected`, no drag-selection inside a pressed container); `crud-ui` `admin.md`. The part list, the contract data and vectors for `-2`, the renderer's base layer, and the default theme's, `ui-react-radix`'s and the showcase `brand.css` focus styles for `press`. `examples/ui-showcase`, `examples/chat` and the in-repo test manifests moved off `href`; `Ui.CollectionOptions.href` (`examples/report-console`) stays. The hub `build-ui` guide (within its 32768-byte bound), the primer, `modules/CLAUDE.md`'s Declarative UI paragraph. A ledger entry under Standard library, "Records that open in place". `Added` fragments for `ui` (describing the `href` break), `ui-react` (`ui_react_layouts-2`), `ui-react-radix`, `crud-ui`; a changeset for `@telorun/ui-react-contract`. `telo release floor` for the showcase and every in-repo module adopting `press`.
