# Telo Hub — discovery frontend

The site at `hub.telo.run`: search the federated discovery hub, read one module's
page, register a module ref. A React Router (framework mode) app served by its
own Node process, which renders every page **per request** from the live hub and
serves the sitemap and `robots.txt`. A module has a crawlable 200 page, and a
sitemap entry, the moment the hub has ingested it — nothing is rebuilt or
deployed.

Same UI idiom as [`apps/studio`](../studio): Radix primitives (`radix-ui`) in
`app/components/ui/*`, `lucide-react` icons, Tailwind v4 tokens in
`app/globals.css`.

## Serving model

`server.mjs` is the process entry for both modes. It owns transport only:
listening on `PORT`, answering `/health`, serving `/assets/`, and choosing where
the server build comes from. Everything else is the React Router app in `app/`.

- **Server reads.** Page loaders read the hub (`GET /module`, `GET /modules`)
  through one hub reader, on `HUB_API_ORIGIN`. A page is rendered to completion
  before its first byte, so its status is final. Client-side navigation fetches
  the next page's data from this server (`…/_.data`), which answers with the
  same statuses and headers as the page itself.
- **Browser reads.** Search, categories, registration and its status, and a
  kind's instances stay in the browser, calling the hub on
  `HUB_BROWSER_API_ORIGIN`. The server hands that origin to the page.
- **No in-process cache.** Every request reads the hub. Caching is expressed as
  response headers, for a shared cache the operator may place in front. Without
  one, hub load equals crawl rate: one `/module` read per module page, at most
  50 `/modules` pages per sitemap shard, and one `/modules` probe per non-empty
  shard, plus one, for the sitemap index.

## Routes

- `/` — search and register; `?q=` is the query and `?category=` the category
  filter (a slug from the hub's `GET /categories`). An empty query with a
  category lists that category.
- `/module/oci/<rest>/` and `/module/url/<rest>/` — one module's page, for the
  ref `oci://<rest>` or `https://<rest>`. Only such a ref has a page, and only
  when `<rest>` is one or more `/`-separated segments, each non-empty, not `.` or
  `..`, and written only in the unencoded RFC 3986 path alphabet
  `A-Z a-z 0-9 - . _ ~ ! $ & ' ( ) * + , ; = : @`. The page path copies `<rest>`
  verbatim. Every other ref has no page: a `./` local ref (a module on the hub's
  own disk, a development seed), an `http://` ref, and any ref holding `%`, `?`,
  `#`, `\`, a space, a control or a non-ASCII character. A request whose path
  names the same ref in another form — no trailing slash, extra trailing
  slashes, a percent-encoded ordinary character — redirects to the page path
  (301, query kept). `?version=` addresses a tracked version, whose canonical is
  the unversioned page.
- `/sitemap.xml` — a sitemap index listing `<SITE_ORIGIN>/sitemaps/modules-<k>.xml`
  for every non-empty shard `k`. Each probe asks the hub for the first module past
  the previous shard, whose `seq` names the next non-empty shard directly.
- `/sitemaps/modules-<k>.xml` — the canonical page URL of every module with
  `seq` in (50000·k, 50000·(k+1)], refs without a page skipped, streamed page by page from
  `/modules`. An empty shard is a valid empty `<urlset>`. If the hub fails after
  the response has started, the connection is reset and `</urlset>` is never
  written, so a truncated shard cannot parse as a complete one.
- `/robots.txt` — allows everything and names `<SITE_ORIGIN>/sitemap.xml`.
- `/health` — 200 while the process serves; never touches the hub.
- `/assets/…` — the built client assets.

The module path is deliberately the same `<transport>/<host>/<path…>` shape the
manifest cache keys use, so one mental model covers a module's URL here and its
cached manifest. The page-bearing grammar is what makes the path read back as
exactly the ref it was built from; every in-app link to a module goes through
it, and a ref without a page is shown as text.

Each page's head — title, description, canonical link — is the same on first
load and after client-side navigation. A module page's title is its display
name; its description is the module's own, or one sentence built from its ref
and exported kinds when it publishes none. Its canonical is its page path, never
the request URL.

## Statuses

| Response | When |
|---|---|
| 200 | a module the hub answers for |
| 404 | an unknown module or unknown `?version=` (one body, linking to the unversioned canonical URL) |
| 404 | an unmatched path, a `/module/…` path whose ref has no page (including local refs), a bad shard name |
| 301 | a module path not in canonical form |
| 503 + `Retry-After: 60` | the hub is unreachable, silent for 10 s (before its headers, or between body chunks), answers a status outside the route's expected set, or sends an unreadable body |
| 500 | a render failure |

The detail of a 5xx is logged on the server and never sent in the response.

## Cache-Control

| Response | Header |
|---|---|
| `/assets/` | `public, max-age=31536000, immutable` |
| 200 HTML (home, module) | `public, max-age=60, stale-if-error=86400` |
| 404, `/sitemap.xml`, shards | `no-cache` |
| 5xx | `no-store` |
| `/robots.txt` | `public, max-age=3600` |

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

## Settings

Read once at start. A missing or malformed required setting stops the process
with a message naming the variable.

| Variable | Required | Meaning |
|---|---|---|
| `HUB_API_ORIGIN` | yes | The hub origin the server reads (`/module`, `/modules`). |
| `HUB_BROWSER_API_ORIGIN` | no (defaults to `HUB_API_ORIGIN`) | The hub origin the browser calls for search, categories, register, register status and instances. |
| `SITE_ORIGIN` | yes | This site's origin, used for canonicals, the sitemap and `robots.txt`. Never derived from the request's `Host`. |
| `PORT` | no (default `8050`) | The port to listen on. |

## Scripts

```sh
pnpm --filter @telorun/hub-web dev     # server.mjs in development mode
pnpm --filter @telorun/hub-web build   # typegen → type-check → react-router build (→ build/)
pnpm --filter @telorun/hub-web start   # server.mjs in production mode, against build/
pnpm --filter @telorun/hub-web test    # build, then node --test over test/*.test.mjs
```

`dev` runs the same `server.mjs` with Vite in middleware mode and loads the
server build through Vite on every request, so edits apply without a restart.
Against the local docker-compose hub:

```sh
HUB_API_ORIGIN=http://localhost:8040 SITE_ORIGIN=http://localhost:8050 \
  pnpm --filter @telorun/hub-web dev
```

The tests boot the production `server.mjs` against the built output and a stub
hub (both on port 0) and assert with real HTTP requests; one of them waits out
the 10 s silence timeout.

## Docker

`apps/hub-web/Dockerfile`, built with the repository root as context
(`docker build -f apps/hub-web/Dockerfile --target <target> .`):

- `development` — runs `node server.mjs` with `NODE_ENV=development` from the
  repository mounted at `/telo`, its dependencies installed.
- `production` — the built client and server bundles and production
  dependencies only (no Vite), running `node server.mjs` as a non-root user with
  `NODE_ENV=production`, listening on 8050.

### Compose service

`docker compose up hub-web` builds the image `telorun/hub-web:${DOCKER_TAG:-latest}`
and runs it beside the hub it reads (`HUB_API_ORIGIN=http://hub:8040`), with
`SITE_ORIGIN=http://hub.telo.localhost:8060`. The proxy serves it at
http://hub.telo.localhost:8060; the browser reaches the hub at
http://telo.localhost:8060 (`HUB_BROWSER_API_ORIGIN`).

| Variable | Default | Meaning |
|---|---|---|
| `HUB_WEB_TARGET` | `development` | The Dockerfile target. `development` runs from the mounted checkout as the host user (`UID` / `GID`, default 1000), so nothing it writes there is root-owned; `production` runs the built image and ignores the mount. |
| `HUB_WEB_PORT` | `8050` | The host port it is published on. |

### Published image

The `hub-web` job of `.github/workflows/publish-docker.yml` builds the
`production` target and pushes `telorun/hub-web` on every push to `main` that
touches `apps/hub-web/**` (among the workflow's other paths), tagged `latest`
and `sha-<short>`, plus `<version>` when this package's `version` moved in that
commit. Like the `docker-runner` job, it skips the "chore(release): version
packages" commit on the push path and builds it on the post-publish release
path.

## End-to-end tests

`apps/hub-web/test-suite-e2e.yaml` (the tests in `tests/e2e/`) runs only through

```sh
pnpm run test:e2e:hub
```

which stands up a fresh stack every time — hub-web on its `production` target —
runs the hub's suite and then this one, and tears the stack down; the hub's
README describes it. Pointing the suite at the development stack is
unsupported: its freshness test needs a hub that has never seen
`oci://ghcr.io/telorun/log`, a ref reserved for it.

## Operating hub.telo.run

What happens outside this repository:

1. Run the `production` image with `SITE_ORIGIN=https://hub.telo.run` and
   `HUB_API_ORIGIN` pointing at the hub API behind HTTPS.
2. Point the `hub.telo.run` DNS record at it.
3. Disable GitHub Pages on `telorun/hub` and delete the `HUB_PAGES_TOKEN`
   repository secret.
4. Submit `https://hub.telo.run/sitemap.xml` in Google Search Console.
