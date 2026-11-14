# Navigation

Site navigation is a [pane](pane.md): a piece of chrome holding a tree of
entries, placed in a [page layout](page-layout.md)'s region, a page's
children or a composite. The tree is separate from routing: the application
lists its [pages](page.md), and the tree names them by reference — never by
path — so a path changes in one place, the editor offers a page picker, and a
library's pages are put in the tree like the application's own. Nothing is
derived from the routes: a navigation pane draws exactly the tree it holds.

```yaml
kind: Ui.PageLayout
metadata: { name: chrome }
header:
  - type: pane
    ref:
      kind: Ui.Navbar
      title: Acme
      navigation:
        items:
          - { type: page, page: !ref home, icon: !ref homeIcon }
          - type: group
            text: Reports
            items:
              - { type: page, page: !ref monthly }
              - { type: page, page: !ref Audit.log, text: Audit trail }
          - type: link
            text: Status
            href: https://status.example.com
            when: !cel "'x-role' in request.headers && request.headers['x-role'] == 'staff'"
      placement: { kind: Ui.HeaderNavigation }
      end:
        - { type: link, text: Sign in, href: { path: !ref signIn } }
```

A header with only a title and links needs no navigation pane: it is a
[`bar` node](nodes.md).

## `Ui.Navigation`

The tree, `{ items }`:

| Field | | |
| --- | --- | --- |
| `items` | required | the entries, in order — `Ui.NavigationItem` each |

It declares no CEL context of its own: the pane holding it binds what an
entry's `when` reads. A navigation pane binds `request`.

### Entries — `Ui.NavigationItem`

Tagged by `type`:

| `type` | Keys | |
| --- | --- | --- |
| `page` | `page`, `text?`, `icon?`, `when?` | a page, with no [variable](page.md#path-variables) in its path; `text` defaults to the page's title, and is required for a page with none |
| `link` | `text`, `href`, `icon?`, `when?` | any address a [`link` node](nodes.md#addresses) may hold: an app-relative path, or `https://`, `http://`, `mailto:` |
| `group` | `text`, `items`, `icon?`, `when?` | entries nested to any depth |

`page` names its page and never holds it (a `use: schema` reference): the
pane reads the page's path and title off its declaration, so a page may place
a navigation naming itself, and two pages may name each other. The
application checks that every page named anywhere it reaches is one of its
`pages`; see `ui-react`'s application.

`icon` is a [`Ui.Icon`](icons.md), declared in place or named by `!ref` —
`Ui.FileIcon`, or an icon set's kind such as `UiLucide.Icon`. It is drawn
before the entry's text, as a tab's glyph in a tab bar, and alone where the
entry is drawn as a glyph — a navigation column's rail — in the colour of the
entry's text. The pane publishes its file in its `assets` reading.

A `link` entry is current, and drawn so (`aria-current="page"`), when its
address leads to where the viewer is under the [rule for
links](nodes.md#the-current-location): the same path and the same query, the
renderer's `_telo*` parameters set aside. A `page` entry is current by its path
alone, whatever the query.

`when` is evaluated over `request` (`request.headers`, `request.ip`) each
time the pane is invoked: per request in a page's children or a layout
region. Inside a composite a pane is resolved once, with no request, and the
composite withholds `request`, so an entry reading it there is refused. An entry whose `when`
is false is not delivered, and a group none of whose entries is delivered is
left out with it.

Each entry is keyed by what its author wrote: the slug of its source text —
the untranslated text, or its page's title — under its group's key and `/`,
a sibling repeating a key taking `~2`, `~3` in declaration order (`Reports`
→ `reports`, its `Archive` group → `reports/archive`). A stored or addressed
state names an entry by that key, never by its position, so an entry gated
off by `when` or added elsewhere moves no other entry's key. The rule is
spelled out in [`ui-react`'s URLs](https://hub.telo.run/module/oci/ghcr.io/telorun/ui-react/).

## Navigation panes

`Ui.NavigationPane` is the abstract every navigation pane extends: a
[`Ui.Pane`](pane.md) holding a required `navigation`. It carries the two
rules a tree is held to, so `Ui.Navbar`, `Ui.NavigationColumn` and a
navigation pane of another module extending it in merge form are all checked
with no rule of their own:

- **A page an entry names has a title, or the entry has a text.** Otherwise
  the entry has no label: `RESOURCE_RULE_VIOLATED` with `data.rule:
  UI_NAVIGATION_PAGE_UNTITLED` at `telo check`, anchored at that entry however
  deep, and `ERR_UI_NAVIGATION_PAGE_UNTITLED` when the pane is created.
- **A page an entry names has no variable in its path.** An entry has nothing
  to fill `/plans/{id}` with: `UI_NAVIGATION_PAGE_HAS_PARAMETERS` at `telo
  check`, `ERR_UI_NAVIGATION_PAGE_HAS_PARAMETERS` when the pane is created.
  Reach the page with a `link` whose `pathParams` fill it.

A navigation pane extending it with `base:` has an author schema of its own,
inherits no rule, and restates them.

### `Ui.Navbar`

A title and a navigation drawn by its placement — a menu bar in the header, a
menu button or a tab bar — with nodes before and after it.

| Field | | |
| --- | --- | --- |
| `title` | optional | a `Text`, drawn at the bar's start, such as the application's name |
| `start` | optional | nodes before the title, such as a logo |
| `end` | optional | nodes after the navigation, such as a sign-in link or a language switch |
| `navigation` | required | the tree |
| `placement` | optional | how the tree is drawn — a [`Ui.NavigationPlacement`](#placements) |

`start` and `end` read `request` like the tree, and bind no page variables and
no query parameters: one bar is drawn on pages with different ones.

### `Ui.NavigationColumn`

The tree drawn as a column whose groups open in place beneath their buttons,
several at once. In a [`Ui.Aside`](split-view.md#the-aside) it folds with the
aside into a rail of glyphs — an entry with no icon drawn as its first letter —
each group floating its entries beside it; placed anywhere else it draws as a
plain column.

| Field | | |
| --- | --- | --- |
| `navigation` | required | the tree |
| `state` | optional | `{ key, store }`: keeps the open groups between visits under `key` in a [`Ui.StateStore`](state-store.md#stores); columns naming one key share them. Left out, they are kept in memory only |

The groups open in a rail's flyouts are never kept.

## Placements

How a `Ui.Navbar` draws its tree:

| Kind | Draws | Keys |
| --- | --- | --- |
| `Ui.HeaderNavigation` | the tree in the header: groups as dropdowns, nested groups as submenus, what does not fit under More | `compact` — a `Ui.CompactNavigationPlacement` |
| `Ui.OverlayNavigation` (compact) | the whole tree behind a menu button, in the surface the button opens | `surface` — a [`Ui.Overlay`](surfaces.md) |
| `Ui.TabBarNavigation` (compact) | the top-level entries as tabs along the bottom edge; a group's tab, or More, opens its entries in `surface`, in a column | `visible` (2–5), `surface` — a [`Ui.Overlay`](surfaces.md) |

`Ui.NavigationPlacement` is the abstract every placement extends, and
`Ui.CompactNavigationPlacement` the narrower one every `compact` slot takes:
a placement that suits a phone screen, which `Ui.OverlayNavigation` and
`Ui.TabBarNavigation` are. A kind of another module extending it is accepted
at `compact` with no change to `ui`. Below the application's breakpoint a
header is replaced by its `compact`; a compact placement has no `compact` of
its own, and writing one is a `SCHEMA_VIOLATION`. A compact placement may be
the bar's placement too: a tab bar at every width.

A sidebar is a [layout's aside](page-layout.md) holding a
`Ui.NavigationColumn`: the aside brings the fold, the rail, the remembered
fold and the narrow-screen drawer.

### The tab bar

The bar shows at most `visible` tabs: with more top-level entries than that,
its last tab is More, holding the rest in order. A page or a link's tab
follows it; a group's tab, and More, opens its entries in `surface`, in a
column whose groups open in place; its tab stays expanded while that surface
is open. Following an entry there closes the surface. The surface's `address`
puts the open group's key in the page's address — `~more` for More — as any
surface's does.

## Defaults

`ui` fills every one, so a renderer reads none of its own:

- a navbar's `start` and `end` omitted: none; its `placement` omitted:
  `{ kind: Ui.HeaderNavigation }`;
- a column's `state` omitted: memory (`state: null` on the wire);
- a header's `compact` omitted: `{ kind: Ui.OverlayNavigation }`;
- an overlay's `surface` omitted: `{ kind: Ui.Drawer, side: start }`;
- a tab bar's `visible` omitted: `5`; its `surface` omitted:
  `{ kind: Ui.Drawer, side: bottom }`, a bottom sheet.

## As a renderer receives it

A navigation pane answers a [`Ui.SpecNode`](nodes.md#as-a-renderer-receives-it):

| `type` | Members |
| --- | --- |
| `navbar` | `title?`, `start`, `end`, `navigation` — `{ items }` as delivered — `placement`, `fill`, `shown?` |
| `navigation-column` | `navigation`, `state` — `{ key, store }` or `null` — `fill`, `shown?` |

An entry arrives as `{ type: page, key, path, text }`, `{ type: link, key,
href, text }` or `{ type: group, key, text, items }`, its key and its page's
path filled in, and with `icon` — the `{ digest, name }` address of the
glyph's file, as every file a node names — when the entry names one.

`Ui.NavigationPlacementSpec`, tagged on `type`, every member present:

| `type` | Members |
| --- | --- |
| `header` | `compact` — the `overlay` or the `tab-bar` branch |
| `overlay` | `surface` — a `Ui.OverlaySpec` |
| `tab-bar` | `visible`, `surface` — a `Ui.OverlaySpec` |

A navigation pane of another module draws its tree the way `ui`'s own do:
`preparedNavigation(navigation, ctx, owner)` once, when it is created —
every default filled, each page entry read off its page's declaration, the
two navigation rules' runtime twins raised, and each glyph's file in the
answer's `assets` — and `deliveredNavigation(ctx.expandValue(items, {
request }))` each time it is invoked. Both are exported by
[`@telorun/ui`](composite.md#for-a-renderers-controller-telorunui). A page
entry read off a declaration carries the page's title as a record of no
particular language (`lang: und`): a title takes no values, so it reads the
same in any, and a translation of it is found by its words.
