# What an application serves

Everything is under the mount path. With the application mounted at `/admin`,
`_telo/ui/app` below is `/admin/_telo/ui/app`.

| URL | Returns | Cache |
| --- | --- | --- |
| any page path, and any other path not under `_telo` | the shell; status 404 when no page declares the path | `no-cache` |
| `_telo/ui/app` | the application document | `private, no-cache`, `ETag` |
| `_telo/ui/page?path=<page path>` | a page document; a 404 problem (`{ type, title, status }`, `application/problem+json`) for an unknown path | `private, no-cache`, `ETag` |
| `_telo/ui/events` | server-sent events | — |
| `_telo/ui/assets/<sha256>/<name>` | a file by content address | `public, max-age=31536000, immutable` |

Anything else under `_telo`, and an asset no address names, is the same 404 problem. Query keys beginning `_telo` are
reserved to the renderer.

## The open key

A [surface](https://hub.telo.run/module/oci/ghcr.io/telorun/ui/) declared with
`address: { name }` is addressed on its page by the query key
`_telo.open.<name>`:

| Address | |
| --- | --- |
| `/todos` | nothing is open |
| `/todos?_telo.open.todo=` | the create form, where a create opener declares the name |
| `/todos?_telo.open.todo=42` | the edit form over the record whose key is `42` |

- Opening adds a history entry, unless a form of the same listing is already
  open in the address: then it takes that form's entry, so closing never
  returns to the form before. Closing removes only that surface's key — by
  going back when the current entry is the one this visit's opening of it
  added, the entry returned to being brought up to the address as it was less
  the key; otherwise by replacing the current entry. Another surface open on
  the page stays open. A surface closed while one opened after it is still
  open remains named in the earlier entry, and stepping back to that entry
  opens it again.
- An address opened cold opens the surface, an edit over the record read from
  `GET <basePath>/<key>`.
- An empty value under a name only an edit opener declares opens nothing. A
  row whose key is the empty string is opened in memory: no key is written and
  no entry added.
- Every history entry the application writes carries its position in
  `history.state`, as `teloPosition`; the entry present when it starts is
  stamped too. That is what lets a step back from a form holding unsaved input
  be undone while the user is asked.

A filter bar drawn in an addressed overlay
([`Ui.OverlayPlacement`](https://hub.telo.run/module/oci/ghcr.io/telorun/ui/) over a
surface with `address: { name }`) uses the same key with an **empty** value:
`/todos?_telo.open.filters=` is the open overlay. Opening adds the entry, back
closes it, a cold load opens it. Done closes the overlay and nothing else.

A [`tabs` node](https://hub.telo.run/module/oci/ghcr.io/telorun/ui/) declared with
`address: { name }` uses the same key for its chosen tab, the value the tab's
[key](#entry-keys): `/reports?_telo.open.section=details` is the tab written
with the text `Details`. The first choice adds a history entry and later ones
take it, so back returns to the page as it was before a tab was chosen. A
value naming no delivered tab chooses the first.

A [tab bar](https://hub.telo.run/module/oci/ghcr.io/telorun/ui/) whose `surface` declares
`address: { name }` holds there the key of the tab whose sheet is open — a
group's, or `~more` for More.

## Entry keys

A navigation entry and a tab of a `tabs` node are named — in the address and
in browser storage — by a key derived from what their author wrote, never by
their position, so an entry gated off by `when` or added elsewhere moves no
other's key. The key is the entry's source text — the untranslated text,
taking `other` at a plural selection — lower-cased, accents dropped, and every
run of anything but letters and digits one `-`: `Admin reports` is
`admin-reports`. A navigation entry inside a group is keyed under the group's
key and `/` (`admin/audit-log`). Of siblings whose keys would be equal, each
after the first takes `~2`, `~3` and so on, in declaration order. A text with
no letter or digit is keyed `entry` (a navigation entry) or `tab`. The
application document carries each navigation entry's key as `key`, and a page
document each tab's.

A name is one state on its page: an overlay that shares its name with a
listing's create opener opens and closes together with the create form. Give the
overlay a name of its own unless that is meant.

## Filter state

A [filter bar](https://hub.telo.run/module/oci/ghcr.io/telorun/ui/) declaring `policy.state` keeps
what is applied in it under its `key`.

### In the address

With `address: true`, one query key per filter:

| Filter | Key |
| --- | --- |
| `eq` on `isDone` | `_telo.f.<key>.isDone` |
| any other operator, e.g. `gte` on `dueOn` | `_telo.f.<key>.dueOn.gte` |
| `in` on `status` | `_telo.f.<key>.status.in`, once per value |
| the bar's search | `_telo.f.<key>.search` |

`/todos?_telo.f.todos.isDone=false&_telo.f.todos.status.in=open&_telo.f.todos.status.in=blocked`

- A key that is present and empty (`_telo.f.todos.isDone=`) is a filter on
  show holding nothing, or a declared default the viewer cleared. An absent
  key is a filter never touched.
- The address says what is applied: it is brought up to date when the bar
  starts and on every change, and when a step back or forward arrives at
  another entry of the same page, by replacing the current history entry,
  never by adding one.
- A key is matched whole against the filters the bar declares; nothing is
  parsed out of it. A key under `_telo.f.<key>.` that is no declared filter's
  is left as it is.

### In browser storage

With a `store`, one entry in local storage (`Ui.LocalStore`) or session
storage (`Ui.SessionStore`):

| | |
| --- | --- |
| Key | `telo.ui:<mount path>:f:<key>` — the mount path is `/` at the root, `/admin` under `/admin` |
| Value | `{ "v": 1, "values": { "isDone": ["false"], "status.in": ["open", "blocked"] }, "open": false }` |

`values` is keyed as the address is, without the prefix — the property, with
`.<operator>` unless it is `eq` — and each value is a list of strings. `open`
is the fold of a collapsible bar — as its placement declares it until the
viewer folds or unfolds it, their choice from then on; it is stored only,
never written to the address. An entry whose `v` is not `1` is discarded.

The entry is written on every change, and once at the start when what it held
had to be corrected. The mount path keeps two applications on one origin
apart; two bars of one application declaring the same `key` share the entry.

### Which wins

At the start: the address, when it carries any of the bar's keys; otherwise
the stored entry; otherwise the declared defaults. With both declared, every
change is written to both.

Whatever is read is held to the fields and schemas the page document carries:
an entry for a filter the bar does not declare, more than one value where the
operator is not `in`, a value the property's type or `enum` refuses, or
`false` for a filter entered with a toggle is dropped, and the store — and
the address — rewritten without it.

A browser that refuses storage — to be read, or only to be written, as under
a full quota — is reported once per store in the console (`The browser
refuses local storage, so filters are kept in memory: …`) and the bar
continues in memory. A bar with no `state` writes nothing anywhere.

## Navigation state

A [sidebar](https://hub.telo.run/module/oci/ghcr.io/telorun/ui/) naming a `store` keeps
one entry in local storage (`Ui.LocalStore`) or session storage
(`Ui.SessionStore`); it writes nothing to the address.

| | |
| --- | --- |
| Key | `telo.ui:<mount path>:n` — one per application, its mount path as a filter bar's |
| Value | `{ "v": 2, "open": ["admin", "admin/logs"], "collapsed": true }` |

`open` lists the groups open in the sidebar's column, each by its
[key](#entry-keys) — `admin` the group written `Admin`, `admin/logs` the group
`Logs` inside it — and `collapsed` whether the sidebar is collapsed to its
rail. The entry is written on every change the viewer makes, never at the
start. What is read back is held to the tree drawn: a key naming no group of
it is ignored, and an entry whose `v` is not `2` is ignored and replaced by
the next write. A store the browser refuses is reported in the console and
the sidebar continues in memory.

## Split view state

A [split view](https://hub.telo.run/module/oci/ghcr.io/telorun/ui/) naming `collapse.state`
keeps one entry in the store it names; it writes nothing to the address.

| | |
| --- | --- |
| Key | `telo.ui:<mount path>:s:<key>` — the mount path as a filter bar's; split views naming one `key` share the entry |
| Value | `{ "v": 1, "collapsed": true }` |

The entry is read when the split view mounts and beats `collapse.collapsed`,
and written on every change the viewer makes, never at the start. An entry
whose `v` is not `1` is ignored and replaced by the next write. A store the
browser refuses is reported in the console and the choice stays in memory.

## The shell

One HTML document, the same for every page: the cascade layer order, an
import map, and the renderer's script. It holds no content: it shows a spinner
for as long as its root is empty, and the renderer draws nothing until the
application's stylesheets have loaded — or, after five seconds, without them —
and its controls are loaded, so a page is never shown unstyled. A failure is
drawn at once. The import map
gives `react`, `react/jsx-runtime`, `react-dom`, `react-dom/client` and
`@telorun/ui-react` each one content-addressed URL, and maps a file two
entries share onto a single address, so the page holds one React and one host.

## The application document

```json
{
  "specVersion": 1,
  "bundle": "<renderer digest>",
  "digest": "<digest of this document>",
  "title": "Todo Admin",
  "lang": "en",
  "pages": [ { "path": "/", "title": "Todos" } ],
  "navigation": {
    "items": [ { "type": "page", "key": "todos", "path": "/", "text": "Todos", "icon": "/admin/_telo/ui/assets/…/house.svg" } ],
    "placement": { "type": "header", "compact": { "type": "overlay", "surface": { "type": "drawer", "side": "start", "…": "…" } } }
  },
  "stylesheets": [ "/admin/_telo/ui/assets/…/renderer.css", "…" ],
  "controls": {
    "stylesheets": { "Select": "/admin/_telo/ui/assets/…/select.css", "…": "…" },
    "sets": [ { "module": "/admin/_telo/ui/assets/…/controls.js", "exports": [ "Select" ] } ]
  },
  "compactBelow": "40rem",
  "header": { "start": [ { "type": "image", "src": "/logo.svg", "alt": "Acme" } ], "end": [], "width": "contained" }
}
```

`lang` is present unless the negotiated language is `und` (the application declares none and serves no other). `stylesheets` is in
cascade order — the renderer's layout, each of the theme's control sets'
stylesheets, the theme's token values and stylesheets, the token set chosen
for this request, then the application's own — so two requests may get
different lists; a theme's or a control set's stylesheet is named by a
stylesheet importing it into its layer. `controls` names the mechanics
stylesheet of each built-in control in use, by control — none for a control a
set replaces — and each set of controls the [theme](theme.md) supplies: its
module and the controls it exports, which the renderer loads before it draws
the page; see [the controls contract](controls-abi.md).
`compactBelow` is the application's
breakpoint, always present: below that viewport width every surface's
`compact` replacement applies. A surface open when the viewport crosses the
breakpoint is swapped in place: what was entered stays.
`pages` lists every page the application serves, in order — what a move
within it may reach. `navigation` is the [navigation](app.md#navigation) for
this request, every default filled: its entries delivered by their `when`,
each carrying its [key](#entry-keys), a `page` entry its page's path, an entry with an icon the
address its glyph's file is served at, and its placement as
[`Ui.NavigationPlacementSpec`](https://hub.telo.run/module/oci/ghcr.io/telorun/ui/).
`header` is always present: its `start` and `end` nodes as `Ui.SpecNode`s
produced for this request, as a page's `children` are, each list empty when
that side declares nothing or every node in it is switched off, and `width`,
how wide the header's content is drawn — the application's `header.width`,
else its `pageWidth`, else `contained`, resolved by `ui`'s `resolvedPageWidth`
([header width](app.md#header-width)).

## A page document

```json
{
  "specVersion": 1,
  "bundle": "<renderer digest>",
  "digest": "<digest of this document>",
  "path": "/",
  "title": "Todos",
  "query": {},
  "width": "contained",
  "children": [ { "type": "text", "text": "Open work", "style": "heading" } ]
}
```

`children` are `Ui.SpecNode`s, produced for this request: no `when` is left in
them, and every `shown` is carried as written. `query` is the page's declared
query parameters, `{}` when it declares none; the renderer reads each from the
address as the page's `query` root. `width` is how wide the page's content is
drawn, `contained` or `full` — the page's own, else the application's
`pageWidth`, else `contained` ([page width](app.md#page-width)).

## Digests

`digest` is a hash of the document as produced, so it differs exactly when
what the viewer would see differs — per request included. It is also the
`ETag`: a request carrying it in `If-None-Match` answers 304.

`bundle` is the renderer's digest. The renderer compares both: another
`bundle` means the server holds a newer renderer, and the page reloads;
another `digest` re-renders in place, keeping what is mounted.

## Events

`_telo/ui/events` opens with `hello`, carrying `bundle`, and sends a comment
every 25 seconds to keep the connection open. The renderer reads a second
`hello` as a reconnect — the server may have restarted — and re-fetches its
documents conditionally. Streams end when the server stops.

## Addresses

Every address the page document carries — a `link` or menu item `href`, a
`value` node's `href`, a `list` or `Ui.TableLayout` column `href`, a relation
or option source `href`, a reader's `source`, an action's `request.target`,
`onSuccess.navigate` and `onSuccess.refreshes` — is `{ path, pathParams,
queryParams }`, expanded in the browser over the roots its site binds (`row`,
`query`, `data`, `input`, `result`). The renderer holds a twin of the expansion
in `ui`, and both answer `modules/ui/conformance/addresses.json` row for row:
a `{name}` segment is the percent-encoded value of its path parameter (an empty
or absent value does not resolve), query parameters follow in declaration
order with null and empty lists left out and a list repeating its key, and
the result must be an address under the mount or an `https:`, `http:` or
`mailto:` one. An app-relative address is requested and linked under the mount.

- **Unresolved.** A link or cell is drawn as plain text, a menu item is left
  out, a reader sends nothing and draws its `failure` tree, an action sends
  nothing and draws its `failure` tree, a refresh is skipped and a navigation
  goes nowhere; each is reported once in the console as
  `ERR_UI_ADDRESS_UNRESOLVED`, naming the parameter.
- **Following one.** An address whose path and query are exactly a declared
  page's path moves within the application; any other is an ordinary load. A
  cell link to anything but a declared page keeps `target="_blank"`.
- **The page already shown.** A move to the page being shown (same path, new
  query or fragment) fetches no document and keeps every node mounted — what a
  form or an action holds, a listing's loaded pages — and each reader re-reads
  the query parameters it declares from the new address.

## Invalidation

Readers and writers meet at one key: the resolved, percent-encoded,
app-relative path, its query left out. After a 2xx the renderer announces an
action's resolved target path, each resolved `refreshes` path and, inside a
listing, its `basePath`; a listing's own edit (`PUT`) and delete also announce
the record's path (`<basePath>/<key>`). Announcing reloads, by exact equality:
every `data` reader whose resolved `source` path is that path (a `refreshes`
entry whose literal path holds a `*` / `**` segment instead reads again every
subscribed reader — `data`, listing or chat — whose key it matches, segment by
segment: `*` one non-empty segment, `**` any number, none included), every listing
whose `basePath` is (with its facet and relation label reads), and a `chat`
whose open conversation path (`<basePath>/conversations/<id>`) is — read again
unless a turn is running in it. A chat announces its own `refreshes` when a send
is admitted and when a turn ends.
