# Telo Hub — discovery frontend

The site at `hub.telo.run`: search and browse the federated discovery hub by
category, runtime and entry type, read one module's page, register a module ref. A React Router (framework mode) app served by its
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

- **Server reads.** Page loaders read the hub (`GET /module`,
  `GET /module/manifest`, `GET /modules`, and — to seed a catalogue page —
  `GET /categories`, `GET /publishers` and `GET /search/modules` with no query)
  through one hub reader, on `HUB_API_ORIGIN`. A seed read carries no query, so
  the hub embeds nothing for it. A page is rendered to completion
  before its first byte, so its status is final. Client-side navigation fetches
  the next page's data from this server (`…/_.data`), which answers with the
  same statuses and headers as the page itself.
- **Browser reads.** Every search with a query or a filter, further pages of a
  listing, the ref typeahead, a contract's implementations, a kind's instances,
  the modules using a module, the manifest source, a version's import pin, and
  registration with its status stay in the browser,
  calling the hub on `HUB_BROWSER_API_ORIGIN`. The server hands that origin to
  the page.
- **No in-process cache of the hub.** Every request reads the hub. Caching is expressed as
  response headers, for a shared cache the operator may place in front. Without
  one, hub load equals crawl rate: one `/module` read per module page, at most
  50 `/modules` pages per sitemap shard, and one `/modules` probe per non-empty
  shard, plus one, for the sitemap index; three reads (`/categories`,
  `/publishers`, `/search/modules`) per home, category or publisher page; and
  per module page two (`/module`, `/module/manifest`), plus `/dependents` when
  something imports it and one `/implementations` per contract it defines.

## Routes

- `/` — the catalogue: a search box, category tiles and the first page of every
  module, read by the server so the list is in the markup. The query string
  narrows it: `?q=` is the query, `?runtime=nodejs|rust` the kernel,
  `?sort=name|recent` the order (read only with no query),
  `?type=library|application` keeps one type of module (both otherwise),
  `?show=deprecated` includes deprecated modules (left out otherwise), and
  `?hide=contract` drops modules exporting only contracts. When the hub does not
  answer the server, the page is still a 200 and the browser asks itself.
  `/?category=<slug>` and `/?publisher=<publisher>` are each a 301 to that
  page, other parameters kept.
- `/category/<slug>` — one category, with the same query string, plus
  `?publisher=<publisher>` to narrow it to one publisher. The slug is one the
  hub's `GET /categories` lists; a slug no module declares is a 404, and a hub
  that does not answer is a 503.
- `/publisher/<host>/<org…>` — every module published under a host and org
  (`/publisher/ghcr.io/telorun`), with the same query string. The path is a
  publisher the hub's `GET /publishers` lists; one it does not list is a 404,
  and a hub that does not answer — or that cannot filter by publisher — is a
  503.
- `/register` — the registration form.
- `/auth/callback` — where the identity provider returns a reader after a
  sign-in. The page redeems the authorization code in the browser and goes back
  to the page the sign-in was started from; a failure is shown with its reason
  and a "Try again".
- `/auth/silent` — where the identity provider lands the silent sign-in check,
  inside a hidden frame. A page of one script that hands the response to the
  page that framed it; it is not the app.
- `/mcp` — how to connect an AI agent: the hub's MCP endpoint
  (`<HUB_BROWSER_API_ORIGIN>/mcp`), the Claude Code command and a client
  configuration, each with a copy button. Linked from the header and from a
  banner on the home page.
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
- `/sitemap.xml` — a sitemap index listing `<SITE_ORIGIN>/sitemaps/pages.xml`,
  then `<SITE_ORIGIN>/sitemaps/modules-<k>.xml` for every non-empty shard `k`. Each probe asks the hub for the first module past
  the previous shard, whose `seq` names the next non-empty shard directly.
- `/sitemaps/modules-<k>.xml` — the canonical page URL of every module with
  `seq` in (50000·k, 50000·(k+1)], refs without a page skipped, streamed page by page from
  `/modules`. An empty shard is a valid empty `<urlset>`. If the hub fails after
  the response has started, the connection is reset and `</urlset>` is never
  written, so a truncated shard cannot parse as a complete one.
- `/sitemaps/pages.xml` — every page that is not a module's: `/`, `/mcp`,
  `/register`, one per category and one per publisher, as the hub's two facets
  list them. The `local` publisher is left out — its modules have no pages. A
  hub that does not answer either facet is a 503.
- `/robots.txt` — allows everything and names `<SITE_ORIGIN>/sitemap.xml`.
- `/health` — 200 while the process serves; never touches the hub.
- `/assets/…` — the built client assets.

The module path is deliberately the same `<transport>/<host>/<path…>` shape the
manifest cache keys use, so one mental model covers a module's URL here and its
cached manifest. The page-bearing grammar is what makes the path read back as
exactly the ref it was built from; every in-app link to a module goes through
it, and a ref without a page is shown as text.

## Search engines

**Every page has one address, and says so.**

| Page | Canonical | Other spellings |
|---|---|---|
| home | `/` | — |
| category | `/category/<slug>`, the slug exactly as the hub's facet lists it | a trailing slash is a 301; any other spelling the hub would accept (`Storage` for `storage`) is a 404 |
| publisher | `/publisher/<host>/<org…>` | a trailing slash or an encoded `/` is a 301 |
| module | `/module/<transport>/<rest>/` | redirected as described under Routes; `?version=` keeps the unversioned canonical |
| register, MCP | `/register`, `/mcp` | — |

- **A filter keeps the listing's canonical.** `?runtime=`, `?type=`, `?sort=`,
  `?show=`, `?hide=` and — beside a category — `?publisher=` show a subset or a
  reordering of one listing, so those addresses name the unfiltered page.
- **A search-results address is `noindex, follow` and names no canonical.** With
  `?q=` the page is whatever matched an unbounded query space: not something to
  index, and not a duplicate of the page it was searched from.
- **Error pages name no canonical.**
- **The sitemap lists exactly the canonical addresses**: every module page, and
  the pages sitemap above.
- **What a crawler reads is in the first response.** The first page of every
  listing, a module's kinds with their field tables, the modules it imports,
  the modules using it and the kinds implementing its contracts are rendered by
  the server, so each module's page links on to the next. Rows past the first
  30 of a listing are loaded by the browser; those modules are reached through
  the sitemap and through each other.
- **Icon and share image.** Every page names the hub's mark as its icon (SVG),
  and its link preview carries the same mark as a square PNG (`og:image`,
  `twitter:image`).
- **Structured data.** The home page states the site (`WebSite`); a module page
  states its breadcrumb trail (`BreadcrumbList`) and itself
  (`SoftwareSourceCode`: name, description, ref as `identifier`, latest version,
  and the repository, license, languages and categories the hub knows).
- **Links a module's author supplied** — its repository and homepage — carry
  `rel="nofollow ugc"`: registration is open, and the hub does not vouch for
  where they lead.

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
| 404 | an unmatched path, a `/module/…` path whose ref has no page (including local refs), a `/category/…` slug no module declares, a `/publisher/…` path the hub does not list, a bad shard name |
| 301 | a module path not in canonical form; `/?category=<slug>`; `/?publisher=<publisher>` |
| 503 + `Retry-After: 60` | the hub is unreachable, silent for 10 s (before its headers, or between body chunks), answers a status outside the route's expected set, or sends an unreadable body |
| 500 | a render failure |

The detail of a 5xx is logged on the server and never sent in the response.

## Cache-Control

| Response | Header |
|---|---|
| `/assets/` | `public, max-age=31536000, immutable` |
| 200 HTML (home, category, publisher, register, mcp, module) | `public, max-age=60, stale-if-error=86400` |
| `/auth/callback`, `/auth/silent` | `no-store`, with `Referrer-Policy: no-referrer` |
| 404, `/sitemap.xml`, shards | `no-cache` |
| 5xx | `no-store` |
| `/robots.txt` | `public, max-age=3600` |

## Catalogue

The URL is the state: the category is the path, the query and every other filter
the query string, so each view reloads, shares and goes Back as itself. Rows
load 30 at a time; "Load more" asks the hub for the next `offset`, and a listing
already loaded in this visit is shown again at once, at the length it had been
paged to, when the reader returns to it.

The filters, in a rail beside the list (a bottom sheet on a narrow screen):

- **Type** — all modules, libraries only, or applications only. Every module is
  one or the other: a library is imported for what it exports, an application
  is run. Both are listed unless one is chosen, and a card says which it is.
- **Category** — one at a time, each a link to its page, with its module count.
- **Publisher** — one at a time, with its module count; combinable with a
  category.
- **Runs on** — any kernel, Node or Rust. The hub does not index which kernels
  an application runs on, so choosing a kernel leaves applications out of an
  "all" listing (the rail says so) and the control is off for applications.
- **Display** — show deprecated modules; hide contract-only modules. The hub
  applies both (`deprecated=exclude`, `contractOnly=exclude` on
  `/search/modules`), so the count line and "Load more" are of what is listed.

**Deprecated modules are hidden unless asked for.** A reader choosing what to
build on should not have to know to filter them out. When any are hidden the
count line says how many — the hub's `hidden.deprecated`, over every match and
not only the rows loaded — with a link that shows them; a search whose only
matches are deprecated says so and offers the same. A deprecated module's own
page is unaffected. The server's seed of a listing is the default one, with
deprecated modules left out; `?show=deprecated` is read by the browser.

A hub that predates the two parameters ignores them. Hiding contract-only
modules is then an error ("this hub cannot hide contract-only modules yet"),
as for a publisher. Leaving deprecated modules out is the default and not a
choice, so that hub's listing is shown as answered: deprecated modules are in
it, each marked.

Active filters repeat as removable chips above the list. A category badge
anywhere on the site, and the publisher in a module page's breadcrumb, is a link
applying it.

With no query the list can be ordered: the hub's default, by name, or
"Recently added" — newest first by when the hub first tracked the version, which
is the hub's observation and not a publish date. Each card then shows that date.

**A hub older than a filter is reported, not trusted.** The hub echoes the
`publisher` and `sort` it applied; a response without the echo is the unfiltered
catalogue, and the page shows an error ("this hub cannot filter by publisher
yet") rather than those rows.

A search that matches nothing inside a category is answered from every category
and says so (the hub's `categoryFilterDropped`).

Keyboard: `/` focuses the search, `↓` moves from it into the list, `↑` / `↓`
walk the cards, `Enter` opens the module page, `Space` opens the quick look,
`Esc` closes it.

## Card, quick look and page

**A click on a card opens the module's page.** The module's name is a real link
stretched over the card, so a click anywhere, a middle-click and the keyboard
all behave as a link does.

**Quick look** is the explicit second action — a button on the card, or `Space`
— for comparing candidates without leaving the list. On a screen at least
1280px wide it is a column docked beside the list; below that, a sheet over it.
It renders from the search hit, which carries every exported kind and instance,
and then asks for one thing: the version's import pin, so the entry it copies
is the pinned one the page offers. Its primary button is the module page.

A module with no page (a local development ref) can only be looked at, so its
card opens the quick look.

Each kind on a card or in the quick look is a link to that kind on the module's
page; its detail shows on hover or keyboard focus.

## Module page

Two columns on a wide screen: the description, the kinds and the instances on
the left; the import entry, the version picker and the provenance (publisher,
license, source, homepage) pinned on the right.

- The import entry uses the module's own name as its alias and is pinned
  (`ref@version#integrity`); the copy button copies the entry line.
- Kinds are grouped by what they are — contracts first, then each capability —
  and each has an anchor (`#kind-<Kind>`), as do `#instances` and
  `#application`.
- A contract lists every kind implementing it, across modules; "Implements"
  links the other way, to the contract's own entry.
- Each kind shows its fields, and its inputs and outputs when it is invoked:
  name, type, whether it is required, description, default and allowed values —
  read by the server from the version's own manifest (`GET /module/manifest`).
  A kind extending another lists the fields its own definition declares. A kind
  that is not a contract also offers an example: the smallest resource of it,
  with a stand-in for every required field.
- "Imports" lists what the version imports, each linked; "Used by" lists the
  modules importing this one, 50 at a time with "Show more".
- "Manifest source" shows the version's `telo.yaml` as written, read when
  opened.
- When the hub serves no manifest for the version, the page renders without the
  field tables, examples and manifest source.
- A version other than the latest shows a banner linking to the latest.
- An application shows what it asks for — variables, secrets and ports, each
  with its environment variable, argument, default and whether it is required —
  and the `telo run` line instead of an import entry.

Every page's head carries Open Graph and Twitter card tags built from its title,
description and canonical address.

## Sign-in

Optional: with `OIDC_ISSUER` and `OIDC_CLIENT_ID` unset the site offers no
sign-in and behaves exactly as it does without this section. Signing in gates
nothing yet — it shows who the reader is.

**The browser is the OAuth client; this server never sees a token and sets no
cookie.** The page is a public client of the identity provider: authorization
code with PKCE (`S256`), scopes `openid profile email`, redirect
`<SITE_ORIGIN>/auth/callback`. The provider's endpoints are fixed paths under the
issuer — `/oauth2/authorize`, `/oauth2/token`, `/oauth2/end-session`.

- **Page HTML never says who is signed in.** Pages are shared and cached, so the
  header's account control is drawn only in the browser, after it has asked.
- **A reader who signed in here before is recognised on every page load, without
  a prompt**: a hidden frame opens the authorization endpoint with
  `prompt=none` and redirect `<SITE_ORIGIN>/auth/silent`. An answer of
  `login_required`, `interaction_required`, `consent_required` or
  `account_selection_required` is "nobody". A frame that has not answered in
  10 s is logged to the console and is also "nobody".
- **A visitor who never signed in here costs the provider nothing.** The check
  runs only while `localStorage` holds `hub.auth.signedIn`, set by a completed
  sign-in and removed by sign-out and by a "nobody" answer. So a reader signed
  in at the provider through another site is shown "Sign in" here until they
  click it once.
- **The check needs this site and the provider to be the same site** (two hosts
  under one registrable domain, as `hub.telo.run` and `accounts.telo.run` are).
  Across sites a browser withholds the provider's cookie from the frame, the
  answer is always "nobody", and a signed-in reader is signed out by every
  reload.
- **"Sign in" is a full-page navigation** to the provider, and back to the page
  it was clicked on — path, query and fragment.
- **The token request carries a DPoP proof** (RFC 9449, `ES256`), signed by a key
  whose private half cannot be exported and that exists only for that page
  load; a `use_dpop_nonce` refusal is retried once with the nonce the provider
  sent.
- **What is kept, and where.** In memory only: the reader's id, name and email
  from the ID token, and the ID token itself (sent as `id_token_hint` on
  sign-out). The access token is not kept — nothing uses one yet. In
  `sessionStorage` under `hub.auth.pending`, from "Sign in" until the callback:
  the PKCE verifier, `state`, nonce and the address to return to. In `localStorage`, the
  `hub.auth.signedIn` marker above, which holds no identity. No cookie.
- **The response is checked before it is believed**: `state` matches, `iss` is
  the configured issuer (RFC 9207), and the ID token's `iss`, `aud`, `nonce` and
  `exp` are this sign-in's.
- **The answer is asked again 30 s before the token it came with expires**, once
  the page is in view, so a sign-out elsewhere shows here too.
- **"Sign out"** navigates to the provider's end-session endpoint with
  `post_logout_redirect_uri=<SITE_ORIGIN>/`.

What the identity provider must offer for this: a public client with the two
redirect addresses and the post-logout address above, CORS on its token endpoint
for `SITE_ORIGIN` (allowing the `DPoP` request header and exposing `DPoP-Nonce`),
and an authorization endpoint this site may frame.

## Product switcher

With `OIDC_ISSUER` set, the header carries the menu of every Telo product —
Cloud, Hub, Marketplace, Studio — that the identity provider (accounts) lists at
`<OIDC_ISSUER>/v1/products`. A site with no identity provider shows none.

- **The server reads the list**, on the root loader, with a 3 s timeout, and
  keeps it in process for 5 minutes. A request that finds it older starts one
  refresh, shared by every request meanwhile, and is answered with the list it
  has without waiting; only while no list was ever read does a page wait for the
  read, never beyond the timeout.
- **A failed read keeps the last good list**; with none ever read the page
  renders without the switcher, as a 200 like any other. A body that is not
  `{ products: [...] }`, a non-2xx answer, a refused connection and a timeout
  are all failures, logged once until the fault changes.
- **Every entry is checked before use**, since it reaches CSS and `<img src>`:
  the id pattern, a name of 1–100 characters, an `https` url, an `https` icon on
  the issuer's own origin, both colours plain `oklch(…)` values, the id not
  listed before. An entry failing any is dropped, the rest keep their order, and
  the dropped ones are logged once until they change. An issuer on `http` (a
  local stack) therefore yields no switcher.
- **Colours are CSS, not `style` attributes**: the page head carries one
  `<style>` setting `--product-<id>` under `:root` and `.dark` and a
  `.telo-product-<id>` class colouring each name. The site's own wordmark keeps
  its `--product` token and never depends on accounts.
- **The menu** is the outline button with the dot grid (labelled "Telo
  products"); each item is the product's icon and `Telo <name>`, the name in its
  hue, linking to the product. Hub is marked `aria-current="true"`.

## Analytics

Off unless `PLAUSIBLE_SCRIPT_URL` is set. With it, every page loads that
Plausible script and initialises it; nothing else on the site reports to a
third party — the fonts
(Geist, the same packages studio bundles) are served with the site.

## Theme

Light, dark, or the OS setting, chosen with the header toggle and kept in
`localStorage` under `hub.theme` (absent means follow the OS). The layout
choice (rows or cards) is kept under `hub.view`.

## Badges

One tone per question a badge answers: version (outlined, monospace), category
(brand), kernel (green, or amber and marked `partial` when a kernel runs only
some of the module's kinds), `Portable` (blue, a module declaring no controller
code at all), language (grey), `Contract only` / `Application` (violet),
`Deprecated` (red). Kernel and language are separate badges because the two
genuinely differ — a `pkg:cargo` controller is Rust and runs on *both* kernels.

Every field the hub added for this is optional at the boundary. This app deploys
independently of the backend, so a hub that predates a field renders nothing
rather than claiming a false negative.

## Settings

Read once at start. A missing or malformed required setting stops the process
with a message naming the variable.

| Variable | Required | Meaning |
|---|---|---|
| `HUB_API_ORIGIN` | yes | The hub origin the server reads (`/module`, `/modules`). |
| `HUB_BROWSER_API_ORIGIN` | no (defaults to `HUB_API_ORIGIN`) | The hub origin the browser calls for search, categories, ref suggestions, implementations, instances, version pins, register and register status. Also the origin of the MCP endpoint the `/mcp` page shows. |
| `SITE_ORIGIN` | yes | This site's origin, used for canonicals, the sitemap and `robots.txt`. Never derived from the request's `Host`. |
| `PLAUSIBLE_SCRIPT_URL` | no | The Plausible script every page loads (`https://<host>/js/<site script>.js`). Unset, the site loads nothing from a third party. |
| `OIDC_ISSUER` | no | The identity provider readers sign in through, as a bare origin (`https://accounts.telo.run`), and where the product switcher's list is read. Set together with `OIDC_CLIENT_ID`, or not at all. |
| `OIDC_CLIENT_ID` | no | This site's client id at that provider. |
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
the 10 s silence timeout. The product switcher's accounts stub serves HTTPS with
a certificate `openssl` makes for the run, trusted by the server under test
through `NODE_EXTRA_CA_CERTS`; the product list's validation and cache are
tested by importing `app/telo-products.server.ts` directly.

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
