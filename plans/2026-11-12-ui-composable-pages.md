---
status: draft
priority: high
depends-on: []
packages: [analyzer/nodejs, modules/ui, modules/ui-react, modules/ui-react-radix, examples, starters, apps/authoring-agent, apps/hub, docs]
refinement: not-ready
---

# Composable pages

## Problem

`UiReact.App` draws the same chrome around every page, and a page cannot opt out of it. That chrome is the application `title`, `header: { start, end, width }`, the `navigation` tree with its placement (header row, sidebar, menu drawer, tab bar) and an automatic `<h1>` page title. A page that should be one component, such as a sign-in form or a chat, still arrives inside a header and under a heading. A footer, an account menu or a second navigation has no place to go, because the chrome is a set of App fields rather than something an application arranges.

The App also checks only part of what its pages link to. `UI_NAVIGATION_PAGE_UNROUTED` refuses a navigation entry that names a page `pages` does not list. A `link` whose `href` is `{ path: !ref somePage }` to an unlisted page passes `telo check` and leads to the not-found page.

## Surface

**Added**
- `Ui.PageLayout`: a `Telo.Invocable` holding the chrome around a page. Its fields are `width?` (a `Ui.PageWidth`), `header?` and `footer?` (lists of `Ui.Node`) and `aside?` (a `Ui.Aside`). The App invokes it per request with `{ request, pageWidth? }`, and it answers `{ width, header, aside?, footer }`.
- `Ui.Aside`: a named shape holding `side`, `size`, `frame`, `toggle`, `label`, `collapse`, `compact`, `actions` and `content`. It is the fold-out column that `Ui.SplitView` and `Ui.PageLayout` both hold.
- `UiReact.App.layout`: the `Ui.PageLayout` every page is drawn in, unless its `pages` entry names another. Omitted, pages are drawn with no chrome.
- `Ui.PageRoute`: a `pages` entry `{ page, layout }` that draws one page in a layout other than the App's. `layout: { kind: Ui.PageLayout }` draws it bare.
- `Ui.Pane`: an abstract `Telo.Invocable`, a piece of chrome. It is invoked with `{ request? }` and answers `{ node? }`.
- The `pane` node `{ type: pane, ref, when?, shown? }` in `Ui.Node`. It places a pane, and on the wire it is replaced by the node the pane answers.
- `Ui.NavigationPane`: an abstract extending `Ui.Pane` that holds a required `navigation` (a `Ui.Navigation`).
- `Ui.Navbar`: a navigation pane holding `title?`, `start?`, `end?`, `navigation` and `placement?` (a `Ui.NavigationPlacement`). It draws a title and its navigation by its placement: a header row, a menu button or a tab bar.
- `Ui.NavigationColumn`: a navigation pane holding `navigation` and `state?` (`{ key, store }`, keeping its open groups in a `Ui.StateStore`). It draws the tree as a column, and as a rail of glyphs while the aside holding it is folded.
- The published reading `assets` of `Ui.Pane`, `Ui.PageLayout` and `Ui.Page`: the files the resource can name, in `Ui.Composite`'s `assets` item shape, known at creation. Absent, the resource names no file.
- The `title` text style, drawn as `h1`. `heading` stays `h2` and `subheading` stays `h3`.
- `UiReact.App.notFound`: nodes drawn per request for a path no page serves, inside the App's layout. Omitted, the built-in heading and text are drawn.
- `reachable: { kind, use, through }` in `x-telo-resource-rules`, exclusive with `in:`. The rule iterates, as `this`, the declaration named by every reference of kind `kind` at a slot of use `use`, reachable from the resource through slots whose use is in `through`.
- `UI_PAGE_UNROUTED`: a page reference reachable from the App names a page `pages` does not list. It is a static check only.
- Wire: the layout document at `_telo/ui/layout?id=<id>`, `{ specVersion, bundle, digest, id, width, header, aside?, footer }`, served `private, no-cache` with `ETag` its `digest` and `Vary: *`. An unknown `id` is the 404 problem every unknown `_telo` path answers.
- Wire: the application document's `layout` (the default layout's id) and `pages[].layout` (each page's layout id, absent for a bare page).
- Wire: `children` on the 404 answer of `_telo/ui/page`, holding the not-found nodes for the request.
- Wire: the `Ui.SpecNode` branches `navbar` (`{ type, title?, start, end, navigation, placement }`) and `navigation-column` (`{ type, navigation, state }`).
- The parts `footer`, `footer-content`, `navbar` and `nav-column`.

**Changed**
- `UiReact.App.pages`: each entry is a page, written in place or named by `!ref`, or a `Ui.PageRoute`.
- `UI_PAGE_PATH_DUPLICATE`: now reads the page of each `pages` entry, whichever form it takes.
- `Ui.SplitView`: now `{ aside, content }`, where `aside` is a `Ui.Aside`. `side`, `size`, `frame`, `toggle`, `label`, `collapse` and `compact` move from its top level into `aside`. On the wire, the `split` branch carries `aside` in the same shape.
- `Ui.Navigation`: now `{ items }` only, its `page` entries are `use: schema` references, and it declares no CEL context of its own.
- `Ui.Page.title`: now the document title and the navigation text only. No heading is drawn for it.
- `UiReact.App.title`: now the document title only.
- Application document: no longer carries `navigation` or `header`.
- Page document: `Vary: *` when the page holds a pane; otherwise the headers its own expressions read, as today.
- Browser storage: a navigation column's open groups are kept under `telo.ui:<mount path>:n:<key>`, one entry per column `state.key`. The fold of an aside stays under its own `collapse.state` key.
- `UI_NAVIGATION_PAGE_UNTITLED` / `ERR_UI_NAVIGATION_PAGE_UNTITLED` and `UI_NAVIGATION_PAGE_HAS_PARAMETERS` / `ERR_UI_NAVIGATION_PAGE_HAS_PARAMETERS`: now declared on `Ui.NavigationPane` instead of `UiReact.App`.
- `UI_SURFACE_COMPACT_ADDRESSED` / `UI_SURFACE_COMPACT_NESTED`: now reported at `aside.compact`, on `Ui.SplitView` and on `Ui.PageLayout`.
- The parts `split-aside`, `split-bar`, `split-actions` and `split-toggle` are renamed `aside`, `aside-bar`, `aside-actions` and `aside-toggle`. They are the same in a split view and a layout, and `aside` carries the states `split-aside` and `sidebar` carried (`data-side`, `data-size`, `data-fill`, folded).
- The parts `app-title`, `header-start` and `header-end` are renamed `navbar-title`, `navbar-start` and `navbar-end`.
- The reserved layout: the `app`, `header` and `header-content` grid rules now come from the page layout. The header spans the application above the aside and `main`, and the sidebar subgrid rule is removed.

**Removed**
- `UiReact.App.header` and `UiReact.App.navigation`.
- `Ui.Navigation.placement`.
- `Ui.SidebarNavigation`, and the `sidebar` branch of `Ui.NavigationPlacementSpec`.
- `UI_NAVIGATION_PAGE_UNROUTED` / `ERR_UI_NAVIGATION_PAGE_UNROUTED`.
- The parts `page-title`, `sidebar` and `sidebar-toggle`.

## Solution

**A page draws its own children, and the App chooses the layout around it.** The App routes, themes and translates. The chrome around a page is a `Ui.PageLayout`:
- `UiReact.App.layout` names the default.
- A `Ui.PageRoute` entry in `pages` names another for one page.
- `layout: { kind: Ui.PageLayout }` draws that page bare: one component, with no header, aside, footer or `h1`.

The App is the only caller of a layout, so a library's page is drawn in whatever layout the application that lists it chooses.

**A layout is three fixed regions around `main`.** The regions are `header`, `aside` and `footer`, placed around an implicit `main` that holds the page's children. There is no outlet node to place or misplace. The renderer draws them as the landmarks `header`, `aside` and `footer`. The header and footer span the application width, with their content inset by the layout's `width`. When `width` is omitted, they use the App's `pageWidth`, else `contained`, so a header lines up with a contained column whatever width a page declares.

The regions, and `notFound`, read `request` at run time. They bind `params` and `query` as closed, empty objects, because one layout is drawn on pages with different variables. So a composite placed there that reads `params.id` is `CEL_UNKNOWN_FIELD`, naming the layout. A `Ui.Data` there still reads the `query` it declares itself.

**The layout travels on its own and is evaluated per navigation.** A layout's content depends on the layout and the request alone, so it is served as the layout document at `_telo/ui/layout?id=<id>`, not repeated in every page document.
- The application document names each page's layout id in `pages[].layout` and the default in `layout`.
- The renderer fetches a layout document the first time it needs an id, then revalidates it with `If-None-Match`:
  - in parallel with each page-document fetch;
  - when the event stream reconnects.
- The server evaluates the layout for each such request, so a navbar follows a sign-in, a session expiry or a role header at the next navigation, with no reload.
- A `304` keeps the layout, and a new `digest` redraws it in place. Between two pages with the same id the regions stay mounted, so a menu does not flash and a folded aside stays folded.

A `304` is decided by the digest of the document produced for that request alone, so it never crosses users with different headers. The layout document is `Vary: *`, because it holds the answers of panes the App handed the request to. The id is a digest of the App field that first names the layout declaration (`/layout`, `/pages/3/layout`), so it is the same on every replica. An unknown path answers the 404 problem with `children`, the not-found nodes produced for the request, drawn in the default layout, so a 404 keeps the navigation.

**A pane is resolved where the tree that places it is resolved.** A pane in a page's children or in a layout region is invoked per request with `{ request }`. A pane inside a composite (a `Ui.SplitView` aside, a `Ui.View`) is invoked once, at the composite's creation, with `{}`. This is the rule `when` already follows. `request` is typed from where the pane is placed: present in a region or a page, nullable inside a composite. It is nullable rather than absent because one pane kind, such as `Ui.NavigationColumn`, serves both placements. An unguarded `request` read in a pane inside a composite is `CEL_NULLABLE_ACCESS`, naming the composite. The message tells the author to place the pane where it is resolved per request, or to drop the read.

A pane answers only `{ node? }`. The files it can name are published in its `assets` reading at creation. Pages and layouts publish the same member, and the App serves only files collected at creation, so every replica serves every file from boot. A pane kind of another module, such as a footer or an account menu, is placed with no change to `ui`.

**Navigation is explicit.** A navigation pane requires its `navigation` tree, and nothing is derived from the routes. The App's routes stay the App's, and no pane receives them. A header with only a title and links is a `bar` node, with no navigation pane.

**The sidebar is an aside.** `Ui.Aside` is one shape: the fold, the rail, the remembered state and the narrow-screen surface. `Ui.SplitView` and `Ui.PageLayout` both hold it, and one renderer component draws it in both places. The shape declares no CEL context. Each holder declares its own on the property holding it:
- a split view's aside reads the placing page's `params`, at creation;
- a layout's aside reads the region context above.

A `Ui.NavigationColumn` in an aside draws a column (`Navigation` with `layout: vertical`), and a rail while the aside is folded, as the sidebar did. Placed anywhere else, it draws as a plain column. Below `compactBelow` the aside becomes its `compact` surface, a drawer from its side by default. Its toggle then stands at the header's edge on the aside's side, or above `main` when the layout has no header.

**No contract generation moves.** No control's props, values, states, intents or parts change, and no field of the component ABI does, so `ui_react_controls-4`, `ui_react-1` and `ui_react_layouts-1` stay. The part list is closed per `ui-react` release: the renames and removals are announced in its changelog fragment. A theme stylesheet still written against the old names draws the renamed regions with the base layer only, which holds every reserved property, and `CheckTheme` reports each new part as `part-unstyled`. `ui-react-radix`'s change is its theme stylesheet.

**A navigation tree carries its rules wherever it is held.** `UI_NAVIGATION_PAGE_UNTITLED` and `UI_NAVIGATION_PAGE_HAS_PARAMETERS` move to `Ui.NavigationPane`. `Ui.Navbar`, `Ui.NavigationColumn` and another module's navigation pane extend it in merge form and inherit both rules. The runtime twins stay in the shared navigation preparation every navigation pane's controller calls. A navigation pane extending in `base:` form inherits no rule and restates them.

**Every page reference is checked, wherever it is written.** The App's rule resolves the page of each `pages` entry (`/pages` and `/pages/*/page`) and walks `reachable: { kind: Ui.Page, use: schema, through: [dependency, call] }`. It holds when `this` is one of those pages. The walk goes from the App through its pages, its layouts, `notFound`, and every composite and pane they reach. It finds every navigation entry, `link`, action `onSuccess.navigate` and address naming a page. `pages` and both `layout` slots are `use: call`, so they are walked, not judged.

`this` is the declaration the reference names. Two bound declarations are equal exactly when they are the same declaration, so a library's page listed through an import alias is never reported as unlisted. Findings are anchored as follows:
- A reference written in the entry's own modules is reported at that reference.
- A reference written in a dependency is reported at the slot of the entry's own modules where the walk first entered that dependency.

The message names the App the rule belongs to. A hop the walk cannot resolve (a kind-only `resources:` input, an unresolved reference) makes the rule `RESOURCE_RULE_SKIPPED` for that App. A walk that reaches nothing anywhere makes it `RESOURCE_RULE_UNEXERCISED`. There is no runtime twin: an unlisted page at run time is a link to the not-found page, which is already defined behaviour.

The strict half refuses each of these as `RESOURCE_RULE_INVALID`:
- `reachable:` beside `in:`;
- a `kind` that does not resolve;
- a `use` outside the reference vocabulary;
- an empty `through`, or a `through` with a value outside that vocabulary.

## Decisions

- **Chrome is a layout of fixed regions, not a tree with an outlet.** An outlet node would be legal wherever a node is, inside composites and pages included. Proving that exactly one exists, and never under a page, needs a walk through every composite.
- **The App assigns layouts, not the page.** The App serves the layout document, so it must hold every layout through its own slots. A layout named on a page would be invoked by something that does not hold it.
- **The layout is evaluated per navigation, not cached or carried in the application document.** A layout reads request headers that change without a reload: a session cookie, a role a proxy adds. Carrying it once in the application document, or memoizing it by header values, leaves the chrome as it was at app load. A server cache keyed by per-user headers also grows without bound.
- **A pane in a composite is resolved once, not left as a hole.** A hole would need the page to call a pane it holds no slot for, so the call graph would credit the call to the composite while the page makes it.
- **`Ui.Pane` is an abstract, and the navbar is one kind under it.** A node type naming the navbar would make every footer or foreign header a new node type in `ui`.
- **The name `Pane`.** "Region" names a layout's and a `bar` node's places, "slot" a reference slot, and "fragment" a view. Section, frame, panel, partial and part are taken too.
- **Reachability is its own key, `reachable:`.** `in:` iterates a collection of the resource's own and anchors findings there. This form walks other resources, binds declarations and anchors elsewhere. The traversal is data (`kind`, `use`, `through`), so the analyzer knows nothing about pages.
- **No migration entry.** Moving App keys into resources the App draws its pages in is beyond a data rewrite. Pre-1.0, it ships as a breaking minor, with every in-repo application rewritten in the same change.

Bookkeeping:
- **Docs:**
  - `ui`: a new `page-layout.md`, and a new `pane.md` covering both pane lifetimes, the `assets` reading and the `request` typing a foreign pane kind declares. Updates to `page.md`, `navigation.md`, `nodes.md` and `split-view.md`; the item `icon` description stops naming a sidebar's rail.
  - `ui-react`:
    - `app.md`: layout assignment, the renderer's layout fetch and revalidation, and that the page check is static only.
    - `urls.md`: the layout document, the application document's `layout` members, the 404 answer's `children`, and the `Vary` rule.
    - `styling.md`: the part list is closed per release, and renames are announced in the changelog.
    - `theme.md`.
  - `docs/extend/resource-rules.md` and the analyzer guide, for `reachable:`.
- **Contract data:**
  - `ui-react`'s part list: the renames, removals and additions above, the part states, and the reserved (part, property) pairs.
  - The scenes: the sidebar scenes become layout and aside scenes, and they carry the layout document.
  - `UiReact.defaultTheme` and the `ui-react-radix` theme style every new part.
- **Controls:** `ui-react-radix`'s `Navigation` drops the sidebar column and draws the navigation column in an aside.
- **In-repo applications:** every one with an App `header` or `navigation`, or relying on the default header and navigation, gets a layout with a navbar and an explicit `navigation`. Every `Ui.SplitView` moves its fold settings into `aside`.
- **Guides:** the hub `build-ui` guide (within its byte bound), the primer, `modules/CLAUDE.md` and the root `CLAUDE.md` UI paragraph.
- **Release:**
  - A ledger entry, "Every link to a page checked before the app runs", under Standard library.
  - An `@telorun/analyzer` changeset.
  - `Added` fragments for `ui`, `ui-react` and `ui-react-radix`; `ui-react`'s names every renamed and removed part.
  - `telo release floor`.

## Examples

### Before

```yaml
kind: Telo.Application
metadata: { name: AcmeConsole, version: 1.0.0 }
lang: en
requires: { telo: ">=0.133.0" }
imports:
  Http: oci://ghcr.io/telorun/http-server@0.44.2
  Ui: oci://ghcr.io/telorun/ui@0.12.0
  UiReact: oci://ghcr.io/telorun/ui-react@0.13.0
ports: { http: { env: PORT, protocol: tcp, default: 8080 } }
targets:
  - !ref server
  - { name: openUi, invoke: { kind: Telo.OpenUrl }, inputs: { url: !cel "resources.server.status.localUrl" } }
---
kind: Http.Server
metadata: { name: server }
listen: { port: !cel "ports.http" }
mounts:
  - { path: /, mount: !ref ui }
---
kind: Ui.Page
metadata: { name: home }
path: /
title: Home
children:
  - { type: text, text: Pick a report from the sidebar., style: muted }
---
kind: Ui.Page
metadata: { name: reports }
path: /reports
title: Reports
width: full
children:
  - type: composite
    ref:
      kind: Ui.SplitView
      side: end
      size: small
      label: Report sections
      collapse: { state: { key: reportSections, store: { kind: Ui.LocalStore } } }
      aside:
        content:
          type: stack
          children:
            - { type: link, text: Summary, href: "/reports?section=summary" }
            - { type: link, text: Details, href: "/reports?section=details" }
      content: { type: text, text: Nothing to report yet., style: muted }
---
kind: UiReact.App
metadata: { name: ui }
title: Acme
theme: !ref UiReact.defaultTheme
header:
  end:
    - { type: link, text: Status, href: "https://status.acme.test" }
pages: [!ref home, !ref reports]
navigation:
  items:
    - { type: page, page: !ref home }
    - { type: page, page: !ref reports, when: !cel "'x-role' in request.headers" }
  placement:
    kind: Ui.SidebarNavigation
    rail: { collapsed: false }
    store: { kind: Ui.LocalStore }
```

Every page gets the header, the sidebar and an `<h1>` of its title. No page can leave them out, and there is nowhere to put a footer.

### After

A module of another author, offering a navigation pane:

```yaml
kind: Telo.Library
metadata:
  name: Help
  version: 0.1.0
  license: MIT
  description: >-
    A titled list of help links and pages for any web screen, gated per
    request by role or header like site navigation, drawn as a compact column
    in a page, a footer or a side panel.
imports:
  Ui: oci://ghcr.io/telorun/ui@0.13.0
exports: { kinds: [Links] }
---
kind: Telo.Definition
metadata:
  name: Links
  description: >-
    Draws a heading over a short column of help links and pages. Takes a
    navigation tree whose entries are delivered per request, and answers the
    node to place.
capability: Telo.Invocable
extends: Ui.NavigationPane
controllers: [pkg:telo/local/js?path=./nodejs/help.mjs&local_path=./nodejs/src/index.ts#LinksController]
schema:
  type: object
  properties:
    heading:
      title: Heading
      description: The text drawn above the links.
      $ref: "telo://manifest#/$defs/Text"
      x-telo-text-values: {}
```

The application:

```yaml
kind: Telo.Application
metadata: { name: AcmeConsole, version: 1.0.0 }
lang: en
requires: { telo: ">=0.133.0" }
imports:
  Http: oci://ghcr.io/telorun/http-server@0.44.2
  Ui: oci://ghcr.io/telorun/ui@0.13.0
  UiReact: oci://ghcr.io/telorun/ui-react@0.14.0
  Help: oci://ghcr.io/acme/help@0.1.0
ports: { http: { env: PORT, protocol: tcp, default: 8080 } }
targets:
  - !ref server
  - { name: openUi, invoke: { kind: Telo.OpenUrl }, inputs: { url: !cel "resources.server.status.localUrl" } }
---
kind: Http.Server
metadata: { name: server }
listen: { port: !cel "ports.http" }
mounts:
  - { path: /, mount: !ref ui }
---
kind: Ui.Page
metadata: { name: home }
path: /
title: Home
children:
  - { type: text, text: Welcome back, style: title }
  - { type: link, text: Open the reports, href: { path: !ref reports } }
  - type: pane
    ref:
      kind: Help.Links
      heading: Need a hand?
      navigation:
        items:
          - { type: link, text: Status, href: "https://status.acme.test" }
          - { type: page, page: !ref reports, text: Reading reports, when: !cel "'x-role' in request.headers" }
---
kind: Ui.Page
metadata: { name: reports }
path: /reports
title: Reports
width: full
children:
  - { type: text, text: Reports, style: title }
  - type: composite
    ref:
      kind: Ui.SplitView
      aside:
        side: end
        size: small
        label: Report sections
        collapse: { state: { key: reportSections, store: { kind: Ui.LocalStore } } }
        content:
          type: pane
          ref:
            kind: Ui.NavigationColumn
            navigation:
              items:
                - { type: link, text: Summary, href: "/reports?section=summary" }
                - { type: link, text: Details, href: "/reports?section=details" }
      content: { type: text, text: Nothing to report yet., style: muted }
---
kind: Ui.Page
metadata: { name: signIn }
path: /sign-in
title: Sign in
children:
  - { type: text, text: Sign in to Acme, style: title }
  - { type: link, text: Back to the start, href: { path: !ref home } }
---
kind: UiReact.App
metadata: { name: ui }
title: Acme
theme: !ref UiReact.defaultTheme
pages:
  - !ref home
  - !ref reports
  - { page: !ref signIn, layout: { kind: Ui.PageLayout } }
layout:
  kind: Ui.PageLayout
  width: contained
  header:
    - type: pane
      ref:
        kind: Ui.Navbar
        title: Acme
        navigation:
          items:
            - { type: page, page: !ref home }
            - { type: page, page: !ref reports, when: !cel "'x-role' in request.headers" }
        placement: { kind: Ui.HeaderNavigation }
        end:
          - { type: link, text: Sign in, href: { path: !ref signIn } }
  aside:
    label: Shortcuts
    collapse: { state: { key: shortcuts, store: { kind: Ui.LocalStore } } }
    content:
      type: pane
      ref:
        kind: Ui.NavigationColumn
        state: { key: shortcuts, store: { kind: Ui.LocalStore } }
        navigation:
          items:
            - { type: link, text: Status, href: "https://status.acme.test" }
            - type: group
              text: Account
              items:
                - { type: page, page: !ref signIn, text: Switch account }
                - { type: link, text: Staff handbook, href: "https://handbook.acme.test", when: !cel "'x-role' in request.headers" }
  footer:
    - { type: text, text: Acme Corporation, style: muted }
notFound:
  - { type: text, text: Nothing here, style: title }
  - { type: link, text: Back to the start, href: { path: !ref home } }
```

What this shows:
- `home` and `reports` are drawn inside the header, the aside and the footer, and moving between them keeps all three mounted. The aside's fold and the column's open groups are remembered under `shortcuts`.
- `reports` spans the full width while the header content stays on the contained column.
- `signIn` is drawn bare.
- The `Help.Links` pane on `home` is invoked per request, so its `Reading reports` entry is delivered only with an `x-role` header. It inherits the navigation rules with no rule of its own.
- The navigation column inside the split view is invoked once, when the split view is created. Its entries read no `request`.
- An unknown path draws `notFound` inside the layout.

### Refusals

A library of ready-made pages:

```yaml
kind: Telo.Library
metadata:
  name: Docs
  version: 0.1.0
  license: MIT
  description: >-
    Ready-made documentation pages for any web app, with a navigation bar
    linking them, to list among the app's pages and place in its header.
imports:
  Ui: oci://ghcr.io/telorun/ui@0.13.0
exports: { resources: [guide, nav] }
---
kind: Ui.Page
metadata: { name: guide }
path: /guide
title: Guide
children:
  - { type: text, text: Getting started, style: title }
---
kind: Ui.Navbar
metadata: { name: nav }
title: Docs
navigation:
  items:
    - { type: page, page: !ref guide }
```

An application that gets six things wrong:

```yaml
kind: Telo.Application
metadata: { name: AcmeDraft, version: 1.0.0 }
lang: en
requires: { telo: ">=0.133.0" }
imports:
  Http: oci://ghcr.io/telorun/http-server@0.44.2
  Ui: oci://ghcr.io/telorun/ui@0.13.0
  UiReact: oci://ghcr.io/telorun/ui-react@0.14.0
  Help: oci://ghcr.io/acme/help@0.1.0
  Docs: ./docs
ports: { http: { env: PORT, protocol: tcp, default: 8080 } }
targets:
  - !ref server
  - { name: openUi, invoke: { kind: Telo.OpenUrl }, inputs: { url: !cel "resources.server.status.localUrl" } }
---
kind: Http.Server
metadata: { name: server }
listen: { port: !cel "ports.http" }
mounts:
  - { path: /, mount: !ref ui }
---
kind: Ui.Page
metadata: { name: home }
path: /
title: Home
children:
  - type: pane
    ref:
      kind: Help.Links
      heading: Need a hand?
      navigation:
        items:
          - { type: page, page: !ref draft }
  - type: composite
    ref:
      kind: Ui.SplitView
      aside:
        label: Sections
        content:
          type: pane
          ref:
            kind: Ui.NavigationColumn
            navigation:
              items:
                - { type: link, text: Admin, href: /admin, when: !cel "'x-role' in request.headers" }
      content: { type: text, text: Welcome, style: title }
---
kind: Ui.Page
metadata: { name: draft }
path: /draft
children:
  - { type: text, text: Work in progress, style: muted }
---
kind: Ui.Page
metadata: { name: signIn }
path: /sign-in
title: Sign in
children:
  - { type: text, text: Sign in to Acme, style: title }
---
kind: UiReact.App
metadata: { name: ui }
title: Acme
theme: !ref UiReact.defaultTheme
pages: [!ref home, !ref draft]
layout:
  kind: Ui.PageLayout
  header:
    - { type: pane, ref: { kind: Ui.Navbar, title: Acme } }
    - { type: pane, ref: !ref Docs.nav }
    - type: composite
      ref:
        kind: Ui.View
        content: { type: link, text: Edit this page, href: { path: "/edit/{id}", pathParams: { id: !cel "params.id" } } }
  footer:
    - { type: link, text: Sign in, href: { path: !ref signIn } }
```

```
$ telo check ./telo.yaml
telo.yaml:30:13  error  Help.Links: names a page with no title, so the entry has no text.
                        Give the page a title, or the entry a text. (rule
                        UI_NAVIGATION_PAGE_UNTITLED)  RESOURCE_RULE_VIOLATED
telo.yaml:42:82  error  Ui.SplitView: CEL at 'aside.content.ref.navigation.items[0].when':
                        'request' is null here, because a pane inside a composite is
                        resolved once at creation. Place the pane in a page's children or
                        a layout region, or drop the read.  CEL_NULLABLE_ACCESS
telo.yaml:64:7   error  Ui.Navbar: must have required property 'navigation'  SCHEMA_VIOLATION
telo.yaml:65:7   error  UiReact.App/ui: names a page the application does not list in
                        its pages, so it leads nowhere. Add the page to pages, or remove
                        the reference. (rule UI_PAGE_UNROUTED; the page Docs.guide,
                        reached through Docs.nav)  RESOURCE_RULE_VIOLATED
telo.yaml:69:105 error  Ui.View: CEL at 'content.href.pathParams.id': 'params.id' is not
                        defined, because a layout region binds no page variables
                        (available: none)  CEL_UNKNOWN_FIELD
telo.yaml:71:46  error  UiReact.App/ui: names a page the application does not list in
                        its pages, so it leads nowhere. Add the page to pages, or remove
                        the reference. (rule UI_PAGE_UNROUTED)  RESOURCE_RULE_VIOLATED

6 errors
```

Every rule violation reports under `RESOURCE_RULE_VIOLATED`, with the rule's own code in `data.rule`. The `Docs.guide` reference is written in the library, so it is reported at the application's `!ref Docs.nav`, where the walk entered the library. An unlisted page does not refuse the run: started anyway, the `Sign in` link opens the not-found page.

A library declaring `reachable:` wrongly:

```yaml
kind: Telo.Library
metadata:
  name: Portal
  version: 0.1.0
  license: MIT
  description: >-
    A contract for multi-page web portals that guarantees every link and menu
    entry leads to a page the portal serves, checked before the app runs.
imports:
  Ui: oci://ghcr.io/telorun/ui@0.13.0
exports: { kinds: [Site] }
---
kind: Telo.Abstract
metadata:
  name: Site
  description: >-
    A portal serving a fixed list of pages. Every page reference reachable
    from it must name one of them.
capability: Telo.Mount
schema:
  type: object
  required: [pages]
  properties:
    pages:
      type: array
      minItems: 1
      items: { x-telo-ref: { kind: Ui.Page, use: call } }
  x-telo-resource-rules:
    - resolve: [/pages]
      in: /pages
      reachable: { kind: Ui.Page, use: schema, through: [dependency, call] }
      condition: !cel "self.pages.exists(p, p == this)"
      code: PORTAL_PAGE_UNSERVED
      message: names a page the portal does not serve.
    - resolve: [/pages]
      reachable: { kind: Ui.Page, use: read, through: [] }
      condition: !cel "self.pages.exists(p, p == this)"
      code: PORTAL_LINK_UNSERVED
      message: links a page the portal does not serve.
```

```
$ telo check ./portal/telo.yaml
portal/telo.yaml:28:7   error  Portal.Site: rule PORTAL_PAGE_UNSERVED declares both 'in' and
                               'reachable'; a rule iterates one of them  RESOURCE_RULE_INVALID
portal/telo.yaml:35:43  error  Portal.Site: rule PORTAL_LINK_UNSERVED: 'use' must be one of
                               schema, dependency, call, detached, trigger.inbound,
                               trigger.consumer  RESOURCE_RULE_INVALID
portal/telo.yaml:35:63  error  Portal.Site: rule PORTAL_LINK_UNSERVED: 'through' must name
                               at least one use  RESOURCE_RULE_INVALID

3 errors
```

### The documents

```
GET /_telo/ui/app
```

```json
{
  "specVersion": 1,
  "bundle": "sha256-4f0c1a",
  "digest": "sha256-71aa02",
  "title": "Acme",
  "lang": "en",
  "pages": [
    { "path": "/", "title": "Home", "layout": "6d1e0b" },
    { "path": "/reports", "title": "Reports", "layout": "6d1e0b" },
    { "path": "/sign-in", "title": "Sign in" }
  ],
  "layout": "6d1e0b",
  "stylesheets": [ "/_telo/ui/assets/a1c09e/renderer.css", "/_telo/ui/assets/b27f4d/default-theme.css" ],
  "controls": { "stylesheets": {}, "sets": [] },
  "compactBelow": "40rem"
}
```

```
GET /_telo/ui/layout?id=6d1e0b
```

```
200 OK
Cache-Control: private, no-cache
ETag: "sha256-c40f19"
Vary: *
```

```json
{
  "specVersion": 1,
  "bundle": "sha256-4f0c1a",
  "digest": "sha256-c40f19",
  "id": "6d1e0b",
  "width": "contained",
  "header": [
    {
      "type": "navbar",
      "title": "Acme",
      "start": [],
      "end": [ { "type": "link", "text": "Sign in", "href": "/sign-in" } ],
      "navigation": { "items": [ { "type": "page", "key": "home", "path": "/", "text": "Home" } ] },
      "placement": { "type": "header", "compact": { "type": "overlay", "surface": { "type": "drawer", "side": "start", "size": "medium", "modal": true } } }
    }
  ],
  "aside": {
    "side": "start",
    "size": "medium",
    "frame": "flush",
    "toggle": { "type": "icon", "icon": null, "label": "hidden" },
    "label": "Shortcuts",
    "collapse": { "collapsed": false, "state": { "key": "shortcuts", "store": { "type": "local" } } },
    "compact": { "type": "drawer", "side": "start", "size": "medium", "modal": true },
    "actions": [],
    "content": {
      "type": "navigation-column",
      "state": { "key": "shortcuts", "store": { "type": "local" } },
      "navigation": {
        "items": [
          { "type": "link", "key": "status", "href": "https://status.acme.test", "text": "Status" },
          { "type": "group", "key": "account", "text": "Account", "items": [ { "type": "page", "key": "account/switch-account", "path": "/sign-in", "text": "Switch account" } ] }
        ]
      }
    }
  },
  "footer": [ { "type": "text", "text": "Acme Corporation", "style": "muted" } ]
}
```

This request carries no `x-role` header, so neither `Reports` in the navbar nor `Staff handbook` in the column is delivered. The next navigation after a proxy adds `x-role` answers a new `digest` with both.

```
GET /_telo/ui/page?path=/nowhere
```

```json
{
  "type": "about:blank",
  "title": "Not Found",
  "status": 404,
  "children": [
    { "type": "text", "text": "Nothing here", "style": "title" },
    { "type": "link", "text": "Back to the start", "href": "/" }
  ]
}
```

The page document of `/reports` carries `path`, `title`, `query`, `width` and `children` as today, and no layout.

## Verify

- A page listed as `{ page, layout: { kind: Ui.PageLayout } }` is drawn with no header, aside, footer or `h1`, and its application-document entry has no `layout`. The application document has no `navigation` or `header`, and no page document has a layout member.
- In a three-page sidebar app the aside is declared once. Moving between pages answers the layout with `304`, requested in parallel with the page document, keeps the aside's fold state and does not remount the navbar. In a 150-page app the bytes of one navigation do not grow with the page count.
- A navbar entry gated on a header appears at the next navigation after the header changes, with no reload. A conditional request carrying a digest produced for another role header gets `200`, not `304`.
- The layout document and a page holding a pane answer `Vary: *`.
- Two `pages` entries naming one layout declaration carry one id, and two inline layouts carry two. A second replica answers the same id with the same `digest`, and serves a navbar icon's file before it has answered any document.
- A pane inside a composite is invoked once in total. Its unguarded `request` read is `CEL_NULLABLE_ACCESS` naming the composite, and the same pane in a layout region needs no guard.
- A `Ui.View` reading `params.id`, placed in a layout header, is `CEL_UNKNOWN_FIELD` naming the layout. The same view placed in a page at `/x/{id}` passes.
- With `pageWidth: contained` and a `full` page, the header content still lines up with the contained column.
- `Ui.SplitView` and a layout's aside produce the same parts and fold behaviour. A `Ui.NavigationColumn` in an aside folds to its rail, and becomes a drawer below `compactBelow`. Two columns with different `state.key`s keep their open groups apart.
- The pane contract's input schema has exactly `request`, optional, and its output exactly `node`. A `Ui.Navbar` with no `navigation` is `SCHEMA_VIOLATION`.
- A navigation pane of another module, extending `Ui.NavigationPane` in merge form with an untitled page entry, reports `UI_NAVIGATION_PAGE_UNTITLED` at that entry with no rule of its own.
- `UI_PAGE_PATH_DUPLICATE` is reported for two entries routing one path whether either is a page or a `Ui.PageRoute`.
- `UI_PAGE_UNROUTED` is reported at each of these, each naming a page the App does not list:
  - a navbar entry;
  - a `link` `href`'s `path`;
  - an entry of a navigation column in the aside;
  - an entry of another module's pane, anchored at the slot of the entry module that reached it.

  A library's page the App lists through its alias is never reported. No controller raises `ERR_UI_PAGE_UNROUTED`, and the running app answers that link with the not-found page.
- `reachable:` beside `in:`, an unresolved `kind`, or a `use` or `through` value outside the reference vocabulary, is `RESOURCE_RULE_INVALID`.
- App → layout → navbar → page reports no dependency cycle, the call graph's caller of every layout is the App, and the walk stays linear on a manifest a hundred times larger.
- `ui-react`'s controls, vectors and component ABI data are unchanged, and a control set built for `ui_react_controls-4` from the previous release still loads.
- `{ type: text, style: title }` draws the page's only `h1`.
- An unknown path draws `notFound`'s nodes inside the App's default layout.
