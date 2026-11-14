# Ui.Page

One page of an application: its address, its optional title and its nodes. A
`Telo.Invocable`: a renderer's application lists it, routes the page's path to
it, and invokes it once per request with the request; the page answers with
its nodes as delivered for that request. A page draws its own nodes and
nothing else: the chrome around it — a header, a sidebar, a footer — is the
[page layout](page-layout.md) the application draws it in.

```yaml
kind: Ui.Page
metadata: { name: reports }
path: /reports
title: Reports
query:
  period: { type: string }
children:
  - { type: text, text: Reports, style: title }
  - { type: text, text: Open work, style: heading }
  - { type: composite, ref: !ref reportTable }
  - type: composite
    ref: !ref salaryTable
    when: !cel "'x-role' in request.headers && request.headers['x-role'] == 'hr'"
```

| Field | | |
| --- | --- | --- |
| `path` | required | the page's address under the application's mount; a `{name}` segment is a [variable](#path-variables) |
| `title` | | a text with no values: the document title while the page is shown, and what a [navigation](navigation.md) entry naming the page says unless it gives its own `text`. No heading is drawn for it — a page draws its heading as a node, `{ type: text, style: title }`. Omitted, the document is titled by the application alone, and an entry naming the page must give its own `text` |
| `query` | | the query parameters the page's own nodes read, as [`Ui.QueryParameters`](conditions.md#query-parameters) |
| `width` | | how wide its content is drawn, a `Ui.PageWidth`: `contained` or `full`; omitted, the application's — see [Width](#width) |
| `children` | required | the page's [nodes](nodes.md), top to bottom |

- `path` is `/` followed by anything other than `/` or `\`, with no control
  character anywhere and never under `/_telo` — so `/`, `/reports` and `/a//b`
  are paths, and `//reports` or `/\reports` are refused by `telo check`
  (`SCHEMA_VIOLATION`), since a browser reads them as another host.
- Inside `children`, each node's `when:` and its leaf values may read
  `request` — `request.headers` (lower-case names), `request.ip` and `request.lang` (the language the server negotiated) — and are
  evaluated for every request; a [pane](pane.md) placed there is invoked for
  every request with it. A `shown` condition and a `value` or `list`
  node read `query` and `params` in the browser instead, and never `request`
  (`CEL_UNKNOWN_IDENTIFIER`).
- A `link`'s `href` is an [address](nodes.md#addresses), and is not evaluated per
  request: `href: !cel "request…"` is `CEL_UNKNOWN_IDENTIFIER`; a link that
  differs by request is two `link` nodes with a `when` each. An address may
  name a page by `!ref`, which is that page's `path` — renaming the `path`
  moves every link to it.
- The tree's structure and its references are literal: a computed list of
  children or a computed `ref` is `REF_SLOT_COMPUTED` at `telo check` and
  `ERR_REF_SLOT_COMPUTED` at creation.

## Path variables

A segment of `path` written exactly `{name}` is a variable: it matches one
non-empty segment of the address, percent-decoded, and the page reads it as
`params.<name>`, a string.

```yaml
kind: Ui.Page
metadata: { name: plan }
path: /plans/{id}
title: Plan
children:
  - type: composite
    ref:
      kind: Ui.Data
      model: !ref PlanDetail
      source: { path: "/api/plans/{id}", pathParams: { id: !cel "params.id" } }
      content: { type: value, value: !cel "data.title" }
```

- A segment is either wholly literal or exactly `{name}`, the name a Telo name
  that is not a CEL keyword. A brace anywhere else (`/plans/x{id}`) and a name
  given twice (`/plans/{id}/revisions/{id}`) are refused by `telo check`
  (`SCHEMA_VIOLATION`) and when the page is created
  (`ERR_RESOURCE_SCHEMA_VALIDATION_FAILED`).
- A literal segment beats a variable one: with `/plans/new` and `/plans/{id}`
  both listed, `/plans/new` opens the first and `/plans/7` the second. Two
  pages whose paths differ only in the names of their variables
  (`/plans/{id}`, `/plans/{key}`) route the same addresses, and an application
  listing both is refused as for two pages at one path.
- An address that matches a page only through a malformed percent-encoded
  segment answers the application's not-found page.
- A navigation entry cannot name a page with a variable, since it has nothing
  to fill it with (see [navigation](navigation.md)); a page with a variable is
  reached by a `link` whose [address](nodes.md#addresses) names it with `!ref`
  and fills every variable in `pathParams`, which `telo check` holds to the
  page's `path` (`PATH_PARAMETER_UNBOUND`, `PATH_PARAMETER_UNUSED`):

  ```yaml
  - type: link
    text: Open
    href: { path: !ref plan, pathParams: { id: !cel "row.id" } }
  ```

- A move to another value of a variable draws the page afresh, since it shows
  another record; a move that changes only the query keeps its nodes mounted
  (see below).

### `params`

`params` is a browser root, beside `query`: the variables of the page drawn,
by name, each a string. It is in scope wherever a page's nodes are — in the
page's own tree, and in every reader, listing, layout, source, view, filter bar,
split view and option source the page places, at any depth of placement and
across an import — read by a `value` or `list` node, a `shown` condition, a
text's values, an address's parameters, a reader's `source`, a listing's
`filters`, a row action's `inputs` and a collection source's templated
`basePath`.

- In the page's own tree `params` holds exactly the page's variables:
  `params.nope` on `/plans/{id}` is `CEL_UNKNOWN_FIELD`, and on a page with no
  variable `params` holds none.
- In a resource the page places, `params` is typed from each page placing it:
  a view reading `params.id` placed on `/plans/{id}` and on `/` is
  `CEL_UNKNOWN_FIELD` naming the `/` page. A resource no page places reads
  `params` as an open map of strings.
- A variable a page lacks is never sent: a parameter that holds nothing
  leaves its read unsent and draws the node's `failure`.

## Created once, invoked per request

Every composite the page places is resolved when the page is created: what it
provides is judged against [`Ui.SpecNode`](nodes.md) once and stands for every
request, and one that is not valid is replaced by an `error` node
(`ERR_UI_NODE_INVALID`) and logged. A pane the page places in its own tree is
invoked per request instead, and one inside a composite once, with the
composite (see [panes](pane.md)).

Invoked with `{ request: { headers, ip?, lang? }, pageWidth? }`, the page answers
`{ path, title, query, width, children }`: `title` the record of its text,
the document title,
`query` the declared parameters (`{}` with none), `width` as under
[Width](#width), and `children` its nodes for that
request — a node whose `when:` is false left out, each composite placed as it
provided, each pane placed as it answered for the request (left out when it
answered nothing), and a node an expression made invalid replaced by an
`error` node, its siblings kept.

A move to the page already shown — a link whose address is the page's own
address with other query parameters, back or forward — keeps its nodes mounted:
each reader and listing re-reads the parameters it declares instead of being
drawn again, so a draft, a scroll position and an open surface stay. This is
how a renderer behaves; `ui` states it so a page can rely on it.

Its published reading is `{ path, title, query, assets }`, so another
resource reads `resources.<page>.path`. `assets` is every file its nodes can
name — each composite's, each pane's reading, each button's glyph — in
`Ui.Composite`'s `assets` item shape and known when the page is created, so
an application serves every file from boot.

The headers a page varies by are the ones its own expressions read; a page
placing a pane in its own tree varies by any (`*`), since the pane is handed
the whole request.

## Width

`Ui.PageWidth` is the one definition of a page's width, the shape every place
an author writes one names: `contained` — no wider than the look's page
measure, the `width.page` [design token](design-tokens.md), centred — or
`full`, all the room the page has. Anything else is `SCHEMA_VIOLATION`.

The page fills its own `width`: the one it declares, else the `pageWidth` it
is invoked with — the application's — else `contained`. It always answers
one, so a renderer draws what the document says and holds no default of its
own; one page listed by two applications is drawn at each one's width.

That chain — the value written where it applies, else the application's
`pageWidth`, else `contained` — is read in one place: `@telorun/ui` exports it
as `resolvedPageWidth`, which a renderer uses for any other `Ui.PageWidth` it
resolves (a [layout's](page-layout.md) width, say), so no renderer restates the
default.

## Listing a page

An application lists its pages in order, written in place or named by
reference — a library's included:

```yaml
pages:
  - !ref home
  - !ref Reports.monthly
  - kind: Ui.Page
    path: /help
    title: Help
    children:
      - { type: text, text: Ask in the team channel. }
```

What draws a page's address in a menu is a [navigation pane](navigation.md),
which names pages by reference and never by path.
