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

## The shell

One HTML document, the same for every page: the cascade layer order, an
import map, and the renderer's script. It holds no content. The import map
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
  "stylesheets": [ "/admin/_telo/ui/assets/…/renderer.css", "…" ]
}
```

`lang` is present only when the application sets one. `stylesheets` is in
application order and includes the theme chosen for this request, so two
requests may get different lists.

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
