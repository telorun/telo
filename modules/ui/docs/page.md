# Ui.Page

One page of an application: its address, its title and its nodes. A
`Telo.Invocable`: a renderer's application lists it, routes the page's path to
it, and invokes it once per request with the request; the page answers with
its nodes as delivered for that request.

```yaml
kind: Ui.Page
metadata: { name: reports }
path: /reports
title: Reports
query:
  period: { type: string }
children:
  - { type: text, text: Open work, style: heading }
  - { type: composite, ref: !ref reportTable }
  - type: composite
    ref: !ref salaryTable
    when: !cel "'x-role' in request.headers && request.headers['x-role'] == 'hr'"
```

| Field | | |
| --- | --- | --- |
| `path` | required | the page's address under the application's mount |
| `title` | required | a text, shown above the page and in the navigation unless an entry says otherwise |
| `query` | | the query parameters the page's own nodes read, as [`Ui.QueryParameters`](conditions.md#query-parameters) |
| `width` | | how wide its content is drawn, a `Ui.PageWidth`: `contained` or `full`; omitted, the application's — see [Width](#width) |
| `children` | required | the page's [nodes](nodes.md), top to bottom |

- `path` is `/` followed by anything other than `/` or `\`, with no control
  character anywhere and never under `/_telo` — so `/`, `/reports` and `/a//b`
  are paths, and `//reports` or `/\reports` are refused by `telo check`
  (`SCHEMA_VIOLATION`), since a browser reads them as another host.
- Inside `children`, each node's `when:` and its leaf values may read
  `request` — `request.headers` (lower-case names) and `request.ip` — and are
  evaluated for every request. A `shown` condition and a `value` or `list`
  node read `query` in the browser instead, and never `request`
  (`CEL_UNKNOWN_IDENTIFIER`).
- The tree's structure and its references are literal: a computed list of
  children or a computed `ref` is `REF_SLOT_COMPUTED` at `telo check` and
  `ERR_REF_SLOT_COMPUTED` at creation.

## Created once, invoked per request

Every composite the page places is resolved when the page is created: what it
provides is judged against [`Ui.SpecNode`](nodes.md) once and stands for every
request, and one that is not valid is replaced by an `error` node
(`ERR_UI_NODE_INVALID`) and logged.

Invoked with `{ request: { headers, ip? }, pageWidth? }`, the page answers
`{ path, title, query, width, children }`: `title` the record of its text,
`query` the declared parameters (`{}` with none), `width` as under
[Width](#width), and `children` its nodes for that
request — a node whose `when:` is false left out, each composite placed as it
provided, and a node an expression made invalid replaced by an `error` node,
its siblings kept.

Its published reading is `{ path, title, query }`, so another resource reads
`resources.<page>.path`.

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
resolves (a header's width, say), so no renderer restates the default.

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

What draws a page's address in a menu is the application's
[navigation](navigation.md), which names pages by reference and never by path.
