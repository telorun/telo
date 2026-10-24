# Hypermedia: links that name routes, and pluggable representations

## Problem

**A HAL response can only be hand-built.** An author writes `_links` in a `body:` with hrefs built from strings:
- nothing checks an href against the route it points to;
- it breaks silently when a router is re-mounted;
- each route repeats the same layout.

**Routes have no identity.** A link cannot name its target, because `!ref` names only top-level resources and routes are unnamed items inside an `Http.Api`.

**There is no place to decorate every response or problem of a media type** (adding links to problems, laying a body out as HAL), short of writing each `body:` by hand.

## Solution

**Routes can be resources:**

- `HttpDispatch.Route` is an abstract in http-dispatch: an addressable HTTP route, meaning a path template plus `request.schema`.
- `Http.Route` is a kind in http-server, capability `Telo.Mount`, `extends: HttpDispatch.Route`.
- Each item of `Http.Api.routes` is either:
  - today's inline route, unchanged with no `kind:`; or
  - a `!ref` to an `Http.Route`.
- An inline item carrying `kind: Http.Route` is a `SCHEMA_VIOLATION`.
- Both forms share one named shape, `Http.RouteEntry`, so they cannot drift.
- Only a route something links to needs a document of its own.
- One `Http.Route` may be listed by several routers.

**Links name a route:** `$defs/Link` in http-dispatch is `{ route, params?, query?, title?, values? }`.

- **`route`** names an `HttpDispatch.Route` as a type reference, so routes may link to each other without an initialization cycle.
- **`params` / `query`** are typed from the target's `request.schema` across the reference. A parameter left unbound makes the link an RFC 6570 template (`templated: true`).
- **`title`** is a `Text`, with `values` paired to it, translated through the application translator in `request.lang` (source language until that plan ships).

**Links and embedded values on outcomes:**

- `returns:` and `catches:` entries gain `links` (rel → a Link or a list of Links) and `embedded` (rel → `{ items, links, embedded }`).
- They are evaluated over `result` / `error`, with `item` typed from the element of `items`.

**Link resolution:** the serving transport resolves each link to an origin-relative path through its mount table.

- A route of the router serving the request resolves under that request's mount prefix.
- Any other route resolves at its single address on this server.
- A route the server never mounts is `HTTP_LINK_ROUTE_UNROUTED`.
- A route mounted at several addresses is `HTTP_LINK_ROUTE_AMBIGUOUS`.
- Both are resource rules with `ERR_` twins, counted over every router listing the route.
- Each declared link is also emitted as an OpenAPI Link Object.

**Representations lay a value out for one media type:**

- `HttpDispatch.Representation` is an abstract.
  - Capability `Telo.Callable`, deterministic.
  - Parameters `{ value, links, embedded }`, with links already resolved to `{ href, templated?, title? }` and embedded items already represented.
  - A required `mediaType` field.
- A content entry may name a `representation:`.
- `Http.Api` and `Http.Server` carry a `representations:` ladder, tried route → router → server like `catches:`. It applies to every content entry and problem whose media type a listed representation declares.
- Embedded items go through the same representation, innermost first.
- **Problem decorator:** a representation for `application/problem+json` decorates problems. The server writes `type`, `title`, `status`, `detail` and `code` after it runs, so it can add members but never change them.
- **Static refusals:** `HTTP_REPRESENTATION_MISSING` (links or embedded with no applicable representation), `HTTP_REPRESENTATION_MEDIA_TYPE_MISMATCH`, `HTTP_REPRESENTATION_DUPLICATE` (two in one ladder level for one media type).
- **Node only for now:** representations are hosted by the Node kernel; the Rust kernel hosts no `Telo.Callable`.

**HAL is a module of its own:** `hal`, depending on http-dispatch only.

- `Hal.Json` extends `HttpDispatch.Representation` with `mediaType: application/hal+json`, laying `links` out as `_links` and `embedded` as `_embedded`.
- Its exported instance `Hal.json` is what an API lists in `representations:`.
- JSON:API, Siren or an RFC 8288 `Link` header representation would each be another module of the same kind.

**Bookkeeping:**

- **The `anyOf` route branch is checked fully.**
  - Unit test: the walk that reads eval paths, accessor sites, `x-telo-context` regions and reference sites gives an inline route exactly the sets it gives the same route as an `Http.Route`.
  - Manifest test: a CEL error in an inline route's `returns` is still reported.
- **`requires:` floors** on http-server, http-dispatch, `hal` and every manifest writing the new keys, each verified by running the previous CLI.
- **The new `hal` module:** `license: MIT` and its `LICENSE`, `modules/hal/docs/`, a hub description, and tests using `Assert.Equals`, including a templated link and two routers linking to each other.
- **Release:** `telo release add` fragments per module.
- **Docs:** `modules/http-server/docs/returns-and-catches.md`, a hypermedia guide, the primer, the hub guides and the benefits ledger ("hypermedia links checked against their target route").

## Decisions

- **A link names a route by `!ref`.** A path string or CEL href cannot be checked against the target's parameters and breaks on a re-mount. It follows `Ui.Navigation` naming pages by `!ref`.
- **Routes accept both forms.** Making every route a resource rewrites every manifest for a name only linked routes need. A `name:` on inline routes would need keyed-list lookup machinery that references already provide.
- **Links live on the outcome entry, layout on the representation.** What a response refers to is the same in every format; only its layout varies by media type.
- **The transport resolves hrefs.** Only it knows the mount table.
- **A representation is a deterministic callable.** Layout is pure, and an invocable would add dispatch and I/O rights for nothing.
- **Links are declared per entry, not attached by type matching** (Spring's `RepresentationModelProcessor`). Schema identity misses inline schemas and hides which links a response carries.
- **HAL is not in http-server.** It is an expired IETF draft, and a generic transport must not depend on one format.
- **The vocabulary lives in http-dispatch**, so `hal` and any other HTTP transport depend on dispatch alone. `Http.RouteEntry` stays in http-server, which owns the handler and outcome regions.
- **The seam is HTTP-only.** MCP and other transports have their own representations; only translated text and the problem's `code` / `data` are shared.

## Example after the change

```yaml
kind: Http.Route
metadata: { name: getOrder }
request: { path: /orders/{id}, method: GET, schema: { params: { type: object, properties: { id: { type: string } }, required: [id] } } }
inputs: { id: !cel "request.params.id" }
handler: !ref loadOrder
returns:
  - status: 200
    links:
      self: { route: !ref getOrder, params: { id: !cel "result.id" } }
      orders: { route: !ref listOrders }
    content:
      application/json: { body: !cel "result" }
      application/hal+json: {}
---
kind: Http.Api
metadata: { name: ordersApi }
representations:
  - !ref Hal.json
routes:
  - !ref getOrder
  - !ref listOrders
```

With `Accept: application/hal+json`, `GET /api/orders/42` on a server mounting `ordersApi` at `/api` answers with `_links.self.href: "/api/orders/42"` and `_links.orders.href: "/api/orders"`.

## Verify

- **Link parameters are checked:** a link missing a required `params` value of its target, or giving one a wrong type, is refused by `telo check`.
- **No cycles:** two routes linking to each other boot without a dependency cycle.
- **Mount prefixes:** the same router mounted under `/v1` and `/v2` resolves its own links under the prefix the request came through, and a route listed by two routers on one server is `HTTP_LINK_ROUTE_AMBIGUOUS` from another router's link.
- **Existing manifests:** every existing `Http.Api` manifest passes `telo check` unchanged, and `routes: [!ref getOrder]` serves what the inline form served.
- **HAL output:** `Accept: application/hal+json` returns `_links` with resolved hrefs and translated titles, and templated links carry `templated: true`.
- **Problem decorator:** a problem decorator adds `_links` and cannot change `code` or `status`.
