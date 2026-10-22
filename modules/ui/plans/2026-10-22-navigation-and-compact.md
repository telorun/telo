# Navigation and narrow screens

Every kind of application menu — a header bar with dropdowns and submenus, a
sidebar with a collapsible icon rail, a menu button opening a drawer, a bottom
tab bar — declared as data, and every screen usable on a phone.

## Shape of the solution

- **Navigation is a tree separate from routing.** `UiReact.App.pages` stays the
  flat list of routes; a page becomes a resource of its own kind, `Ui.Page`. A
  navigation tree names pages by `!ref`, never by path, so the editor offers a
  page picker, a path change moves every entry with it, and a library can ship
  pages.
- **How the tree is drawn is a placement kind**, like filter placements and form
  surfaces: a header bar, a sidebar, an overlay behind a menu button, a tab bar.
  Below `compactBelow` a placement is replaced by a compact one, which is the
  menu-button drawer unless the author names another.
- **Site navigation is drawn as navigation, not as a command menu.** A new
  `Navigation` control implements the WAI-ARIA disclosure-navigation pattern;
  it floats its panels, so it joins the layer controls, which makes this
  `ui_react_controls-2`.
- **One rule for narrow screens.** A compact behaviour that changes *what* is
  drawn or how it is used is declared as a `compact` replacement whose default
  `ui` fills; a compact behaviour that only lays out the same structure
  differently (wrapping, stacking, scrolling sideways) is the theme's CSS, keyed
  on `data-compact="true"` on the `app` part. The renderer invents no compact
  structure, and `compactBelow` stays the one breakpoint.
- **Icons are resources.** An abstract `Ui.Icon` (a single-colour glyph that
  provides one file) with `Ui.FileIcon` in `ui` and Lucide's glyphs in a new
  module, `ui-lucide`. A glyph is drawn as a mask in the current text colour, so
  a theme colours it like text.

Vocabulary lives in `ui` (renderer-neutral) and `ui-react` draws it:

| Module | Gains |
| --- | --- |
| `ui` | `Ui.Page`; the `Ui.Navigation` record `{ items, placement }`; the `Ui.NavigationItem` shape; `Ui.NavigationPlacement`, `Ui.CompactNavigationPlacement` and the four placement kinds; `Ui.NavigationPlacementSpec`; `Ui.Icon`, `Ui.FileIcon`; the `tabs` node; `Ui.FoldingFilterPlacement`, `Ui.ViewportOverlay`; the helper filling every navigation default |
| `ui-react` | `UiReact.App.pages` as a list of `Ui.Page`; `UiReact.App.navigation`; the unrouted-page rule; the `Navigation` and `Tabs` controls; the parts; `ui_react_controls-2` |
| `ui-react-radix` | its `Navigation` and `Tabs` against generation 2 |
| `ui-lucide` (new, MIT) | `UiLucide.Icon` |

Dependency direction: `ui-react` → `ui`; `ui-react-radix` → `ui-react`;
`ui-lucide` → `ui`; `ui` imports nothing from a renderer.

---

## Phase 1 — Narrow screens without new vocabulary

Measured at 390px on the showcase (`examples/ui-showcase`, mounts `/` and
`/radix`).

**Before.**
- The header is 180–195px tall and sticky: the page links wrap onto three rows
  and cover nearly a quarter of the screen while scrolling.
- An aside filter bar with no `compact` stays beside the content: on the CRUD
  page of `/radix` the table is squeezed to a ~30px column and its New button and
  pager sit off the left edge.
- A filter whose control has two bounds (`gt` / `lt` on one property) is wider
  than the screen on `/filters`, so the whole page scrolls sideways.
- A table scrolls sideways inside `table-frame` with nothing showing that more
  columns exist.
- The showcase's own token table (Themes page) and a long `mailto:` link under the
  `/brand` theme make their pages scroll sideways.

**After.**
- `Ui.AsidePlacement` without `compact` is filled by `ui` with
  `{ kind: Ui.CollapsiblePlacement }` (folded), so the wire's `aside` branch
  always carries `compact`. The pinned-field warning no longer applies to an
  aside placement, since it now always folds on a narrow screen.
  `Ui.AbovePlacement` keeps no default: a row above the content only wraps.
- Under `data-compact="true"`, both themes:
  - let the header scroll: it stops being sticky, and `nav` becomes one row that
    scrolls sideways;
  - let a filter's bounds and every filter control shrink and wrap;
  - give `table-frame` an edge shadow while more columns lie beyond it.
- The showcase's token table wraps its long cells; `brand.css` breaks long words
  in text, values and links as the default and Radix themes already do.

**Verify.**
- At 390px, on every showcase page of `/`, `/radix` and `/brand`, the document's
  scroll width equals the viewport width.
- The header is no taller than two rows, and it scrolls away with the page.
- The CRUD page on `/radix` shows a folded filter toggle above a full-width table.
- A `Ui.AsidePlacement` with no `compact` reaches the renderer with
  `compact: { type: collapsible, open: false }`. Pinned-field fixtures on an
  aside bar no longer warn.
- `UiReactConformance.CheckTheme` passes on every theme.

---

## Phase 2 — `ui_react_controls-2`: the `Navigation` and `Tabs` controls

**Before.** Generation 1 has 22 controls, eight of them layer controls replaced as
one unit. The `menu` node is drawn through `Menu` (`role=menu`), so its links are
announced as menu items, and an item is marked current through an optional
`current` member on `Menu`'s items.

**After.**
- **`Navigation`, a layer control**, implementing disclosure navigation:
  - it draws a tree horizontally, vertically or as an icon rail;
  - it draws every item as a real link and every group as a disclosure button;
  - it floats each open panel at the end of `<body>`, marked `data-telo-layer`,
    with Tab order flowing into it;
  - it moves what does not fit into a More group;
  - it draws a `nav` landmark only when given a label.

  The renderer owns which groups are open and every move between pages: the
  control reports what was chosen.
- **`Tabs`, a non-layer control**, for the `tabs` node (Phase 4).
- **`IconName` gains `menu`, `more`, `collapse`, `expand`.**
- **The layer unit is nine controls.** `UI_CONTROLS_LAYERS_PARTIAL` /
  `ERR_UI_CONTROLS_LAYERS_PARTIAL` list nine names, so a set implementing the old
  eight is refused.
- **The `menu` node is drawn by `Navigation`**, as one disclosure with no landmark;
  an item styled `strong` carries `aria-current="true"`. `current` leaves `Menu`'s
  items, and `Menu` stays the command menu (`role=menu`).
- **The renderer hosts generation 2 only.** `ui-react-radix` implements
  `Navigation` and `Tabs` against it.
- **The contract data, vectors and every-part scenes are extended,**
  `ui-react-conformance` runs them, and the parts for nav groups, panels, the
  toggle and the tab bar are added. Every theme styles them.

**Verify.**
- A controls set implementing the old eight layer controls is refused with
  `UI_CONTROLS_LAYERS_PARTIAL` at `telo check` and with
  `ERR_UI_CONTROLS_LAYERS_PARTIAL` at start.
- With a navigation panel and a tooltip both open, Escape closes only the top one,
  under the built-ins and under the Radix set.
- A screen reader reads a `menu` node's items as links. The current one is
  announced as current.
- `UiReactConformance.CheckControls` passes for the built-ins and for
  `UiReactRadix.controls` at generation 2.

---

## Phase 3 — Pages as resources and the navigation tree

**Before.** `UiReact.App.pages` is a list of `{ path, title, query?, children }`.
The renderer draws one flat `nav-link` per page, in order, and nothing else can
be put in the navigation.

**After.**
- **`Ui.Page`** is a kind with `path`, `title`, `query` and `children`. It is
  invoked by the App per request with the request and answers the page's resolved
  document; its composites are resolved once, at creation. `UiReact.App.pages` is
  a list of `Ui.Page`, inline or `!ref`. `UI_PAGE_PATH_DUPLICATE` reads the listed
  pages' paths through `resolve:`.
- **`UiReact.App.navigation`** is the `Ui.Navigation` record `{ items, placement }`.
  `items` is a tree of entries tagged by `type`:
  - `page` — `{ page: !ref, text?, icon?, when? }`; the text defaults to the
    page's title;
  - `link` — `{ text, href, icon?, when? }`, held to the link address rule;
  - `group` — `{ text, items, icon?, when? }`, nested to any depth.

  `when` is evaluated per request over `request`, as on header nodes. A group none
  of whose entries is delivered is left out.
- **An entry naming a page `pages` does not list** is `RESOURCE_RULE_VIOLATED`
  with `data.rule: UI_NAVIGATION_PAGE_UNROUTED`, anchored at that entry at any
  depth, and `ERR_UI_NAVIGATION_PAGE_UNROUTED` at creation. The analyzer's rule
  `in:` pointer gains the repeated-segment spelling eval paths already use, so a
  rule visits every entry of a tree of unknown depth. `ui-react` declares the
  `requires: telo:` floor of the release carrying it, verified by running the
  previous published CLI against it.
- **Placements:** `Ui.NavigationPlacement` (abstract) and
  `Ui.CompactNavigationPlacement` (a narrower abstract, the type of every
  `compact` slot):

  | Kind | Draws | Keys |
  | --- | --- | --- |
  | `Ui.HeaderNavigation` | the tree in the header; groups as dropdowns, nested groups as submenus, overflow under More | `compact` |
  | `Ui.OverlayNavigation` (compact) | the whole tree behind a menu button | `surface` (a `Ui.Overlay`) |

  The sidebar and tab-bar kinds arrive in Phase 4.
- **Every default is filled by `ui`:**
  - no `navigation`: one `page` entry per `pages` entry, in order (today's nav);
  - no `placement`: `{ kind: Ui.HeaderNavigation }`;
  - header `compact` omitted: `{ kind: Ui.OverlayNavigation }`;
  - overlay `surface` omitted: `{ kind: Ui.Drawer, side: start }`.

  The wire shape is `Ui.NavigationPlacementSpec`, tagged `header` / `overlay`.
- **The menu button** is drawn first in the header, or last when the surface is a
  drawer opening from `end`. The `header` slots stay as they are under every
  placement.
- **The renderer marks the entry of the page being shown, and every group on
  the way to it**, by which page is shown.
- **Every in-repo `UiReact.App` moves to `Ui.Page`:** examples, starters,
  blueprints and tests.

**Verify.**
- A `!ref` to a page missing from `pages`, three groups deep, is reported at that
  entry by `telo check`, and the start fails with
  `ERR_UI_NAVIGATION_PAGE_UNROUTED`.
- A library exporting a `Ui.Page` is listed and put in the navigation by an app
  with no other change.
- No navigation field holds a page path.
- At 390px with no `navigation` block, the header shows the menu button and the
  drawer holds every page. At 1280px the header bar opens a group as a dropdown
  and a nested group as a submenu.
- The previous published CLI reports `MODULE_REQUIRES_NEWER_RUNTIME` for
  `ui-react`, and fails without the floor.

---

## Phase 4 — Sidebar, tab bar, icons, in-page tabs, abstract compact slots

**Before.** The navigation can only sit in the header or behind a menu button,
entries carry no icons, and a page has no tabs. Filter placements' and surfaces'
`compact` slots list their concrete kinds, so another module's kind cannot be
accepted there.

**After.**
- **More placements:**

  | Kind | Draws | Keys |
  | --- | --- | --- |
  | `Ui.SidebarNavigation` | a column beside `main` | `side` (`start` \| `end`), `rail: { collapsed }`, `store` (a `Ui.StateStore`, for open groups and the rail), `compact` |
  | `Ui.TabBarNavigation` (compact) | top-level entries as bottom tabs; a group or More opens its entries in `surface` | `visible` (2–5), `surface` |

  A sidebar's `compact` omitted is an overlay drawer opening from the sidebar's
  side. A rail draws an icon-less top-level entry as its first letter. The tab
  bar is valid as the main placement too.
- **Icons:**
  - `Ui.Icon` (abstract) and `Ui.FileIcon` (`file`, a `!module-path`);
  - `UiLucide.Icon` in the new `ui-lucide` module, whose `name` is a closed enum
    of Lucide's glyph names. Its SVGs are staged through `sources:` with Lucide's
    ISC notice, and the module carries `license: MIT` and its `LICENSE`.

  A navigation entry's `icon` is a `use: dependency` reference to a `Ui.Icon`. The
  glyph is drawn as a CSS mask in the current text colour, never inserted as SVG
  markup. The closed `IconName` list stays for the renderer's own glyphs.
- **The `tabs` node:** `{ type: tabs, tabs: [{ text, children }], address? }`,
  drawn by the `Tabs` control. With `address: { name }` the chosen tab is in the
  page's address, as for a surface.
- **Abstract compact slots:**
  - filter placements' `compact` is typed by `Ui.FoldingFilterPlacement`, which
    `Ui.CollapsiblePlacement` and `Ui.OverlayPlacement` extend;
  - surfaces' `compact` is typed by `Ui.ViewportOverlay`, which `Ui.Dialog` and
    `Ui.Drawer` extend, under `Ui.Overlay`.

  Manifests already written keep validating unchanged.
- **The showcase** gains a sidebar mount and a tab-bar compact, icons on its
  entries, and a tabs page.
- **Docs:** a benefits-ledger entry "Responsive navigation" in
  `docs/guides/what-you-get.md`; the authoring-agent primer; the hub's
  `build-ui` guide; the `ui`, `ui-react` and `ui-lucide` docs.

**Verify.**
- A kind from another module extending `Ui.CompactNavigationPlacement` is
  accepted at `compact` with no change to `ui`.
- `compact` written on an overlay or tab-bar placement is a `SCHEMA_VIOLATION`.
- `UiLucide.Icon` with an unknown `name` is a `SCHEMA_VIOLATION`.
- The current entry's glyph takes the accent colour with no icon CSS.
- An app's check and start time do not grow with Lucide's glyph count.
- A collapsed rail persists its state across reloads through the declared store.
- At 390px the tab bar shows at most `visible` entries, and a group opens in its
  surface.

---

## Release notes per phase

- Each module's changes go into a `telo release add` fragment, one per module.
  A breaking change is written as `Added`, with the break described in the body.
- Phase 2 is breaking for any external controls set: the layer unit grows.
- Phase 3 is breaking for every `UiReact.App`: its pages become `Ui.Page`.
- Only Phase 3 widens the manifest grammar (the rule `in:` pointer), so only
  `ui-react` takes a new `requires:` floor.
