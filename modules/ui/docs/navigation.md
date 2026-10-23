# Navigation

An application's navigation is a tree of entries, separate from its routing:
the application lists its [pages](page.md), and the tree names them by
reference — never by path — so a path changes in one place, the editor offers
a page picker, and a library's pages are put in the tree like the
application's own. How the tree is drawn is a placement kind.

## `Ui.Navigation`

The record a renderer's application takes as its `navigation`:

```yaml
navigation:
  items:
    - { type: page, page: !ref home, icon: !ref homeIcon }
    - type: group
      text: Reports
      icon: !ref reportsIcon
      items:
        - { type: page, page: !ref monthly }
        - { type: page, page: !ref Audit.log, text: Audit trail }
        - type: group
          text: Archive
          items:
            - { type: page, page: !ref archive2025 }
    - type: link
      text: Status
      href: https://status.example.com
      when: !cel "'x-role' in request.headers && request.headers['x-role'] == 'staff'"
  placement: { kind: Ui.HeaderNavigation }
```

| Field | | |
| --- | --- | --- |
| `items` | | the entries, in order — `Ui.NavigationItem` each |
| `placement` | | how the tree is drawn — a [`Ui.NavigationPlacement`](#placements) |

### Entries — `Ui.NavigationItem`

Tagged by `type`:

| `type` | Keys | |
| --- | --- | --- |
| `page` | `page`, `text?`, `icon?`, `when?` | a page the application lists; `text` defaults to the page's title |
| `link` | `text`, `href`, `icon?`, `when?` | any address a [`link` node](nodes.md#addresses) may hold: an app-relative path, or `https://`, `http://`, `mailto:` |
| `group` | `text`, `items`, `icon?`, `when?` | entries nested to any depth |

`icon` is a [`Ui.Icon`](icons.md), declared in place or named by `!ref` — `Ui.FileIcon`, or an icon
set's kind such as `UiLucide.Icon`. It is drawn before the entry's text, as a
tab's glyph in a tab bar, and in a sidebar's rail in place of the entry's first
letter, in the colour of the entry's text.

`when` is evaluated for every request over `request` (`request.headers`,
`request.ip`), as a page's own nodes are. An entry whose `when` is false is
not delivered, and a group none of whose entries is delivered is left out
with it.

Each entry is keyed by what its author wrote: the slug of its source text —
the untranslated text, or its page's title — under its group's key and `/`,
a sibling repeating a key taking `~2`, `~3` in declaration order (`Reports`
→ `reports`, its `Archive` group → `reports/archive`). A stored or addressed
state names an entry by that key, never by its position, so an entry gated
off by `when` or added elsewhere moves no other entry's key. The rule is
spelled out in [`ui-react`'s URLs](../../ui-react/docs/urls.md#entry-keys).

**Every page an entry names must be one the application lists.** An entry
naming any other page, at any depth of the tree, leads nowhere: it is
`RESOURCE_RULE_VIOLATED` with `data.rule: UI_NAVIGATION_PAGE_UNROUTED` at
`telo check`, anchored at that entry, and `ERR_UI_NAVIGATION_PAGE_UNROUTED`
when the application is created.

## Placements

| Kind | Draws | Keys |
| --- | --- | --- |
| `Ui.HeaderNavigation` | the tree in the header: groups as dropdowns, nested groups as submenus, what does not fit under More | `compact` — a `Ui.CompactNavigationPlacement` |
| `Ui.SidebarNavigation` | the tree in a column beside the page, each group opening in place beneath its button, several at once; collapsed to a rail, each group floating its entries beside it | `side` (`start` \| `end`), `rail: { collapsed }`, `store` — a [`Ui.StateStore`](state-store.md#stores), `compact` — a `Ui.CompactNavigationPlacement` |
| `Ui.OverlayNavigation` (compact) | the whole tree behind a menu button, in the surface the button opens | `surface` — a [`Ui.Overlay`](surfaces.md) |
| `Ui.TabBarNavigation` (compact) | the top-level entries as tabs along the bottom edge; a group's tab, or More, opens its entries in `surface`, in a column | `visible` (2–5), `surface` — a [`Ui.Overlay`](surfaces.md) |

`Ui.NavigationPlacement` is the abstract every placement extends, and
`Ui.CompactNavigationPlacement` the narrower one every `compact` slot takes:
a placement that suits a phone screen, which `Ui.OverlayNavigation` and
`Ui.TabBarNavigation` are. A kind of another module extending it is accepted
at `compact` with no change to `ui`. Below the application's breakpoint a
header or a sidebar is replaced by its `compact`; a compact placement has no
`compact` of its own, and writing one is a `SCHEMA_VIOLATION`. A compact
placement may be the application's placement too: a tab bar at every width.

```yaml
navigation:
  items: [ … ]
  placement:
    kind: Ui.SidebarNavigation
    rail: { collapsed: false }
    store: { kind: Ui.LocalStore }
    compact: { kind: Ui.TabBarNavigation, visible: 4 }
```

### The sidebar

- `side` — the edge of the page it sits at.
- `rail` — written, the viewer can collapse the sidebar to a rail, where each
  top-level entry is drawn as its icon — its first letter when it has none —
  and named by its whole text, and expand it again; `collapsed` says whether it starts collapsed. Left
  out, the sidebar does not collapse.
- `store` — where the open groups and whether the rail is collapsed are kept
  between visits; a stored choice wins over `collapsed`. Left out, they are
  kept in memory only. The groups open in a rail's flyouts are never kept.

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

- no `navigation`: one `page` entry per page the application lists, in order;
- no `placement`: `{ kind: Ui.HeaderNavigation }`;
- a header's `compact` omitted: `{ kind: Ui.OverlayNavigation }`;
- a sidebar's `side` omitted: `start`; its `rail` omitted: no rail, and its
  `collapsed`: `false`; its `store` omitted: memory;
- a sidebar's `compact` omitted: `{ kind: Ui.OverlayNavigation }` whose
  drawer slides in from the sidebar's own side;
- an overlay's `surface` omitted: `{ kind: Ui.Drawer, side: start }`;
- a tab bar's `visible` omitted: `5`; its `surface` omitted:
  `{ kind: Ui.Drawer, side: bottom }`, a bottom sheet.

An application with no `navigation` block therefore draws its pages in the
header, and below the breakpoint a menu button opening a drawer from the start
edge that holds every page.

## As a renderer receives it

`Ui.NavigationPlacementSpec`, tagged on `type`, every member present:

| `type` | Members |
| --- | --- |
| `header` | `compact` — the `overlay` or the `tab-bar` branch |
| `sidebar` | `side`, `rail?` — `{ collapsed }`, present when declared — `store` — a `Ui.StateStoreSpec`, `memory` when none is named — and `compact`, as on `header` |
| `overlay` | `surface` — a `Ui.OverlaySpec` |
| `tab-bar` | `visible`, `surface` — a `Ui.OverlaySpec` |

A renderer's controller prepares the navigation once with
`preparedNavigation(navigation, pages, ctx, owner)` and delivers it per request
with `deliveredNavigation(evaluated)` — both exported by
[`@telorun/ui`](composite.md#for-a-renderers-controller-telorunui) — so an
entry arrives as `{ type: page, key, path, text }`, `{ type: link, key, href, text }` or
`{ type: group, key, text, items }`, its key and its page's path filled in, and with `icon` —
the address the renderer serves the icon's file at — when the entry names one.
`preparedNavigation` takes a fifth argument, the function serving an icon's
`file` and answering that address.
