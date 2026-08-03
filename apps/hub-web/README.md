# Telo Hub — discovery frontend

A standalone React + Vite SPA for searching the federated discovery hub,
browsing a module, and registering a module ref. Deployed as static assets to
GitHub Pages at `hub.telo.run`; it reads and POSTs to the hub's verbs on
`telo.sh` cross-origin. Pure static hosting — the hub app
([`apps/hub`](../hub)) is never in the frontend's serving path.

Same UI idiom as [`apps/telo-editor`](../telo-editor): Radix primitives
(`radix-ui`) in `src/components/ui/*`, `lucide-react` icons, Tailwind v4 tokens
in `src/app/globals.css`. No Tauri — it's a browser app.

Search and browse are one control pair, because the hub serves them from one
endpoint: the text field is `q`, the category dropdown is `category`, and an
empty query with a category selected lists that category. The dropdown's options
come from `GET /categories` — modules declare their own categories, so the
vocabulary is derived from the index and nothing is hardcoded here. Each option
carries a `slug` and a `label`: the label is what the author wrote and what the
dropdown and chips print, the slug is what the filter and the URL use. Both fields mirror into
the URL, so a browse is shareable. The hub returns the pre-limit `total`
alongside a page of hits; the list says how many it is withholding rather than
stopping at the page size in silence.

## Preview panel vs. page

Two ways to look at a module, because there are two questions.

**Scanning** ("is this the one?") is the common case, so a left-click on a
result opens a **side panel** rather than navigating. It renders entirely from
the search hit — the response carries every exported kind with its capability,
description, runtime and deprecation, plus the exported instances — so it opens
with **no request at all**. Making this a navigation costs a round trip and a
Back for every candidate considered, which is the whole cost of choosing.

**Committing** ("tell me everything") is the page: the full kind list, the
version picker, provenance links, and a URL worth sharing. The row is a real
`<a href>`, so cmd/middle-click opens it in a new tab and the address is honest;
the panel also links to it explicitly.

The one thing the panel does not show is the tracked version list — that needs a
call, so it belongs to the page.

Each kind and each exported instance in a row or panel opens a **popover** with
its own detail. Same reasoning: the data is already in the response, so
answering "what does this kind do?" should not cost a navigation.

## Routing

Two routes, hand-rolled over the History API — a router package would be more
machinery than two routes and one query param need.

- `/` — search and register.
- `/module/<transport>/<host>/<path…>` — one module's page, `?version=` to
  address a tracked version other than the latest.

The module path is deliberately the same `<transport>/<host>/<path…>` shape the
manifest cache keys use, so one mental model covers a module's URL here and its
cached manifest. A percent-encoded ref in a single segment would round-trip too,
but it reads as opaque and defeats the point of a shareable link.

GitHub Pages serves a static tree, so a deep link would 404 at the CDN; the
deploy workflow copies `index.html` to `404.html`, which makes the SPA the
fallback for any unmatched path and lets the route resolve client-side.
Prerendering is **not** done — the page is linkable, not yet indexable.

## Badges

The page and the result list show which kernels can run a module, derived by the
hub from each kind's controllers: `Node` / `Rust`, marked `partial` when a kernel
runs only some of the module's kinds, or one `Portable` badge when it declares no
controller code at all and therefore runs anywhere. Language is a separate badge
from runtime, because the two genuinely differ — a `pkg:cargo` controller is
Rust and runs on *both* kernels.

Every field the hub added for this is optional at the boundary. This app deploys
independently of the backend, so a hub that predates a field renders nothing
rather than claiming a false negative.

## Develop

```sh
pnpm --filter @telorun/hub-web dev
```

By default the app targets the production hub API (`https://telo.sh`). Point it
at the local docker-compose hub instead:

```sh
VITE_HUB_API=http://localhost:8040 pnpm --filter @telorun/hub-web dev
```

## Build

```sh
pnpm --filter @telorun/hub-web build   # → dist/ (static assets)
```

## Deploy

`.github/workflows/hub-pages.yml` builds `dist/` and publishes it to the
[`telorun/hub`](https://github.com/telorun/hub) GitHub Pages repo
(`cname: hub.telo.run`) on pushes to `main` that touch this app — mirroring the
editor's `editor.telo.run` pipeline. It needs a `HUB_PAGES_TOKEN` repo secret
with push access to `telorun/hub`, and the `hub.telo.run` DNS `CNAME` pointing at
GitHub Pages.
