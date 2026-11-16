---
status: done
priority: high
depends-on: []
refinement: not-ready
packages: [analyzer, modules/ui, modules/ui-react, modules/ui-react-radix, modules/crud-ui, examples/ui-showcase, examples/chat, apps/hub, apps/authoring-agent, docs]
---

# Pressing anything, and pages that open in place

## Problem

Only three things in a screen react to a press: a `link` navigates, a `button` node or row action runs an action, and a listing's `edit` opener opens a form. Everything else is inert:

- A card in `Ui.CardLayout`, a table row, a board card, a calendar event, or a group of nodes cannot do anything when pressed. Making a card open something means putting a `link` inside it.
- Nothing but a form opens over the current page. A record's page (`/posts/{id}`) can only be navigated to, leaving the list behind; there is no way to show it in a dialog or drawer.
- "Where this goes" has a spelling per site — `href` on a `link`, a menu item, a `value` node, a `list` column, a `Ui.TableLayout` column, a relation, an option source and a navigation `link` entry, `onSuccess.navigate` on an action — each able only to move to an address, so no site can open a page over the current one and the next site that goes somewhere adds another key.

## Constraints

None.

## Surface

**Added**

- `Ui.Destination` — abstract over where something goes; its kinds are `Ui.Navigate` and `Ui.OpenPage`.
- `Ui.Navigate` — destination `{ href }`: moves to an address.
- `Ui.OpenPage` — destination `{ page, pathParams?, queryParams?, surface? }`: opens a page over the current one in a `Ui.ViewportOverlay`.
- `to` — the key holding a `Ui.Destination`: on the `link` node, a `menu` item, the `value` node, `list` and `Ui.TableLayout` columns, a `Ui.CollectionPresentation` relation, `Ui.OptionSource` (so `Ui.CollectionOptions`), a `Ui.Navigation` `link` entry, `Ui.Action.onSuccess` and `Ui.Press`.
- `Ui.Press` — named shape `{ to, label }`, `label` a required `Ui.BoundText`: what pressing a region does, and its accessible name.
- `press` — key holding a `Ui.Press`, on the `box`, `stack` and `columns` nodes, on `Ui.Listing` and on `CrudUi.Admin`.
- `_telo.page.<name>` — query key holding the app-relative address of the page open in the surface named `<name>` (`_telo.page.post=%2Fposts%2Fhello`), owned by the page shell.
- `Ui.DestinationSpec` — the wire form of a destination, `type` one of `navigate | openPage`, the `openPage` branch carrying `keepsSurface` (true exactly when `surface` was omitted); `Ui.PressSpec` — the wire form of a press, `{ to, label }`, as `press` on the `box`, `stack` and `columns` spec branches and as a listing's record press.
- `ui_react_layouts-2` — the layout contract's next generation: a record's `press` member, `selected` reporting it, `onOpen` running it; the renderer hosts it alone.
- `press` — styling part: the element spanning a pressed node or record, its geometry reserved to the renderer's base layer.

**Changed**

- `_telo.open.<name>`, `_telo.f.<key>.*`, `_telo.v.<key>.*` — written by nodes inside an opened page, kept in memory rather than in the address.
- `data-selected` on a record part, `current` on a navigation entry and a menu item — also set while the page their destination opened is open.
- The reserved (part, property) pairs — `press` (`position`, `inset`, `z-index`), any part holding a `press` (in a table, the first `table-cell` of a pressed `table-row`) and interactive content after a `press` (`position`), reported by `CheckTheme` when a theme sets them.
- `UI_PAGE_UNROUTED` — also reached through `Ui.OpenPage.page` at any `to`.
- `x-telo-context-withheld` — legal beside `x-telo-context-from-referrer`: the node is typed where a referrer's scope holds the path and withheld where a referrer's scope lacks it or nothing references the resource; `CONTEXT_WITHHELD_INVALID` no longer refuses the pair.
- `ERR_UI_COMPONENT_ABI_UNSUPPORTED` — names `ui_react_layouts-2`; a component layout built for `ui_react_layouts-1` now meets it.

**Removed**

- `href` on the `link` node, a `menu` item, the `value` node, `list` and `Ui.TableLayout` columns, a relation, `Ui.OptionSource` and a `Ui.Navigation` `link` entry — `SCHEMA_VIOLATION`; `to: { kind: Ui.Navigate, href }` replaces it.
- `Ui.Action.onSuccess.navigate` — `SCHEMA_VIOLATION`; `onSuccess.to` replaces it.
- `href` on the wire's `link`, `value`, menu item, `list` column, relation, option source and navigation `link` branches, and `navigate` on the wire's `onSuccess` — `to` carries them.
- `ui_react_layouts-1` — no longer hosted.

## Solution

**One destination vocabulary.** Wherever something goes somewhere it holds `to`: a reference slot (`x-telo-ref`, `use: dependency`, kind `Ui.Destination`) holding an inline declaration, so a destination is checked with its own schema and typed regions wherever it is written, inside a node tree included. `Ui.Destination` is an open abstract: a kind extending `Ui.Navigate` or `Ui.OpenPage` with `base:` (a "post page" destination over `id`) needs no change to `ui`, while a destination of a new wire `type` is one more `Ui.DestinationSpec` branch in `ui` and the renderer, as a new surface kind is. Anything but a `Ui.Destination` at the slot is `REFERENCE_KIND_MISMATCH`. `Ui.Destination` is a `Telo.Provider` abstract whose `outputType` is `Ui.DestinationSpec`; it declares no key of its own.

- `Ui.Navigate` — `href` is a `Ui.Address`.
- `Ui.OpenPage` — `page` is a `use: schema` reference to a `Ui.Page` (a declaration read, as `Ui.Address` reads a page's `path`, so two pages may open each other); `pathParams` carries `x-telo-path-params-for: { template: /page, through: path }`, so a missing or unknown variable is `PATH_PARAMETER_UNBOUND` / `PATH_PARAMETER_UNUSED`; `queryParams` is an address's; `surface`, the surface it opens in, is a `use: dependency` reference to a `Ui.ViewportOverlay` (a dialog or a drawer — a popover has no address of its own and a cold load has nothing to anchor it to). Omitted, it means the surface it is pressed in: inside an opened page that page's surface, anywhere else a dialog — `ui` fills it with `Ui.Dialog`'s defaults and sets `keepsSurface` on the wire, so a renderer reads no default. Written, it is always honoured. The renderer fetches the opened page's own page document — the one a navigation to its address fetches — and draws its children in the surface, titled by the page's `title`, else by the text or label naming what opened it. A page no application lists draws the not-found page in the surface, as a link to it would.

Every destination has an address, so every `to` is drawn as a real `<a>` to it and opens in a new tab like any link: for `Ui.OpenPage` that is the opened page's own address, an unmodified click opening it in the surface.

**Two shapes: a link, and a pressed region.** A site that draws one text — a `link` node, a menu item, a `value` node, a `list` or `Ui.TableLayout` column, a relation's label, an option, a navigation `link` entry — takes `to` directly and is named by that text, as `href` was. A region holding several things takes `press: { to, label }` — the named shape `Ui.Press`, on the `box`, `stack` and `columns` nodes, on `Ui.Listing` (the record press) and on `CrudUi.Admin`. A pressed `badge`, `image`, `svg` or `time` is a `box` with `press` around it; a pressed text is a `link`. `Ui.Action.onSuccess.to`, over `result` and `input`, takes the place of `onSuccess.navigate`, and the body-read rule counts a `to` reading `result`.

So the same `Ui.OpenPage` value opens the same page in the same surface from a card, a link, a menu item, a navbar entry and a success, and a later site that goes somewhere takes `to` rather than a key of its own. `href` and `onSuccess.navigate` at those sites are `SCHEMA_VIOLATION`; `press` on any other node is `SCHEMA_VIOLATION`. A `Ui.Navigation` `page` entry keeps its spelling: it is the site map's page reference, its text defaulting to the page's title. A navigation `link` entry or menu item holding a `Ui.OpenPage` needs nothing new of the `Navigation` control: it draws the page's address as its link and reports a plain press as `onChange(key)` as today, and the renderer opens the page for that key instead of moving to it. There is no manifest migration: matching the `Ui.` prefix and every hosting kind in a data migration is the obstacle the composable chat plan declined; in-repo manifests are updated and the `ui` fragment describes the break.

`UI_PAGE_UNROUTED` reaches a page through `Ui.OpenPage.page` at every `to`.

A destination's accessors — `href`, `pathParams`, `queryParams` — read the roots bound where its `to` is written (`row`, `data`, `query`, `params`, `values`, `result`, `input`): `Ui.Destination` declares every root once, as the region at its schema root, each binding typed from the referrer (`x-telo-context-from-referrer`) and withheld beside it (`x-telo-context-withheld`, one reason for all of them), and every merge-form destination kind — `Ui.Navigate`, `Ui.OpenPage`, another module's — inherits the region and declares none of its own (a `base:`-form child, whose schema is its own, declares it again). So a root the site binds is typed as the site types it, and a read of one it does not bind — `row` on a page's own `link` — is `CEL_UNKNOWN_IDENTIFIER`, naming the resource holding the `to` and saying a destination reads only the roots bound where it is written. The analyzer change this needs is generic: the withheld mark becomes legal beside `x-telo-context-from-referrer`, as the node's own reading wherever no referrer types it. A press's `label` values are written in the holder's own scope and read its bindings directly. A relation's `to` reads `row` as the related record, as its `href` did.

**The accessible name belongs to the trigger, not the destination.** A press carries `label`, required, so it is checked statically (`SCHEMA_VIOLATION` when absent, `CEL_UNKNOWN_FIELD` for a misspelt value), crosses the wire as one text and names the press element the same way in every renderer and layout component. Being a `Ui.BoundText` it names each record (`Read {$title}`); it should contain the visible text, so speech input finds it. Nothing is computed from drawn content: a card is named by its label rather than announced as all of its text. A site taking `to` directly is named by its own text, and a success effect has no name, which is why `label` is not a key of a destination.

**Running an action is never a destination.** It stays the `button` node, row actions and every other `Ui.BoundAction`: an action's answer and failure are drawn at its button, and a pressed card, a success effect or a link has no such place.

**A pressed container** uses the covering-target pattern, and its geometry is the renderer's, reserved in its base layer as the page width is, so no theme, control set or layout component restates it: the `press` element is the first child of the element it covers, absolutely positioned at `inset: 0`; the covered element is positioned as its containing block; and interactive content after it inside the covered element — links, buttons, form controls, `label`, `summary`, `[tabindex]`, `[contenteditable]` — is positioned, so it paints above the press by tree order and stays separately reachable. A nested pressed container is raised by the same rule, so nesting presses needs no rule. A theme paints only the press's focus ring:

```css
[data-telo-part="press"]:focus-visible { outline: 2px solid currentColor; outline-offset: 2px; border-radius: inherit; }
```

Text inside a pressed container cannot be drag-selected, the pattern's own cost — which is why a table's record press covers only the row's first cell, leaving every other cell's value copyable.

**A listing's press is explicit.** `Ui.Listing.press` says what pressing a record does, over `row`; written, the record's edit stays on its edit button. Without `press` a record press is what it is today: the `edit` opener. A listing's record press is its own `press`, never set by another resource; a relation's `to` lives on the shared `Ui.CollectionPresentation`, as its `href` did, and applies in every listing over it. `CrudUi.Admin.press` is forwarded whole to its listing, `row` typed from `source.collection.schemas.list` as its `layout` is.

**Opened pages.** The page shell hosts one opened page. Its address is the shell's own key, `_telo.page.<name>=<app-relative address>`, `<name>` the `surface.address` name — navigation state of the shell, apart from the node state under `_telo.open.*` (a listing's opener, a filter overlay, a `tabs` node), so a page and a listing may share a name. A cold load looks for the surface in the current route's page document, then its layout document (header, aside, footer), each in tree order, and opens the page in the surface of the first `Ui.OpenPage` declaring that name, whatever page the value names. The renderer writes `_telo.page.<name>` only when that lookup would restore a surface equal by value to the one being opened; otherwise the opened page is held in memory, so a reload never opens the wrong surface or nothing. A value that is not an app-relative address opens nothing and is dropped by replace; of several `_telo.page.*` keys the first in query order that resolves opens and the others are dropped.

Opening a page while one is open replaces it and takes its history entry, so Back never walks a chain of opened pages. An `Ui.OpenPage` with no `surface` reached inside an opened page keeps the host surface — its kind, name and `compact` — replaces only the content and rewrites `_telo.page.<name>` to the new page's address. One with a written `surface`, inside an opened page or on the underlying page while a non-modal surface is open, keeps the open surface and changes only its content when its filled surface spec equals the open one by value (two cards of one listing); otherwise the open surface closes with its key and its own opens. A `Ui.Navigate` inside an opened page navigates the application, which closes it. Escape and close shut it, drop its key and return focus to the underlying element that opened what is shown. Every address an opened page's own nodes would write (`_telo.open.*`, `_telo.f.*`, `_telo.v.*`) is kept in memory, so only the opened page's address enters the host's.

```text
/?_telo.page.post=%2Fposts%2Fhello                       the posts page, post "hello" open in the end drawer
/?_telo.page.post=%2Fauthors%2Fada%3Ffrom%3Dhello        "About the author" pressed inside it: the same drawer, now Ada's page
/posts/hello                                             post "hello" as a page of its own
```

**Selection.** A record part carries `data-selected` while its listing's press, or the `to` of a column or `value` node inside it, leads to where the viewer is: its resolved address — path and query, `_telo*` parameters aside — equals the current address for `Ui.Navigate`, or the open page's address for `Ui.OpenPage`. A navigation entry and a menu item are current by the same test. A relation label's `to` never selects its row.

**Layouts.** Every built-in layout draws the record press across the whole record (list item, card, board card, calendar and timeline event, tree item), except `Ui.TableLayout`, which draws it across the row's first cell — the author orders the columns, so the first is the record's name — while the row keeps `data-selected`. Drawing a press is a new required behaviour and `selected` changes meaning, so the layout contract is `ui_react_layouts-2`, hosted alone: a record gains `press` — the element the renderer draws for the listing's press, `null` without one — which a component places as the first child of the element it covers, its record root or one part of it; `selected` holds whether that press leads to where the viewer is, and the component sets `data-selected` from it; `onOpen(key)` runs the press, else the `edit` opener, `can.open` holding for either. A component built for `ui_react_layouts-1` replaces its listing with `ERR_UI_COMPONENT_ABI_UNSUPPORTED` naming `ui_react_layouts-2` at start; its author rebuilds against `-2`. A component layout written for it:

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

**Wire.** The `box`, `stack` and `columns` spec branches carry `press` (null when absent), a `Ui.PressSpec` `{ to, label }`; a `link` node, a menu item, a `value` node, a `list` column, a relation spec, an option source spec and a navigation `link` entry carry `to` in place of `href`, and an action's `onSuccess` carries `to` when written. `to` is a `Ui.DestinationSpec` whose `type` is one-to-one with the kind; its `href` is the wire's existing address shape — a template and bindings resolved in the browser, since `row` exists only there — a press's `label` the wire's text or bound text, and `ui` fills the surface and sets `keepsSurface`, so a renderer reads no default. The author page's "All posts" link's `to`, then the card listing's press:

```json
{ "type": "navigate", "href": { "path": { "value": "/" }, "pathParams": {}, "queryParams": {} } }
```

```json
{
  "to": {
    "type": "openPage",
    "href": { "path": { "value": "/posts/{id}" }, "pathParams": { "id": { "root": "row", "path": ["id"] } }, "queryParams": {} },
    "surface": {
      "type": "drawer",
      "side": "end",
      "size": "medium",
      "modal": true,
      "dismiss": { "escape": true, "outside": true, "closeButton": true },
      "address": { "name": "post" }
    },
    "keepsSurface": false
  },
  "label": {
    "text": { "text": "Open {$title}", "context": null, "lang": "en", "computed": false },
    "values": { "title": { "root": "row", "path": ["title"] } }
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

After — the whole card opens the post in an end drawer kept in the address, the card's own link still goes to the full page, the author's label opens the author's page in a dialog, the post's "About the author" turns the drawer into the author's page, the author's page opens each of the author's posts in turn and goes back to the post it came from, and its "All posts" link navigates to the list:

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
    to: { kind: Ui.OpenPage, page: !ref authorPage, pathParams: { id: !cel "row.id" } }
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
      # Pressing a card opens the post in an end drawer: `?_telo.page.post=%2Fposts%2Fhello`.
      press:
        to:
          kind: Ui.OpenPage
          page: !ref postPage
          pathParams: { id: !cel "row.id" }
          surface: { kind: Ui.Drawer, side: end, address: { name: post } }
        label: { text: "Open {$title}", values: { title: !cel "row.title" } }
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
              to: { kind: Ui.Navigate, href: { path: !ref postPage, pathParams: { id: !cel "row.id" } } }
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
          # No `surface`: opened inside the post's drawer, the author's page replaces it there.
          - type: link
            text: About the author
            to:
              kind: Ui.OpenPage
              page: !ref authorPage
              pathParams: { id: !cel "data.authorId" }
              queryParams: { from: !cel "data.id" }
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
          - { type: link, text: All posts, to: { kind: Ui.Navigate, href: { path: !ref postsPage } } }
  - type: link
    text: Back to the post
    shown: { at: !cel "query.from", matches: { type: string } }
    to: { kind: Ui.OpenPage, page: !ref postPage, pathParams: { id: !cel "query.from" } }
  # The author's posts. Pressing one opens it — over the list, or replacing
  # this page when it is itself open over another.
  - type: composite
    ref:
      kind: Ui.Listing
      presentation: !ref postsPresentation
      model: !ref Post
      filters: { authorId: !cel "params.id" }
      press:
        to: { kind: Ui.OpenPage, page: !ref postPage, pathParams: { id: !cel "row.id" } }
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
                to: { kind: Ui.Navigate, href: { path: !ref postPage, pathParams: { id: !cel "row.id" } } }
              # The author's label opens the author's page, as the presentation says.
              - value: !cel "row.authorId"
  - !ref postPage
  - !ref authorPage
```

Before — every other site that goes somewhere spells it `href` or `navigate`, and none can open a page over the current one:

```yaml
kind: Telo.Library
metadata:
  name: ProjectScreens
  version: 1.0.0
  description: Screens over projects and the people who own them.
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
metadata: { name: Person }
schema:
  type: object
  required: [id, name]
  properties: { id: { type: string }, name: { type: string, title: Name } }
---
kind: Telo.JsonSchema
metadata: { name: NewProject }
schema:
  type: object
  required: [name, ownerId]
  additionalProperties: false
  properties: { name: { type: string, title: Name, minLength: 1 }, ownerId: { type: string, title: Owner } }
---
kind: Telo.JsonSchema
metadata: { name: Project }
extends: NewProject
schema:
  type: object
  required: [id]
  properties: { id: { type: string } }
---
kind: Ui.Page
metadata: { name: helpPage }
path: /help
title: Help
query: { topic: { type: string } }
children: [{ type: text, text: How projects work }]
---
kind: Ui.Page
metadata: { name: personPage }
path: /people/{id}
title: Person
children:
  - type: composite
    ref:
      kind: Ui.Data
      model: !ref Person
      source: { path: "/api/people/{id}", pathParams: { id: !cel "params.id" } }
      content: { type: value, value: !cel "data.name" }
---
kind: Ui.Page
metadata: { name: projectPage }
path: /projects/{id}
title: Project
children:
  - type: composite
    ref:
      kind: Ui.Data
      model: !ref Project
      source: { path: "/api/projects/{id}", pathParams: { id: !cel "params.id" } }
      content:
        type: stack
        children:
          - { type: value, value: !cel "data.name" }
          - type: value
            value: !cel "data.ownerId"
            href: { path: !ref personPage, pathParams: { id: !cel "data.ownerId" } }
---
kind: Ui.Page
metadata: { name: homePage }
path: /
title: Projects
children:
  - type: menu
    text: Help
    items:
      - { type: link, text: Shortcuts, href: { path: !ref helpPage, queryParams: { topic: shortcuts } } }
      - { type: link, text: Status, href: "https://status.acme.test" }
  - type: composite
    ref:
      kind: Ui.Action
      inputModel: !ref NewProject
      outputModel: !ref Project
      request: { target: /api/projects }
      label: Create
      fields:
        - name
        - kind: Ui.ChoiceField
          property: ownerId
          options:
            kind: Ui.CollectionOptions
            model: !ref Person
            value: !cel "row.id"
            label: !cel "row.name"
            href: { path: !ref personPage, pathParams: { id: !cel "row.id" } }
            source:
              kind: Ui.CollectionSource
              basePath: /api/people
              collection: { kind: DataModel.Collection, model: !ref Person, query: { filters: [{ property: id, operator: in }], sort: [] } }
      onSuccess:
        navigate: { path: !ref projectPage, pathParams: { id: !cel "result.id" } }
        refreshes: [/api/projects]
---
kind: UiReact.App
metadata: { name: ui }
title: Projects
theme: !ref UiReact.defaultTheme
layout:
  kind: Ui.PageLayout
  header:
    - type: pane
      ref:
        kind: Ui.Navbar
        title: Acme
        navigation:
          items:
            - { type: page, page: !ref homePage }
            - { type: link, text: Help, href: { path: !ref helpPage } }
pages: [!ref homePage, !ref projectPage, !ref personPage, !ref helpPage]
```

After — the navbar's Help opens in a drawer, a menu item opens a help topic in a dialog, a pressed box opens the getting-started topic, an owner opens in a dialog from the project's page and from a chosen option, and a created project opens in a drawer:

```yaml
kind: Telo.Library
metadata:
  name: ProjectScreens
  version: 1.1.0
  description: Screens over projects and the people who own them, each opening over the page.
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
metadata: { name: Person }
schema:
  type: object
  required: [id, name]
  properties: { id: { type: string }, name: { type: string, title: Name } }
---
kind: Telo.JsonSchema
metadata: { name: NewProject }
schema:
  type: object
  required: [name, ownerId]
  additionalProperties: false
  properties: { name: { type: string, title: Name, minLength: 1 }, ownerId: { type: string, title: Owner } }
---
kind: Telo.JsonSchema
metadata: { name: Project }
extends: NewProject
schema:
  type: object
  required: [id]
  properties: { id: { type: string } }
---
kind: Ui.Page
metadata: { name: helpPage }
path: /help
title: Help
query: { topic: { type: string } }
children: [{ type: text, text: How projects work }]
---
kind: Ui.Page
metadata: { name: personPage }
path: /people/{id}
title: Person
children:
  - type: composite
    ref:
      kind: Ui.Data
      model: !ref Person
      source: { path: "/api/people/{id}", pathParams: { id: !cel "params.id" } }
      content: { type: value, value: !cel "data.name" }
---
kind: Ui.Page
metadata: { name: projectPage }
path: /projects/{id}
title: Project
children:
  - type: composite
    ref:
      kind: Ui.Data
      model: !ref Project
      source: { path: "/api/projects/{id}", pathParams: { id: !cel "params.id" } }
      content:
        type: stack
        children:
          - { type: value, value: !cel "data.name" }
          # Inside the drawer a created project opens in, the owner replaces it there.
          - type: value
            value: !cel "data.ownerId"
            to: { kind: Ui.OpenPage, page: !ref personPage, pathParams: { id: !cel "data.ownerId" } }
---
kind: Ui.Page
metadata: { name: homePage }
path: /
title: Projects
children:
  - type: menu
    text: Help
    items:
      - type: link
        text: Shortcuts
        to: { kind: Ui.OpenPage, page: !ref helpPage, queryParams: { topic: shortcuts }, surface: { kind: Ui.Dialog, size: small } }
      - { type: link, text: Status, to: { kind: Ui.Navigate, href: "https://status.acme.test" } }
  # One region, one target: the badge and both texts open the topic together.
  - type: box
    press:
      to: { kind: Ui.OpenPage, page: !ref helpPage, queryParams: { topic: getting-started } }
      label: Getting started
    children:
      - { type: badge, text: New }
      - { type: text, style: heading, text: Getting started }
      - { type: text, text: Five minutes to your first project. }
  - type: composite
    ref:
      kind: Ui.Action
      inputModel: !ref NewProject
      outputModel: !ref Project
      request: { target: /api/projects }
      label: Create
      fields:
        - name
        - kind: Ui.ChoiceField
          property: ownerId
          options:
            kind: Ui.CollectionOptions
            model: !ref Person
            value: !cel "row.id"
            label: !cel "row.name"
            to: { kind: Ui.OpenPage, page: !ref personPage, pathParams: { id: !cel "row.id" } }
            source:
              kind: Ui.CollectionSource
              basePath: /api/people
              collection: { kind: DataModel.Collection, model: !ref Person, query: { filters: [{ property: id, operator: in }], sort: [] } }
      onSuccess:
        # Reading `result`, so the body is read.
        to:
          kind: Ui.OpenPage
          page: !ref projectPage
          pathParams: { id: !cel "result.id" }
          surface: { kind: Ui.Drawer, side: end, address: { name: project } }
        refreshes: [/api/projects]
---
kind: UiReact.App
metadata: { name: ui }
title: Projects
theme: !ref UiReact.defaultTheme
layout:
  kind: Ui.PageLayout
  header:
    - type: pane
      ref:
        kind: Ui.Navbar
        title: Acme
        navigation:
          items:
            - { type: page, page: !ref homePage }
            - type: link
              text: Help
              to: { kind: Ui.OpenPage, page: !ref helpPage, surface: { kind: Ui.Drawer, side: end, modal: false } }
pages: [!ref homePage, !ref projectPage, !ref personPage, !ref helpPage]
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
            to: { kind: Ui.OpenPage, page: !ref taskPage, pathParams: { id: !cel "row.id" } }
            label: { text: "Open {$title}", values: { title: !cel "row.title" } }
  - !ref taskPage
```

Refused — every line marked below is reported by `telo check` where it is written, and the kernel refuses the same at load:

```yaml
kind: Telo.Library
metadata:
  name: BlogRefused
  version: 1.0.0
  description: Destinations and presses that are refused.
requires: { telo: ">=unreleased" }
lang: en
imports:
  Ui: ../../modules/ui
  UiReact: ../../modules/ui-react
exports:
  resources: [ui]
---
kind: Telo.JsonSchema
metadata: { name: Author }
schema: { type: object, required: [id], properties: { id: { type: string } } }
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
      content:
        type: stack
        # CEL_UNKNOWN_FIELD — `Author` has no `idd`.
        press:
          to: { kind: Ui.OpenPage, page: !ref draftsPage, queryParams: { author: !cel "data.id" } }
          label: { text: "Drafts by {$id}", values: { id: !cel "data.idd" } }
        children: [{ type: text, text: Drafts }, { type: text, text: Unpublished posts by this author. }]
---
# UI_PAGE_UNROUTED, reported on the App — `authorPage` opens it, and `pages` does not list it.
kind: Ui.Page
metadata: { name: draftsPage }
path: /drafts
title: Drafts
children: [{ type: text, text: Drafts }]
---
kind: Ui.Page
metadata: { name: homePage }
path: /
title: Home
children:
  # PATH_PARAMETER_UNBOUND — `/authors/{id}` needs `id`.
  - { type: link, text: Newest author, to: { kind: Ui.OpenPage, page: !ref authorPage } }
  # REFERENCE_KIND_MISMATCH — `page` names a Ui.Page.
  - { type: link, text: Authors, to: { kind: Ui.OpenPage, page: !ref Author } }
  # CEL_UNKNOWN_IDENTIFIER — a page's own nodes bind no `row`.
  - { type: link, text: First author, to: { kind: Ui.OpenPage, page: !ref authorPage, pathParams: { id: !cel "row.id" } } }
  # REFERENCE_KIND_MISMATCH — `to` holds a Ui.Destination.
  - { type: link, text: Close, to: { kind: Ui.Dialog } }
  # REFERENCE_KIND_MISMATCH — a page opens in a Ui.ViewportOverlay: a dialog or a drawer.
  - type: link
    text: Ada in a popover
    to: { kind: Ui.OpenPage, page: !ref authorPage, pathParams: { id: ada }, surface: { kind: Ui.Popover, side: bottom } }
  # SCHEMA_VIOLATION — a press needs a `label`.
  - type: box
    press: { to: { kind: Ui.OpenPage, page: !ref authorPage, pathParams: { id: ada } } }
    children: [{ type: text, text: Ada }, { type: text, text: Writes about compilers. }]
  # SCHEMA_VIOLATION — `press` is on `box`, `stack` and `columns`; a pressed text is a `link`.
  - { type: text, text: Ada, press: { to: { kind: Ui.OpenPage, page: !ref authorPage, pathParams: { id: ada } }, label: Ada } }
  # SCHEMA_VIOLATION — `href` is gone from `value`; write `to: { kind: Ui.Navigate, href }`.
  - { type: value, value: ada, href: { path: !ref authorPage, pathParams: { id: ada } } }
  # SCHEMA_VIOLATION — `href` is gone from `link`; write `to: { kind: Ui.Navigate, href }`.
  - { type: link, text: Authors, href: /authors }
  # SCHEMA_VIOLATION — `onSuccess.navigate` is gone; write `onSuccess.to`.
  - type: composite
    ref:
      kind: Ui.Action
      inputModel: !ref Author
      request: { target: /api/authors }
      label: Add
      onSuccess: { navigate: / }
---
kind: UiReact.App
metadata: { name: ui }
title: Blog
theme: !ref UiReact.defaultTheme
pages: [!ref homePage, !ref authorPage]
```

## Verify

- On `/`, pressing a card opens the post in an end drawer and the address becomes `/?_telo.page.post=%2Fposts%2Fhello`; the card carries `data-selected` while its post is open, and no other card does; reloading reopens it; Escape closes it, drops the key and returns focus to the card. The card's "Full page" link navigates to `/posts/hello`, by mouse and by keyboard, without opening the drawer.
- Inside the open post, "About the author" leaves the drawer open, the address becomes `/?_telo.page.post=%2Fauthors%2Fada%3Ffrom%3Dhello` with no new history entry, and "Back to the post" is shown; reloading reopens Ada's page in the drawer; pressing one of her posts there replaces it again; Back after closing returns to `/`. `postPage` and `authorPage` open each other and pass `telo check` and boot. "All posts" navigates the application to `/` and closes the drawer.
- With the non-modal Help drawer open from the navbar, the Help entry is current; a press whose filled surface spec equals the open one swaps the drawer's content and replaces the entry; one whose spec differs (the Shortcuts menu item's dialog) closes the drawer, opens its own surface and writes only its own key; at no moment are two opened pages hosted.
- On `/table`, the title cell is a real `<a>` to `/posts/<id>` that opens in a new tab, and the author label opens the author's page in a dialog, unaddressed, without selecting its row.
- In `ProjectScreens`, the navbar's Help, the Shortcuts menu item, the pressed box, an owner `value`, a chosen owner option and a created project each open their page in the surface they name; the Help entry and the Shortcuts item are drawn by the unchanged `Navigation` control as links to the page's address, and a plain press on them opens rather than navigates; a created project opens at `/?_telo.page.project=%2Fprojects%2F<id>`.
- Every press element's accessible name is exactly its formatted `label` ("Open Hello world", "Getting started"); no renderer code reads text out of drawn content to name anything.
- With `press` written, the record's edit button opens the `edit` form; a listing with `edit` and no `press` behaves as today.
- A fixture holding a filter bar and an addressed `edit` opener inside an opened page writes neither to the host's address.
- Each refused line above is reported by `telo check` with the code shown, and fails a consumer's run with its kernel twin; `href` on a `list` column, a `Ui.TableLayout` column, a relation, a menu item, a `Ui.OptionSource` and a navigation `link` entry, and `press` on a `badge`, `image`, `svg`, `value` and `time` node, are `SCHEMA_VIOLATION` too; `{ kind: Ui.Close }` at a `to` is `UNDEFINED_KIND`.
- One `Ui.OpenPage` value written at a press, a `link`'s `to`, a navigation `link` entry and an action's `onSuccess.to` opens the same page in the same surface; a `link` to it is a real `<a>` to the page's own address, so a middle click opens the full page; `onSuccess.to` reading `result` forces the body read.
- A `to` inside a `Ui.Data` tree inside a `list` column types `data` and `row` from the referrer — one fixture with a field misspelt in each is `CEL_UNKNOWN_FIELD` twice.
- A `to` reading a root its site does not bind is `CEL_UNKNOWN_IDENTIFIER` naming the resource holding it — `row` on a page's own `link` (`'row' is not available here — Ui.Page/homePage withholds it: a destination reads only the roots bound where it is written`), `result` in a navigation `link` entry, `data` outside a `Ui.Data`; a destination reached from two referrers, one binding the root and one not, is refused once, naming the one that does not; a kind declaring the pair is not `CONTEXT_WITHHELD_INVALID`.
- Layouts: the layout vectors hold `press` as the first child of each built-in record root, and of the row's first cell for a table; the hosted generation is exactly `ui_react_layouts-2`; a component layout built for `ui_react_layouts-1` is replaced by `ERR_UI_COMPONENT_ABI_UNSUPPORTED` naming `ui_react_layouts-2`; the `GalleryLayout` component draws `record.press` and sets `data-selected` from `selected`.
- In a real browser engine — happy-dom does no layout — a pointer on a card, a table row's first cell, a pressed box and a component record lands on the press over text and on a nested link, row action or control over those; on a pressed table, dragging across the second and later cells selects their text, and a middle click on the first cell opens a new tab.
- `CheckTheme` passes for both built-in themes and the showcase brand theme with no geometry declared for `press`, and reports a theme that sets one of the new reserved pairs.
- The `TaskScreens` Admin opens `/tasks/<id>` in a dialog from a row's first cell.
- Cold load: a name declared both in a layout `link` entry and in the page opens the page's surface; opening a page whose surface name is declared only inside an opened page writes no `_telo.page.*` key, and a reload shows the underlying page alone; `_telo.page.x=https%3A%2F%2Fevil` and a second `_telo.page.*` key are dropped by replace; a listing and an `Ui.OpenPage` both named `post` on one page keep separate state.
- An omitted and an explicit `{ kind: Ui.Dialog }` give equal `surface` on the wire and different `keepsSurface`; inside the post drawer, a link with `surface: { kind: Ui.Dialog }` closes the drawer and opens a dialog, and one whose written drawer equals the host's swaps in place.
- A destination kind of another module, extending `Ui.Destination` in merge form with no region of its own, types `row` from a listing's press and refuses `row` on a page's own `link` with the withheld reason; no destination kind in `ui` restates the roots.

## Bookkeeping

Docs: `ui` `nodes.md` (`to` on `link`, menu items and `value`; `press` on `box`, `stack`, `columns`), `presses.md` (new: destinations and their two kinds, the `to` key, the link-or-region split, presses, `label` containing the visible text), `action.md` (`onSuccess.to`), `field-kinds.md` (an option source's `to`), `navigation.md` (a `link` entry's `to`), `listing.md`, `listing-layouts.md` (a table's first column carries the press), `collection-presentation.md`, `surfaces.md` (a page opened in a surface, the one-opened-page rule, an omitted `surface` keeping the host's, the non-modal case); `ui-react` `urls.md` (a section "The page key" beside "The open key": `_telo.page.<name>`, the cold-load lookup, the write and drop rules, in-memory addresses inside an opened page), `layouts-abi.md` (`-2` alone, `record.press` as the first child of the element it covers — the record root or one part of it, the root never `static`, a non-interactive element a component positions inside a record taking `pointer-events: none`), `styling.md` (the `press` part, the reserved rows, `data-selected`, no drag-selection inside a pressed container); `crud-ui` `admin.md`. The part list, the contract data and vectors for `-2` (the `-1` ones removed), the renderer's base layer, and the default theme's, `ui-react-radix`'s and the showcase `brand.css` focus styles for `press`. `examples/ui-showcase`, `examples/chat`, `examples/report-console` and the in-repo test manifests moved off `href` and `onSuccess.navigate`. The hub `build-ui` guide (within its 32768-byte bound), the primer, `modules/CLAUDE.md`'s Declarative UI paragraph. For the analyzer change: `docs/extend/referrer-typed-bindings.md` (the mark beside `x-telo-context-from-referrer`, the "No referrer" paragraph, the misuse list, a region on an abstract inherited by its merge-form children), the `x-telo-context-withheld` lines of the root and analyzer guides, the primer's and the hub `design-library` guide's `x-telo-context-from-referrer` sentences, and an `Added` fragment for `analyzer`. A ledger entry under Standard library, "Records that open in place". `Added` fragments for `ui` (describing the `href` and `onSuccess.navigate` break), `ui-react` (`ui_react_layouts-2`, `-1` no longer hosted), `ui-react-radix`, `crud-ui`; a changeset for `@telorun/ui-react-contract`. `telo release floor` for the showcase and every in-repo module adopting `to` or `press`.
