---
status: draft
priority: high
depends-on: []
packages: [analyzer/nodejs, modules/ui, modules/ui-react, modules/ui-react-radix, examples, starters, apps/authoring-agent, apps/hub, docs]
refinement: not-started
---

# Composable pages

## Problem

`UiReact.App` draws chrome around every page, and a page cannot opt out of it: the application `title`, `header: { start, end, width }` and the `navigation` tree with its placement (header row, sidebar, menu drawer, tab bar), plus an automatic `<h1>` page title. A page that should be one component — a chat, a form — still arrives inside a header and under a heading. A second header, a footer or an account menu has no place to go, because the chrome is App fields rather than something a page places.

The App also checks only part of what its pages link to. `UI_NAVIGATION_PAGE_UNROUTED` refuses a navigation entry naming a page `pages` does not list, but a `link` whose `href` is `{ path: !ref somePage }` to an unlisted page passes `telo check` and leads to the not-found page.

## Surface

**Added**
- `Ui.Pane`: an abstract `Telo.Invocable`, a piece of a page delivered per request. It is invoked with `{ request, pages, pageWidth }` (`pages` the paths the serving mount delivers for that request) and answers `{ node?, assets }`.
- The `pane` node `{ type: pane, ref, when?, shown? }` in `Ui.Node`: places a pane. Inside a composite's tree it is a hole the delivering page fills per request.
- `Ui.Navbar`: a pane holding `title?`, `start`, `end`, `width?`, `navigation?` and `placement?` (a `Ui.NavigationPlacement`). Without `navigation`, it holds one entry per delivered page, in `pages` order.
- `Ui.NavigationColumn`: a pane holding `navigation?` and `store?` (a `Ui.StateStore` for its open groups). It draws the tree as a column, and as a rail of glyphs while its `Ui.SplitView` is folded.
- The `title` style: drawn as `h1` (`heading` stays `h2`, `subheading` `h3`).
- `UiReact.App.notFound`: nodes drawn for a path no page serves, per request. Omitted, the built-in heading and text.
- Wire: `Ui.SpecNode` branches `pane` (`{ key, node }`, `key` the pane's identity), `navbar` and `navigation-column`.
- Parts `header-title` and `nav-column`.
- `in: { reaches, use, through }` in `x-telo-resource-rules`: the rule iterates, as `this`, every reference of kind `reaches` and use `use` reachable from the resource through slots whose use is in `through`. Each finding is anchored at the reference.
- `UI_PAGE_UNROUTED` / `ERR_UI_PAGE_UNROUTED`: a page reference reachable from the App names a page `pages` does not list.

**Changed**
- `Ui.Navigation`: now `{ items }` only, and its `page` entries are `use: schema` references.
- `Ui.Page.title`: the document title and navigation text only; no heading is drawn for it.
- `UiReact.App.title`: the document title only.
- Application document: no longer carries `navigation` or `header`.
- The renderer's reserved layout: the header rules apply to a navbar's `header` part wherever it is placed; the sidebar subgrid rule goes.

**Removed**
- `UiReact.App.header` and `UiReact.App.navigation`.
- `Ui.Navigation.placement`.
- `Ui.SidebarNavigation`.
- `UI_NAVIGATION_PAGE_UNROUTED` / `ERR_UI_NAVIGATION_PAGE_UNROUTED`.
- The `page-title`, `app-title`, `sidebar` and `sidebar-toggle` parts.

## Solution

**A page is its children, nothing more.** The App routes, themes and translates, and draws only what the page holds. A header is a `Ui.Navbar` declared once and placed by each page that wants it, as the first child or anywhere else. A page holding only a chat composite is a single component.

**Panes are the per-request twin of composites.** A composite is resolved once, at creation, so its `when`s are fixed then. A pane is invoked on every request, so a navigation entry's `when` and its nodes' values read `request` as they do today. The page invokes every pane in its tree, including one in a composite's provided node. A navbar's own nodes read `request` only and no browser root, as the App header did. Between pages that place the same pane at the same position, the renderer keeps it mounted, so a menu does not flash on navigation. `pages` is what lets a navbar drop entries for pages the mount does not deliver. Another module's pane kind (a footer, an account menu) is placed with no change to `ui`.

**The sidebar is a split view.** `Ui.NavigationColumn` goes in a `Ui.SplitView` aside. The split view's `collapse` and `state` are the rail and its memory, and its compact surface is the narrow-screen drawer, so folding has one owner. The navbar keeps the header row, menu-button and tab-bar placements.

**Every page reference is checked, wherever it is.** The App's rule reads `resolve: [/pages]` with `in: { reaches: Ui.Page, use: schema, through: [dependency, call] }`. It walks from the App through its pages, composites and panes to every navbar entry and every `link` or address naming a page. Each reference to an unlisted page is refused where it is written. At start, the App refuses the same references with `ERR_UI_PAGE_UNROUTED`, from what its pages and their panes publish.

## Decisions

- **`Ui.Pane` is an abstract, and the navbar one kind under it.** Rejected: a node type naming the navbar (every footer or foreign header would need a new node type in `ui`), the navbar inline in each page (no reuse), and a composite (loses per-request `when`).
- **The name `Pane`.** "Region" already names a `bar` node's slots and the place a command's roots belong to; section, fragment, frame, panel, partial and part are taken too.
- **Reachability is a form of `in:`, not a new key.** `in:` already says what a rule iterates and where it reports. The traversal is declared (`reaches`, `use`, `through`), so the analyzer knows nothing about pages. Rejected: dropping the check (a real broken-link class would remain), and repetition through reference slots in `resolve:` (it couples a rule to every container node and misses a foreign pane).
- **`pageWidth` is a pane input**, so a contained header lines up with a contained page as it does today.
- **The not-found page keeps chrome through `notFound`.** Otherwise a 404 strands the viewer with no navigation.
- **No migration entry.** Moving App keys into a new resource every page references is beyond a data rewrite. Pre-1.0, it ships as a breaking minor, with every in-repo application rewritten in the same change.

Bookkeeping:
- **Docs:** `ui` `page.md`, `navigation.md`, `nodes.md`, `split-view.md`, a new `pane.md`; `ui-react` `app.md`, `urls.md`, `styling.md`, `theme.md`; `docs/extend/resource-rules.md` and the analyzer guide for `in: { reaches }`.
- **Controls:** `ui-react-radix`'s `Navigation` drops the sidebar column.
- **In-repo applications:** every one with an App `header` or `navigation`, or relying on the default header, gets a navbar.
- **Guides:** the hub `build-ui` guide (within its byte bound), the primer, `modules/CLAUDE.md`, the root `CLAUDE.md` UI paragraph.
- **Release:** a ledger entry, "Every link to a page checked before the app runs", under Standard library; an `@telorun/analyzer` changeset; `Added` fragments for `ui`, `ui-react` and `ui-react-radix`; `telo release floor`.

## Verify

- A page with no `pane` node is drawn with no header, navigation or `h1`. Its document has no `navigation` or `header`.
- Two pages placing one `Ui.Navbar` share it. A navbar entry whose `when` reads a request header differs per request, and the renderer keeps the navbar mounted while moving between the two pages.
- A pane placed inside a `Ui.SplitView` aside is invoked per request while the split view is resolved once.
- A `Ui.NavigationColumn` in a split view folds to its rail on collapse and remembers it, and becomes a drawer below `compactBelow`.
- `UI_PAGE_UNROUTED` is reported at a navbar entry, at a `link` `href`, and at an entry of a pane from another module, each naming a page the App does not list. A clean manifest whose App lists such a page fails at start with `ERR_UI_PAGE_UNROUTED`.
- An `in: { reaches }` object with a `use` value outside the reference vocabulary is `RESOURCE_RULE_INVALID`.
- Page → navbar → page reports no dependency cycle.
- `{ type: text, style: title }` draws the page's only `h1`.
- An unknown path draws `notFound`'s nodes, including its navbar.

## Example after the change

```yaml
kind: Ui.Navbar
metadata: { name: mainNav }
title: Acme
navigation:
  items:
    - { type: page, page: !ref home }
    - { type: page, page: !ref reports, when: !cel "'x-role' in request.headers" }
placement: { kind: Ui.HeaderNavigation }
---
kind: Ui.Page
metadata: { name: home }
path: /
title: Home
children:
  - { type: pane, ref: !ref mainNav }
  - { type: text, text: Welcome, style: title }
---
kind: Ui.Page
metadata: { name: reports }
path: /reports
title: Reports
children:
  - { type: pane, ref: !ref mainNav }
  - { type: composite, ref: !ref reportsTable }
---
kind: UiReact.App
metadata: { name: ui }
title: Acme
theme: !ref UiReact.defaultTheme
pages: [!ref home, !ref reports]
notFound:
  - { type: pane, ref: !ref mainNav }
  - { type: text, text: Nothing here, style: title }
```
