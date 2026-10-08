# What an application serves

Everything is under the mount path. With the application mounted at `/admin`,
`_telo/ui/app` below is `/admin/_telo/ui/app`.

| URL | Returns | Cache |
| --- | --- | --- |
| any page path, and any other path not under `_telo` | the shell; status 404 when no page declares the path | `no-cache` |
| `_telo/ui/app` | the application document | `private, no-cache`, `ETag` |
| `_telo/ui/page?path=<page path>` | a page document; a JSON 404 for an unknown path | `private, no-cache`, `ETag` |
| `_telo/ui/events` | server-sent events | — |
| `_telo/ui/assets/<sha256>/<name>` | a file by content address | `public, max-age=31536000, immutable` |

Anything else under `_telo` is a JSON 404. Query keys beginning `_telo` are
reserved to the renderer.

## The open key

A [surface](../../ui/docs/surfaces.md#address) declared with
`address: { name }` is addressed on its page by the query key
`_telo.open.<name>`:

| Address | |
| --- | --- |
| `/todos` | nothing is open |
| `/todos?_telo.open.todo=` | the create form, where a create opener declares the name |
| `/todos?_telo.open.todo=42` | the edit form over the row whose key is `42` |

- Opening adds a history entry, unless a form of the same table is already
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
([`Ui.OverlayPlacement`](../../ui/docs/filter-placement.md#folding) over a
surface with `address: { name }`) uses the same key with an **empty** value:
`/todos?_telo.open.filters=` is the open overlay. Opening adds the entry, back
closes it, a cold load opens it. Done closes the overlay and nothing else.

A name is one state on its page: an overlay that shares its name with a
table's create opener opens and closes together with the create form. Give the
overlay a name of its own unless that is meant.

## Filter state

A [filter bar](../../ui/docs/state-store.md) declaring `policy.state` keeps
what is applied in it under its `key`.

### In the address

With `address: true`, one query key per filter:

| Filter | Key |
| --- | --- |
| `eq` on `isDone` | `_telo.f.<key>.isDone` |
| any other operator, e.g. `gte` on `dueOn` | `_telo.f.<key>.dueOn.gte` |
| `in` on `status` | `_telo.f.<key>.status.in`, once per value |

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

## The shell

One HTML document, the same for every page: the cascade layer order, an
import map, and the renderer's script. It holds no content: it shows a spinner
for as long as its root is empty, and the renderer draws nothing until the
application's stylesheets have loaded — or, after five seconds, without them —
so a page is never shown unstyled. A failure is drawn at once. The import map
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
  "stylesheets": [ "/admin/_telo/ui/assets/…/renderer.css", "…" ],
  "compactBelow": "40rem"
}
```

`lang` is present only when the application sets one. `stylesheets` is in
application order and includes the theme chosen for this request, so two
requests may get different lists. `compactBelow` is the application's
breakpoint, always present: below that viewport width every surface's
`compact` replacement applies. A surface open when the viewport crosses the
breakpoint is swapped in place: what was entered stays.

## A page document

```json
{
  "specVersion": 1,
  "bundle": "<renderer digest>",
  "digest": "<digest of this document>",
  "path": "/",
  "title": "Todos",
  "children": [ { "type": "text", "text": "Open work", "style": "heading" } ]
}
```

`children` are `Ui.SpecNode`s, produced for this request.

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
