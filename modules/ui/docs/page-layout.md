# Ui.PageLayout

The chrome around a page: three regions — `header`, `aside` and `footer` —
around an implicit `main` holding the page's own nodes. A `Telo.Invocable`: a
renderer's application assigns it to its pages and invokes it per request, so
a navigation bar follows a sign-in, a session expiry or a role header at the
next navigation. A page never names its layout; the application does, so a
library's page is drawn in whatever layout the application listing it chooses.

```yaml
kind: Ui.PageLayout
metadata: { name: chrome }
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
footer:
  - { type: text, text: Acme Corporation, style: muted }
```

| Field | | |
| --- | --- | --- |
| `width` | the application's | how wide the header's and footer's content is drawn — a [`Ui.PageWidth`](page.md#width) |
| `header` | none | [nodes](nodes.md) spanning the top of the application |
| `aside` | none | a fold-out column beside every page — a [`Ui.Aside`](split-view.md#the-aside) |
| `footer` | none | nodes spanning the bottom of the application |

A layout with nothing written draws a page bare: one component, no header,
aside or footer.

## Assigned by the application

An application names the layout every page is drawn in, and a `pages` entry
may name another for one page: `Ui.PageRoute`, `{ page, layout }`, both
references the application invokes (`use: call`).

```yaml
pages:
  - !ref home
  - { page: !ref signIn, layout: { kind: Ui.PageLayout } }
```

| `Ui.PageRoute` key | | |
| --- | --- | --- |
| `page` | required | the [`Ui.Page`](page.md) routed to |
| `layout` | required | the layout it is drawn in; `{ kind: Ui.PageLayout }` draws it bare |

## The regions

The header and the footer span the application's width; their content is
inset by the layout's width against the application's width, and `main` insets
the page against `main`: beside no aside a contained header lines up with a
contained page, and beside an aside the two columns do not, since `main` is
the narrower box. The width is the layout's own, else the
`pageWidth` it is invoked with — the application's — else `contained`, read
by `resolvedPageWidth`.

Every region is delivered per request: a node's `when:` and its text values
read `request` (`headers`, `ip`, `lang`), and a [pane](pane.md) placed in a
region is invoked with it. A composite placed in a region is resolved once,
when the layout is created.

**A region reads no page variables and no query parameters.** One layout is
drawn on pages with different ones, so a region withholds `params` and `query`
(`x-telo-context-withheld`): a composite placed in a region that reads
`params.id` is `CEL_UNKNOWN_IDENTIFIER`, naming the layout and the reason —
`'params' is not available here — Ui.PageLayout/layout withholds it: a layout
region is drawn on pages with different path variables and query parameters,
so it reads none.` The same view placed in a page at `/x/{id}` reads it. A
`Ui.Data` in a region still reads the `query` it declares itself.

The region context is `Ui.Node`'s `$defs/Region` — a list of nodes reading
`request` and withholding `params` and `query`, the reason written once in
`$defs/RegionPageInput` — which `header` and `footer` are, and which a
renderer's own per-request nodes (an application's not-found nodes) reference
to read the same. The `aside` and a navbar's `start` / `end` declare the same
context on the property holding them.

## The aside

`aside` is a [`Ui.Aside`](split-view.md#the-aside), the shape a split view's
aside has, filled by the same defaults and drawn by the same component: the
fold, the rail, the remembered fold and the narrow-screen surface. A
[`Ui.NavigationColumn`](navigation.md#uinavigationcolumn) in it folds to a
rail of glyphs, which is how an application gets a sidebar. Its `compact`
surface declares neither an `address` nor a `compact` of its own:
`UI_SURFACE_COMPACT_ADDRESSED` / `UI_SURFACE_COMPACT_NESTED` at `telo check`,
at `aside.compact`, and `ERR_UI_SURFACE_COMPACT_ADDRESSED` /
`ERR_UI_SURFACE_COMPACT_NESTED` when the layout is created.

## Invoked per request

Invoked with `{ request: { headers, ip?, lang? }, pageWidth? }`, the layout
answers `{ width, header, aside?, footer }`:

```json
{
  "width": "contained",
  "header": [
    {
      "type": "navbar",
      "title": { "text": "Acme", "context": null, "lang": "en", "computed": false },
      "start": [],
      "end": [ { "type": "link", "text": { "…": "…" }, "href": { "path": { "value": "/sign-in" }, "pathParams": {}, "queryParams": {} }, "button": null, "fill": false } ],
      "navigation": { "items": [ { "type": "page", "key": "home", "path": "/", "text": { "text": "Home", "context": null, "lang": "und", "computed": false } } ] },
      "placement": { "type": "header", "compact": { "type": "overlay", "surface": { "type": "drawer", "side": "start", "size": "medium", "modal": true, "dismiss": { "escape": true, "outside": true, "closeButton": true } } } },
      "fill": false
    }
  ],
  "aside": {
    "side": "start",
    "size": "medium",
    "frame": "flush",
    "toggle": { "type": "icon", "icon": null, "label": "hidden" },
    "label": { "text": "Shortcuts", "context": null, "lang": "en", "computed": false },
    "collapse": { "collapsed": false, "state": { "key": "shortcuts", "store": { "type": "local" } } },
    "compact": { "type": "drawer", "side": "start", "size": "medium", "modal": true, "dismiss": { "escape": true, "outside": true, "closeButton": true } },
    "actions": [],
    "content": { "type": "navigation-column", "state": { "key": "shortcuts", "store": { "type": "local" } }, "navigation": { "items": [ "…" ] }, "fill": false }
  },
  "footer": [ { "type": "text", "text": { "…": "…" }, "style": "muted", "fill": false } ]
}
```

- `width` the resolved width;
- `header` and `footer` the regions' nodes for that request — a node switched
  off left out, each pane placed as it answered, each composite as it
  provided, and a node an expression made invalid replaced by an `error` node
  and logged (`ERR_UI_NODE_INVALID`);
- `aside`, present when the layout has one, `Ui.SpecNode`'s `Aside` shape with
  every member filled; what it holds is delivered for the request, an empty
  `stack` when nothing is.

`ui` fills every default — `header` and `footer` `[]`, and every member of the
aside — so a renderer reads none of its own.

## `assets`

The layout's published reading is `{ assets }`: every file its regions can
name — each composite's, each pane's reading, the aside toggle's glyph —
known when it is created, in `Ui.Composite`'s `assets` item shape.
